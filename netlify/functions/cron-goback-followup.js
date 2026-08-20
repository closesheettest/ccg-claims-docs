// Scheduled poke for goback-followup.
//
// Netlify 403s direct HTTP calls to a scheduled function, and goback-followup
// has to stay callable — the office runs it dry (?apply=0) to see who's due
// before anything goes out. So the worker stays a normal function and this thin
// cron calls it, the same split the other crons here use.
//
// Every 15 minutes → a rep hears from us ~60–75 min after the appointment time.

const SELF = process.env.URL || process.env.DEPLOY_URL || "https://free-roof-inspections.netlify.app";

export const handler = async () => {
  const q = process.env.CRON_SECRET ? `&secret=${encodeURIComponent(process.env.CRON_SECRET)}` : "";
  const r = await fetch(`${SELF}/.netlify/functions/goback-followup?apply=1${q}`);
  const body = await r.text().catch(() => "");
  return { statusCode: 200, body: JSON.stringify({ ok: true, worker_status: r.status, worker: body.slice(0, 800) }) };
};

export const config = { schedule: "*/15 * * * *" };
