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
  const targetYmd = (qp.date && /^\d{4}-\d{2}-\d{2}$/.test(qp.date)) ? qp.date : prevEtYmd();

  // Send gating + extra recipients (scheduled runs). Dry runs never send.
  // The detailed missing-info goes to the REGIONAL MANAGER (not the rep).
  // The admin summary goes to ADMIN_ALERT_PHONE + any extra recipients set
  // on the auto_sms 'sales_audit' row (managed from the Auto SMS admin page).
  let sendAtAll = false, extraRecipients = [];
  if (!dry) {
    const row = await loadFlag(SB_URL, sb, "sales_audit");
    sendAtAll = !row || row.enabled !== false;
    extraRecipients = parseRecipients(row && row.recipients);
  }

  // 1. Pull recent jobs (sold yesterday → updated yesterday). 4-day pad.
  const sinceSec = Math.floor(Date.now() / 1000) - 4 * 24 * 60 * 60;
  const jobs = await fetchRecentJobs(jnHeaders, sinceSec);

  // 2. Keep jobs whose Sold Date (ET) == target day AND status is "sold".
  const sold = jobs.filter((j) => {
    const sd = soldDateSec(j);
    if (sd == null) return false;
    if (etYMD(new Date(sd * 1000)) !== targetYmd) return false;
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
      const r = await sendSms(base, a, "Admin", adminMessage(targetYmd, flagged, notified, noZone));
      notified.admin.push({ to: a, ok: r.ok, error: r.error });
    }
  }

  return json(200, {
    ok: true,
    date: targetYmd,
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
// The checklist. Reads fields by their JN label (trailing spaces tolerated).

function auditJob(job) {
  const F = trimmedFieldMap(job);
  const missing = [];   // left blank / unanswered
  const errors = [];    // filled wrong

  const has = (label) => { const v = F[label]; return v !== undefined && v !== null && v !== "" && !(Array.isArray(v) && !v.length); };
  const str = (label) => (F[label] == null ? "" : String(F[label]).trim());
  const numv = (label) => { const n = Number(F[label]); return Number.isFinite(n) ? n : NaN; };
  const answered = (label) => label in F && F[label] !== null && F[label] !== "";   // booleans: present (true OR false)
  const yes = (label) => { const v = F[label]; return v === true || v === "true" || v === "Yes" || v === "yes" || v === 1; };
  const pos = (label) => { const n = numv(label); return Number.isFinite(n) && n > 0; };

  // ── Start Date is NOT checked — reps are told to LEAVE IT ALONE / never
  //    touch it (the office owns it). Do not flag it.

  // ── Always-required answers ──────────────────────────────────────────
  if (!has("*Payment Type*")) missing.push("Payment Type");
  if (!has("Preferred Communication")) missing.push("Preferred Communication");
  if (!has("Sales Rep Harvested")) missing.push("Sales Rep Harvested (Yes/No)");
  if (!answered("Previous Pending")) missing.push("Previous Pending (Yes/No)");
  if (!answered("Detached Structure Included")) missing.push("Detached Structure Included (Yes/No)");
  if (!answered("Solar Panels")) missing.push("Solar Panels (Yes/No)");
  if (!answered("IRBADS")) missing.push("IRBADS (Yes/No)");
  if (!answered("Insulation")) missing.push("Insulation (Yes/No)");
  if (!answered("Radiant Barrier")) missing.push("Radiant Barrier (Yes/No)");
  if (!answered("Modified Bitman")) missing.push("Modified Bitumen (Yes/No)");
  if (!answered("TPO")) missing.push("TPO (Yes/No)");
  if (!has("Measurements Needed?")) missing.push("Measurements Needed?");
  if (!has("# of Stories")) missing.push("# of Stories");
  if (!pos("Roof Price ONLY")) errors.push("Roof Price ONLY is 0 / blank");
  if (!pos("# of Squares (Pitch)")) errors.push("# of Squares (Pitch) is 0 / blank");

  // ── Roofing product + its color ──────────────────────────────────────
  const products = ["Exposed Fastener", "Standing Seam", "Shingle", "Permalock", "Tile", "Stone Coated Metal"];
  const soldProducts = products.filter((p) => yes(p));
  if (soldProducts.length === 0) {
    errors.push("No roofing product selected (Exposed Fastener / Standing Seam / Shingle / Permalock / Tile / Stone Coated Metal)");
  }
  if (yes("Exposed Fastener") && !has("Exposed Fastener Color")) missing.push("Exposed Fastener Color");
  if (yes("Standing Seam") && !has("Standing Seam Color")) missing.push("Standing Seam Color");
  if (yes("Shingle")) {
    if (!has("Shingle Color")) missing.push("Shingle Color");
    if (!has("Drip Edge Color (Shingle Only)")) missing.push("Drip Edge Color (Shingle Only)");
  }
  if (yes("Permalock") && !has("Permalock Colors")) missing.push("Permalock Color");

  // ── Measurements rule ────────────────────────────────────────────────
  if ((yes("Exposed Fastener") || yes("Standing Seam")) && str("Measurements Needed?") !== "Needs Measurements") {
    errors.push('Measurements Needed? must be "Needs Measurements" for Exposed Fastener / Standing Seam');
  }

  // ── Flat-roof products ───────────────────────────────────────────────
  if (yes("Modified Bitman")) {
    if (!pos("# of Squares (Flat)")) errors.push("# of Squares (Flat) is 0 (Modified Bitumen sold)");
    if (!has("Mod Bit Color")) missing.push("Mod Bit Color");
  }
  if (yes("TPO") && !pos("# of Squares (Flat)")) errors.push("# of Squares (Flat) is 0 (TPO sold)");
  if (yes("Modified Bitman") && yes("TPO")) errors.push("Modified Bitumen and TPO can't both be Yes");

  // ── IRBADS ───────────────────────────────────────────────────────────
  if (yes("IRBADS") && !has("IRBADS Area")) missing.push("IRBADS Area");

  // ── Insulation (+ price-per-sqft mistake) ────────────────────────────
  if (yes("Insulation")) {
    if (!pos("Insulation SqFt")) errors.push("Insulation SqFt is 0 (Insulation sold)");
    if (!pos("Insulation Cost")) errors.push("Insulation Cost is 0 (Insulation sold)");
    else if (pos("Insulation SqFt") && numv("Insulation Cost") < numv("Insulation SqFt")) {
      errors.push(`Insulation Cost ($${numv("Insulation Cost")}) looks like price-per-sqft, not the contract total`);
    }
  }

  // ── Radiant Barrier (+ price-per-sqft mistake) ───────────────────────
  if (yes("Radiant Barrier")) {
    if (!pos("Radiant Barrier SqFt")) errors.push("Radiant Barrier SqFt is 0 (Radiant Barrier sold)");
    if (!pos("Radiant Barrier Cost")) errors.push("Radiant Barrier Cost is 0 (Radiant Barrier sold)");
    else if (pos("Radiant Barrier SqFt") && numv("Radiant Barrier Cost") < numv("Radiant Barrier SqFt")) {
      errors.push(`Radiant Barrier Cost ($${numv("Radiant Barrier Cost")}) looks like price-per-sqft, not the contract total`);
    }
  }

  return { missing, errors };
}

// JN echoes friendly labels as keys (sometimes with trailing spaces or *…*).
// Build a lookup keyed by the TRIMMED, *-stripped label so rules are robust.
function trimmedFieldMap(job) {
  const m = {};
  for (const [k, v] of Object.entries(job)) {
    m[k.trim()] = v;                          // exact (trimmed)
    const bare = k.trim().replace(/^\*|\*$/g, "").trim();
    if (!(bare in m)) m[bare] = v;            // *Payment Type* → Payment Type
  }
  return m;
}

// ──────────────────────────────────────────────────────────────────────
// SMS composition.

function issueLines(f) {
  let s = "";
  if (f.missing.length) s += "Missing:\n" + f.missing.map((x) => `• ${x}`).join("\n") + "\n";
  if (f.errors.length) s += "Wrong:\n" + f.errors.map((x) => `• ${x}`).join("\n") + "\n";
  return s.trim();
}

// Regional manager gets the FULL per-deal detail for their zone (rep,
// customer, job, and exactly what's missing/wrong). Reps are NOT texted.
function managerMessage(zone, list) {
  let s = `🗂 ${zone} — ${list.length} sale${list.length === 1 ? "" : "s"} from yesterday need fixing:\n`;
  list.forEach((f) => {
    s += `\n— ${f.rep_name} · ${f.customer}\nJob: ${f.name}\n${issueLines(f)}\n`;
  });
  return s.trim() + "\n\nHave the rep open each job in JobNimbus and correct these.";
}

function adminMessage(date, flagged, notified, noZone) {
  let s = `📊 Sales audit ${date}: ${flagged.length} record(s) need fixing.\n`;
  flagged.forEach((f) => {
    const n = f.missing.length + f.errors.length;
    s += `\n• ${f.customer} — ${f.rep_name} (${f.name}) — ${n} issue${n === 1 ? "" : "s"}`;
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

async function fetchRecentJobs(jnHeaders, sinceSec) {
  const all = [];
  for (let page = 0; page < 15; page++) {
    const r = await fetch(
      `${JN_BASE}/jobs?size=100&from=${page * 100}&sort=-date_updated&date_updated_after=${sinceSec}`,
      { headers: jnHeaders },
    );
    if (!r.ok) break;
    const d = await r.json().catch(() => ({}));
    const rows = d.results || d.jobs || [];
    all.push(...rows);
    if (rows.length < 100) break;
  }
  return all;
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
