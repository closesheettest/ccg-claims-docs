// Probe: find the exact JobNimbus lead-source (source_name) strings, and counts
// for the candidates we care about. Read-only.
const JN_BASE = "https://app.jobnimbus.com/api1";
const JN_KEY = process.env.JOBNIMBUS_API_KEY;

exports.handler = async () => {
  const H = { Authorization: `bearer ${JN_KEY}`, "Content-Type": "application/json" };
  // Exact-count probes for candidate source names.
  const candidates = ["Instant Quote", "Facebook", "Facebook Lead", "Facebook Leads", "AI Bot", "AI Bot Call", "AI Bot Caller", "AI", "Bot", "AI Chatbot", "Chatbot"];
  const counts = {};
  for (const s of candidates) {
    const f = encodeURIComponent(JSON.stringify({ must: [{ match_phrase: { source_name: s } }] }));
    const d = await get(`${JN_BASE}/contacts?size=1&filter=${f}`, H);
    counts[s] = d.count ?? null;
  }
  // Also tally the top source_names from a sample of recent contacts.
  const tally = {};
  for (let page = 0; page < 20; page++) {
    const d = await get(`${JN_BASE}/contacts?size=100&from=${page * 100}&sort=-date_created`, H);
    const rows = d.results || d.contacts || [];
    if (!rows.length) break;
    for (const c of rows) { const s = c.source_name || "(none)"; tally[s] = (tally[s] || 0) + 1; }
    if (rows.length < 100) break;
  }
  const top = Object.entries(tally).sort((a, b) => b[1] - a[1]).map(([name, n]) => ({ name, n }));
  return json({ ok: true, candidate_counts: counts, top_sources_in_recent_2000: top });
};
async function get(url, headers) { try { const r = await fetch(url, { headers }); return await r.json(); } catch (e) { return { error: String(e) }; } }
function json(o) { return { statusCode: 200, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }, body: JSON.stringify(o) }; }
