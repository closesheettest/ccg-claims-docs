// netlify/functions/all-manager-pay.js
//
// Managers Pay report (OVERRIDE pay only — no rep sales commission). Reads last
// week's SOLD deals from JobNimbus, groups Region → Sales rep → Deal, and pays
// the regional manager an override on each deal:
//
//   override       = total contract $ × base_rate            (default 2%)
//                    EXCEPT a manager's own sale, which uses own_sale_rate
//                    (default 1%) INSTEAD of base_rate (not additive — on his
//                    own deal he already earns the sales commission).
//   IRBAD override = (Insulation Total Cost + Radiant Barrier Total Cost)
//                    × (irbad_rate + irbad_bonus)            (default 20% + 10%)
//   + a flat monthly_bonus $ per manager (default 0)
//
// Roof-only $ shown per deal = total contract − IRBAD (informational; the 2% is
// on the FULL contract per owner's spec). All rates live in app_settings
// (manager_pay_config) so the admin can change them and this recalculates.
//
// GET /.netlify/functions/all-manager-pay[?period=lastweek|week|month|custom&start=&end=]
//   → { ok, period, range, config, regions:[{ zone, manager, reps:[{ rep,
//        is_manager, deals:[{ customer, address, sold, contract, roof, irbad,
//        base_or, irbad_or, own_or, deal_or }], totals }], totals, monthly_bonus,
//        grand_or }], totals }
//
// Env: JOBNIMBUS_API_KEY, VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY.

import { fetchSoldJobs } from "./_appt-conversion.js";

const JN_KEY = process.env.JOBNIMBUS_API_KEY;
const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const sb = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" };
const TMS_REP_ZONES_URL = "https://trainingmanagementsys.netlify.app/.netlify/functions/rep-zones?include_inactive=1";
const ZONE_ORDER = ["Zone 1", "Zone 2", "Zone 3", "Zone 4", "Internal Reps"];
const TZ = "America/New_York";

// Rate keys are per-region overridable. ins_min_ppsf / rad_min_ppsf are GLOBAL
// $/sqft thresholds: IRBAD override only pays when a product's price-per-sqft
// meets its floor (insulation ≥ $1.50, radiant ≥ $2.50). Below it → no override.
export const DEFAULT_CONFIG = { base_rate: 0.02, own_sale_rate: 0.01, irbad_rate: 0.20, irbad_bonus: 0.10, monthly_bonus: 0, ins_min_ppsf: 1.5, rad_min_ppsf: 2.5 };
const RATE_KEYS = ["base_rate", "own_sale_rate", "irbad_rate", "irbad_bonus", "monthly_bonus"];
function pickRates(c) { const o = {}; if (c) for (const k of RATE_KEYS) if (typeof c[k] === "number") o[k] = c[k]; return o; }
function numOr(v, dflt) { const n = Number(v); return Number.isFinite(n) ? n : dflt; }
// Effective rates for a region: defaults (top-level) overlaid by any
// config.regions[zone] overrides. Thresholds stay global (top-level only).
export function effectiveConfig(config, zone) {
  const stored = config || {};
  return {
    ...DEFAULT_CONFIG, ...pickRates(stored), ...pickRates((stored.regions && stored.regions[zone]) || {}),
    ins_min_ppsf: numOr(stored.ins_min_ppsf, DEFAULT_CONFIG.ins_min_ppsf),
    rad_min_ppsf: numOr(stored.rad_min_ppsf, DEFAULT_CONFIG.rad_min_ppsf),
  };
}

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return cors(200, "");
  if (!JN_KEY || !SB_URL || !SB_KEY) return cors(500, JSON.stringify({ ok: false, error: "env missing" }));
  try {
    const qp = event.queryStringParameters || {};
    const { start, end, period } = pickWindow(qp);
    const startSec = Math.floor(start.getTime() / 1000), endSec = Math.floor(end.getTime() / 1000);

    const [soldJobs, { zoneOf, zoneManager }, config] = await Promise.all([
      fetchSoldJobs(JN_KEY, startSec, endSec),
      fetchZoneResolver(),
      loadConfig(),
    ]);

    const report = computeReport(soldJobs, zoneOf, zoneManager, config);
    // Top-level config = the DEFAULT rates (per-region effective rates ride on
    // each region object as region.config).
    return cors(200, JSON.stringify({ ok: true, period, range: { start: start.toISOString(), end: end.toISOString() }, config: effectiveConfig(config, null), ...report }));
  } catch (e) {
    return cors(500, JSON.stringify({ ok: false, error: e.message || "error" }));
  }
};

