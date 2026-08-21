// netlify/functions/pa-signed.js
//
// PA SIGNED STATUS — every claim a public adjuster has actually signed, in the
// column matching how far it has got since.
//
// The PA Deal Inventory answers "has a PA signed this yet?" and stops there:
// everything signed lands in one column and you can't tell a claim filed
// yesterday from one that settled. This board picks up where that one ends.
//
// SIGNED means the same thing here as everywhere else — the exact Five Star
// rule from _btpa: pa_fields.pa_signup === "Signed" OR pa_signed_at. NOT the
// optimistic "Sit Sold PA" JobNimbus status, which the office sets while the PA
// may still be chasing the homeowner.
//
// The columns after that are the milestones the PA stamps in their own portal,
// each a date on pa_fields:
//   pa_filed → pa_coverage_opened → iss_uploaded (settlement/iink) → closed_cancelled
// A claim's column is the FURTHEST milestone it has reached.
//
//   GET /.netlify/functions/pa-signed
//   → { ok, generated_at, columns:[…], totals }
//
// Env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY.

const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const sbH = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` };

const COLUMNS = [
  { key: "signed",     label: "Signed",            color: "#16a34a", hint: "The PA has the homeowner. Nothing filed yet." },
  { key: "filed",      label: "Claim Filed",       color: "#0e7490", hint: "The claim is in with the carrier." },
  { key: "coverage",   label: "Coverage Opened",   color: "#7c3aed", hint: "The carrier opened coverage." },
  { key: "settlement", label: "Settlement / iink", color: "#b45309", hint: "Settlement paperwork is in." },
  { key: "closed",     label: "Closed / Cancelled",color: "#64748b", hint: "Finished, or the claim was cancelled." },
];

// Milestone values arrive as unix seconds from Five Star, or occasionally as an
// ISO string. Both have to survive the trip to the card.
function msOf(v) {
  if (!v) return null;
  if (typeof v === "number") return v > 1e12 ? v : v * 1000;
  const n = Number(v);
  if (Number.isFinite(n) && n > 0) return n > 1e12 ? n : n * 1000;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}
function paFields(row) {
  let f = row.pa_fields;
  if (typeof f === "string") { try { f = JSON.parse(f); } catch { f = {}; } }
  return f && typeof f === "object" ? f : {};
}

export const handler = async () => {
  if (!SB_URL || !SB_KEY) return json(500, { ok: false, error: "env missing" });
  try {
    const [inspections, pas, companies] = await Promise.all([
      sbGetAll("inspections?result=eq.damage&select=id,client_name,address,city,mobile,sales_rep_name,original_sales_rep_name,result_at,signed_at,jn_job_id,jn_status,pa_id,pa_company_id,pa_signed_at,pa_fields,pa_notes_log,cancelled_at"),
      sbGetAll("pas?select=id,name,phone,pa_company_id"),
      sbGetAll("pa_companies?select=id,name"),
    ]);
    const paById = Object.fromEntries(pas.map((p) => [p.id, p]));
    const coById = Object.fromEntries(companies.map((c) => [c.id, c.name]));

    const now = Date.now();
    const buckets = Object.fromEntries(COLUMNS.map((c) => [c.key, []]));

    for (const i of inspections) {
      if (i.cancelled_at) continue;
      const f = paFields(i);
      const isSigned = f.pa_signup === "Signed" || !!i.pa_signed_at;
      if (!isSigned) continue;

      const m = {
        filed: msOf(f.pa_filed),
        coverage: msOf(f.pa_coverage_opened),
        settlement: msOf(f.iss_uploaded),
        closed: msOf(f.closed_cancelled),
      };
      const stage = m.closed ? "closed" : m.settlement ? "settlement" : m.coverage ? "coverage" : m.filed ? "filed" : "signed";

      const signedMs = msOf(i.pa_signed_at) || msOf(f.pa_signed_at) || null;
      const pa = i.pa_id ? paById[i.pa_id] : null;
      const notes = Array.isArray(i.pa_notes_log) ? i.pa_notes_log : [];
      const last = notes.length ? notes[notes.length - 1] : null;
      // The clock that matters on a signed claim is how long it's been sitting
      // AT ITS CURRENT STAGE — a claim signed in June and filed in June is fine;
      // one signed in June with nothing since is not.
      const stageMs = m[stage] || signedMs;

      buckets[stage].push({
        id: i.id,
        name: (i.client_name || "").trim() || "—",
        address: [i.address, i.city].filter(Boolean).join(", "),
        phone: i.mobile || null,
        rep: i.sales_rep_name || i.original_sales_rep_name || null,
        pa: pa ? pa.name : null,
        company: pa && pa.pa_company_id ? (coById[pa.pa_company_id] || null) : null,
        signed_at: signedMs ? new Date(signedMs).toISOString() : null,
        age_days: stageMs ? Math.floor((now - stageMs) / 86400000) : null,
        since_signed_days: signedMs ? Math.floor((now - signedMs) / 86400000) : null,
        milestones: Object.fromEntries(Object.entries(m).map(([k, v]) => [k, v ? new Date(v).toISOString() : null])),
        jn_status: i.jn_status || null,
        jn_job_id: i.jn_job_id || null,
        notes: notes.length,
        last_note: last ? String(last.text || "").slice(0, 220) : null,
        last_note_at: last ? last.at || null : null,
      });
    }
    for (const k of Object.keys(buckets)) buckets[k].sort((a, b) => (b.age_days || 0) - (a.age_days || 0));

    const columns = COLUMNS.map((c) => ({ ...c, count: buckets[c.key].length, deals: buckets[c.key] }));
    const all = columns.flatMap((c) => c.deals);
    return json(200, {
      ok: true,
      generated_at: new Date().toISOString(),
      totals: {
        deals: all.length,
        in_flight: all.length - buckets.closed.length,
        // Signed but nothing filed after two weeks — the one number worth chasing.
        stalled: buckets.signed.filter((d) => (d.age_days || 0) > 14).length,
        no_date: all.filter((d) => !d.signed_at).length,
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
