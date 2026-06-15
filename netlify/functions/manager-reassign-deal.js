// netlify/functions/manager-reassign-deal.js
//
// Reassign a departed rep's deal from the Regional Manager dashboard. The
// manager picks an "Assign Rep" (the person who'll now work it) and a
// "Sales Rep" (who gets the credit), then this writes both to JobNimbus:
//   • ASSIGN REP  → ADDED to the job's owners / "Assigned To" (JN allows
//     more than one — we keep anyone already on it and append, deduped).
//   • SALES REP   → REPLACES the job's sales_rep (+ sales_rep_name).
//
// Called cross-origin from the TMS regional-manager dashboard (same open-CORS
// pattern as the zone-* report feeds it sits next to). Validates that the JN
// ids passed are real active reps (from the TMS roster) so a stray call can't
// write garbage onto a job.
//
// POST { jnid, assigneeId?, salesRepId? }  (at least one of the two)
// → { ok, jnid, owners, sales_rep, sales_rep_name }
//
// Env: JOBNIMBUS_API_KEY.

const JN_BASE = "https://app.jobnimbus.com/api1";
const JN_KEY = process.env.JOBNIMBUS_API_KEY;
const REP_ZONES_URL = "https://trainingmanagementsys.netlify.app/.netlify/functions/rep-zones";
const jnHeaders = { Authorization: `bearer ${JN_KEY}`, "Content-Type": "application/json" };

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return cors(200, "");
  if (event.httpMethod !== "POST") return cors(405, JSON.stringify({ ok: false, error: "POST only" }));
  if (!JN_KEY) return cors(500, JSON.stringify({ ok: false, error: "JOBNIMBUS_API_KEY not set" }));

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { return cors(400, JSON.stringify({ ok: false, error: "bad JSON" })); }
  const jnid = String(body.jnid || "").trim();
  const assigneeId = String(body.assigneeId || "").trim();
  const salesRepId = String(body.salesRepId || "").trim();
  if (!jnid) return cors(400, JSON.stringify({ ok: false, error: "jnid required" }));
  if (!assigneeId && !salesRepId) return cors(400, JSON.stringify({ ok: false, error: "pick an assign rep and/or sales rep" }));

  // Validate the rep ids against the active TMS roster (name lookup for the
  // sales_rep_name we write). Rejects anything that isn't a current rep.
  const reps = await fetchActiveReps();
  const byId = {};
  for (const r of reps) if (r.jobnimbus_id) byId[r.jobnimbus_id] = r;
  if (assigneeId && !byId[assigneeId]) return cors(400, JSON.stringify({ ok: false, error: "assign rep is not a current active rep" }));
  if (salesRepId && !byId[salesRepId]) return cors(400, JSON.stringify({ ok: false, error: "sales rep is not a current active rep" }));

  try {
    // 1. Read the job's current owners so we APPEND (not clobber) the assignee.
    const jr = await fetch(`${JN_BASE}/jobs/${encodeURIComponent(jnid)}`, { headers: jnHeaders });
    if (!jr.ok) return cors(502, JSON.stringify({ ok: false, error: `JN job fetch ${jr.status}` }));
    const job = await jr.json();
    const existing = Array.isArray(job.owners) ? job.owners.filter((o) => o && o.id).map((o) => ({ id: o.id })) : [];

    const patch = {};
    if (assigneeId) {
      const owners = existing.slice();
      if (!owners.some((o) => o.id === assigneeId)) owners.push({ id: assigneeId });
      patch.owners = owners;
    }
    if (salesRepId) {
      patch.sales_rep = salesRepId;
      patch.sales_rep_name = byId[salesRepId].name;
    }

    const pr = await fetch(`${JN_BASE}/jobs/${encodeURIComponent(jnid)}`, {
      method: "PUT", headers: jnHeaders, body: JSON.stringify(patch),
    });
    const text = await pr.text();
    if (!pr.ok) return cors(502, JSON.stringify({ ok: false, error: `JN update ${pr.status}: ${text.slice(0, 200)}` }));

    return cors(200, JSON.stringify({
      ok: true,
      jnid,
      owners: patch.owners ? patch.owners.map((o) => byId[o.id]?.name || o.id) : undefined,
      sales_rep: patch.sales_rep_name || undefined,
    }));
  } catch (e) {
    return cors(500, JSON.stringify({ ok: false, error: e.message || "error" }));
  }
};

async function fetchActiveReps() {
  try {
    const res = await fetch(REP_ZONES_URL);
    if (!res.ok) return [];
    return (await res.json().catch(() => ({}))).reps || [];
  } catch { return []; }
}

function cors(status, body) {
  return {
    statusCode: status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
    body,
  };
}
