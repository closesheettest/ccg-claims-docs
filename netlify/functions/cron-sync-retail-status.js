// netlify/functions/cron-sync-retail-status.js
//
// Catches the "office side" of retail outcomes: reads the JobNimbus status of
// every ACTIVE retail deal (result=retail, not cancelled, no outcome yet) and,
// when JN shows a terminal status, stamps inspections.retail_outcome — which
// drops it off the rep's Retail visit list. The row is KEPT for reporting.
//
// JN status → outcome:
//   sold pipeline (Sit Sold, Signed Contract, … Install Set, etc.) → "sold"
//   "Sit - No Sale"                                                → "no_sale"
//   "BTR - NI"                                                      → "ni"
//   (Lost retail deals get cancelled elsewhere, so they already drop off.)
//
// GET /.netlify/functions/cron-sync-retail-status   (also runs on schedule)
// Env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, JOBNIMBUS_API_KEY.

const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const sb = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" };
const JN_BASE = "https://app.jobnimbus.com/api1";
const JN_KEY = process.env.JOBNIMBUS_API_KEY;
const jnH = { Authorization: `bearer ${JN_KEY}`, "Content-Type": "application/json" };

const SOLD = new Set(["sit sold", "signed contract", "production review", "job prep", "in funding", "waiting on pace", "upcoming installs", "install set", "roof started", "new roof", "paid closed", "upcoming commissions", "sit sold insp"].map(norm).filter((x) => x !== "sit sold insp"));
function norm(s) { return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(); }
function outcomeFor(status) {
  const s = norm(status);
  if (!s) return null;
  if (SOLD.has(s)) return "sold";
  if (s === "sit no sale") return "no_sale";
  if (s === "btr ni" || s === "not interested") return "ni";
  return null; // still active (Sit Sold Insp, Appointment Scheduled, etc.)
}

exports.handler = async () => {
  if (!SB_URL || !SB_KEY || !JN_KEY) return j(500, { ok: false, error: "env missing" });
  try {
    const rows = await sbGet("inspections?result=eq.retail&cancelled_at=is.null&retail_outcome=is.null&jn_job_id=not.is.null&select=id,jn_job_id&limit=2000");
    const ids = rows.map((r) => r.jn_job_id).filter(Boolean);
    const statusById = {};
    for (let i = 0; i < ids.length; i += 100) {
      const filter = encodeURIComponent(JSON.stringify({ must: [{ terms: { jnid: ids.slice(i, i + 100) } }] }));
      const r = await fetch(`${JN_BASE}/jobs?size=100&filter=${filter}`, { headers: jnH });
      if (!r.ok) continue;
      const d = await r.json().catch(() => ({}));
      for (const job of (d.results || d.jobs || [])) statusById[job.jnid || job.id] = job.status_name;
    }
    let updated = 0; const byOutcome = {};
    for (const row of rows) {
      const outcome = outcomeFor(statusById[row.jn_job_id]);
      if (!outcome) continue;
      const up = await fetch(`${SB_URL}/rest/v1/inspections?id=eq.${encodeURIComponent(row.id)}`, {
        method: "PATCH", headers: { ...sb, Prefer: "return=minimal" },
        body: JSON.stringify({ retail_outcome: outcome, retail_outcome_at: new Date().toISOString(), retail_outcome_by: "JN sync" }),
      });
      if (up.ok) { updated++; byOutcome[outcome] = (byOutcome[outcome] || 0) + 1; }
    }
    return j(200, { ok: true, checked: rows.length, updated, byOutcome });
  } catch (e) {
    return j(500, { ok: false, error: e.message || "error" });
  }
};

async function sbGet(path) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: sb });
  if (!r.ok) return [];
  return r.json().catch(() => []);
}
function j(status, body) { return { statusCode: status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }, body: JSON.stringify(body) }; }
