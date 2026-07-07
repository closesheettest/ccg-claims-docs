// netlify/functions/jn-activity.js
//
// DIAGNOSTIC (read-only). Pulls a JobNimbus job's activity feed so we can see
// WHO performed an action — specifically who deleted an attachment (the
// "QuickBooks deleted the inspection report" question).
//
//   GET /.netlify/functions/jn-activity?jnid=<jobid>[&size=100]
//     → { jnid, count, deletions:[...], actors:{name:count}, activities:[...] }
//
// Env: JOBNIMBUS_API_KEY.

const JN_BASE = "https://app.jobnimbus.com/api1";
const JN_KEY = process.env.JOBNIMBUS_API_KEY;
const jnH = { Authorization: `bearer ${JN_KEY}`, "Content-Type": "application/json" };
const fmt = (s) => (s ? new Date(s * 1000).toLocaleString("en-US", { timeZone: "America/New_York" }) : null);

exports.handler = async (event) => {
  if (!JN_KEY) return json(500, { error: "missing JOBNIMBUS_API_KEY" });
  const qp = event.queryStringParameters || {};
  const jnid = String(qp.jnid || "").trim();
  if (!jnid) return json(400, { error: "jnid required" });
  const size = Math.min(parseInt(qp.size, 10) || 100, 300);

  // Try a couple filter shapes — JN relates activities to a job via primary/related.
  const attempts = [
    `activities?filter=${enc({ must: [{ term: { "related.id": jnid } }] })}&size=${size}&sort=-date_created`,
    `activities?filter=${enc({ must: [{ term: { "primary.id": jnid } }] })}&size=${size}&sort=-date_created`,
  ];

  let acts = [], usedUrl = null, lastErr = null;
  for (const path of attempts) {
    const r = await fetch(`${JN_BASE}/${path}`, { headers: jnH });
    const txt = await r.text();
    if (!r.ok) { lastErr = `${r.status}: ${txt.slice(0, 200)}`; continue; }
    let d = {}; try { d = JSON.parse(txt); } catch { /* */ }
    acts = d.activity || d.activities || d.results || (Array.isArray(d) ? d : []);
    usedUrl = path;
    if (acts.length) break;
  }
  if (!usedUrl) return json(502, { error: "JN activities fetch failed", detail: lastErr });

  const rows = acts.map((a) => ({
    date: fmt(a.date_created),
    by: a.created_by_name || a.created_by || "(unknown)",
    by_id: a.created_by || null,
    type: a.record_type_name || a.type || null,
    is_status_update: a.is_status_update || false,
    note: String(a.note || a.message || "").replace(/\s+/g, " ").slice(0, 160),
  }));

  const deletions = rows.filter((a) => /delet|attach|document|removed/i.test(`${a.note} ${a.type}`));
  const actors = {};
  for (const r of rows) actors[r.by] = (actors[r.by] || 0) + 1;

  return json(200, { jnid, count: rows.length, actors, deletions, activities: rows });
};

const enc = (obj) => encodeURIComponent(JSON.stringify(obj));
function json(status, obj) {
  return {
    statusCode: status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" },
    body: JSON.stringify(obj, null, 2),
  };
}
