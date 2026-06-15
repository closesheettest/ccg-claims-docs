// netlify/functions/cron-weekly-recap.js
//
// Monday-morning hype blast: recaps LAST week's FINAL standings for BOTH
// boards (signed inspections + sold), to fire the field up for the new week.
// Monday is the perfect slot — the boards have just reset to zero, so the
// daily "current standings" text has nothing to say (it skips Mondays); this
// recap takes that slot with the results that just finished.
//
//   🏆 LAST WEEK'S RESULTS — new week, clean slate!
//   🔨 Roof Inspections: 🦈 SHARKS took it with 16 — beating HURRICANE (15)!
//   🥇 SHARKS 16 · 🥈 HURRICANE 15 · 🥉 SQUAD 6 · SitSold 0
//   💰 Sales: 🌀 HURRICANE took it with 9 — beating SitSold (5)!
//   …
//   Reset to zero. Who's taking it this week? 👉 <dashboard>
//
// Audience: whole field (every active rep + manager) via
// leaderboard-blast-background, plus extra copy-recipients from the auto_sms
// row (key "weekly_recap"); that row also holds the on/off switch.
//
// Trigger:
//   • Scheduled — 13:00 UTC MONDAY = 9 AM EDT (mirrored in netlify.toml).
//   • Manual GET /.netlify/functions/cron-weekly-recap (any day, for testing);
//     add ?dry=1 to compose + report without sending.
//
// Required env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, URL.

const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const AUTO_SMS_KEY = "weekly_recap";
const LEAD_EMOJI = { SHARKS: "🦈", SQUAD: "💥", HURRICANE: "🌀", SitSold: "🔥" };
const MEDAL = ["🥇", "🥈", "🥉"];
const DASHBOARD_URL = "https://us-shingle-rep-dashboard.netlify.app";

export const handler = async (event) => {
  const isManual = event?.httpMethod === "GET";
  const dry = !!(event?.queryStringParameters?.dry);
  const base = process.env.URL || process.env.DEPLOY_URL || process.env.PUBLIC_SITE_URL || "";

  // Scheduled runs only fire on Monday ET. Manual GET runs any day (testing).
  const etDay = new Date().toLocaleDateString("en-US", { weekday: "short", timeZone: "America/New_York" });
  if (!isManual && etDay !== "Mon") {
    return json(200, { ok: true, fired: false, reason: `Not Monday (ET ${etDay}) — recap only runs Monday` });
  }

  const cfg = await loadAutoSms(AUTO_SMS_KEY);
  if (!cfg.enabled) return json(200, { ok: true, fired: false, reason: "disabled in auto_sms" });

  // Last week's FINAL standings from both public feeds.
  const insp = await fetchZones(`${base}/.netlify/functions/zone-leaderboard?period=lastweek`);
  const sales = await fetchZones(`${base}/.netlify/functions/zone-sales-leaderboard?period=lastweek`);
  if (!insp && !sales) return json(502, { ok: false, error: "Both leaderboard feeds unavailable" });

  const message = buildMessage(insp, sales);

  if (dry) return json(200, { ok: true, fired: false, dry: true, would_send: message, extra_recipients: cfg.recipients });

  let blastOk = false, blastResult = null;
  try {
    const r = await fetch(`${base}/.netlify/functions/leaderboard-blast-background`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, extraRecipients: cfg.recipients }),
    });
    blastOk = r.ok || r.status === 202;
    blastResult = await r.json().catch(() => null);
  } catch (e) {
    console.warn("Weekly recap blast threw:", e.message || e);
  }
  await stampAutoSms(AUTO_SMS_KEY, blastOk ? "sent" : "blast trigger failed");
  return json(200, { ok: true, fired: true, message, blast_triggered: blastOk, blast: blastResult });
};

// One board → a two-line block (headline + ranking).
function boardBlock(label, zones) {
  const sorted = (zones || []).slice().sort((a, b) => (b.count || 0) - (a.count || 0));
  const first = sorted[0];
  const topCount = first ? (first.count || 0) : 0;
  const tied = topCount > 0 ? sorted.filter((z) => (z.count || 0) === topCount) : [];

  let head;
  if (topCount === 0) {
    head = `${label}: quiet week — wide open. First team to put one up takes the lead!`;
  } else if (tied.length >= 2) {
    head = `${label}: 🤝 ${tied.map((z) => z.team).join(" & ")} TIED at ${topCount}!`;
  } else {
    const flair = LEAD_EMOJI[first.team] || "🏆";
    const second = sorted[1];
    head = `${label}: ${flair} ${first.team} took 1st with ${topCount}` +
      (second && (second.count || 0) > 0 ? ` — beating ${second.team} (${second.count})!` : `!`);
  }
  const ranking = sorted.map((z, i) => `${MEDAL[i] || (i + 1) + "."} ${z.team} ${z.count || 0}`).join(" · ");
  return `${head}\n${ranking}`;
}

function buildMessage(insp, sales) {
  const parts = ["🏆 LAST WEEK'S RESULTS — new week, clean slate!"];
  if (insp) parts.push("\n🔨 " + boardBlock("Roof Inspections", insp));
  if (sales) parts.push("\n💰 " + boardBlock("Sales", sales));
  parts.push("\nEverybody's back to zero. Who's taking it this week? 👉 " + DASHBOARD_URL);
  return parts.join("\n");
}

async function fetchZones(url) {
  try {
    const r = await fetch(url);
    const d = await r.json().catch(() => null);
    if (!r.ok || !d?.ok) return null;
    return d.zones || [];
  } catch { return null; }
}

async function loadAutoSms(key) {
  if (!SB_URL || !SB_KEY) return { enabled: true, recipients: [] };
  try {
    const r = await fetch(`${SB_URL}/rest/v1/auto_sms?key=eq.${encodeURIComponent(key)}&select=enabled,recipients&limit=1`,
      { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` } });
    if (!r.ok) return { enabled: true, recipients: [] };
    const row = (await r.json().catch(() => []))[0];
    if (!row) return { enabled: true, recipients: [] };
    return { enabled: row.enabled !== false, recipients: Array.isArray(row.recipients) ? row.recipients : [] };
  } catch { return { enabled: true, recipients: [] }; }
}

async function stampAutoSms(key, status) {
  if (!SB_URL || !SB_KEY) return;
  try {
    await fetch(`${SB_URL}/rest/v1/auto_sms?key=eq.${encodeURIComponent(key)}`, {
      method: "PATCH",
      headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({ last_sent_at: new Date().toISOString(), last_status: status }),
    });
  } catch { /* best-effort */ }
}

function json(status, body) {
  return { statusCode: status, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

// Scheduled — 13:00 UTC Monday = 9 AM EDT. Mirrored in netlify.toml.
export const config = { schedule: "0 13 * * 1" };
