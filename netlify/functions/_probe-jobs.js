// TEMP probe — inspect JobNimbus job status/location fields for the reconcile rule.
// DELETE after diagnosis.  GET ?ids=<jnid,jnid,...>
const JN_KEY = process.env.JOBNIMBUS_API_KEY;
const JN_BASE = "https://app.jobnimbus.com/api1";
export const handler = async (event) => {
  if (!JN_KEY) return json(500, { ok: false, error: "no key" });
  const ids = String((event.queryStringParameters || {}).ids || "").split(",").map((s) => s.trim()).filter(Boolean);
  const headers = { Authorization: `bearer ${JN_KEY}`, "Content-Type": "application/json" };
  const out = [];
  for (const id of ids) {
    try {
      const r = await fetch(`${JN_BASE}/jobs/${encodeURIComponent(id)}`, { headers });
      if (!r.ok) { out.push({ id, err: r.status }); continue; }
      const j = await r.json();
      out.push({ id, name: j.name, status_name: j.status_name, location: j.location, cf_string_34: j.cf_string_34, is_lead: j.is_lead, is_closed: j.is_closed, rt_name: j.record_type_name });
    } catch (e) { out.push({ id, err: String(e && e.message) }); }
  }
  return json(200, { ok: true, jobs: out });
};
function json(statusCode, body) {
  return { statusCode, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" }, body: JSON.stringify(body) };
}
