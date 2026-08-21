// Thin scheduled wrapper for payroll-monday-checkin. The worker stays plain
// HTTP so the office can run ?dry=1 against it — Netlify 403s manual calls to
// a scheduled function. Same split as cron-shift-nudge / payroll-nudge.
//
// Runs hourly across the window that covers 7 AM ET in both EDT and EST; the
// worker's own gate is what makes it fire exactly once, on Monday at 7.
const BASE = (process.env.URL || "https://free-roof-inspections.netlify.app").replace(/\/$/, "");

export const handler = async () => {
  try {
    const r = await fetch(`${BASE}/.netlify/functions/payroll-monday-checkin`);
    const body = await r.text();
    return { statusCode: 200, body };
  } catch (e) {
    return { statusCode: 200, body: JSON.stringify({ ok: false, error: e.message }) };
  }
};

export const config = { schedule: "0 11,12 * * 1" };