// ── Pay calc (pure — also imported by the local verifier) ──────────────────
export function computeReport(soldJobs, zoneOf, zoneManager, config) {
  // Rates can be set per region: top-level keys are the default for every
  // region; config.regions[zone] overrides any subset for that one region.
  const effFor = (zone) => effectiveConfig(config, zone);
  const byZone = {}; // zone -> { repName -> { rep, jnId, is_manager, deals:[] } }

  for (const job of soldJobs) {
    let name = String(job.sales_rep_name || "").trim();
    let repId = job.sales_rep || null;
    let e = zoneOf(repId, name);
    if (!name) { // no Sales Rep → fall back to Assigned owner (mirrors appt-conversion)
      const ownerId = job.owners && job.owners[0] && job.owners[0].id;
      const oe = ownerId ? zoneOf(ownerId, "") : null;
      if (oe) { e = oe; name = oe.name || ""; repId = ownerId; }
    }
    const zone = (e && e.zone) || "Internal Reps";
    const repName = name || "(no rep)";
    const reps = (byZone[zone] = byZone[zone] || {});
    const mgr = zoneManager[zone];
    const isManager = !!(mgr && repId && String(repId) === String(mgr.jnId));
    const rec = (reps[repName] = reps[repName] || { rep: repName, jnId: repId, is_manager: isManager, deals: [] });

    const F = trimmedFieldMap(job);
    const contract = saleAmount(job);
    const ins = numOf(F, "Insulation Total Cost");
    const rad = numOf(F, "Radiant Barrier Total Cost");
    const insSqft = numOf(F, "Insulation SqFt");
    const radSqft = numOf(F, "Radiant Barrier SqFt");
    const irbad = ins + rad;
    const roof = Math.max(0, contract - irbad);
    const cfg = effFor(zone);
    // IRBAD override only pays when price-per-sqft meets the floor (insulation
    // ≥ ins_min_ppsf, radiant ≥ rad_min_ppsf), judged per product. Missing sqft
    // → can't justify → no override.
    const insPpsf = insSqft > 0 ? ins / insSqft : 0;
    const radPpsf = radSqft > 0 ? rad / radSqft : 0;
    const insQual = ins > 0 && insSqft > 0 && insPpsf >= cfg.ins_min_ppsf;
    const radQual = rad > 0 && radSqft > 0 && radPpsf >= cfg.rad_min_ppsf;
    const irbadRate = cfg.irbad_rate + cfg.irbad_bonus;
    // A manager's OWN sale earns only the own rate (1%); every other rep's deal
    // earns the base override (2%). No additive "+own" anymore.
    const base_or = contract * (isManager ? cfg.own_sale_rate : cfg.base_rate);
    const irbad_or = (insQual ? ins * irbadRate : 0) + (radQual ? rad * irbadRate : 0);
    const deal_or = base_or + irbad_or;

    rec.deals.push({
      customer: (job.primary && job.primary.name) || job.name || "—",
      address: [job.address_line1, job.city].filter(Boolean).join(", "),
      sold: fmtDate(soldDateSec(job)),
      contract: round(contract), roof: round(roof), irbad: round(irbad),
      ins: round(ins), ins_sqft: round(insSqft), ins_ppsf: round(insPpsf), ins_qual: insQual,
      rad: round(rad), rad_sqft: round(radSqft), rad_ppsf: round(radPpsf), rad_qual: radQual,
      base_or: round(base_or), irbad_or: round(irbad_or), deal_or: round(deal_or),
    });
  }

  const regions = Object.entries(byZone).map(([zone, repsMap]) => {
    const reps = Object.values(repsMap).map((r) => ({ ...r, totals: sumDeals(r.deals) }))
      .sort((a, b) => b.totals.deal_or - a.totals.deal_or || a.rep.localeCompare(b.rep));
    const totals = sumDeals(reps.flatMap((r) => r.deals));
    const hasMgr = !!zoneManager[zone];
    const cfg = effFor(zone);
    const monthly_bonus = round(hasMgr ? cfg.monthly_bonus : 0);
    return { zone, manager: hasMgr ? zoneManager[zone].name : null, unassigned: !hasMgr, reps, totals, monthly_bonus, grand_or: round(totals.deal_or + monthly_bonus), config: cfg };
  }).sort((a, b) => zoneRank(a.zone) - zoneRank(b.zone) || a.zone.localeCompare(b.zone));

  // Grand totals = MANAGER PAY only (managed regions). Unassigned/no-manager
  // regions are listed for fixing, but no manager earns their override, so
  // they're excluded from the pay total.
  const managed = regions.filter((z) => !z.unassigned);
  const totals = sumDeals(managed.flatMap((z) => z.reps.flatMap((r) => r.deals)));
  totals.monthly_bonus = round(managed.reduce((s, z) => s + z.monthly_bonus, 0));
  totals.grand_or = round(totals.deal_or + totals.monthly_bonus);
  return { regions, totals };
}

