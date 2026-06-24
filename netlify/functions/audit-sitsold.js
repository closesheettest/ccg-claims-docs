// netlify/functions/audit-sitsold.js
//
// Reconciles JobNimbus "Sit Sold Insp" jobs (what JN counts as "needs to be
// inspected") against our inspections table. Explains why the Inspections Map
// (driven by our table, result IS NULL) can show fewer than JN's count.
//
// Buckets each JN Sit-Sold-Insp job:
//   needs_inspection  — in our table, result IS NULL  → correctly on the map
//   done_jn_stale     — in our table WITH a result    → finished in our app but
//                       JN status never advanced (the sync gap; re-push fixes)
//   not_in_table      — no inspections row at all      → JN-native / orphan
//   no_geo            — in our table, result null, but missing lat/lng
//
// GET → { ok, jn_total, counts, done_jn_stale:[…], not_in_table:[…], no_geo:[…] }
// Env: JOBNIMBUS_API_KEY, VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY.

const JN_BASE = "https://app.jobnimbus.com/api1";
const JN_KEY = process.env.JOBNIMBUS_API_KEY;
const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const STATUS = "Sit Sold Insp";
const jnHeaders = { Authorization: `bearer ${JN_KEY}`, "Content-Type": "application/json" };
const sb = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` };

exports.handler = async () => {
  if (!JN_KEY) return json(500, { ok: false, error: "JOBNIMBUS_API_KEY not set" });
  if (!SB_URL || !SB_KEY) return json(500, { ok: false, error: "Supabase env missing" });
  try {
    // 1. Every JN job currently at "Sit Sold Insp".
    const jobs = await fetchStatusJobs(STATUS);
    const byJnid = {};
    for (const j of jobs) { const id = j.jnid || j.id; if (id) byJnid[id] = j; }
    const jnids = Object.keys(byJnid);

    // 2. Our inspections rows for those jnids.
    const rows = [];
    for (let i = 0; i < jnids.length; i += 80) {
      const chunk = jnids.slice(i, i + 80).map((x) => `"${x}"`).join(",");
      const got = await sbGet(`inspections?jn_job_id=in.(${encodeURIComponent(chunk)})&select=jn_job_id,client_name,result,latitude,longitude,cancelled_at`);
      rows.push(...got);
    }
    const ourByJnid = {};
    for (const r of rows) if (!r.cancelled_at) ourByJnid[r.jn_job_id] = r;

    const needs = [], doneStale = [], notInTable = [], noGeo = [], leadsOrUnsold = [];
    for (const id of jnids) {
      const ours = ourByJnid[id];
      const j = byJnid[id];
      const label = { jnid: id, name: j.name || "", address: j.address_line1 || "" };
      if (!ours) {
        // Skip JN Leads / jobs with no Sold Date — leads parked at this status,
        // never sold/signed through the app, so there's no record to expect.
        const isLead = String(j.record_type_name || "").toLowerCase() === "lead";
        const soldDate = Number(j.cf_date_5 || j["Sold Date"] || 0);
        if (isLead || !(soldDate > 0)) { leadsOrUnsold.push(label); continue; }
        notInTable.push(label); continue;
      }
      if (ours.result) { doneStale.push({ ...label, our_result: ours.result, client: (ours.client_name || "").trim() }); continue; }
      if (ours.latitude == null || ours.longitude == null) { noGeo.push({ ...label, client: (ours.client_name || "").trim() }); continue; }
      needs.push(label);
    }

    return json(200, {
      ok: true,
      jn_total: jnids.length,
      counts: { needs_inspection: needs.length, done_jn_stale: doneStale.length, not_in_table: notInTable.length, no_geo: noGeo.length, leads_or_unsold: leadsOrUnsold.length },
      done_jn_stale: doneStale,
      not_in_table: notInTable,
      no_geo: noGeo,
      leads_or_unsold: leadsOrUnsold,
    });
  } catch (e) {
    return json(500, { ok: false, error: e.message || "error" });
  }
};

async function fetchStatusJobs(statusName) {
  const out = [];
  const sinceSec = Math.floor(Date.now() / 1000) - 540 * 24 * 60 * 60; // ~18 mo
  const filter = encodeURIComponent(JSON.stringify({ must: [{ match_phrase: { status_name: statusName } }] }));
  for (let page = 0; page < 60; page++) {
    const r = await fetch(`${JN_BASE}/jobs?size=100&from=${page * 100}&sort=-date_updated&date_updated_after=${sinceSec}&filter=${filter}`, { headers: jnHeaders });
    if (!r.ok) break;
    const d = await r.json().catch(() => ({}));
    const list = d.results || d.jobs || [];
    out.push(...list);
    if (list.length < 100) break;
  }
  return out;
}
async function sbGet(path) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: sb });
  if (!r.ok) return [];
  return r.json().catch(() => []);
}
function json(status, body) {
  return { statusCode: status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" }, body: JSON.stringify(body) };
}
