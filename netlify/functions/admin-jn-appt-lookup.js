// netlify/functions/admin-jn-appt-lookup.js — TEMP admin/debug: does a homeowner/address
// have a JobNimbus job + appointment task? Read-only. Removed after use.
//   GET ?name=Sonja Mattick   or   ?address=844 Haskell
import { jnFetch } from "./_jn.js";
const JN_KEY = process.env.JOBNIMBUS_API_KEY;
const APPT_RTS = new Set([4, 12, 17]);
const APPT_NAMES = new Set(["Initial Appointment", "Reset Appointment", "Appointment"]);

export const handler = async (event) => {
  if (!JN_KEY) return json(500, { ok: false, error: "env missing" });
  const q = event.queryStringParameters || {};
  const name = String(q.name || "").trim();
  const address = String(q.address || "").trim();
  const jobs = [], seen = new Set();
  const pushJob = (j) => { const id = j.jnid || j.id; if (id && !seen.has(id)) { seen.add(id); jobs.push({ id, name: j.name || j.display_name, status_name: j.status_name, record_type_name: j.record_type_name, sales_rep: j.sales_rep, owners: (j.owners || []).map((o) => o.id), harvested: harvestFlag(j), address: [j.address_line1, j.city, j.zip].filter(Boolean).join(", ") }); } };

  if (name) {
    const cf = encodeURIComponent(JSON.stringify({ must: [{ match_phrase: { display_name: name } }] }));
    const cRes = await jnGet(`contacts?size=10&filter=${cf}`);
    for (const c of (cRes.results || cRes.contacts || cRes.data || [])) {
      const cid = c.jnid || c.id;
      const jf = encodeURIComponent(JSON.stringify({ must: [{ term: { "primary.id": cid } }] }));
      const jr = await jnGet(`jobs?size=20&sort=-date_created&filter=${jf}`);
      for (const j of (jr.results || jr.jobs || jr.data || [])) pushJob(j);
    }
  }
  if (address) {
    const af = encodeURIComponent(JSON.stringify({ must: [{ match_phrase: { address_line1: address } }] }));
    const ar = await jnGet(`jobs?size=20&filter=${af}`);
    for (const j of (ar.results || ar.jobs || ar.data || [])) pushJob(j);
  }
  const tasks = [];
  for (const j of jobs) {
    const tf = encodeURIComponent(JSON.stringify({ must: [{ term: { "related.id": j.id } }] }));
    const tr = await jnGet(`tasks?size=50&filter=${tf}`);
    for (const t of (tr.results || tr.tasks || tr.data || [])) {
      if (!APPT_NAMES.has(t.record_type_name) && !APPT_RTS.has(Number(t.record_type))) continue;
      tasks.push({ jobId: j.id, title: t.title, type: t.record_type_name, date_iso: t.date_start ? new Date(t.date_start * 1000).toISOString() : null, owners: (t.owners || []).map((o) => o.id), completed: !!t.is_completed });
    }
  }
  return json(200, { ok: true, jobs, appt_tasks: tasks });
};
function harvestFlag(job) { for (const [k, v] of Object.entries(job)) if (/sales rep harvested/i.test(k.replace(/\*/g, "").trim())) return v; return undefined; }
async function jnGet(path) { const r = await jnFetch(JN_KEY, path); if (!r.ok) return {}; return r.json().catch(() => ({})); }
function json(s, o) { return { statusCode: s, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }, body: JSON.stringify(o) }; }
