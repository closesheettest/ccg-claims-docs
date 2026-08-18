// Scheduled poke for contest-freeze.
//
// Netlify 403s direct HTTP calls to a scheduled function, and contest-freeze has
// to stay callable — Week 1 needed a backfill, and a correction needs a refreeze.
// So the worker stays a normal function and this tiny cron calls it, the same
// split the other crons in this project use.
//
// Fridays 1 AM ET: the week's Wed + Thu are over, nothing more can score.

const SELF = process.env.URL || process.env.DEPLOY_URL || "https://free-roof-inspections.netlify.app";

export const handler = async () => {
  // CRON_SECRET is optional on this project; pass it when it exists.
  const q = process.env.CRON_SECRET ? `?secret=${encodeURIComponent(process.env.CRON_SECRET)}` : "";
  const r = await fetch(`${SELF}/.netlify/functions/contest-freeze${q}`);
  const body = await r.text().catch(() => "");
  return { statusCode: 200, body: JSON.stringify({ ok: true, worker_status: r.status, worker: body.slice(0, 800) }) };
};

export const config = { schedule: "0 5 * * 5" };
