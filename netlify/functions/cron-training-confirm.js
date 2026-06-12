// netlify/functions/cron-training-confirm.js
//
// Next-morning ride-along confirmation texts. Each morning at ~9:30 AM ET it
// finds every rep William logged as riding with him YESTERDAY who hasn't been
// texted yet, and sends them a link to confirm "did you train with William
// yesterday — from what time to what time?" (/?ridealong=<confirm_token>).
//
// Scheduled "30 13,14 * * *" (covers 9:30 ET in both EDT and EST); the handler
// guards to ET hour 9 so it fires exactly once year-round. A manual GET runs
// regardless (for testing). Stamps text_sent_at so re-runs are idempotent.
//
// Env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, URL (Netlify base).

const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const sb = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" };

export const handler = async (event) => {
  if (!SB_URL || !SB_KEY) return json(500, { ok: false, error: "Missing Supabase env" });

  const isManual = event && event.httpMethod === "GET";
  const etHour = Number(
    new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hour12: false }).format(new Date()),
  );
  // Only the 9 AM ET firing counts (the toml runs it at 13:00 & 14:00 UTC to
  // catch DST). Manual GETs bypass the guard so we can test any time.
  if (!isManual && etHour !== 9) {
    return json(200, { ok: true, skipped: true, reason: `ET hour is ${etHour}, not 9` });
  }

  const base = process.env.URL || process.env.DEPLOY_URL || process.env.PUBLIC_SITE_URL || "";
  const yesterday = yesterdayET();

  const rows = await sbGet(
    `ride_alongs?ride_date=eq.${yesterday}&text_sent_at=is.null&select=id,rep_name,rep_phone,confirm_token&limit=500`,
  );

  let sent = 0, skipped = 0;
  const failures = [];
  for (const r of rows) {
    if (!r.rep_phone) { skipped++; continue; }
    const first = (r.rep_name || "").trim().split(/\s+/)[0] || "";
    const link = `${base}/?ridealong=${r.confirm_token}`;
    const message =
      `Hey${first ? " " + first : ""}! Quick one — did you go out with William for training yesterday? ` +
      `Tap to confirm your hours: ${link}`;
    const ok = await sendSms(base, r.rep_phone, r.rep_name, message);
    if (ok) {
      await fetch(`${SB_URL}/rest/v1/ride_alongs?id=eq.${r.id}`, {
        method: "PATCH", headers: { ...sb, Prefer: "return=minimal" }, body: JSON.stringify({ text_sent_at: new Date().toISOString() }),
      });
      sent++;
    } else {
      failures.push(r.rep_name || r.id);
    }
  }

  return json(200, { ok: true, yesterday, total: rows.length, sent, skipped_no_phone: skipped, failures });
};

async function sendSms(base, to, name, message) {
  try {
    const r = await fetch(`${base}/.netlify/functions/ghl-sms`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ to, name, message }),
    });
    return r.ok;
  } catch (e) {
    console.warn("ghl-sms send failed:", e.message || e);
    return false;
  }
}

async function sbGet(path) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: sb });
  if (!r.ok) return [];
  return await r.json().catch(() => []);
}

function yesterdayET() {
  const todayStr = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const d = new Date(todayStr + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

function json(status, body) {
  return { statusCode: status, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

export const config = { schedule: "30 13,14 * * *" };
