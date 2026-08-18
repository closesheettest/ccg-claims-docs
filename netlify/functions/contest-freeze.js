// Freeze a contest week's standing so it can never change again.
//
// Points are earned on timestamped activity, so they were always stable. The
// SCORE wasn't: it's points ÷ active reps, and the rep count was read live from
// the TMS roster on every request. Deactivating a rep, setting someone
// 'non_field' or moving a zone therefore re-scored every FINISHED week — and it
// flipped Week 1's winner from HURRICANE to SHARKS days after the week ended
// (Neal, 2026-08-18). Roster changes must affect the CURRENT week only.
//
// So each week gets snapshotted the morning after it closes, and contest-report
// serves the snapshot for that week from then on.
//
//   GET /.netlify/functions/contest-freeze?secret=<CRON_SECRET>
//     • no ?week   → freezes the most recent week that has ENDED (the cron path)
//     • ?week=N    → freezes that specific week
//     • ?reps=Zone 1:8,Zone 2:10,Zone 3:7,Zone 4:5
//                  → overrides the rep divisor, for backfilling a week that
//                    closed before this existed and whose roster is no longer
//                    readable. Stored as reps_note so it's never mistaken for live.
//     • ?dry=1     → compute and show, write nothing
//
// A week already frozen is left alone (the primary key would reject it anyway) —
// re-freezing needs ?refreeze=1 AND an explicit ?reps= or nothing would change.
//
// Env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, CRON_SECRET.
// Requires sql/contest_week_freeze.sql to have been run.

const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const sb = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` };

// Kept in step with contest-report / zone-contest-leaderboard.
const WEEKS = [
  { label: "Week 1", start: "2026-08-12", end: "2026-08-13" },
  { label: "Week 2", start: "2026-08-19", end: "2026-08-20" },
  { label: "Week 3", start: "2026-08-26", end: "2026-08-27" },
  { label: "Week 4", start: "2026-09-02", end: "2026-09-03" },
];

const SELF = process.env.URL || process.env.DEPLOY_URL || "https://free-roof-inspections.netlify.app";

export const handler = async (event) => {
  const qp = event.queryStringParameters || {};
  const provided = event.headers?.["x-cron-secret"] || qp.secret;
  if (!process.env.CRON_SECRET || provided !== process.env.CRON_SECRET) {
    return json(401, { ok: false, error: "Unauthorized" });
  }
  if (!SB_URL || !SB_KEY) return json(500, { ok: false, error: "env missing" });

  const dry = qp.dry === "1";
  const now = new Date();

  // Which week? Default = the latest one that has fully ENDED. Never the week in
  // progress: freezing a live week would stop it scoring.
  let weekNo = Number(qp.week) || null;
  if (!weekNo) {
    for (let i = 0; i < WEEKS.length; i++) {
      if (etDayEnd(WEEKS[i].end) < now) weekNo = i + 1;
    }
    if (!weekNo) return json(200, { ok: true, skipped: "no contest week has ended yet" });
  }
  const w = WEEKS[weekNo - 1];
  if (!w) return json(400, { ok: false, error: `no week ${weekNo}` });
  if (etDayEnd(w.end) >= now && !dry) {
    return json(200, { ok: true, skipped: `${w.label} hasn't ended yet — a live week must stay live` });
  }

  const already = await sbGet(`contest_week_results?week_no=eq.${weekNo}&select=week_no,frozen_at,reps_note&limit=1`);
  if (already === null) {
    return json(500, { ok: false, error: "contest_week_results is missing — run sql/contest_week_freeze.sql" });
  }
  if (already[0] && qp.refreeze !== "1") {
    return json(200, { ok: true, already_frozen: true, week: w.label, frozen_at: already[0].frozen_at, reps_note: already[0].reps_note || null });
  }

  // Recompute from the audit report (?fresh=1 so it doesn't hand back a snapshot).
  const url = `${SELF}/.netlify/functions/contest-report?week=${weekNo}&fresh=1` +
    (qp.reps ? `&reps=${encodeURIComponent(qp.reps)}` : "");
  const res = await fetch(url);
  const payload = await res.json().catch(() => null);
  if (!payload || !payload.ok) return json(502, { ok: false, error: "could not compute the week", detail: payload?.error || res.status });

  const standing = (payload.teams || []).map((t) => ({ team: t.team, zone: t.zone, avg: t.avg, points: t.points, activeReps: t.activeReps }));
  const winner = standing[0] || null;

  if (dry) return json(200, { ok: true, dry_run: true, week: w.label, week_range: payload.window?.range, winner, standing });

  const row = {
    week_no: weekNo,
    label: w.label,
    week_range: payload.window?.range || null,
    payload,
    reps_note: qp.reps ? `rep divisor supplied by operator: ${qp.reps}` : null,
  };
  const put = await fetch(`${SB_URL}/rest/v1/contest_week_results${qp.refreeze === "1" ? "?week_no=eq." + weekNo : ""}`, {
    method: qp.refreeze === "1" ? "PATCH" : "POST",
    headers: { ...sb, "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify(qp.refreeze === "1" ? { ...row, frozen_at: new Date().toISOString() } : row),
  });
  if (!put.ok) return json(500, { ok: false, error: `write failed: ${put.status} ${await put.text().catch(() => "")}` });

  return json(200, { ok: true, frozen: w.label, week_range: row.week_range, winner, standing, reps_note: row.reps_note });
};

async function sbGet(path) {
  try {
    const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: sb });
    if (!r.ok) return null;
    return await r.json().catch(() => null);
  } catch { return null; }
}

// ET wall-clock → UTC instant (EDT/EST aware), same helpers the report uses.
function etOffset(y, m, d, h) {
  const guess = Date.UTC(y, m - 1, d, h + 4, 0, 0);
  const p = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", hour12: false }).formatToParts(new Date(guess));
  const hh = Number((p.find((x) => x.type === "hour") || {}).value);
  return hh === h ? 4 : 5;
}
function etDayEnd(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, 23 + etOffset(y, m, d, 23), 59, 59));
}
function json(status, body) {
  return { statusCode: status, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

// Friday 5:00 UTC = 1 AM ET — the week's Wed+Thu are over, nothing more can score.
export const config = { schedule: "0 5 * * 5" };
