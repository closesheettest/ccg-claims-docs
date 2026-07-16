// Probe: inspect the `related` array on Instant-Quote contacts to see whether a
// contact self-reports its linked jobs (so we can count "no jobs" per-contact
// without scanning every job past the 10k cap). Read-only.
const JN_BASE = "https://app.jobnimbus.com/api1";
const JN_KEY = process.env.JOBNIMBUS_API_KEY;

exports.handler = async () => {
  const H = { Authorization: `bearer ${JN_KEY}`, "Content-Type": "application/json" };
  const iqFilter = encodeURIComponent(JSON.stringify({ must: [{ match_phrase: { source_name: "Instant Quote" } }] }));
  const c = await get(`${JN_BASE}/contacts?size=20&filter=${iqFilter}`, H);
  const rows = c.results || c.contacts || [];
  const sample = rows.slice(0, 12).map((r) => {
    const rel = Array.isArray(r.related) ? r.related : [];
    const relTypes = {};
    for (const x of rel) { const t = x && x.type || "(none)"; relTypes[t] = (relTypes[t] || 0) + 1; }
    return {
      name: r.display_name,
      related_types: relTypes,
      related_len: rel.length,
      task_count: r.task_count,
      approved_estimate_total: r.approved_estimate_total,
    };
  });
  return json({ ok: true, iq_count: c.count, sample });
};
async function get(url, headers) {
  try { const r = await fetch(url, { headers }); return await r.json(); } catch (e) { return { error: String(e) }; }
}
function json(o) { return { statusCode: 200, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }, body: JSON.stringify(o) }; }
