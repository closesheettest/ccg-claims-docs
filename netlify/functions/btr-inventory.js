// netlify/functions/btr-inventory.js
//
// BTR DEAL INVENTORY — every back-to-retail deal on one board, in the column it's
// actually in. The retail twin of pa-inventory, same rules, same layout.
//
// Columns come from _retail.retailStage — the SAME classifier the master report
// and the BTR reports already use — so this board can't tell a different story
// about a deal than the rest of the app does.
//
// Worth knowing when reading it: retailStage TRUSTS A RECORDED OUTCOME OVER THE
// JOBNIMBUS STATUS. The office routinely leaves a deal at "Sit Sold Insp" long
// after the rep recorded what happened, so reading JN alone shows worked deals
// as never-worked.
//
//   GET /.netlify/functions/btr-inventory
//   → { ok, generated_at, columns:[{ key, label, color, count, deals:[…] }], totals }
//
// Env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY.

import { retailStage } from "./_retail.js";

const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const sbH = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` };

// Left to right = the order a retail deal travels. The closed-out states sit at
// the end as visible columns rather than hidden filters.
const COLUMNS = [
  { key: "not_worked",     label: "Not Worked",        color: "#b45309", hint: "Inspection signed, the retail go-back hasn't started." },
  { key: "no_sit",         label: "No Sit",            color: "#b91c1c", hint: "Went out and didn't sit — needs another run at it." },
  { key: "appt_scheduled", label: "Appointment Set",   color: "#2563eb", hint: "A retail appointment is booked." },
  { key: "sit_pending",    label: "Sit Pending",       color: "#7c3aed", hint: "Sat with them, still working it." },
  { key: "sold",           label: "Sold",              color: "#16a34a", hint: "Signed the contract." },
  { key: "no_sale",        label: "No Sale",           color: "#c2410c", hint: "Sat and didn't close." },
  { key: "credit_denial",  label: "Credit Denied",     color: "#0e7490", hint: "Wanted it, financing said no." },
  { key: "declined",       label: "Not Interested",    color: "#64748b", hint: "Homeowner is out — BTR-NI." },
  { key: "lost",           label: "Lost / Stale",      color: "#94a3b8", hint: "Dead, no response, or written off." },
];

export const handler = async () => {
  if (!SB_URL || !SB_KEY) return json(500, { ok: false, error: "env missing" });
  try {
    const [inspections, appts] = await Promise.all([
      sbGetAll("inspections?result=eq.retail&select=id,client_name,address,city,state,zip,mobile,sales_rep_name,original_sales_rep_name,signed_at,result_at,jn_job_id,jn_status,retail_outcome,retail_outcome_at,retail_outcome_by,pa_notes_log,cancelled_at,goback_not_home_count,goback_last_attempt_at"),
      sbGetAll("retail_appointments?select=inspection_id,start_at,booked_by,created_at"),
    ]);

    const byInsp = {};
    for (const a of appts) (byInsp[a.inspection_id] = byInsp[a.inspection_id] || []).push(a);
    const latestAppt = (id) => (byInsp[id] || []).slice().sort((x, y) => new Date(y.start_at) - new Date(x.start_at))[0] || null;

    const now = Date.now();
    const live = inspections.filter((i) => !i.cancelled_at);

    const buckets = Object.fromEntries(COLUMNS.map((c) => [c.key, []]));
    for (const i of live) {
      const state = retailStage(i.jn_status, i.retail_outcome);
      if (!buckets[state]) continue;
      const appt = latestAppt(i.id);
      // AGE from the day the inspection produced a retail result — that's when
      // the deal became the rep's to work.
      const clock = i.result_at || i.signed_at || null;
      const notes = Array.isArray(i.pa_notes_log) ? i.pa_notes_log : [];
      const last = notes.length ? notes[notes.length - 1] : null;
      const apptMs = appt && appt.start_at ? Date.parse(appt.start_at) : 0;
      const closed = ["sold", "no_sale", "credit_denial", "declined", "lost"].includes(state);
      buckets[state].push({
        id: i.id,
        name: (i.client_name || "").trim() || "—",
        address: [i.address, i.city].filter(Boolean).join(", "),
        phone: i.mobile || null,
        rep: i.sales_rep_name || i.original_sales_rep_name || null,
        age_days: clock ? Math.floor((now - Date.parse(clock)) / 86400000) : null,
        appt_at: appt ? appt.start_at : null,
        booked_by: appt ? appt.booked_by || null : null,
        // An appointment whose time passed on a deal nobody has closed out. Same
        // flag as the PA board, and the same meaning: the visit may well have
        // happened and nobody wrote down the result.
        appt_open: !!(apptMs && apptMs < now && !closed),
        not_home: i.goback_not_home_count || 0,
        outcome: i.retail_outcome || null,
        outcome_by: i.retail_outcome_by || null,
        jn_status: i.jn_status || null,
        jn_job_id: i.jn_job_id || null,
        notes: notes.length,
        last_note: last ? String(last.text || "").slice(0, 220) : null,
        last_note_at: last ? last.at || null : null,
      });
    }
    for (const k of Object.keys(buckets)) buckets[k].sort((a, b) => (b.age_days || 0) - (a.age_days || 0));

    const columns = COLUMNS.map((c) => ({ ...c, count: buckets[c.key].length, deals: buckets[c.key] }));
    const openStates = ["not_worked", "no_sit", "appt_scheduled", "sit_pending"];
    return json(200, {
      ok: true,
      generated_at: new Date().toISOString(),
      totals: {
        deals: live.length,
        open: openStates.reduce((n, k) => n + buckets[k].length, 0),
        sold: buckets.sold.length,
        appt_open: columns.reduce((n, c) => n + c.deals.filter((d) => d.appt_open).length, 0),
      },
      columns,
    });
  } catch (e) {
    return json(500, { ok: false, error: e.message || "error" });
  }
};

async function sbGetAll(pathQuery, pageSize = 1000) {
  const out = [];
  for (let from = 0; ; from += pageSize) {
    const r = await fetch(`${SB_URL}/rest/v1/${pathQuery}`, { headers: { ...sbH, "Range-Unit": "items", Range: `${from}-${from + pageSize - 1}` } });
    if (!r.ok) break;
    const b = await r.json().catch(() => []);
    if (!Array.isArray(b) || !b.length) break;
    out.push(...b);
    if (b.length < pageSize) break;
  }
  return out;
}
function json(statusCode, body) {
  return { statusCode, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }, body: JSON.stringify(body) };
}
