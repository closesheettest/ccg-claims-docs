// netlify/functions/cron-goback-autoschedule.js
//
// THE SENDER for "Auto-Schedule After Inspection" (config: goback_autoschedule_config,
// edited at ?mode=gobackschedule). After an inspection completes (inspections.result_at),
// the homeowner gets the configured text sequence — each message at its own wait (days
// after the inspection) + send time (ET) — to book their come-back review. It STOPS the
// moment they book (review_appt_at set). Idempotent: every (inspection, msg#) send is
// logged with a unique key, so a message never goes out twice.
//
// SAFETY: (1) OFF unless the config's `enabled` is true. (2) Never blasts the backlog —
// only inspections completed on/after app_settings.goback_autoschedule_since. (3) Quiet
// hours — nothing sends before 8 AM or after 9 PM ET. (4) A message only fires within an
// 18-hour window of its scheduled time (a long-down cron won't send stale texts).
//
// Runs on a schedule (netlify.toml). Env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, URL.

const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const sb = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" };
const ORIGIN = (process.env.URL || "https://free-roof-inspections.netlify.app").replace(/\/$/, "");
const GRACE_MS = 18 * 60 * 60 * 1000;
const COMPANY = "U.S. Shingle & Metal";

export const handler = async () => {
  if (!SB_URL || !SB_KEY) return resp(500, { ok: false, error: "env missing" });
  try {
    const config = await getSetting("goback_autoschedule_config");
    const cfg = config ? (typeof config === "string" ? JSON.parse(config) : config) : null;
    if (!cfg || !cfg.enabled || !Array.isArray(cfg.messages) || !cfg.messages.length) {
      return resp(200, { ok: true, skipped: "disabled or no messages" });
    }
    const msgs = cfg.messages.filter((m) => m && m.body && typeof m.delay_days === "number" && m.send_time);

    // Quiet hours — bail entirely outside 8 AM–9 PM ET.
    const now = new Date();
    const etHour = Number(tzParts(now).hour);
    if (etHour < 8 || etHour >= 21) return resp(200, { ok: true, skipped: `quiet hours (ET ${etHour})` });

    // Never touch the backlog: only inspections completed on/after the cutoff.
    const since = (await getSetting("goback_autoschedule_since")) || "2000-01-01T00:00:00Z";
    // Also cap the look-back to the longest message delay + 2 days (older = every message
    // is long past its window anyway).
    const maxDelay = Math.max(0, ...msgs.map((m) => m.delay_days || 0));
    const lookback = new Date(now.getTime() - (maxDelay + 2) * 24 * 60 * 60 * 1000).toISOString();
    const floor = since > lookback ? since : lookback;

    // Candidates: completed inspection, not booked, not cancelled, has a cell + a rep.
    const rows = await sbGetAll(
      `inspections?result_at=gte.${encodeURIComponent(floor)}&review_appt_at=is.null&cancelled_at=is.null` +
      `&mobile=not.is.null&result=not.is.null&or=(retail_outcome.is.null,retail_outcome.neq.sold)` +
      `&select=id,client_name,jn_status,mobile,email,address,city,state,zip,sales_rep_name,result_at,goback_token`
    );
    if (!rows.length) return resp(200, { ok: true, sent: 0, candidates: 0 });

  // ALREADY BOUGHT A ROOF → do not ask them to book a report review.
  //
  // The booked-check (review_appt_at) only catches someone who scheduled the
  // come-back. It says nothing about a homeowner who SOLD — and "I have your
  // report and want to come go over it" to a customer who signed a contract
  // last week reads like nobody here talks to each other. Caught on Wilmer
  // Benitez, who sold retail while his PA keeps the claim.
  //
  // retail_outcome=sold is filtered in the query above; the JN sold statuses are
  // filtered here because jn_status is free text.
  // DEAD / REFUSED → leave them alone.
  //
  // Same class of mistake as texting someone who already bought: "I have your
  // report and want to come go over it" to a homeowner who told us No, was
  // disqualified, no-showed, or whose deal is Lost is a message that should
  // never leave the building. Caught by Neal on the email pass — 4 of 43.
  const DEAD_JN = ["refused appointment", "no show h o", "btr ni", "not interested", "lost", "dq", "no response", "stale", "dead"];
  const notDead = (r) => { const st = String(r.jn_status || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(); return !DEAD_JN.some((d) => st === d || st.startsWith(d)); };
  const SOLD_JN = new Set(["sit sold","signed contract","production review","job prep","in funding","waiting on pace","upcoming installs","install set","roof started","new roof","install complete collect payment","paid closed","upcoming commissions","commission","holds","extras"]);
  const notSold = (r) => !SOLD_JN.has(String(r.jn_status || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim());

    // Which (inspection, msg#) already went out.
    const ids = rows.map((r) => r.id);
    const sentSet = new Set();
    const logs = await sbGetAll(`goback_text_log?inspection_id=in.(${ids.map((i) => `"${i}"`).join(",")})&select=inspection_id,msg_idx`);
    for (const l of logs) sentSet.add(`${l.inspection_id}:${l.msg_idx}`);

    let sent = 0;
    for (const insp of rows) {
      if (!notSold(insp)) continue;          // already bought a roof
      if (!notDead(insp)) continue;           // refused / DQ / no-show / lost
      const anchorDay = tzParts(new Date(insp.result_at)); // ET Y/M/D of completion
      for (let idx = 0; idx < msgs.length; idx++) {
        if (sentSet.has(`${insp.id}:${idx}`)) continue;
        const m = msgs[idx];
        const [hh, mm] = String(m.send_time).split(":").map((n) => parseInt(n, 10));
        // scheduled = (completion ET date + delay_days) at send_time ET
        const schedUTC = etWallToUTC(+anchorDay.year, +anchorDay.month, +anchorDay.day + (m.delay_days || 0), hh || 0, mm || 0);
        const dueMs = schedUTC.getTime();
        if (now.getTime() < dueMs) continue;                 // not time yet
        if (now.getTime() - dueMs > GRACE_MS) {              // window passed — skip (don't send stale), but mark
          await logSend(insp.id, idx, insp.mobile, false).catch(() => {});
          continue;
        }
        // Send it.
        const body = fill(m.body, insp);
        const [smsOk, mailOk] = await Promise.all([
          sendSms(insp.mobile, insp.client_name || "there", body),
          sendEmail(insp.email, insp.client_name, body),
        ]);
        const ok = smsOk || mailOk;          // reached them on EITHER channel
        await logSend(insp.id, idx, insp.mobile, ok).catch(() => {});
        if (ok) sent++;
        break; // one message per inspection per run — the next fires on a later run
      }
    }
    return resp(200, { ok: true, sent, candidates: rows.length });
  } catch (e) {
    return resp(500, { ok: false, error: e.message || "error" });
  }
};

function fill(body, insp) {
  const first = (insp.client_name || "").trim().split(/\s+/)[0] || "there";
  const link = `${ORIGIN}/?mode=gobackbook&t=${encodeURIComponent(insp.goback_token)}`;
  const addr = [insp.address, insp.city].filter(Boolean).join(", ");
  return String(body)
    .replace(/\{name\}/g, first)
    .replace(/\{rep\}/g, insp.sales_rep_name || "your rep")
    .replace(/\{link\}/g, link)
    .replace(/\{address\}/g, addr)
    .replace(/\{company\}/g, COMPANY);
}
async function sendSms(phone, name, message) {
  try {
    const r = await fetch(`${ORIGIN}/.netlify/functions/ghl-sms`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to: phone, name, message }),
    });
    const o = await r.json().catch(() => ({}));
    return !!(r.ok && o.success && !o.skipped); // opted-out (skipped) counts as not-sent
  } catch { return false; }
}
// SMS **and** EMAIL. A text alone silently misses anyone on DND or opted out of
// the GHL number — the same reason every trainee/rep message goes out on both
// channels. The email carries the identical wording with the {link} as a real
// link, so whichever one they see, they land on the same booking page.
async function sendEmail(to, name, message) {
  if (!to || !/.+@.+\..+/.test(String(to))) return false;
  const first = String(name || "").trim().split(/\s+/)[0] || "there";
  const linked = String(message).replace(
    /(https?:\/\/\S+)/g,
    '<a href="$1" style="color:#1d4ed8;font-weight:700">$1</a>',
  );
  const html =
    `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.55;color:#0f172a">` +
    `<p style="white-space:pre-wrap;margin:0 0 14px">${linked}</p>` +
    `<p style="margin:18px 0 0;font-size:12.5px;color:#64748b">${COMPANY}</p>` +
    `</div>`;
  try {
    const r = await fetch(`${ORIGIN}/.netlify/functions/send-email`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to, subject: `${first}, your roof inspection report`, html }),
    });
    return r.ok;
  } catch { return false; }
}

