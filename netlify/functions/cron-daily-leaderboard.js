// netlify/functions/cron-daily-leaderboard.js
//
// Morning standings snapshot. Once a day (9 AM Eastern) texts the whole
// field a short "here's where the week stands" message, e.g.:
//
//   📊 Starting Friday: 💥 SQUAD is in the lead with 8.
//   🌀 HURRICANE is 3 away from taking the lead.
//   👉 Press here for full details: https://us-shingle-rep-dashboard.netlify.app
//
// Unlike leaderboard-notify (which fires the instant a NEW team takes
// 1st), this is a scheduled daily heartbeat regardless of whether the
// lead changed — a fresh nudge to start the day.
//
// Audience: the whole field (every active rep + manager), fanned out by
// leaderboard-blast-background, PLUS any extra copy-recipients configured
// for this auto-SMS in the Supabase auto_sms table (key "daily_leaderboard")
// — that's how an admin gets their own copy and can later opt out.
//
// The auto_sms row also carries the on/off switch: if enabled=false this
// cron sends nothing. A missing row / read error fails OPEN (still sends)
// so a DB hiccup never silently kills the morning text.
//
// Trigger:
//   • Netlify scheduled function — 13:00 UTC = 9 AM EDT (mirrored in
//     netlify.toml). NOTE: fixed-UTC cron, so in EST (winter) this lands
//     at 8 AM. Good enough for a morning heartbeat.
//   • Manual GET /.netlify/functions/cron-daily-leaderboard for testing;
//     add ?dry=1 to compose + report without sending.
//
// Required env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, URL.

const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const AUTO_SMS_KEY = "daily_leaderboard";

// Per-team flair (mirrors leaderboard-notify). Generic trophy otherwise.
const LEAD_EMOJI = { SHARKS: "🦈", SQUAD: "💥", HURRICANE: "🌀", SitSold: "🔥" };
const DASHBOARD_URL = "https://us-shingle-rep-dashboard.netlify.app";

export const handler = async (event) => {
  const dry = !!(event?.queryStringParameters?.dry);
  const base =
    process.env.URL || process.env.DEPLOY_URL || process.env.PUBLIC_SITE_URL || "";

  // Monday morning the board is freshly reset to 0 — a "current standings"
  // text would just say "nobody's signed yet." So scheduled Monday runs are
  // skipped; the separate weekly-recap cron owns Monday 9 AM with last week's
  // final results. (Manual GET still runs any day, for testing.)
  const etDay = new Date().toLocaleDateString("en-US", { weekday: "short", timeZone: "America/New_York" });
  if (etDay === "Mon" && event?.httpMethod !== "GET") {
    return json(200, { ok: true, fired: false, reason: "Monday — handled by weekly recap" });
  }

  // 1. On/off + extra copy-recipients from the auto_sms registry.
  const cfg = await loadAutoSms(AUTO_SMS_KEY);
  if (!cfg.enabled) {
    return json(200, { ok: true, fired: false, reason: "disabled in auto_sms" });
  }

  // 2. Current standings from the public leaderboard fn.
  let lb;
  try {
    const r = await fetch(`${base}/.netlify/functions/zone-leaderboard`);
    lb = await r.json();
    if (!r.ok || !lb?.ok) {
      return json(502, { ok: false, error: "zone-leaderboard unavailable", detail: lb });
    }
  } catch (e) {
    return json(502, { ok: false, error: `Could not reach zone-leaderboard: ${e.message}` });
  }

  const zones = lb.zones || [];
  const dayName = new Date().toLocaleDateString("en-US", {
    weekday: "long",
    timeZone: "America/New_York",
  });
  const message = buildMessage(zones, dayName);

  if (dry) {
    return json(200, { ok: true, fired: false, dry: true, would_send: message, extra_recipients: cfg.recipients });
  }

  // 3. Fan out to the whole field + the configured extra recipients.
  let blastOk = false;
  let blastResult = null;
  try {
    const r = await fetch(`${base}/.netlify/functions/leaderboard-blast-background`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, extraRecipients: cfg.recipients }),
    });
    blastOk = r.ok || r.status === 202;
    blastResult = await r.json().catch(() => null);
  } catch (e) {
    console.warn("Daily blast trigger threw:", e.message || e);
  }

  await stampAutoSms(AUTO_SMS_KEY, blastOk ? "sent" : "blast trigger failed");

  return json(200, { ok: true, fired: true, message, blast_triggered: blastOk, blast: blastResult });
};

// Carrier-safe: one line, no emoji, plain words, a single bare-domain link, and
// under ~160 chars. Emoji-dense multi-line texts with "Press here 👉" + a full
// https URL get content-filtered by carriers for some recipient segments (the
// message silently never arrives). Keep it lean so it delivers everywhere.
function buildMessage(zones, dayName) {
  const top = zones[0];
  const runner = zones[1];
  // No link — reps know where the dashboard is, and a URL is the single biggest
  // carrier spam trigger. Plain standings text delivers everywhere.
  if (!top || top.count === 0) {
    return `US Shingle standings (${dayName}): no signings yet this week — first team to sign takes the lead.`;
  }
  let msg = `US Shingle standings (${dayName}): ${top.team} leads with ${top.count}`;
  if (runner && runner.count > 0) {
    const gap = top.count - runner.count;
    msg += gap === 0 ? `, tied by ${runner.team} at ${runner.count}` : `, ${runner.team} ${gap} behind`;
  } else if (runner) {
    msg += `, ${runner.team} ${top.count} behind`;
  }
  return `${msg}.`;
}

// ── auto_sms registry helpers (fail-open) ───────────────────────────
async function loadAutoSms(key) {
  if (!SB_URL || !SB_KEY) return { enabled: true, recipients: [] };
  try {
    const r = await fetch(
      `${SB_URL}/rest/v1/auto_sms?key=eq.${encodeURIComponent(key)}&select=enabled,recipients&limit=1`,
      { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` } },
    );
    if (!r.ok) return { enabled: true, recipients: [] };
    const rows = await r.json().catch(() => []);
    const row = rows[0];
    if (!row) return { enabled: true, recipients: [] };
    const recipients = Array.isArray(row.recipients) ? row.recipients : [];
    return { enabled: row.enabled !== false, recipients };
  } catch {
    return { enabled: true, recipients: [] };
  }
}

async function stampAutoSms(key, status) {
  if (!SB_URL || !SB_KEY) return;
  try {
    await fetch(`${SB_URL}/rest/v1/auto_sms?key=eq.${encodeURIComponent(key)}`, {
      method: "PATCH",
      headers: {
        apikey: SB_KEY,
        Authorization: `Bearer ${SB_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify({ last_sent_at: new Date().toISOString(), last_status: status }),
    });
  } catch {
    /* best-effort */
  }
}

function json(status, body) {
  return {
    statusCode: status,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

// Netlify scheduled function — 9 AM EDT (13:00 UTC). Mirrored in netlify.toml.
export const config = { schedule: "0 13 * * *" };
