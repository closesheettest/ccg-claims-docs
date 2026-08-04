// netlify/functions/cron-harvest-nosits.js
//
// Scheduled trigger for the no-sit sync. The worker (harvest-sync-nosits) is
// invoked over HTTP by the admin "Sync now" button — but a Netlify SCHEDULED
// function can't also be called over HTTP (Netlify returns 403 for the manual
// request, which surfaced as "sync failed" in the admin). So the schedule lives
// HERE, in a thin wrapper that calls the worker, and the worker stays a plain
// HTTP function the button can hit. Mirrors cron-harvest-leadsync → the IQ sync.
//
// Twice daily — same fixed-UTC cadence the worker used to carry (unchanged).

export const config = { schedule: "40 7,15 * * *" };

export const handler = async () => {
  const base =
    process.env.URL || process.env.DEPLOY_PRIME_URL || process.env.DEPLOY_URL || "";
  try {
    const r = await fetch(`${base}/.netlify/functions/harvest-sync-nosits?commit=1`);
    const result = await r.json().catch(() => ({}));
    return { statusCode: 200, body: JSON.stringify({ ok: r.ok, triggered: true, worker_status: r.status, result }) };
  } catch (e) {
    return { statusCode: 200, body: JSON.stringify({ ok: false, error: String((e && e.message) || e) }) };
  }
};
