// Quick probe: true totals for the Instant-Quote-contacts audit, using the JN
// API's own `count` field (avoids the 10k pagination cap). Read-only.
//   GET → { iq_contacts_count, jobs_count, contacts_resp_keys, jobs_resp_keys }
const JN_BASE = "https://app.jobnimbus.com/api1";
const JN_KEY = process.env.JOBNIMBUS_API_KEY;

exports.handler = async () => {
  const H = { Authorization: `bearer ${JN_KEY}`, "Content-Type": "application/json" };
  const iqFilter = encodeURIComponent(JSON.stringify({ must: [{ match_phrase: { source_name: "Instant Quote" } }] }));
  const c = await get(`${JN_BASE}/contacts?size=1&filter=${iqFilter}`, H);
  const j = await get(`${JN_BASE}/jobs?size=1`, H);
  return json({
    ok: true,
    iq_contacts_count: c.count ?? c.total ?? null,
    jobs_count: j.count ?? j.total ?? null,
    contacts_resp_keys: Object.keys(c || {}),
    jobs_resp_keys: Object.keys(j || {}),
    sample_contact_keys: Object.keys((c.results || c.contacts || [])[0] || {}),
  });
};
async function get(url, headers) {
  try { const r = await fetch(url, { headers }); return await r.json(); } catch (e) { return { error: String(e) }; }
}
function json(o) { return { statusCode: 200, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }, body: JSON.stringify(o) }; }