function sumDeals(deals) {
  const t = deals.reduce((s, d) => ({
    contract: s.contract + d.contract, roof: s.roof + d.roof, irbad: s.irbad + d.irbad,
    base_or: s.base_or + d.base_or, irbad_or: s.irbad_or + d.irbad_or, deal_or: s.deal_or + d.deal_or,
  }), { contract: 0, roof: 0, irbad: 0, base_or: 0, irbad_or: 0, deal_or: 0 });
  for (const k of Object.keys(t)) t[k] = round(t[k]);
  t.deals = deals.length;
  return t;
}

// ── Field / money helpers ──────────────────────────────────────────────────
function trimmedFieldMap(job) {
  const m = {};
  for (const [k, v] of Object.entries(job)) { const t = k.trim(); m[t] = v; const bare = t.replace(/^\*|\*$/g, "").trim(); if (!(bare in m)) m[bare] = v; }
  return m;
}
function numOf(F, label) { const n = Number(F[label]); return Number.isFinite(n) ? n : 0; }
function saleAmount(job) { return Math.max(Number(job.approved_estimate_total) || 0, Number(job.approved_invoice_total) || 0, Number(job.last_budget_revenue) || 0); }
function soldDateSec(job) { const v = job["Sold Date"] != null ? job["Sold Date"] : job.cf_date_5; const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null; }
function round(n) { return Math.round((Number(n) || 0) * 100) / 100; }
function zoneRank(z) { const i = ZONE_ORDER.indexOf(z); return i === -1 ? 99 : i; }
function fmtDate(sec) {
  const n = Number(sec);
  if (!Number.isFinite(n) || n <= 0) return "";
  try { return new Intl.DateTimeFormat("en-US", { timeZone: TZ, month: "numeric", day: "numeric", year: "numeric" }).format(new Date(n * 1000)); } catch { return ""; }
}

// ── Zone + manager resolver (TMS rep-zones feed) ───────────────────────────
async function fetchZoneResolver() {
  let reps = [];
  try { const res = await fetch(TMS_REP_ZONES_URL); if (res.ok) reps = (await res.json()).reps || []; } catch (e) { console.warn("rep-zones fetch failed:", e.message || e); }
  const byJnId = {}, byName = {}, zoneManager = {};
  for (const r of reps) {
    const e = { zone: r.zone, level: r.rep_level, name: r.name };
    if (r.jobnimbus_id) byJnId[r.jobnimbus_id] = e;
    if (r.name) byName[normalizeName(r.name)] = e;
    if (r.managed_region) {
      zoneManager[r.managed_region] = { jnId: r.jobnimbus_id || null, name: r.name };
      // A manager's own sale should land in the zone they MANAGE.
      if (r.jobnimbus_id) byJnId[r.jobnimbus_id] = { zone: r.managed_region, level: r.rep_level, name: r.name };
    }
  }
  const zoneOf = (id, name) => (id && byJnId[id]) || (name && byName[normalizeName(name)]) || null;
  return { zoneOf, zoneManager };
}
function normalizeName(n) { return String(n || "").toLowerCase().replace(/[^a-z]+/g, " ").trim(); }

// ── Config (app_settings.manager_pay_config) ───────────────────────────────
async function loadConfig() {
  try {
    const r = await fetch(`${SB_URL}/rest/v1/app_settings?key=eq.manager_pay_config&select=value&limit=1`, { headers: sb });
    if (r.ok) { const rows = await r.json(); const v = rows[0]?.value; if (v) return typeof v === "string" ? JSON.parse(v) : v; }
  } catch { /* fall through to defaults */ }
  return { ...DEFAULT_CONFIG };
}

