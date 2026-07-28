// netlify/functions/admin-jn-appt-lookup.js
//
// Admin/debug: find a homeowner's JobNimbus job(s) + their appointment tasks (owners +
// dates), so we can see WHY a map appt isn't surfacing and link the pin to the real job.
// Read-only unless you pass pin_id — then it also stamps the chosen job onto the pin.
//
//   GET  ?name=Laura Nembhard[&address=16294][&pin_id=<uuid>&job_id=<jnid>]
//   → { ok, contacts:[...], jobs:[{id,name,status_name,record_type_name,owners,sales_rep}],
//        tasks:[{jobId,title,type,rt,date_start,owners}], linked? }
//
// Env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, JOBNIMBUS_API_KEY

import { jnFetch } from "./_jn.js";

const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const JN_KEY = process.env.JOBNIMBUS_API_KEY;
const APPT_RTS = new Set([4, 12, 17]);
const APPT_NAMES = new Set(["Initial Appointment", "Reset Appointment", "Appointment"]);

export const handler = async (event) => {
  if (!JN_KEY) return json(500, { ok: false, error: "env missing" });
  const q = event.queryStringParameters || {};
  const name = String(q.name || "").trim();
  const address = String(q.address || "").trim();
  if (!name && !address) return json(400, { ok: false, error: "name or address required" });

  // 1) Contacts by display name.
  const cf = encodeURIComponent(JSON.stringify({ must: [{ match_phrase: { display_name: name } }] }));
  const cRes = name ? await jnGet(`contacts?size=10&filter=${cf}`) : {};
  const contacts = (cRes.results || cRes.contacts || cRes.data || []).map((c) => ({ id: c.jnid || c.id, name: c.display_name, mobile: c.mobile_phone }));

  // 2) Jobs for those contacts (and by address if given).
  const jobs = [];
  const seen = new Set();
  const pushJob = (j) => { const id = j.jnid || j.id; if (id && !seen.has(id)) { seen.add(id); jobs.push({ id, name: j.name || j.display_name, status_name: j.status_name, record_type_name: j.record_type_name, owners: (j.owners || []).map((o) => o.id), sales_rep: j.sales_rep, address: [j.address_line1, j.city, j.zip].filter(Boolean).join(", ") }); } };
  for (const c of contacts) {
    const jf = encodeURIComponent(JSON.stringify({ must: [{ term: { "primary.id": c.id } }] }));
    const jr = await jnGet(`jobs?size=20&sort=-date_created&filter=${jf}`);
    for (const j of (jr.results || jr.jobs || jr.data || [])) pushJob(j);
  }
  if (address) {
    const af = encodeURIComponent(JSON.stringify({ must: [{ match_phrase: { address_line1: address } }] }));
    const ar = await jnGet(`jobs?size=20&filter=${af}`);
    for (const j of (ar.results || ar.jobs || ar.data || [])) pushJob(j);
  }

  // 3) Appointment tasks on those jobs (owners + dates).
  const tasks = [];
  for (const j of jobs) {
    const tf = encodeURIComponent(JSON.stringify({ must: [{ term: { "related.id": j.id } }] }));
    const tr = await jnGet(`tasks?size=50&filter=${tf}`);
    for (const t of (tr.results || tr.tasks || tr.data || [])) {
      if (!APPT_NAMES.has(t.record_type_name) && !APPT_RTS.has(Number(t.record_type))) continue;
      tasks.push({ jobId: j.id, title: t.title, type: t.record_type_name, rt: t.record_type, date_start: t.date_start, date_iso: t.date_start ? new Date(t.date_start * 1000).toISOString() : null, owners: (t.owners || []).map((o) => o.id), completed: !!t.is_completed });
    }
  }

  // 4) Optional: link a chosen job onto the pin.
  let linked = false;
  if (q.pin_id && q.job_id && SB_URL && SB_KEY) {
    const r = await fetch(`${SB_URL}/rest/v1/canvass_prospects?id=eq.${encodeURIComponent(q.pin_id)}`, {
      method: "PATCH", headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({ jn_job_id: q.job_id }),
    });
    linked = r.ok;
  }

  return json(200, { ok: true, contacts, jobs, tasks, linked });
};

async function jnGet(path) {
  const r = await jnFetch(JN_KEY, path);
  if (!r.ok) return {};
  return r.json().catch(() => ({}));
}
function json(statusCode, obj) {
  return { statusCode, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }, body: JSON.stringify(obj) };
}
