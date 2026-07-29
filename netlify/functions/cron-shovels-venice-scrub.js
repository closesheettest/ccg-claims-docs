// netlify/functions/cron-shovels-venice-scrub.js
//
// Daily Venice roof-age scrub via Shovels.ai — free-tier safe.
// Each run checks up to 45 un-checked Venice INSPECTION-LEAD pins (~90 Shovels
// credits) and self-throttles: it hard-stops the moment credits_left drops below
// a floor, so it can never blow the free tier even if the daily allotment is smaller
// than we think.
//
// RULE (Neal): a home with a ROOFING permit dated 2012 or newer = roof too new =
// BAD lead → flip the pin to 'new_roof' (drops off the active inspection list).
// No roofing permit since 2012 (or none at all) = aging roof → keep it, just mark
// it checked so we never re-spend a credit on that house. Works through all ~820
// Venice inspection leads over ~18 days, hands-off.
//
// Progress is tracked per-pin in extra.shovels_checked_at (no schema change), and a
// daily summary is written to app_settings.shovels_venice_scrub_log.
//
// Schedule: daily 10:00 AM ET.  Manual/preview: GET ?dry=1 (no Shovels calls, just
// counts what's pending); GET ?limit=N to run a smaller batch by hand.
//
// Env: SHOVELS_API_KEY, VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY.

const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const SHOVELS_KEY = process.env.SHOVELS_API_KEY;
const BASE = "https://api.shovels.ai/v2";
const sb = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" };

const DAILY_CAP = 45;        // pins/day (~90 Shovels credits)
const CREDIT_FLOOR = 20;     // stop if credits_left drops below this
const NEW_ROOF_SINCE = 2012; // a roofing permit this year or newer = roof too new = bad lead
const CITY = "venice";

export const config = { schedule: "0 14 * * *" }; // 10:00 AM ET daily

export const handler = async (event) => {
  const qs = (event && event.queryStringParameters) || {};
  const dry = qs.dry === "1";
  const cap = Math.max(1, Math.min(Number(qs.limit) || DAILY_CAP, DAILY_CAP));
  if (!SB_URL || !SB_KEY) return json(500, { ok: false, error: "Supabase env missing" });
  if (!SHOVELS_KEY && !dry) return json(500, { ok: false, error: "SHOVELS_API_KEY missing" });

  const filter = `city=ilike.${CITY}&status=eq.insp&extra->>shovels_checked_at=is.null`;
  const pending = await sbCount(`canvass_prospects?${filter}&select=id`);
  const pins = await sbGet(`canvass_prospects?${filter}&select=id,address,city,state,zip,extra&order=id&limit=${cap}`);

  if (dry) return json(200, { ok: true, dry: true, would_process: pins.length, pending_total: pending });

  const H = { "X-API-Key": SHOVELS_KEY, Accept: "application/json" };
  let credits = null, bad = 0, aging = 0, errors = 0, processed = 0, stoppedOnCredits = false;
  const nowIso = new Date().toISOString();

  for (const p of pins) {
    if (credits != null && credits < CREDIT_FLOOR) { stoppedOnCredits = true; break; }
    const full = [p.address, p.city, p.state, p.zip].map((x) => String(x || "").trim()).filter(Boolean).join(", ");
    if (!full) continue;
    try {
      // 1) address → geo_id
      const aRes = await fetch(`${BASE}/addresses/search?q=${encodeURIComponent(full)}&size=1`, { headers: H });
      credits = readCredits(aRes) ?? credits;
      const geoId = firstGeo(await aRes.json().catch(() => ({})));
      let result, tooNew = false;
      if (!geoId) {
        result = { status: "NOT FOUND" };
      } else {
        // 2) any ROOFING permit dated 2012+ ?  (permit_from bounds the search at 2012)
        const today = new Date().toISOString().slice(0, 10);
        const pRes = await fetch(`${BASE}/permits/search?geo_id=${encodeURIComponent(geoId)}&permit_from=${NEW_ROOF_SINCE}-01-01&permit_to=${today}&size=100`, { headers: H });
        credits = readCredits(pRes) ?? credits;
        const roofing = listItems(await pRes.json().catch(() => ({}))).filter(isRoof);
        const dates = roofing.map(permitDate).filter(Boolean).sort();
        tooNew = roofing.length > 0; // a roofing permit since 2012 → roof too new → bad
        result = { status: "OK", since: NEW_ROOF_SINCE, roof_permit_count: roofing.length, last_roof_permit_date: dates.length ? dates[dates.length - 1] : null };
      }
      processed++;
      const extra = Object.assign({}, p.extra || {}, { shovels_checked_at: nowIso, shovels_result: result });
      const patch = tooNew
        ? { status: "new_roof", status_updated_at: nowIso, status_by: "Shovels scrub", extra }
        : { extra };
      await sbPatch(`canvass_prospects?id=eq.${encodeURIComponent(p.id)}`, patch);
      if (tooNew) bad++; else aging++;
    } catch { errors++; }
  }

  const summary = { at: nowIso, processed, bad_new_roof: bad, aging_kept: aging, errors, credits_left: credits, stopped_on_credits: stoppedOnCredits, pending_after: Math.max(0, pending - processed) };
  await logSummary(summary);
  return json(200, { ok: true, ...summary });
};