async function logSend(inspection_id, msg_idx, to_phone, ok) {
  // Unique(inspection_id,msg_idx) → merge-duplicates keeps the first (never resends).
  await fetch(`${SB_URL}/rest/v1/goback_text_log?on_conflict=inspection_id,msg_idx`, {
    method: "POST", headers: { ...sb, Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ inspection_id, msg_idx, to_phone, ok }),
  });
}
async function getSetting(key) {
  const r = await fetch(`${SB_URL}/rest/v1/app_settings?key=eq.${encodeURIComponent(key)}&select=value&limit=1`, { headers: sb });
  if (!r.ok) return null;
  const rows = await r.json().catch(() => []);
  return rows[0] ? rows[0].value : null;
}
async function sbGetAll(path) {
  const out = [];
  for (let from = 0; from < 100000; from += 1000) {
    const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: { ...sb, "Range-Unit": "items", Range: `${from}-${from + 999}` } });
    if (!r.ok) break;
    const rows = await r.json().catch(() => []);
    out.push(...rows);
    if (rows.length < 1000) break;
  }
  return out;
}
// ── ET helpers ──
const TZ = "America/New_York";
function tzParts(date) {
  const dtf = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const p = {}; for (const part of dtf.formatToParts(date)) p[part.type] = part.value; return p;
}
function offsetMs(date) { const p = tzParts(date); return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - date.getTime(); }
function etWallToUTC(y, mo, d, h, mi) { const guess = Date.UTC(y, mo - 1, d, h, mi, 0); return new Date(guess - offsetMs(new Date(guess))); }
function resp(statusCode, body) { return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }; }
