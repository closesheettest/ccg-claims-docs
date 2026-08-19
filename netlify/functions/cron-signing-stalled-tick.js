// Scheduled poke for signing-stall-check.
//
// Netlify 403s direct HTTP calls to a scheduled function, and the worker must stay
// callable (dry runs, verification, one-off re-checks) — so the worker is a normal
// function and this tiny cron calls it. Same split the other crons here use.
//
// Every 15 minutes: a signing that has been phone-verified that long and still
// isn't signed has stalled, and the rep may still be at the door.

const SELF = process.env.URL || process.env.DEPLOY_URL || "https://free-roof-inspections.netlify.app";

export const handler = async () => {
  const r = await fetch(`${SELF}/.netlify/functions/signing-stall-check`);
  const body = await r.text().catch(() => "");
  return { statusCode: 200, body: JSON.stringify({ ok: true, worker_status: r.status, worker: body.slice(0, 600) }) };
};

export const config = { schedule: "*/15 * * * *" };
