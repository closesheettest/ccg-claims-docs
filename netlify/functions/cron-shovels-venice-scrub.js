// netlify/functions/cron-shovels-venice-scrub.js
//
// Thin SCHEDULED wrapper for the Venice roof-age scrub. Netlify 403s HTTP calls to
// a scheduled function, so the actual scrub lives in the callable worker
// `shovels-venice-scrub` (which can be run by hand); this wrapper just keeps the
// daily schedule and fires the worker. Mirrors cron-harvest-nosits → its worker.
//
// Schedule: daily 10:00 AM ET. Manual runs hit the worker directly:
//   GET /.netlify/functions/shovels-venice-scrub?dry=1   (preview counts)
//   GET /.netlify/functions/shovels-venice-scrub         (full daily batch)

export const config = { schedule: "0 14 * * *" }; // 10:00 AM ET daily

export const handler = async () => {
  const base = process.env.URL || process.env.DEPLOY_URL || "https://free-roof-inspections.netlify.app";
  try {
    const r = await fetch(`${base}/.netlify/functions/shovels-venice-scrub`);
    const body = await r.text();
    console.log(`cron-shovels-venice-scrub → worker ${r.status}: ${body.slice(0, 300)}`);
    return { statusCode: r.status, body };
  } catch (e) {
    console.warn("cron-shovels-venice-scrub: worker fetch failed:", e.message);
    return { statusCode: 502, body: JSON.stringify({ ok: false, error: e.message }) };
  }
};
