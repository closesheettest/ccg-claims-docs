// netlify/functions/cron-sales-audit.js
//
// "Sales inventory" — a morning audit of yesterday's JobNimbus sales. Reps
// routinely forget fields (or fill the wrong value) when they log a sale,
// and the office wastes time each day chasing it down. This scans every job
// SOLD yesterday (by the JN "Sold Date" field) against a checklist and, for
// any job with problems:
//   • texts the SALES REP what they left blank + what they got wrong, with
//     the job name to open,
//   • texts each REGIONAL MANAGER the roll-up for their zone,
//   • texts the ADMIN (ADMIN_ALERT_PHONE) every customer with mistakes +
//     which reps were notified.
// Clean mornings send nothing.
//
// Schedule: 0 16 * * * UTC = NOON EDT. Also exports.config.
// Detail goes to the REGIONAL MANAGER (not the rep). Admin summary →
// ADMIN_ALERT_PHONE + any extra recipients on the auto_sms 'sales_audit' row.
//
// Modes / manual use:
//   GET ?dry=1[&date=YYYY-MM-DD]  → compute + RETURN JSON, send nothing.
//                                   date defaults to yesterday (ET).
//   Scheduled run: only sends when auto_sms key 'sales_audit' is enabled.
//     Rep texts additionally require 'sales_audit_text_reps' enabled
//     (soft-launch = manager+admin only until that's turned on).
//
// Required env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, JOBNIMBUS_API_KEY.
//   Optional: ADMIN_ALERT_PHONE (comma list), URL/PUBLIC_SITE_URL (for SMS).

import { auditJob } from "./_sales-audit.js";

const JN_BASE = "https://app.jobnimbus.com/api1";
const TMS_REP_ZONES_URL =
  "https://trainingmanagementsys.netlify.app/.netlify/functions/rep-zones";
const TZ = "America/New_York";

// Statuses that mean "this is a real sale" (normalized: lowercase, non-alnum
// → space). Mirrors zone-sales-leaderboard.js. A job sold yesterday should be
// in one of these; anything Lost/cancelled never is.
const SOLD_STATUSES = new Set([
  "sit sold", "signed contract", "production review", "job prep",
  "upcoming installs", "install set",
]);
// Exact JN status_name spellings — pull jobs BY these statuses so older sold
// deals aren't lost to the 1,500-job scan cap. SOLD_STATUSES stays the filter.
const SOLD_STATUS_NAMES = [
  "Sit - Sold", "Signed Contract", "Production Review", "Job Prep",
  "Upcoming Installs", "Install Set",
];