// ── Supabase helpers ────────────────────────────────────────────────────────
async function sbGet(path) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: sb });
  if (!r.ok) return [];
  return r.json().catch(() => []);
}
async function sbCount(path) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: { ...sb, Prefer: "count=exact", Range: "0-0" } });
  const cr = r.headers.get("content-range") || "";
  const n = Number(cr.split("/")[1]);
  return Number.isFinite(n) ? n : 0;
}
async function sbPatch(path, body) {
  await fetch(`${SB_URL}/rest/v1/${path}`, { method: "PATCH", headers: { ...sb, Prefer: "return=minimal" }, body: JSON.stringify(body) }).catch(() => {});
}
async function logSummary(summary) {
  await putSetting("shovels_venice_scrub_log", summary); // last run
  // Rolling per-day tally for the report → { "YYYY-MM-DD": { bad, aging, processed } }.
  try {
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
    const cur = (await getSetting("shovels_venice_scrub_daily")) || {};
    const day = cur[today] || { bad: 0, aging: 0, processed: 0 };
    day.bad += summary.bad_new_roof || 0;
    day.aging += summary.aging_kept || 0;
    day.processed += summary.processed || 0;
    cur[today] = day;
    const keep = {}; for (const k of Object.keys(cur).sort().slice(-30)) keep[k] = cur[k];
    await putSetting("shovels_venice_scrub_daily", keep);
  } catch { /* non-fatal */ }
}
async function putSetting(key, obj) {
  await fetch(`${SB_URL}/rest/v1/app_settings?on_conflict=key`, {
    method: "POST", headers: { ...sb, Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ key, value: JSON.stringify(obj) }),
  }).catch(() => {});
}
async function getSetting(key) {
  const r = await fetch(`${SB_URL}/rest/v1/app_settings?key=eq.${encodeURIComponent(key)}&select=value&limit=1`, { headers: sb }).catch(() => null);
  if (!r || !r.ok) return null;
  const rows = await r.json().catch(() => []);
  const v = rows?.[0]?.value;
  return v ? (typeof v === "string" ? JSON.parse(v) : v) : null;
}

// ── Shovels parsing (same tag-proof logic as shovels-permit.js) ──────────────
function listItems(j) {
  if (Array.isArray(j)) return j;
  for (const k of ["items", "results", "data", "permits", "addresses"]) if (Array.isArray(j?.[k])) return j[k];
  return [];
}
function firstGeo(j) {
  const a = listItems(j)[0] || (j && typeof j === "object" && j.geo_id ? j : null);
  return a && (a.geo_id || a.id || a.geoId);
}
function isRoof(p) {
  if (!p || typeof p !== "object") return false;
  const fields = [p.tags, p.description, p.type, p.subtype, p.name, p.permit_type, p.classification, p.work_class, p.scope, p.job_type];
  let hay = fields.filter((x) => x != null).map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ").toLowerCase();
  if (!hay) hay = JSON.stringify(p).toLowerCase();
  return /roof/.test(hay);
}
function permitDate(p) {
  if (!p || typeof p !== "object") return null;
  const today = new Date().toISOString().slice(0, 10);
  for (const f of [p.issue_date, p.final_date, p.file_date, p.start_date, p.end_date, p.permit_from, p.approval_date, p.status_date]) {
    const d = f ? String(f).slice(0, 10) : null;
    if (d && /^\d{4}-\d{2}-\d{2}$/.test(d) && d <= today) return d;
  }
  return null;
}
function readCredits(res) {
  for (const h of ["x-credits-remaining", "x-ratelimit-remaining", "ratelimit-remaining", "x-quota-remaining"]) {
    const v = res.headers.get(h);
    if (v != null && v !== "") { const n = Number(v); if (!Number.isNaN(n)) return n; }
  }
  return null;
}
function json(statusCode, obj) {
  return { statusCode, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }, body: JSON.stringify(obj) };
}
