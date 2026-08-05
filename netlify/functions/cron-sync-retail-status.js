// netlify/functions/cron-sync-retail-status.js
//
// Thin SCHEDULED wrapper (netlify.toml: "15 * * * *"). Netlify 403s HTTP calls to a
// scheduled function, so the actual logic lives in the callable WORKER
// (sync-retail-status), which the office/report can also invoke on demand.
// Mirrors cron-harvest-nosits → harvest-sync-nosits.
const BASE = (process.env.URL || process.env.PUBLIC_SITE_URL || "https://free-roof-inspections.netlify.app").replace(/\/$/, "");
exports.handler = async () => {
  try {
    const r = await fetch(`${BASE}/.netlify/functions/sync-retail-status`);
    const body = await r.text().catch(() => "");
    return { statusCode: r.status, body };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: e.message || "error" }) };
  }
};
