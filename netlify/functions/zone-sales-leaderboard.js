// Public, read-only WEEKLY SALES leaderboard for the Sales Rep Dashboard.
//
// Sibling of zone-leaderboard.js (which counts signed *inspections*). This
// one counts *sales* — JobNimbus jobs that were SOLD this week — ranked by
// team so the dashboard can render a second "1st HURRICANE · 4 …" bar
// directly under the inspections bar. Same response shape, same Mon→Sun ET
// week, same zone-resolution bridge, so the two strips look identical.
//
// What counts as a weekly sale:
//   • The job's "Sold Date" (JN custom field, a unix-seconds timestamp —
//     same value as cf_date_5) falls inside this Mon→Sun ET week, AND
//   • the job's current status_name is one of the live "sold" statuses
//     (Sit Sold → Install Set). Lost/cancelled jobs never have a sold
//     status, so they're excluded automatically.
//
// Sold Date is the driver per the field team: a deal sold Monday still
// counts all week even after it advances to Job Prep / Install Set.
//
// Zone resolution: JN jobs carry the rep's JN id (sales_rep) + name
// (sales_rep_name) directly, so we map straight through the TMS rep-zones
// feed — no CCG sales_reps bridge needed. Jobs with no rep assigned (e.g.
// self-generated upgrades) can't be credited to a team and are not shown.
//
// Request:  GET /.netlify/functions/zone-sales-leaderboard   (?debug=1 for
//           a breakdown of the matched jobs)
// Response: { ok, week:{start,end}, total, zones:[
//             { zone:'Zone 4', team:'HURRICANE', count:4, rank:1 }, … ] }

const JN_BASE = 'https://app.jobnimbus.com/api1'
const JN_KEY = process.env.JOBNIMBUS_API_KEY
const TMS_REP_ZONES_URL =
  'https://trainingmanagementsys.netlify.app/.netlify/functions/rep-zones'

// Mirrors TMS src/lib/zones.js ZONE_TEAMS / zone-leaderboard.js.
const ZONE_TEAMS = {
  'Zone 1': 'SQUAD',
  'Zone 2': 'SitSold',
  'Zone 3': 'SHARKS',
  'Zone 4': 'HURRICANE',
}
const ZONE_ORDER = ['Zone 1', 'Zone 2', 'Zone 3', 'Zone 4']

// Current pipeline statuses that mean "this deal is sold" (lower-cased for
// a case-insensitive match). Add later stages here if sold jobs start
// advancing past Install Set within the same week.
const SOLD_STATUSES = new Set([
  'sit sold',
  'signed contract',
  'production review',
  'job prep',
  'upcoming installs',
  'install set',
])

const jnHeaders = {
  Authorization: `Bearer ${JN_KEY}`,
  'Content-Type': 'application/json',
}

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return cors(200, '')
  if (event.httpMethod !== 'GET') {
    return cors(405, JSON.stringify({ ok: false, error: 'Method Not Allowed' }))
  }
  if (!JN_KEY) {
    return cors(500, JSON.stringify({ ok: false, error: 'Server misconfigured (missing JOBNIMBUS_API_KEY)' }))
  }
  const debug = (event.queryStringParameters || {}).debug === '1'

  try {
    const { start, end } = weekRange()
    const startMs = start.getTime()
    const endMs = end.getTime()

    // Pull jobs touched since just before the week opened — any job sold
    // this week necessarily changed status (→ updated) this week, so this
    // window captures them all. 2-day pad guards ET/UTC + manual edits.
    const since = Math.floor(startMs / 1000) - 2 * 24 * 60 * 60
    const jobs = await fetchRecentJobs(since)

    const zoneOf = await fetchZoneResolver()

    const counts = {}
    const matched = []
    let unattributed = 0
    for (const j of jobs) {
      // Normalize the JN status before matching: JN names several stages
      // with separators/punctuation ("Sit - Sold", not "Sit Sold"), so a
      // plain lowercase compare missed sold deals. Collapse everything
      // non-alphanumeric to single spaces so "Sit - Sold" → "sit sold".
      const status = String(j.status_name || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim()
      if (!SOLD_STATUSES.has(status)) continue
      const soldMs = soldDateMs(j)
      if (soldMs == null || soldMs < startMs || soldMs > endMs) continue

      const zone = zoneOf(j.sales_rep, j.sales_rep_name)
      if (!zone) { unattributed++; if (debug) matched.push({ name: j.name, rep: j.sales_rep_name || null, status: j.status_name, sold: new Date(soldMs).toISOString(), zone: null }); continue }
      counts[zone] = (counts[zone] || 0) + 1
      if (debug) matched.push({ name: j.name, rep: j.sales_rep_name || null, status: j.status_name, sold: new Date(soldMs).toISOString(), zone })
    }

    const zones = ZONE_ORDER.map((zone) => ({
      zone,
      team: ZONE_TEAMS[zone] || zone,
      count: counts[zone] || 0,
    }))
    zones.sort((a, b) => b.count - a.count)
    zones.forEach((z, i) => { z.rank = i + 1 })

    const total = zones.reduce((s, z) => s + z.count, 0)

    const payload = {
      ok: true,
      week: { start: start.toISOString(), end: end.toISOString() },
      total,
      zones,
    }
    if (debug) {
      payload.scanned = jobs.length
      payload.unattributed = unattributed
      payload.matched = matched
    }
    return cors(200, JSON.stringify(payload))
  } catch (e) {
    return cors(500, JSON.stringify({ ok: false, error: e.message || 'Unknown error' }))
  }
}

