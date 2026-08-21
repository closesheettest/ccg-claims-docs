// netlify/functions/pa-inventory.js
//
// PA DEAL INVENTORY — every damage (BTPA) deal on one board, in the column that
// matches where it actually is. Laid out like a JobNimbus board: a column per
// lifecycle state, a card per homeowner.
//
// The columns come from _btpa.damageState — the SAME classifier the master
// report and the reps' go-back map use — so this board cannot tell a different
// story about a deal than the rest of the app does. That mattered: the old PA
// screens each decided a deal's state their own way, which is how you end up
// with "so many holes I have no idea what's what" (Neal, 2026-08-21).
//
// Each card carries the numbers you'd otherwise have to open the deal to learn:
// how long it's been sitting, who has it, when the appointment is/was, whether
// an appointment came and went with nothing recorded.
//
//   GET /.netlify/functions/pa-inventory
//   → { ok, generated_at, columns:[{ key, label, color, count, deals:[…] }], totals }
//
// Env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY.

import { damageState } from "./_btpa.js";

const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const sbH = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` };

// Board order = the order a deal actually travels, left to right. Dead sits at
// the end rather than being hidden — a column of DQs you can see is worth more
// than a filter you have to remember to turn on.
const COLUMNS = [
  { key: "need_appt",    label: "Needs Appointment",  color: "#b45309", hint: "No PA appointment has ever been booked." },
  { key: "rescheduling", label: "Needs Reschedule",   color: "#b91c1c", hint: "An appointment fell through or its time passed — rebook it." },
  { key: "rescheduled",  label: "Rebooked",           color: "#0e7490", hint: "Fell through once, now has a new time ahead." },
  { key: "upcoming",     label: "Appointment Set",    color: "#2563eb", hint: "A PA appointment is booked for later." },
  { key: "waiting_docs", label: "Sit Pending",        color: "#7c3aed", hint: "The homeowner sat with the PA; the PA is collecting documents." },
  { key: "signed",       label: "Signed",             color: "#16a34a", hint: "The PA signed the homeowner for the claim." },
  { key: "dead",         label: "Dead / DQ",          color: "#64748b", hint: "Homeowner not interested, or the office closed it out." },
];

export const handler = async () => {
  if (!SB_URL || !SB_KEY) return json(500, { ok: false, error: "env missing" });
  try {
    const [inspections, appts, pas, companies] = await Promise.all([
      sbGetAll("inspections?result=eq.damage&select=id,client_name,address,city,state,zip,mobile,sales_rep_name,original_sales_rep_name,signed_at,result_at,jn_job_id,jn_status,pa_id,pa_company_id,pa_stage,pa_signed_at,pa_opened_at,pa_fields,pa_notes_log,cancelled_at"),
      sbGetAll("pa_appointments?select=id,inspection_id,start_at,status,booked_by,created_at"),
      sbGetAll("pas?select=id,name,phone,pa_company_id"),
      sbGetAll("pa_companies?select=id,name"),
    ]);

    const paById = Object.fromEntries(pas.map((p) => [p.id, p]));
    const coById = Object.fromEntries(companies.map((c) => [c.id, c.name]));
    // Cancelled appointments don't define a state — same rule the master report uses.
    const byInsp = {};
    for (const a of appts) { if (a.status === "cancelled") continue; (byInsp[a.inspection_id] = byInsp[a.inspection_id] || []).push(a); }
    const latestAppt = (id) => (byInsp[id] || []).slice().sort((x, y) => new Date(y.start_at) - new Date(x.start_at))[0] || null;

    const now = Date.now();
    // A live deal only. A cancelled inspection isn't inventory, it's history.
    const live = inspections.filter((i) => !i.cancelled_at && String(i.jn_status || "").toLowerCase() !== "lost");

    const buckets = Object.fromEntries(COLUMNS.map((c) => [c.key, []]));
    for (const i of live) {
      const appt = latestAppt(i.id);
      const state = damageState(i, appt, now);
      if (!buckets[state]) continue;               // an unknown state is a bug, not a column
      const pa = i.pa_id ? paById[i.pa_id] : null;
      // AGE runs from the day we found damage — that's when the clock a homeowner
      // feels starts, not when a PA happened to pick it up.
      const clock = i.result_at || i.signed_at || null;
      const notes = Array.isArray(i.pa_notes_log) ? i.pa_notes_log : [];
      const last = notes.length ? notes[notes.length - 1] : null;
      const apptMs = appt && appt.start_at ? Date.parse(appt.start_at) : 0;
      buckets[state].push({
        id: i.id,
        name: (i.client_name || "").trim() || "—",
        address: [i.address, i.city].filter(Boolean).join(", "),
        phone: i.mobile || null,
        rep: i.sales_rep_name || i.original_sales_rep_name || null,
        pa: pa ? pa.name : null,
        company: pa && pa.pa_company_id ? (coById[pa.pa_company_id] || null) : null,
        age_days: clock ? Math.floor((now - Date.parse(clock)) / 86400000) : null,
        appt_at: appt ? appt.start_at : null,
        // An appointment whose time passed while it still says "scheduled" is the
        // single most useful flag on this board: work may well have happened and
        // nobody wrote down the result.
        appt_open: !!(appt && appt.status === "scheduled" && apptMs && apptMs < now),
        jn_status: i.jn_status || null,
        jn_job_id: i.jn_job_id || null,
        notes: notes.length,
        last_note: last ? String(last.text || "").slice(0, 220) : null,
        last_note_at: last ? last.at || null : null,
      });
    }

    // Oldest first inside every column — the board should point at what's been
    // waiting longest, not at whatever was touched most recently.
    for (const k of Object.keys(buckets)) buckets[k].sort((a, b) => (b.age_days || 0) - (a.age_days || 0));

    const columns = COLUMNS.map((c) => ({ ...c, count: buckets[c.key].length, deals: buckets[c.key] }));
    return json(200, {
      ok: true,
      generated_at: new Date().toISOString(),
      totals: {
        deals: live.length,
        unsigned: live.length - buckets.signed.length - buckets.dead.length,
        appt_open: columns.reduce((n, c) => n + c.deals.filter((d) => d.appt_open).length, 0),
        no_pa: live.filter((i) => !i.pa_id).length,
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
