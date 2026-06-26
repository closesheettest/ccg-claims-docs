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
  'in funding',
  'waiting on pace',
  'upcoming installs',
  'install set',
  // Post-install stages — still a sale, just further along. A deal sold this
  // month that advanced here (e.g. 2020 Providence Rd → Roof Started) was
  // dropping off the monthly count.
  'roof started',
  'new roof',
  'install complete collect payment', // "Install Complete - Collect Payment"
  'paid closed',          // "Paid & Closed"
  'upcoming commissions',
  'commission',           // "Commission" — post-sale commission stage
  'holds',                // "Holds" — special status, still a sale (sold date set)
  'extras',               // "Extras" — add-on/extra work, still a sale
])

// Exact JobNimbus status_name spellings for the sold stages — used to pull
// ONLY sold-stage jobs from JN by status, instead of scanning the 1,500
// most-recently-updated jobs of every status (which truncated and dropped
// real sold deals that hadn't been touched recently). The normalized
// SOLD_STATUSES set above still does the authoritative filter, so any
// over-match (e.g. "Sit - Sold" also returning "Sit Sold Insp") is dropped.
const SOLD_STATUS_NAMES = [
  'Sit - Sold',
  'Signed Contract',
  'Production Review',
  'Job Prep',
  'In Funding',
  'Waiting on PACE',
  'Upcoming Installs',
  'Install Set',
  'Roof Started',
  'New Roof',
  'Paid & Closed',
  'Upcoming Commissions',
  'Holds',
  'Extras',
]

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
    // Window selection, in priority order:
    //   1. explicit ?start=<ISO>&end=<ISO>  (any range — e.g. "last week")
    //   2. ?period=month                    (month-to-date)
    //   3. default                          (this Mon→Sun ET week)
    // Sold Date drives membership, so any window is computable from JN.
    const qp = event.queryStringParameters || {}
    let start, end, period
    if (qp.start && qp.end) {
      const s = new Date(qp.start), e = new Date(qp.end)
      if (!Number.isNaN(s.getTime()) && !Number.isNaN(e.getTime())) { start = s; end = e; period = 'custom' }
    }
    if (!start) {
      period = qp.period === 'month' ? 'month' : qp.period === 'lastweek' ? 'lastweek' : 'week'
      ;({ start, end } = period === 'month' ? monthRange() : period === 'lastweek' ? lastWeekRange() : weekRange())
    }
    const startMs = start.getTime()
    const endMs = end.getTime()

    // Pull jobs touched since just before the week opened — any job sold
    // this week necessarily changed status (→ updated) this week, so this
    // window captures them all. 2-day pad guards ET/UTC + manual edits.
    const since = Math.floor(startMs / 1000) - 2 * 24 * 60 * 60
    const jobs = await fetchSoldJobs(since)

    const zoneOf = await fetchZoneResolver()

    const counts = {}
    const dealsByZone = {} // zone → [{ rep, customer, amount }]
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
      // Per-deal detail for the dashboard drill-down. We deliberately show
      // the CUSTOMER NAME (primary contact), not the JN job name — job
      // names embed the street address and the dashboard is public.
      const rep = (j.sales_rep_name || '—').trim()
      const customer = (j.primary && j.primary.name ? String(j.primary.name) : '')
        .replace(/\s+/g, ' ').trim() || '—'
      const amount = Number(j.approved_estimate_total) || 0
      ;(dealsByZone[zone] = dealsByZone[zone] || []).push({ rep, customer, amount })
      if (debug) matched.push({ name: j.name, rep: j.sales_rep_name || null, status: j.status_name, sold: new Date(soldMs).toISOString(), zone })
    }

    const zones = ZONE_ORDER.map((zone) => {
      const deals = (dealsByZone[zone] || []).sort((a, b) => b.amount - a.amount)
      return {
        zone,
        team: ZONE_TEAMS[zone] || zone,
        count: counts[zone] || 0,
        total_amount: deals.reduce((s, d) => s + (d.amount || 0), 0),
        deals,
      }
    })
    zones.sort((a, b) => b.count - a.count)
    zones.forEach((z, i) => { z.rank = i + 1 })

    const total = zones.reduce((s, z) => s + z.count, 0)

    const payload = {
      ok: true,
      period,
      range: { start: start.toISOString(), end: end.toISOString() },
      week: { start: start.toISOString(), end: end.toISOString() }, // back-compat
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

// Pull jobs BY SOLD STATUS (server-side filter), updated since the window
// opened — so the scan only ever contains sold-stage jobs (a small set),
// never the 1,500-job cap of mixed statuses. One query per sold status;
// deduped by jnid. Each query is bounded by date_updated_after (a deal sold
// this week was necessarily touched this week) so volume stays tiny.
async function fetchSoldJobs(since) {
  const byId = new Map()
  for (const name of SOLD_STATUS_NAMES) {
    const filter = encodeURIComponent(JSON.stringify({ must: [{ match_phrase: { status_name: name } }] }))
    for (let page = 0; page < 20; page++) {
      const from = page * 100
      const r = await fetch(
        `${JN_BASE}/jobs?size=100&from=${from}&sort=-date_updated&date_updated_after=${since}&filter=${filter}`,
        { headers: jnHeaders }
      )
      if (!r.ok) break
      const d = await r.json().catch(() => ({}))
      const rows = d.results || d.jobs || []
      for (const j of rows) byId.set(j.jnid || j.id, j)
      if (rows.length < 100) break
    }
  }
  return [...byId.values()]
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

// Month-to-date: 1st of the current ET month 00:00 → now.
function monthRange(now = new Date()) {
  const p = tzParts(now)
  const start = etWallToUTC(+p.year, +p.month, 1, 0, 0, 0)
  return { start, end: now }
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

// Prior Mon–Sun week (this week's window shifted back 7 days) — Monday recap.
function lastWeekRange(now = new Date()) {
  const { start, end } = weekRange(now)
  return {
    start: new Date(start.getTime() - 7 * 24 * 60 * 60 * 1000),
    end: new Date(end.getTime() - 7 * 24 * 60 * 60 * 1000),
  }
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