// ── Date windows (ET, DST-safe) ────────────────────────────────────────────
// Default = the WEEK JUST ENDED: the Mon–Sun week ending on the most recent
// Sunday (today if today is Sunday). The UI passes explicit start/end for any
// other week (◀ ▶); ?period=current = the in-progress week, prev = one before.
function tzParts(date) { const dtf = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour12: false, weekday: "short", year: "numeric", month: "2-digit", day: "2-digit" }); const p = {}; for (const part of dtf.formatToParts(date)) p[part.type] = part.value; return p; }
function etMidnightUTC(y, m, d) { // UTC instant of ET-local midnight on y-m-d
  const noon = new Date(Date.UTC(y, m - 1, d, 12));
  const hp = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "2-digit", hour12: false }).formatToParts(noon);
  const etHour = Number(hp.find((x) => x.type === "hour").value); // ET hour when UTC=12 → offset
  return new Date(Date.UTC(y, m - 1, d, 12 - etHour));
}
function addYMD(y, m, d, delta) { const b = new Date(Date.UTC(y, m - 1, d)); b.setUTCDate(b.getUTCDate() + delta); return { y: b.getUTCFullYear(), m: b.getUTCMonth() + 1, d: b.getUTCDate() }; }
const SUN = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
// End boundary is EXCLUSIVE (last second of the prior day) so a deal sold at
// exactly Monday 00:00 ET belongs only to the next week — never double-counted.
// This matches the Appt→Sales report's window exactly (it ends at …23:59:59).
const endExclusive = (midnightUTC) => new Date(midnightUTC.getTime() - 1000);
function currentWeek(now = new Date()) { const p = tzParts(now); const dowMon = ((SUN[p.weekday] ?? 0) + 6) % 7; const mon = addYMD(+p.year, +p.month, +p.day, -dowMon); const nextMon = addYMD(mon.y, mon.m, mon.d, 7); return { start: etMidnightUTC(mon.y, mon.m, mon.d), end: endExclusive(etMidnightUTC(nextMon.y, nextMon.m, nextMon.d)) }; }
// "Last week" = the Mon–Sun BEFORE the current (in-progress) Mon-anchored week
// — the last FULLY-completed week. This matches the Appt→Sales report's
// "lastweek" so the two reports line up. backWeeks shifts further back (◀ Older).
function lastWeek(now = new Date(), backWeeks = 0) {
  const p = tzParts(now);
  const dowMon = ((SUN[p.weekday] ?? 0) + 6) % 7;
  const mon = addYMD(+p.year, +p.month, +p.day, -dowMon - (backWeeks + 1) * 7);
  const nextMon = addYMD(mon.y, mon.m, mon.d, 7);
  return { start: etMidnightUTC(mon.y, mon.m, mon.d), end: endExclusive(etMidnightUTC(nextMon.y, nextMon.m, nextMon.d)) };
}
function monthRange(now = new Date()) { const p = tzParts(now); const start = etMidnightUTC(+p.year, +p.month, 1); const n = +p.month === 12 ? { y: +p.year + 1, m: 1 } : { y: +p.year, m: +p.month + 1 }; return { start, end: endExclusive(etMidnightUTC(n.y, n.m, 1)) }; }
function pickWindow(qp) {
  if (qp.start && qp.end) { const s = new Date(qp.start), e = new Date(qp.end); if (!Number.isNaN(s.getTime()) && !Number.isNaN(e.getTime())) return { start: s, end: e, period: "custom" }; }
  const wb = Number(qp.weeks_back); // 0 = last completed week, 1 = one before, … (UI ◀ ▶)
  if (Number.isFinite(wb) && wb >= 0) return { ...lastWeek(new Date(), Math.floor(wb)), period: wb === 0 ? "lastweek" : `-${Math.floor(wb)}w` };
  if (qp.period === "month") return { ...monthRange(), period: "month" };
  if (qp.period === "current") return { ...currentWeek(), period: "current" };
  if (qp.period === "prev") return { ...lastWeek(new Date(), 1), period: "prev" };
  return { ...lastWeek(), period: "lastweek" }; // default: last completed week (matches Appt→Sales)
}

function cors(status, body) {
  return { statusCode: status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" }, body };
}
