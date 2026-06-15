// netlify/functions/backfill-reassigned-deals.js
//
// One-shot repair for deals a manager already reassigned in JobNimbus BEFORE
// manager-reassign-deal.js learned to keep our Supabase row in sync.
//
// Symptom: the manager changed the JN job's sales_rep to an ACTIVE rep, but our
// inspections row still carries the DEPARTED rep — so the back-to-retail /
// no-damage reports keep showing the deal stuck in the "Non-active rep" section
// instead of moving it up under the active rep.
//
// This scans recent retail / no-damage inspections, compares each one's stored
// sales_rep to its JN job's CURRENT sales_rep, and — when JN now shows an active
// rep that differs from what we have — rewrites our row to match JN. That lets
// the reports re-group the deal under the active rep on the next load.
//
// GET (dry run, lists what WOULD change) — add ?apply=1 to actually write.
//   ?days=N  scan window (default 120)
//
// Env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, JOBNIMBUS_API_KEY.

const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const JN_KEY = process.env.JOBNIMBUS_API_KEY;
const JN_BASE = "https://app.jobnimbus.com/api1";
const REP_ZONES_URL = "https://trainingmanagementsys.netlify.app/.netlify/functions/rep-zones";
const sb = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" };
const jnHeaders = { Authorization: `bearer ${JN_KEY}`, "Content-Type": "application/json" };

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return cors(200, "");
  if (!SB_URL || !SB_KEY) return cors(500, JSON.stringify({ ok: false, error: "Supabase env missing" }));
  if (!JN_KEY) return cors(500, JSON.stringify({ ok: false, error: "JOBNIMBUS_API_KEY not set" }));

  const qp = (event.queryStringParameters || {});
  const apply = ["1", "true", "yes"].includes(String(qp.apply || "").toLowerCase());
  const days = Math.min(Math.max(parseInt(qp.days, 10) || 120, 1), 365);

  try {
    // Active roster (the only sales reps a deal should be re-grouped under).
    const reps = await fetchActiveReps();
    const activeById = {};
    const activeByName = {};
    for (const r of reps) {
      if (r.jobnimbus_id) activeById[r.jobnimbus_id] = r;
      if (r.name) activeByName[normName(r.name)] = r;
    }

    // Candidate inspections: the report types that have a "non-active rep"
    // section, recent, with a JN job to compare against.
    const cutoff = new Date(Date.now() - days * 864e5).toISOString();
    const rows = await sbGet(
      `inspections?cancelled_at=is.null&result=in.(retail,no_damage)&jn_job_id=not.is.null&signed_at=gte.${encodeURIComponent(cutoff)}` +
      `&select=id,client_name,address,result,sales_rep_id,sales_rep_name,jn_job_id,signed_at&order=signed_at.desc&limit=3000`
    );

    const changes = [];
    const BATCH = 6;
    for (let i = 0; i < rows.length; i += BATCH) {
      const chunk = rows.slice(i, i + BATCH);
      const jobs = await Promise.all(chunk.map((r) => getJobSalesRep(r.jn_job_id)));
      chunk.forEach((r, k) => {
        const j = jobs[k];
        if (!j) return;
        // Who does JN currently credit? Resolve to an active rep by id, else name.
        const jnRep = (j.salesRepId && activeById[j.salesRepId]) ||
                      (j.salesRepName && activeByName[normName(j.salesRepName)]) || null;
        if (!jnRep) return;                                  // JN rep isn't active → not a reassign-to-active
        if (r.sales_rep_id && r.sales_rep_id === jnRep.jobnimbus_id) return; // already in sync
        // Our row points somewhere else (the departed rep) → fix it to match JN.
        changes.push({
          id: r.id,
          client: (r.client_name || "").trim(),
          address: r.address || "",
          result: r.result,
          from: r.sales_rep_name || r.sales_rep_id || "(none)",
          to: jnRep.name,
          to_id: jnRep.jobnimbus_id,
          jnid: r.jn_job_id,
        });
      });
    }

    let applied = 0;
    if (apply) {
      for (const c of changes) {
        const ok = await patchInspection(c.id, c.to_id, c.to);
        if (ok) applied++;
      }
    }

    return cors(200, JSON.stringify({
      ok: true,
      dry_run: !apply,
      scanned: rows.length,
      window_days: days,
      would_fix: changes.length,
      applied,
      changes,
    }));
  } catch (e) {
    return cors(500, JSON.stringify({ ok: false, error: e.message || "error" }));
  }
};

async function getJobSalesRep(jnid) {
  try {
    const r = await fetch(`${JN_BASE}/jobs/${encodeURIComponent(jnid)}`, { headers: jnHeaders });
    if (!r.ok) return null;
    const j = await r.json().catch(() => null);
    if (!j) return null;
    return { salesRepId: j.sales_rep || "", salesRepName: j.sales_rep_name || "" };
  } catch { return null; }
}

async function patchInspection(id, salesRepId, salesRepName) {
  try {
    const r = await fetch(`${SB_URL}/rest/v1/inspections?id=eq.${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { ...sb, Prefer: "return=minimal" },
      body: JSON.stringify({ sales_rep_id: salesRepId, sales_rep_name: salesRepName }),
    });
    return r.ok;
  } catch { return false; }
}

async function fetchActiveReps() {
  try {
    const res = await fetch(REP_ZONES_URL);
    if (!res.ok) return [];
    return (await res.json().catch(() => ({}))).reps || [];
  } catch { return []; }
}

async function sbGet(path) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: sb });
  if (!r.ok) return [];
  return r.json().catch(() => []);
}

function normName(x) { return String(x || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(); }
function cors(status, body) {
  return { statusCode: status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" }, body };
}
