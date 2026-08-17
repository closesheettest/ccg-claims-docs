// netlify/functions/goback-backfill.js
//
// ONE-OFF catch-up for "Auto-Schedule After Inspection".
//
// The sequence was configured on 2026-08-14 but the toggle was never SAVED, so
// `enabled` sat false and nothing sent. It went live 2026-08-17. The normal
// sender (cron-goback-autoschedule) deliberately will NOT fill that gap: a
// message only fires within 18 hours of its scheduled time, so every message for
// those days is past its window and gets marked skipped instead of sent. That
// guard is right — it stops a restarted cron blasting stale texts — so catching
// up is a deliberate act, which is this.
//
// Sends MESSAGE 1 ONLY, once per homeowner, to inspections completed in the
// look-back window. Logs each send as msg_idx 0 so the cron never repeats it;
// messages 2 and 3 then follow the normal schedule for anyone still in window.
//
// SAFETY:
//   • DRY RUN BY DEFAULT. It only sends with confirm === "SEND".
//   • Skips anyone who already booked (review_appt_at), is cancelled, has no
//     mobile, or already has ANY goback_text_log row.
//   • Dedupes by phone — one homeowner with two inspections gets one text.
//   • Quiet hours: refuses to send outside 8 AM – 9 PM ET.
//   • Requires the admin token, same as the rest of the admin tools.
//
// POST { admin, days?, confirm?, body? }
//   → dry run:  { ok, dry_run:true, would_send, sample, people:[...] }
//   → live:     { ok, sent, failed, results:[...] }
//
// Env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, URL

const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const sb = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" };
const ORIGIN = (process.env.URL || "https://free-roof-inspections.netlify.app").replace(/\/$/, "");
const COMPANY = "U.S. Shingle & Metal";

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return resp(200, { ok: true });
  if (event.httpMethod !== "POST") return resp(405, { ok: false, error: "POST only" });
  if (!SB_URL || !SB_KEY) return resp(500, { ok: false, error: "env missing" });

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { return resp(400, { ok: false, error: "bad JSON" }); }

  const wantAdmin = await getSetting("harvest_admin_token");
  if (!wantAdmin || String(body.admin || "").trim() !== String(wantAdmin)) {
    return resp(401, { ok: false, error: "admin token required" });
  }

  const live = String(body.confirm || "") === "SEND";
  const days = Math.min(Math.max(parseInt(body.days, 10) || 7, 1), 30);

  // Message 1 from the saved sequence unless an override is passed.
  const cfgRaw = await getSetting("goback_autoschedule_config");
  const cfg = cfgRaw ? (typeof cfgRaw === "string" ? JSON.parse(cfgRaw) : cfgRaw) : null;
  const msg1 = cfg && Array.isArray(cfg.messages) && cfg.messages[0] ? cfg.messages[0].body : null;
  const template = String(body.body || msg1 || "").trim();
  if (!template) return resp(400, { ok: false, error: "no message body configured" });

  // Quiet hours — the same rule the cron follows. Never text someone at 6 AM.
  const etHour = Number(tzParts(new Date()).hour);
  if (live && (etHour < 8 || etHour >= 21)) {
    return resp(200, { ok: false, error: `Quiet hours — it's ${etHour}:00 ET. Texts only go out 8 AM–9 PM.` });
  }

  const sinceIso = new Date(Date.now() - days * 86400000).toISOString();
  const rows = await sbGetAll(
    `inspections?result_at=gte.${encodeURIComponent(sinceIso)}&review_appt_at=is.null&cancelled_at=is.null` +
    `&mobile=not.is.null&result=not.is.null&or=(retail_outcome.is.null,retail_outcome.neq.sold)&goback_token=not.is.null` +
    `&select=id,client_name,jn_status,mobile,email,address,city,state,zip,sales_rep_name,result,result_at,goback_token&order=result_at.desc`
  );

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
  const SOLD_JN = new Set(["sit sold","signed contract","production review","job prep","in funding","waiting on pace","upcoming installs","install set","roof started","new roof","install complete collect payment","paid closed","upcoming commissions","commission","holds","extras"]);
  const notSold = (r) => !SOLD_JN.has(String(r.jn_status || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim());

  // Anyone the sequence ACTUALLY REACHED is out — this must never double up.
  //
  // ok=true only. The cron writes a log row in two very different cases: it sent
  // the message (ok=true), or the message was past its 18-hour window so it was
  // marked skipped and nothing went out (ok=false). Treating both as "already
  // texted" excluded exactly the people this catch-up exists for — when the
  // toggle was saved on 8/17 the cron immediately marked 28 stale messages
  // skipped, all ok=false, and those 16 homeowners had received nothing.
  const already = new Set();
  if (rows.length) {
    const ids = rows.map((r) => `"${r.id}"`).join(",");
    const logs = await sbGetAll(`goback_text_log?inspection_id=in.(${ids})&ok=is.true&select=inspection_id`);
    for (const l of logs) already.add(l.inspection_id);
  }

  // One text per PERSON, not per inspection: a homeowner with both a retail and a
  // damage record on the same phone gets one message (the most recent).
  const byPhone = new Map();
  for (const r of rows) {
    if (already.has(r.id)) continue;
    if (!notSold(r)) continue;              // already bought a roof
    const key = String(r.mobile || "").replace(/\D/g, "").slice(-10);
    if (key.length < 10) continue;
    if (!byPhone.has(key)) byPhone.set(key, r);
  }
  const people = [...byPhone.values()];

  if (!live) {
    return resp(200, {
      ok: true, dry_run: true, window_days: days,
      would_send: people.length,
      skipped_already_reached: rows.filter((r) => already.has(r.id)).length,
      collapsed_duplicate_phones: rows.length - already.size - people.length,
      sample: people[0] ? fill(template, people[0]) : null,
      people: people.map((p) => ({
        name: p.client_name, phone: p.mobile, email: p.email || null, rep: p.sales_rep_name,
        result: p.result, inspected: (p.result_at || "").slice(0, 10),
      })),
    });
  }

  const results = [];
  let sent = 0, failed = 0;
  for (const p of people) {
    const text = fill(template, p);
    const [smsOk, mailOk] = await Promise.all([
      sendSms(p.mobile, p.client_name || "there", text),
      sendEmail(p.email, p.client_name, text),
    ]);
    const ok = smsOk || mailOk;
    await logSend(p.id, 0, p.mobile, ok).catch(() => {});
    if (ok) sent++; else failed++;
    results.push({ name: p.client_name, phone: p.mobile, sms: smsOk, email: mailOk });
  }
  return resp(200, { ok: true, sent, failed, total: people.length, results });
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
    return !!(r.ok && o.success && !o.skipped);   // opted-out counts as not sent
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
  for (let from = 0; from < 20000; from += 1000) {
    const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: { ...sb, "Range-Unit": "items", Range: `${from}-${from + 999}` } });
    if (!r.ok) break;
    const rows = await r.json().catch(() => []);
    out.push(...rows);
    if (rows.length < 1000) break;
  }
  return out;
}
function tzParts(d) {
  const p = {};
  for (const x of new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour12: false, hour: "2-digit" }).formatToParts(d)) p[x.type] = x.value;
  return p;
}
function resp(statusCode, obj) {
  return { statusCode, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }, body: JSON.stringify(obj) };
}
