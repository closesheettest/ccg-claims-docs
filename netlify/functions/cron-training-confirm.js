// netlify/functions/cron-training-confirm.js
//
// Next-morning ride-along confirmation texts + daily reminders. Each morning at
// ~9:30 AM ET it:
//   1. FIRST TEXT  — every rep William logged riding with him YESTERDAY who
//      hasn't been texted yet gets a link to confirm "did you train with
//      William yesterday — from what time to what time?" (/?ridealong=<token>).
//   2. REMINDERS   — every rep already texted on an EARLIER day who still
//      hasn't responded (confirmed is null) gets a daily nudge, until they
//      answer or the ride is older than 14 days. (Clara was texted and never
//      replied — this keeps after them once a day.)
//
// Scheduled "30 13,14 * * *" (covers 9:30 ET in both EDT and EST); the handler
// guards to ET hour 9 so it fires exactly once year-round. A manual GET runs
// regardless (for testing). Stamps text_sent_at so re-runs are idempotent; the
// once-a-day guard means reminders go out at most once per day.
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
    `ride_alongs?ride_date=eq.${yesterday}&text_sent_at=is.null&select=id,rep_id,rep_name,rep_phone,confirm_token&limit=500`,
  );
  const emailByRep = await fetchEmails(rows.map((r) => r.rep_id));

  let sent = 0, skipped = 0;
  const failures = [];
  for (const r of rows) {
    const email = emailByRep[r.rep_id] || "";
    if (!r.rep_phone && !email) { skipped++; continue; }
    const first = (r.rep_name || "").trim().split(/\s+/)[0] || "";
    const link = `${base}/?ridealong=${r.confirm_token}`;
    const message =
      `Hey${first ? " " + first : ""}! Quick one — did you go out with William for training yesterday? ` +
      `Tap to confirm your hours: ${link}`;
    const emailBody = `Hey${first ? " " + first : ""}! Quick one — did you go out with William for training yesterday? Tap below to confirm your hours.`;
    const ok = await sendBoth(base, r.rep_phone, email, r.rep_name, "Confirm your training hours with William", message, emailBody, link);
    if (ok) {
      await fetch(`${SB_URL}/rest/v1/ride_alongs?id=eq.${r.id}`, {
        method: "PATCH", headers: { ...sb, Prefer: "return=minimal" }, body: JSON.stringify({ text_sent_at: new Date().toISOString() }),
      });
      sent++;
    } else {
      failures.push(r.rep_name || r.id);
    }
  }

  // ── 2. REMINDERS — earlier days, texted but still no response ──────────
  // Anyone texted on a day BEFORE yesterday (yesterday is handled above as the
  // first send) who hasn't answered (confirmed is null) gets a daily nudge,
  // back to 14 days. Skip the "no one rode" sentinel + refusals (no rep reply
  // expected) + rows with no phone.
  const cutoff = addDaysET(yesterday, -13); // 14-day window ending yesterday
  const pending = await sbGet(
    `ride_alongs?text_sent_at=not.is.null&confirmed=is.null&ride_date=gte.${cutoff}&ride_date=lt.${yesterday}&rep_id=neq.__none__&select=id,rep_id,rep_name,rep_phone,confirm_token,ride_date,refused_to_ride&limit=500`,
  );
  const emailByRepRem = await fetchEmails(pending.map((r) => r.rep_id));
  let reminded = 0;
  const remindFailures = [];
  for (const r of pending) {
    if (r.refused_to_ride === true) continue; // trainer-reported, no rep text
    const email = emailByRepRem[r.rep_id] || "";
    if (!r.rep_phone && !email) continue;
    const first = (r.rep_name || "").trim().split(/\s+/)[0] || "";
    const link = `${base}/?ridealong=${r.confirm_token}`;
    const message =
      `Reminder${first ? " " + first : ""} — we still need your training hours from ${fmtDate(r.ride_date)} with William. ` +
      `It only takes a sec: ${link}`;
    const emailBody = `Reminder${first ? " " + first : ""} — we still need your training hours from ${fmtDate(r.ride_date)} with William. Tap below to confirm.`;
    const ok = await sendBoth(base, r.rep_phone, email, r.rep_name, "Reminder: confirm your training hours", message, emailBody, link);
    if (ok) reminded++;
    else remindFailures.push(r.rep_name || r.id);
  }

  return json(200, { ok: true, yesterday, total: rows.length, sent, skipped_no_phone: skipped, failures, reminded, remind_failures: remindFailures });
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

// Look up rep emails by their JobNimbus id (ride_alongs.rep_id = sales_reps.jobnimbus_id).
async function fetchEmails(ids) {
  const uniq = [...new Set((ids || []).filter(Boolean))];
  if (!uniq.length) return {};
  const chunk = uniq.map((x) => `"${x}"`).join(",");
  const rows = await sbGet(`sales_reps?jobnimbus_id=in.(${encodeURIComponent(chunk)})&select=jobnimbus_id,email`);
  const m = {};
  for (const r of rows) if (r.email && String(r.email).includes("@")) m[r.jobnimbus_id] = r.email;
  return m;
}

// Send by BOTH channels — SMS and email — so a DND / opted-out phone still gets
// it. Returns true if EITHER channel succeeded.
async function sendBoth(base, phone, email, name, subject, smsMessage, emailBody, link) {
  let any = false;
  if (phone && await sendSms(base, phone, name, smsMessage)) any = true;
  if (email && await sendEmail(base, email, subject, emailBody, link)) any = true;
  return any;
}

async function sendEmail(base, to, subject, bodyText, link) {
  try {
    const html =
      `<div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;color:#111827">` +
      `<p style="font-size:15px;line-height:1.6">${escapeHtml(bodyText)}</p>` +
      `<p style="margin:18px 0"><a href="${link}" style="display:inline-block;background:#16a34a;color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:700">Confirm my training hours</a></p>` +
      `<p style="font-size:12px;color:#6b7280">Or open this link: <a href="${link}">${escapeHtml(link)}</a></p>` +
      `</div>`;
    const r = await fetch(`${base}/.netlify/functions/send-email`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ to, subject, html }),
    });
    return r.ok;
  } catch (e) {
    console.warn("send-email failed:", e.message || e);
    return false;
  }
}

function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
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

// "YYYY-MM-DD" + n days (n may be negative) → "YYYY-MM-DD".
function addDaysET(ymd, n) {
  const d = new Date(ymd + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// "YYYY-MM-DD" → "Mon, Jun 9" for a friendly reminder.
function fmtDate(ymd) {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric" }).format(new Date(ymd + "T12:00:00Z"));
  } catch { return ymd; }
}

function json(status, body) {
  return { statusCode: status, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

export const config = { schedule: "30 13,14 * * *" };