// ────────────────────────────────────────────────────────────────────
// JN jobs — paged list, newest-updated first, bounded to the week window.

async function fetchRecentJobs(since) {
  const all = []
  const MAX_PAGES = 15
  for (let page = 0; page < MAX_PAGES; page++) {
    const from = page * 100
    const r = await fetch(
      `${JN_BASE}/jobs?size=100&from=${from}&sort=-date_updated&date_updated_after=${since}`,
      { headers: jnHeaders }
    )
    if (!r.ok) break
    const d = await r.json().catch(() => ({}))
    const rows = d.results || d.jobs || []
    all.push(...rows)
    if (rows.length < 100) break
  }
  return all
}

// "Sold Date" is exposed both as a labeled key and as cf_date_5; read
// whichever is present. Stored as unix *seconds* → ms (or null).
function soldDateMs(job) {
  const v = job['Sold Date'] != null ? job['Sold Date'] : job.cf_date_5
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n * 1000 : null
}

// ────────────────────────────────────────────────────────────────────
// Zone resolver — TMS rep-zones keyed by JN id + normalized name. Jobs
// carry the JN rep id directly, so no CCG sales_reps bridge is needed.

async function fetchZoneResolver() {
  let reps = []
  try {
    const res = await fetch(TMS_REP_ZONES_URL)
    if (res.ok) reps = (await res.json()).reps || []
  } catch (e) {
    console.warn('TMS rep-zones fetch failed:', e.message || e)
  }
  const byJnId = {}
  const byName = {}
  for (const r of reps) {
    if (r.jobnimbus_id) byJnId[r.jobnimbus_id] = r.zone
    if (r.name) byName[normalizeName(r.name)] = r.zone
  }
  return (jnId, name) =>
    (jnId && byJnId[jnId]) || byName[normalizeName(name)] || null
}

// Same normalization as zone-leaderboard.js / manager-records-api.js.
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

// ────────────────────────────────────────────────────────────────────
// This-week window in America/New_York (Mon 00:00 → Sun 23:59:59).
// Copied verbatim from zone-leaderboard.js so both bars share one week.

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

function offsetMs(date) {
  const p = tzParts(date)
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second)
  return asUTC - date.getTime()
}

function etWallToUTC(y, mo, d, h, mi, s) {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s)
  const off = offsetMs(new Date(guess))
  return new Date(guess - off)
}

function weekRange(now = new Date()) {
  const p = tzParts(now)
  const DOW = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 }
  const dow = DOW[p.weekday] ?? 0
  const base = new Date(Date.UTC(+p.year, +p.month - 1, +p.day))
  base.setUTCDate(base.getUTCDate() - dow)
  const start = etWallToUTC(base.getUTCFullYear(), base.getUTCMonth() + 1, base.getUTCDate(), 0, 0, 0)
  const endBase = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate()))
  endBase.setUTCDate(endBase.getUTCDate() + 6)
  const end = etWallToUTC(endBase.getUTCFullYear(), endBase.getUTCMonth() + 1, endBase.getUTCDate(), 23, 59, 59)
  return { start, end }
}

function cors(status, body) {
  return {
    statusCode: status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=120',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
    body,
  }
}
