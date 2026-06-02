// Public, read-only zone leaderboard for the Sales Rep Dashboard.
//
// Returns each team's count of *signed inspections this week*, ranked
// high → low, so the dashboard can render a "1st SHARKS · 4 · 2nd
// SQUAD · 3 …" bar across the top. Lives on the claims site
// (free-roof-inspections.netlify.app) but is fetched cross-origin from
// the separate dashboard site, so CORS is open — the payload is
// aggregate counts only (no homeowner or rep names), nothing sensitive.
//
// "This week" = Monday 00:00 → Sunday 23:59 *America/New_York*, reset
// every Monday. This matches the window the admin app's My Stats
// leaderboard + weekly report use (App.jsx fetchMyStats), so the
// numbers agree across surfaces.
//
// "Signed inspection" = same metric as the app's weekly "submissions":
// inspections with a signed_at in the window, not cancelled, deduped
// per homeowner, keeping rows that either have a result or are still
// actively pending. Duplicated here rather than imported because this
// is a Netlify function and the React source isn't bundled.
//
// Zone resolution mirrors manager-records-api.js: bridge each signing's
// rep name → CCG sales_reps → TMS rep-zones → zone string. Unmatched
// reps land in "No Zone" and are not shown on the leaderboard.
//
// Request:  GET /.netlify/functions/zone-leaderboard
// Response: { ok, week: { start, end }, total, zones: [
//             { zone: 'Zone 3', team: 'SHARKS', count: 4, rank: 1 }, … ] }

const SB_URL = process.env.VITE_SUPABASE_URL
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY
const TMS_REP_ZONES_URL =
  'https://trainingmanagementsys.netlify.app/.netlify/functions/rep-zones'

// Team names per zone — mirrors TMS src/lib/zones.js ZONE_TEAMS. Zones
// without a named team fall back to the bare zone label.
const ZONE_TEAMS = {
  'Zone 1': 'SQUAD',
  'Zone 3': 'SHARKS',
  'Zone 4': 'HURRICANE',
}
// All zones we want to show even at zero, in display order. Keeps the
// bar stable Monday morning when nobody's signed yet.
const ZONE_ORDER = ['Zone 1', 'Zone 2', 'Zone 3', 'Zone 4']

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return cors(200, '')
  if (event.httpMethod !== 'GET') {
    return cors(405, JSON.stringify({ ok: false, error: 'Method Not Allowed' }))
  }
  if (!SB_URL || !SB_KEY) {
    return cors(500, JSON.stringify({ ok: false, error: 'Server misconfigured (missing Supabase env)' }))
  }

  try {
    const { start, end } = weekRange()

    // Pull every signed inspection in the window (cancelled excluded
    // server-side). Same column set the app's My Stats query uses.
    const rows = await fetchTable('inspections', {
      select:
        'id,sales_rep_id,sales_rep_name,signed_at,result,result_at,' +
        'client_name,address,zip,jn_status,cancelled_at',
      filter:
        `signed_at=gte.${encodeURIComponent(start.toISOString())}` +
        `&signed_at=lte.${encodeURIComponent(end.toISOString())}` +
        `&cancelled_at=is.null`,
      limit: 2000,
    })

    const signed = dedupSignings(rows)

    // rep (name or id) → zone
    const { byName, byId } = await fetchZoneMaps()

    const counts = {} // zone → count
    for (const r of signed) {
      const zone =
        (r.sales_rep_id != null && byId[String(r.sales_rep_id)]) ||
        byName[normalizeName(r.sales_rep_name)] ||
        null
      if (!zone) continue // No Zone — not shown
      counts[zone] = (counts[zone] || 0) + 1
    }

    // Build a row for every known zone (zero included), then rank.
    const zones = ZONE_ORDER.map((zone) => ({
      zone,
      team: ZONE_TEAMS[zone] || zone,
      count: counts[zone] || 0,
    }))
    // Highest count first; tie-break by zone order (stable sort keeps it).
    zones.sort((a, b) => b.count - a.count)
    zones.forEach((z, i) => { z.rank = i + 1 })

    const total = zones.reduce((s, z) => s + z.count, 0)

    return cors(200, JSON.stringify({
      ok: true,
      week: { start: start.toISOString(), end: end.toISOString() },
      total,
      zones,
    }))
  } catch (e) {
    return cors(500, JSON.stringify({ ok: false, error: e.message || 'Unknown error' }))
  }
}

// ────────────────────────────────────────────────────────────────────
// This-week window in America/New_York (Mon 00:00 → Sun 23:59:59).
// DST-safe: we resolve ET wall-clock components to UTC instants using
// the zone's actual offset at each boundary date.

const TZ = 'America/New_York'

function tzParts(date) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, hour12: false, weekday: 'short',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  })
  const p = {}
  for (const part of dtf.formatToParts(date)) p[part.type] = part.value
  return p
}

// ms to add to a UTC instant to read it as ET wall-clock (offset < 0).
function offsetMs(date) {
  const p = tzParts(date)
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second)
  return asUTC - date.getTime()
}

