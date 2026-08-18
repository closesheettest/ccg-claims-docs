// netlify/functions/cron-payroll-signoff.js
//
// Scheduled trigger for the DAILY manager sign-off reminder. Same split as
// cron-shift-nudge: the worker (payroll-signoff-run) stays HTTP-callable so the
// office can run `?dry=1`, and the schedule lives here in a thin wrapper,
// because Netlify 403s manual calls to a scheduled function.
//
// 8 AM + 11 AM ET, every day. The worker skips departments with no activity.

export const config = { schedule: "0 12,15 * * *" };

export const handler = async () => {
  const base = process.env.URL || process.env.DEPLOY_PRIME_URL || process.env.DEPLOY_URL || "";
  try {
    const r = await fetch(`${base}/.netlify/functions/payroll-signoff-run`);
    const result = await r.json().catch(() => ({}));
    return { statusCode: 200, body: JSON.stringify({ ok: r.ok, triggered: true, worker_status: r.status, result }) };
  } catch (e) {
    return { statusCode: 200, body: JSON.stringify({ ok: false, error: String((e && e.message) || e) }) };
  }
};
