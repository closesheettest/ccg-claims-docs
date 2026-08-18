// netlify/functions/cron-shift-nudge.js
//
// Scheduled trigger for the check-in / recap nudges. The worker
// (payroll-nudge) has to stay HTTP-callable so the office can run
// `?dry=1` and see who WOULD be texted — and Netlify returns 403 for a manual
// call to a SCHEDULED function. So the schedule lives here, in a thin wrapper,
// and the worker stays a plain HTTP function. Mirrors cron-harvest-nosits.
//
// Every 15 minutes; the worker itself decides who is actually due.

export const config = { schedule: "*/15 * * * *" };

export const handler = async () => {
  const base = process.env.URL || process.env.DEPLOY_PRIME_URL || process.env.DEPLOY_URL || "";
  try {
    const r = await fetch(`${base}/.netlify/functions/payroll-nudge`);
    const result = await r.json().catch(() => ({}));
    return { statusCode: 200, body: JSON.stringify({ ok: r.ok, triggered: true, worker_status: r.status, result }) };
  } catch (e) {
    return { statusCode: 200, body: JSON.stringify({ ok: false, error: String((e && e.message) || e) }) };
  }
};
