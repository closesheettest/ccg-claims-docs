// netlify/functions/backfill-original-signer.js
//
// One-time (re-runnable) recovery for the "frozen sign-up credit" feature.
//
// When a retail deal a rep SIGNED is reassigned to a sales rep, the reassign
// only REPLACES sales_rep but APPENDS to the JN job's `owners` — so the original
// signer stays in owners forever. We use that to recover who signed each deal.
//
// Run the SQL backfill FIRST (sets original_sales_rep_* = current sales_rep_*
// for every row where it's null). THEN run this to FORCE the original signer
// back to the given rep on every inspection whose JN job still lists that rep
// as an owner — fixing the deals that were reassigned away from them.
//
// POST { rep_jn_id?, rep_name?, dry_run? }
//   defaults to William Hernandez (the outside free-inspections trainer).
// → { ok, rep, jn_jobs_owned, inspections_updated, dry_run }
//
// Env: JOBNIMBUS_API_KEY, VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY.

const JN_BASE = "https://app.jobnimbus.com/api1";
const JN_KEY = process.env.JOBNIMBUS_API_KEY;
const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const jnHeaders = { Authorization: `bearer ${JN_KEY}`, "Content-Type": "application/json" };
const sbHeaders = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" };

// Default: William Hernandez (outside free-inspections trainer).
const DEFAULT_REP_ID = "aa4432f4afaf40c8a66ef499cdf52c2f";
const DEFAULT_REP_NAME = "William Hernandez";

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { ok: false, error: "POST only" });
  if (!JN_KEY) return json(500, { ok: false, error: "JOBNIMBUS_API_KEY not set" });
  if (!SB_URL || !SB_KEY) return json(500, { ok: false, error: "Supabase env not set" });

  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch {}
  const repId = String(body.rep_jn_id || DEFAULT_REP_ID).trim();
  const repName = String(body.rep_name || DEFAULT_REP_NAME).trim();
  const dryRun = body.dry_run === true;

  try {
    // 1. Page through every JN job where this rep is an owner.
    const filter = encodeURIComponent(JSON.stringify({ must: [{ term: { "owners.id": repId } }] }));
    const jnids = [];
    let from = 0;
    const size = 100;
    for (let page = 0; page < 50; page++) {
      const r = await fetch(`${JN_BASE}/jobs?filter=${filter}&size=${size}&from=${from}`, { headers: jnHeaders });
      if (!r.ok) return json(502, { ok: false, error: `JN jobs ${r.status}` });
      const d = await r.json().catch(() => ({}));
      const results = d.results || d.data || [];
      for (const j of results) {
        const id = j.jnid || j.id;
        if (id) jnids.push(id);
      }
      if (results.length < size) break;
      from += results.length;
    }
    const uniqJnids = [...new Set(jnids)];

    if (dryRun) {
      return json(200, { ok: true, rep: repName, jn_jobs_owned: uniqJnids.length, inspections_updated: 0, dry_run: true });
    }

    // 2. Force original_sales_rep_* = this rep on every inspection linked to
    //    those JN jobs (chunked to keep the `in.()` filter a sane length).
    let updated = 0;
    const payload = JSON.stringify({ original_sales_rep_id: repId, original_sales_rep_name: repName });
    for (let i = 0; i < uniqJnids.length; i += 50) {
      const chunk = uniqJnids.slice(i, i + 50);
      const inList = chunk.map((x) => `"${x}"`).join(",");
      const r = await fetch(`${SB_URL}/rest/v1/inspections?jn_job_id=in.(${encodeURIComponent(inList)})`, {
        method: "PATCH",
        headers: { ...sbHeaders, Prefer: "return=representation" },
        body: payload,
      });
      if (!r.ok) {
        const t = await r.text();
        return json(502, { ok: false, error: `Supabase PATCH ${r.status}: ${t.slice(0, 200)}`, updated_so_far: updated });
      }
      const rows = await r.json().catch(() => []);
      updated += Array.isArray(rows) ? rows.length : 0;
    }

    return json(200, { ok: true, rep: repName, jn_jobs_owned: uniqJnids.length, inspections_updated: updated, dry_run: false });
  } catch (e) {
    return json(500, { ok: false, error: e.message || "error" });
  }
};

function json(status, b) {
  return { statusCode: status, headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) };
}