export const handler = async (event) => {
  for (const k of ["VITE_SUPABASE_URL", "VITE_SUPABASE_ANON_KEY", "JOBNIMBUS_API_KEY"]) {
    if (!process.env[k]) return json(500, { ok: false, error: `Missing env: ${k}` });
  }
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
  const JN_KEY = process.env.JOBNIMBUS_API_KEY;
  const sb = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" };
  const jnHeaders = { Authorization: `bearer ${JN_KEY}`, "Content-Type": "application/json" };
  const base = (process.env.URL || process.env.PUBLIC_SITE_URL || "").replace(/\/$/, "");

  const qp = event?.queryStringParameters || {};
  const dry = qp.dry === "1";
  // Rolling window: re-flag EVERY still-unfixed sold deal from the last N days
  // (default 30) every day — not just yesterday's — so a deal sold days ago
  // that's still broken keeps nagging the manager until it's actually fixed.
  const lookbackDays = Math.min(Math.max(parseInt(qp.days, 10) || 30, 1), 120);
  const nowSec = Math.floor(Date.now() / 1000);
  const windowStartSec = nowSec - lookbackDays * 86400;

  // Send gating + extra recipients (scheduled runs). Dry runs never send.
  // The detailed missing-info goes to the REGIONAL MANAGER (not the rep).
  // The admin summary goes to ADMIN_ALERT_PHONE + any extra recipients set
  // on the auto_sms 'sales_audit' row (managed from the Auto SMS admin page).
  let sendAtAll = false, extraRecipients = [];
  if (!dry) {
    const row = await loadFlag(SB_URL, sb, "sales_audit");
    sendAtAll = !row || row.enabled !== false;
    extraRecipients = parseRecipients(row && row.recipients);
    // ALSO honor the TMS Notifications page: anyone subscribed to the
    // "sales_audit_noon" event there gets the admin summary too. (The
    // office manages all subscriptions on TMS → Settings → Notifications;
    // this lets that page control the noon audit even though it's a CCG
    // cron.) Public read with the TMS publishable key — no env setup.
    const tmsSubs = await tmsSubscriberPhones("sales_audit_noon");
    if (tmsSubs.length) extraRecipients = extraRecipients.concat(tmsSubs);
  }

  // 1. Pull sold jobs across the whole window (+2-day pad on the JN fetch).
  const sinceSec = windowStartSec - 2 * 86400;
  const jobs = await fetchSoldJobs(jnHeaders, sinceSec);

  // 2. Keep jobs sold WITHIN the window with a "sold" status.
  const sold = jobs.filter((j) => {
    const sd = soldDateSec(j);
    if (sd == null || sd < windowStartSec) return false;
    const status = String(j.status_name || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    return SOLD_STATUSES.has(status);
  });

  // 3. Audit each.
  const flagged = [];
  for (const j of sold) {
    const issues = auditJob(j);
    if (issues.missing.length || issues.errors.length) {
      flagged.push({
        jnid: j.jnid || j.id,
        name: j.name || "(no name)",
        customer: (j.primary && j.primary.name ? String(j.primary.name).replace(/\s+/g, " ").trim() : "—"),
        rep_id: j.sales_rep || null,
        rep_name: (j.sales_rep_name || "").trim() || "(no rep)",
        sold: (() => { const sd = soldDateSec(j); return sd ? etYMD(new Date(sd * 1000)) : null; })(),
        missing: issues.missing,
        errors: issues.errors,
      });
    }
  }

  // 4. Resolve rep zones + phones. Primary source for BOTH is the TMS active-
  //    rep directory (rep-zones feed — that's where rep phones live, under
  //    active sales reps). Falls back to CCG sales_reps for phone if missing.
  const dir = await fetchRepDirectory();
  const repCache = {};
  for (const f of flagged) {
    const d = dir(f.rep_id, f.rep_name) || {};
    f.zone = d.zone || null;
    f.rep_phone = d.phone || null;
    if (!f.rep_phone) {
      const key = f.rep_id || f.rep_name;
      if (!(key in repCache)) repCache[key] = await resolveRep(SB_URL, sb, f.rep_id, f.rep_name);
      f.rep_phone = repCache[key]?.phone || null;
    }
  }

  // 5. Compose + (optionally) send. REPS ARE NOT TEXTED. The detailed
  //    missing-info goes to that zone's REGIONAL MANAGER; the admin (+ extra
  //    recipients) gets the roll-up summary.
  const notified = { managers: [], admin: [] };
  if (!dry && sendAtAll && base && flagged.length) {
    // Regional manager gets the per-deal detail for their zone.
    const byZone = groupBy(flagged.filter((f) => f.zone), (f) => f.zone);
    for (const [zone, list] of Object.entries(byZone)) {
      const mgr = await fetchManager(SB_URL, sb, zone);
      if (!mgr?.phone) { notified.managers.push({ zone, ok: false, error: "no manager phone" }); continue; }
      const r = await sendSms(base, mgr.phone, mgr.name || "Manager", managerMessage(zone, list));
      notified.managers.push({ zone, ok: r.ok, count: list.length, error: r.error });
    }
    // Any flagged deals whose rep has no resolvable zone → no manager to send
    // to; surface them in the admin summary so they're not lost.
    const noZone = flagged.filter((f) => !f.zone);

    // Admin summary → ADMIN_ALERT_PHONE + extra recipients from the Auto SMS row.
    const adminPhones = dedupe([
      ...String(process.env.ADMIN_ALERT_PHONE || "").split(","),
      ...extraRecipients,
    ]);
    for (const a of adminPhones) {
      const r = await sendSms(base, a, "Admin", adminMessage(lookbackDays, flagged, notified, noZone));
      notified.admin.push({ to: a, ok: r.ok, error: r.error });
    }
  }

  return json(200, {
    ok: true,
    window_days: lookbackDays,
    dry,
    sent: !dry && sendAtAll,
    extra_recipients: extraRecipients,
    sold_count: sold.length,
    flagged_count: flagged.length,
    clean_count: sold.length - flagged.length,
    flagged,
    notified: dry ? undefined : notified,
  });
};

// ──────────────────────────────────────────────────────────────────────
// SMS composition. (The checklist itself lives in ./_sales-audit.js so the
// morning audit + the regional-manager "Deals need to be fixed" view share
// one source of truth — see the import at the top.)

// Start-date mismatches are the MANAGER's to fix (only they touch Start date);
// everything else is the rep's. Split them so the manager text is clear.
function isStartDateIssue(x) { return /start date/i.test(x) && /sold date/i.test(x); }

function issueLines(f) {
  const repErrors = (f.errors || []).filter((x) => !isStartDateIssue(x));
  const mgrErrors = (f.errors || []).filter(isStartDateIssue);
  let s = "";
  if (f.missing.length) s += "Rep — missing:\n" + f.missing.map((x) => `• ${x}`).join("\n") + "\n";
  if (repErrors.length) s += "Rep — wrong:\n" + repErrors.map((x) => `• ${x}`).join("\n") + "\n";
  if (mgrErrors.length) s += "👔 You fix (Start date):\n" + mgrErrors.map((x) => `• ${x}`).join("\n") + "\n";
  return s.trim();
}

// Regional manager gets the FULL per-deal detail for their zone (rep,
// customer, job, and exactly what's missing/wrong). Reps are NOT texted.
function managerMessage(zone, list) {
  let s = `🗂 ${zone} — ${list.length} sale${list.length === 1 ? "" : "s"} STILL need fixing:\n`;
  list.forEach((f) => {
    s += `\n— ${f.rep_name} · ${f.customer}${f.sold ? ` · sold ${f.sold}` : ""}\nJob: ${f.name}\n${issueLines(f)}\n`;
  });
  return s.trim() + "\n\nHave the rep correct their items in JobNimbus. 👔 Start date items are yours to fix — reps don't touch Start date.";
}

function adminMessage(days, flagged, notified, noZone) {
  let s = `📊 Sales audit (last ${days} days): ${flagged.length} sold deal(s) still need fixing.\n`;
  flagged.forEach((f) => {
    const n = f.missing.length + f.errors.length;
    s += `\n• ${f.customer} — ${f.rep_name} (${f.name})${f.sold ? ` · sold ${f.sold}` : ""} — ${n} issue${n === 1 ? "" : "s"}`;
  });
  const mgrOk = (notified.managers || []).filter((m) => m.ok).map((m) => m.zone);
  const mgrBad = (notified.managers || []).filter((m) => !m.ok).map((m) => `${m.zone} (${m.error})`);
  s += `\n\nManagers texted: ${mgrOk.length ? mgrOk.join(", ") : "none"}`;
  if (mgrBad.length) s += `\nNOT reached: ${mgrBad.join(", ")}`;
  if (noZone && noZone.length) s += `\n⚠ No zone/manager for: ${noZone.map((f) => f.rep_name).join(", ")}`;
  return s;
}

// ──────────────────────────────────────────────────────────────────────
// JN fetch + helpers.

// Pull jobs by each sold status_name (server-side filter), updated since the
// window opened — capped-proof; deduped by jnid.
async function fetchSoldJobs(jnHeaders, sinceSec) {
  const byId = new Map();
  for (const name of SOLD_STATUS_NAMES) {
    const filter = encodeURIComponent(JSON.stringify({ must: [{ match_phrase: { status_name: name } }] }));
    for (let page = 0; page < 20; page++) {
      const r = await fetch(
        `${JN_BASE}/jobs?size=100&from=${page * 100}&sort=-date_updated&date_updated_after=${sinceSec}&filter=${filter}`,
        { headers: jnHeaders },
      );
      if (!r.ok) break;
      const d = await r.json().catch(() => ({}));
      const rows = d.results || d.jobs || [];
      for (const j of rows) byId.set(j.jnid || j.id, j);
      if (rows.length < 100) break;
    }
  }
  return [...byId.values()];
}

function soldDateSec(job) {
  const v = job["Sold Date"] != null ? job["Sold Date"] : job.cf_date_5;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function etYMD(date) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}
function prevEtYmd() {
  const todayEt = etYMD(new Date());
  const [y, m, d] = todayEt.split("-").map(Number);
  const noonUtc = Date.UTC(y, m - 1, d, 12, 0, 0) - 24 * 60 * 60 * 1000;
  return etYMD(new Date(noonUtc));
}

// ──────────────────────────────────────────────────────────────────────
// Rep / zone / manager resolution (mirrors pa-refused-to-sign.js).

async function resolveRep(SB_URL, headers, salesRepId, salesRepName) {
  const sel = "id,name,phone,jobnimbus_id";
  const get = async (q) => {
    const res = await fetch(`${SB_URL}/rest/v1/sales_reps?${q}&select=${sel}&limit=1`, { headers });
    if (!res.ok) return null;
    return (await res.json().catch(() => []))?.[0] || null;
  };
  let rep = null;
  if (salesRepId) {
    rep = await get(`jobnimbus_id=eq.${encodeURIComponent(salesRepId)}`);
    if (!rep) rep = await get(`id=eq.${encodeURIComponent(salesRepId)}`);
  }
  if (!rep && salesRepName) rep = await get(`name=ilike.${encodeURIComponent(salesRepName)}`);
  return rep;
}

// Returns (jnId, name) → { zone, phone } from the TMS active-rep directory.
async function fetchRepDirectory() {
  let reps = [];
  try {
    const res = await fetch(TMS_REP_ZONES_URL);
    if (res.ok) reps = (await res.json()).reps || [];
  } catch (e) { console.warn("TMS rep-zones fetch failed:", e.message || e); }
  const byJnId = {}, byName = {};
  for (const r of reps) {
    const entry = { zone: r.zone || null, phone: r.phone || null };
    if (r.jobnimbus_id) byJnId[r.jobnimbus_id] = entry;
    if (r.name) byName[normalizeName(r.name)] = entry;
  }
  return (jnId, name) => (jnId && byJnId[jnId]) || byName[normalizeName(name)] || null;
}

async function fetchManager(SB_URL, headers, zone) {
  const res = await fetch(
    `${SB_URL}/rest/v1/regional_managers?zone=eq.${encodeURIComponent(zone)}&select=zone,name,phone&limit=1`,
    { headers },
  );
  if (!res.ok) return null;
  return (await res.json().catch(() => []))?.[0] || null;
}

// Pull phones of TMS people subscribed to a notification event, so the
// office can manage the noon audit's summary recipients from TMS →
// Settings → Notifications. Reads the TMS Supabase with its PUBLIC
// publishable key (same one the TMS frontend uses) — anon SELECT on
// notification_recipients is allowed, so no env/secret setup is needed.
// Best-effort: any failure just returns [] and the audit still sends to
// ADMIN_ALERT_PHONE + the Auto-SMS recipients.
const TMS_SB_URL = "https://yfmzktvmlfeqcubnvhxr.supabase.co";
const TMS_SB_KEY = "sb_publishable_Nfr-w2esI_2JoBwBXOWpIg_rWJWkBrN";
async function tmsSubscriberPhones(eventKey) {
  try {
    const r = await fetch(
      `${TMS_SB_URL}/rest/v1/notification_recipients?select=phone,notify_via_sms,subscribed_events&active=eq.true&subscribed_events=cs.%7B%22${encodeURIComponent(eventKey)}%22%7D`,
      { headers: { apikey: TMS_SB_KEY, Authorization: `Bearer ${TMS_SB_KEY}` } },
    );
    if (!r.ok) return [];
    const rows = await r.json().catch(() => []);
    return (rows || [])
      .filter((x) => x.notify_via_sms !== false && x.phone)
      .map((x) => x.phone);
  } catch { return []; }
}

// Load the auto_sms row (enabled flag + extra recipients) for a key.
async function loadFlag(SB_URL, headers, key) {
  try {
    const res = await fetch(`${SB_URL}/rest/v1/auto_sms?key=eq.${encodeURIComponent(key)}&select=enabled,recipients&limit=1`, { headers });
    if (!res.ok) return null;
    return (await res.json().catch(() => []))?.[0] || null;
  } catch { return null; }
}

// auto_sms.recipients is what the Auto SMS admin writes: an array of
// { name, phone } objects (also tolerate a plain string / array of strings).
function parseRecipients(v) {
  if (!v) return [];
  const arr = Array.isArray(v) ? v : String(v).split(/[,\n;]/);
  return arr
    .map((x) => (x && typeof x === "object" ? x.phone : x))
    .map((s) => String(s || "").trim())
    .filter(Boolean);
}

function dedupe(list) {
  const seen = new Set(), out = [];
  for (const s of list.map((x) => String(x).trim()).filter(Boolean)) {
    if (!seen.has(s)) { seen.add(s); out.push(s); }
  }
  return out;
}

async function sendSms(base, to, name, message) {
  try {
    const r = await fetch(`${base}/.netlify/functions/ghl-sms`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to, name, message }),
    });
    const rb = await r.json().catch(() => ({}));
    return { ok: r.ok, to, error: r.ok ? undefined : (rb.error || `status ${r.status}`) };
  } catch (e) { return { ok: false, to, error: e.message }; }
}

function normalizeName(s) {
  return String(s || "").toLowerCase()
    .replace(/["“”]([^"“”]*)["“”]/g, "").replace(/'([^']*)'/g, "").replace(/\(([^)]*)\)/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
}

function groupBy(arr, keyFn) {
  const m = {};
  for (const x of arr) { const k = keyFn(x); (m[k] = m[k] || []).push(x); }
  return m;
}

function json(status, body) {
  return { statusCode: status, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

// Noon EDT (16:00 UTC). The toml mirror keeps this visible from project root.
export const config = { schedule: "0 16 * * *" };