// Given ET wall-clock components, return the matching UTC instant.
function etWallToUTC(y, mo, d, h, mi, s) {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s)
  const off = offsetMs(new Date(guess))
  return new Date(guess - off)
}

function weekRange(now = new Date()) {
  const p = tzParts(now)
  const DOW = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 }
  const dow = DOW[p.weekday] ?? 0
  // Monday's ET calendar date = today − dow days (calendar math in UTC
  // on the ET Y/M/D to avoid DST hour drift).
  const base = new Date(Date.UTC(+p.year, +p.month - 1, +p.day))
  base.setUTCDate(base.getUTCDate() - dow)
  const start = etWallToUTC(base.getUTCFullYear(), base.getUTCMonth() + 1, base.getUTCDate(), 0, 0, 0)
  const endBase = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate()))
  endBase.setUTCDate(endBase.getUTCDate() + 6)
  const end = etWallToUTC(endBase.getUTCFullYear(), endBase.getUTCMonth() + 1, endBase.getUTCDate(), 23, 59, 59)
  return { start, end }
}

// ────────────────────────────────────────────────────────────────────
// Signed-inspection dedup — mirrors App.jsx dedupAndCount so the count
// equals the app's weekly "submissions" number.

function dedupSignings(rows) {
  const PENDING_STATUSES = new Set(['', 'needs inspection', 'new lead'])
  const isActivePending = (r) => {
    const st = (r.jn_status || '').trim().toLowerCase()
    return !r.result && PENDING_STATUSES.has(st)
  }
  const normKey = (n, zip, addr) => {
    const nn = (n || '').trim().toLowerCase().replace(/\s+/g, ' ')
    const z = (zip || '').trim()
    if (z) return `${nn}|zip:${z}`
    return `${nn}|st:${(addr || '').split(',')[0].trim().toLowerCase().replace(/\s+/g, ' ')}`
  }
  const groupByKey = new Map()
  for (const r of rows || []) {
    const k = normKey(r.client_name, r.zip, r.address)
    const ex = groupByKey.get(k)
    if (!ex) { groupByKey.set(k, r); continue }
    if (r.result && !ex.result) { groupByKey.set(k, r); continue }
    if (ex.result && !r.result) continue
    const tNew = r.result_at ? new Date(r.result_at).getTime() : (r.signed_at ? new Date(r.signed_at).getTime() : 0)
    const tOld = ex.result_at ? new Date(ex.result_at).getTime() : (ex.signed_at ? new Date(ex.signed_at).getTime() : 0)
    if (tNew > tOld) groupByKey.set(k, r)
  }
  return [...groupByKey.values()].filter((r) => r.result || isActivePending(r))
}

// ────────────────────────────────────────────────────────────────────
// Zone maps — CCG sales_reps bridged through TMS rep-zones. Returns
// { byName: { normalizedName → zone }, byId: { salesRepId → zone } }.

async function fetchZoneMaps() {
  // a) TMS reps → zone, keyed by JN id + normalized name.
  let tmsReps = []
  try {
    const res = await fetch(TMS_REP_ZONES_URL)
    if (res.ok) tmsReps = (await res.json()).reps || []
  } catch (e) {
    console.warn('TMS rep-zones fetch failed:', e.message || e)
  }
  const zoneByJnId = {}
  const zoneByNormName = {}
  for (const r of tmsReps) {
    if (r.jobnimbus_id) zoneByJnId[r.jobnimbus_id] = r.zone
    if (r.name) zoneByNormName[normalizeName(r.name)] = r.zone
  }

  // b) CCG sales_reps → zone via the bridge. Keyed by CCG id + name so
  //    inspections can match on either sales_rep_id or sales_rep_name.
  const salesReps = await fetchTable('sales_reps', { select: 'id,name,jobnimbus_id', limit: 1000 })
  const byName = {}
  const byId = {}
  for (const sr of salesReps || []) {
    const zone = (sr.jobnimbus_id && zoneByJnId[sr.jobnimbus_id]) || zoneByNormName[normalizeName(sr.name)] || null
    if (!zone) continue
    if (sr.name) byName[normalizeName(sr.name)] = zone
    if (sr.id != null) byId[String(sr.id)] = zone
  }
  return { byName, byId }
}

// Same normalization as manager-records-api.js / weekly report so name
// variants ('James "Jimmy" Bates' → 'james bates') collapse identically.
function normalizeName(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/["“”]([^"“”]*)["“”]/g, '')
    .replace(/'([^']*)'/g, '')
    .replace(/\(([^)]*)\)/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

async function fetchTable(table, { select, filter, limit }) {
  let url = `${SB_URL}/rest/v1/${table}?select=${encodeURIComponent(select)}`
  if (filter) url += `&${filter}`
  if (limit) url += `&limit=${limit}`
  const res = await fetch(url, {
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
  })
  if (!res.ok) {
    const txt = await res.text().catch(() => '')
    console.warn(`Supabase ${table} query failed: ${res.status} ${txt}`)
    return []
  }
  return await res.json().catch(() => [])
}

function cors(status, body) {
  return {
    statusCode: status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=60',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
    body,
  }
}
