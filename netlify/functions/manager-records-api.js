// Backend for the zone-scoped Regional Manager Records page.
//
// The page lives at the homepage with ?manager=<token>. Token is the
// only auth — same pattern as the TMS /regional-manager/:token
// dashboard. Each of the four managers (Tony / Richard / Chad / Sam)
// has a row in CCG's regional_managers table with a UUID token; the
// URL goes in their phone, they tap it, the page renders only deals
// in their zone.
//
// Actions:
//   POST { action: 'whoami',  token }
//     → { ok, manager: { zone, name, phone } }
//   POST { action: 'records', token }
//     → { ok, manager, repsInZone: [name…], dealsByRep: {rep: [d…]},
//         pendingSignatures: [d…], totals: { … } }
//   POST { action: 'mark-jn-progress', token, id, fields }   (stamp JN push)
//   POST { action: 'update-deal', token, id, source, fields } (edit contact)
//   POST { action: 'mark-lost', token, id, source, reason }   (kill a deal)
//
// Zone resolution: rep name → TMS /rep-zones → zone string. Matches
// the same logic generate-weekly-report-pdf.js uses so the two views
// agree on who's in whose zone.
//
// Phase 1 is READ-ONLY. The page surfaces "Push to JN Photos",
// "Cert Now", and "Edit" buttons but they're stubbed in the UI;
// Phase 2 wires them to existing admin handlers.

const SB_URL = process.env.VITE_SUPABASE_URL
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY
const JN_BASE = 'https://app.jobnimbus.com/api1'
const JN_KEY = process.env.JOBNIMBUS_API_KEY
// The inbound setter (Viviana). Appointments she's still the JN owner of are the
// unrouted backlog — they surface in every manager's "needs" list to be assigned.
const SETTER_VIVIANA_ID = 'm3n90ppl4smcf6nasr1jgje'
const TMS_REP_ZONES_URL =
  'https://trainingmanagementsys.netlify.app/.netlify/functions/rep-zones'

// Florida territory model — a deal's zone is decided by WHERE THE PROPERTY IS
// (geocoded county → zone), used to route non-rep damage leads to the right
// zone manager. ⚠️ MIRRORS all-no-sits.js — keep the two maps in sync.
const ZONE_COUNTIES = {
  'Zone 1': ['Nassau', 'Duval', 'Baker', 'Union', 'Bradford', 'Clay', 'St. Johns', 'Putnam', 'Flagler', 'Alachua', 'Levy', 'Marion', 'Sumter', 'Lake', 'Seminole', 'Volusia'],
  'Zone 2': ['Pasco', 'Hillsborough', 'Polk', 'Osceola', 'Indian River', 'Highlands', 'Citrus', 'Hernando'],
  'Zone 3': ['Pinellas', 'Manatee', 'Sarasota', 'Charlotte', 'Lee', 'Collier', 'Monroe', 'Hardee', 'DeSoto', 'Glades', 'Hendry', 'St. Lucie', 'Okeechobee'],
  'Zone 4': ['Martin', 'Palm Beach', 'Broward', 'Miami-Dade'],
}
const ZONE_SPLIT_LAT = 28.55 // Brevard & Orange: north→Zone 1, south→Zone 2
const normCounty = (s) => String(s || '').toLowerCase().replace(/\bcounty\b/g, '').replace(/[^a-z0-9]+/g, ' ').trim()
const COUNTY_ZONE = (() => { const m = {}; for (const [z, cs] of Object.entries(ZONE_COUNTIES)) for (const c of cs) m[normCounty(c)] = z; return m })()
function countyToZone(county, lat) {
  const n = normCounty(county)
  if (!n) return 'Unassigned'
  if (n === 'brevard' || n === 'orange') return (lat != null && lat >= ZONE_SPLIT_LAT) ? 'Zone 1' : 'Zone 2'
  return COUNTY_ZONE[n] || 'Unassigned'
}

export const handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return json(405, { ok: false, error: 'Method Not Allowed' })
  }
  if (!SB_URL || !SB_KEY) {
    return json(500, { ok: false, error: 'Server misconfigured (missing Supabase env)' })
  }

  let body
  try {
    body = JSON.parse(event.body || '{}')
  } catch {
    return json(400, { ok: false, error: 'Invalid JSON body' })
  }

  const action = String(body.action || '').trim()
  const token = String(body.token || '').trim()
  if (!token) return json(400, { ok: false, error: 'token required' })

  // Validate the token → get the manager + their zone.
  const manager = await fetchManager(token)
  if (!manager) return json(401, { ok: false, error: 'Invalid token' })

  if (action === 'whoami') {
    return json(200, { ok: true, manager })
  }
  if (action === 'records') {
    return await buildRecords(manager)
  }
  if (action === 'mark-jn-progress') {
    return await markJnProgress(body)
  }
  if (action === 'update-deal') {
    return await updateDeal(body)
  }
  if (action === 'mark-lost') {
    return await markLost(body)
  }
  if (action === 'assign-lead') {
    return await assignLead(body)
  }
  if (action === 'list-appointments') {
    return await listAppointments(manager, body)
  }
  if (action === 'assign-appointment') {
    return await assignAppointment(manager, body)
  }
  return json(400, { ok: false, error: `Unknown action: ${action}` })
}

// Edit a deal's contact details from the manager page. Whitelisted
// fields only, mapped to the underlying table columns. Works on either
// the inspections or claims row depending on which source the deal came
// from. Token-gated (the manager is validated above).
async function updateDeal(body) {
  const id = body.id
  if (!id) return json(400, { ok: false, error: 'id required' })
  const table = body.source === 'claim' ? 'claims' : 'inspections'
  const f = body.fields || {}
  // manager-facing field → DB column
  const MAP = {
    homeowner_name: 'client_name',
    address: 'address',
    city: 'city',
    state: 'state',
    zip: 'zip',
    phone: 'mobile',
  }
  const patch = {}
  for (const [k, col] of Object.entries(MAP)) {
    if (f[k] !== undefined) patch[col] = f[k] === '' ? null : f[k]
  }
  if (Object.keys(patch).length === 0) {
    return json(400, { ok: false, error: 'no writable fields' })
  }
  const url = `${SB_URL}/rest/v1/${table}?id=eq.${encodeURIComponent(id)}`
  const res = await fetch(url, {
    method: 'PATCH',
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify(patch),
  })
  if (!res.ok) {
    const txt = await res.text().catch(() => '')
    return json(500, { ok: false, error: `update failed: ${res.status} ${txt}` })
  }
  return json(200, { ok: true })
}

// Mark a deal Lost from the manager page (e.g. a test deal that never
// should have been signed). DB-only path used for claim-track deals —
// inspection-track deals go through inspector-submit-result on the
// client so the Lost result also reflects into JobNimbus. Sets result =
// 'lost' + cancelled_at so the deal drops out of the attention list.
async function markLost(body) {
  const id = body.id
  if (!id) return json(400, { ok: false, error: 'id required' })
  const table = body.source === 'claim' ? 'claims' : 'inspections'
  const reason = String(body.reason || '').trim()
  if (!reason) return json(400, { ok: false, error: 'reason required' })
  const now = new Date().toISOString()
  const patch = { result: 'lost', result_at: now, cancelled_at: now }
  // lost_reason exists on inspections (written by inspector-submit-result);
  // don't write it to claims where the column may not exist.
  if (table === 'inspections') patch.lost_reason = reason
  const url = `${SB_URL}/rest/v1/${table}?id=eq.${encodeURIComponent(id)}`
  const res = await fetch(url, {
    method: 'PATCH',
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify(patch),
  })
  if (!res.ok) {
    const txt = await res.text().catch(() => '')
    return json(500, { ok: false, error: `mark-lost failed: ${res.status} ${txt}` })
  }
  return json(200, { ok: true })
}

// Assign a deal to a rep from the manager page. Sets the JobNimbus job's
// "Sales Rep" (sales_rep, a JN user id) and "Assigned To" (owners, an
// array of {id}) so the rep sees the job in JN — then reflects the new
// rep name onto our row so the lead drops out of "company leads" and
// lands in that rep's section on the next load. Token-gated above.
async function assignLead(body) {
  const id = body.id
  if (!id) return json(400, { ok: false, error: 'id required' })
  const jnJobId = String(body.jnJobId || '').trim()
  if (!jnJobId) {
    return json(400, { ok: false, error: 'This deal isn’t in JobNimbus yet — push it to JN first.' })
  }
  const salesRepJnId = String(body.salesRepJnId || '').trim()
  const salesRepName = String(body.salesRepName || '').trim()
  const assignedJnId = String(body.assignedJnId || '').trim()
  if (!salesRepJnId && !assignedJnId) {
    return json(400, { ok: false, error: 'Pick a rep to assign.' })
  }
  if (!JN_KEY) {
    return json(500, { ok: false, error: 'Server misconfigured (missing JobNimbus key)' })
  }

  // 1. Update the JN job. sales_rep + owners both take a JN user id.
  const putBody = { jnid: jnJobId }
  if (salesRepJnId) putBody.sales_rep = salesRepJnId
  if (assignedJnId) putBody.owners = [{ id: assignedJnId }]
  const jnRes = await fetch(`${JN_BASE}/jobs/${encodeURIComponent(jnJobId)}`, {
    method: 'PUT',
    headers: { Authorization: `bearer ${JN_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(putBody),
  })
  if (!jnRes.ok) {
    const txt = await jnRes.text().catch(() => '')
    return json(502, { ok: false, error: `JobNimbus update failed: ${jnRes.status} ${txt}` })
  }

  // 2. Reflect the new sales rep on our record so the lead moves into
  //    that rep's section (grouping is by sales_rep_name). Best-effort —
  //    the JN push already succeeded.
  if (salesRepName) {
    const table = body.source === 'claim' ? 'claims' : 'inspections'
    const patch = { sales_rep_name: salesRepName }
    if (salesRepJnId) patch.sales_rep_id = salesRepJnId
    const url = `${SB_URL}/rest/v1/${table}?id=eq.${encodeURIComponent(id)}`
    await fetch(url, {
      method: 'PATCH',
      headers: {
        apikey: SB_KEY,
        Authorization: `Bearer ${SB_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify(patch),
    }).catch(() => {})
  }
  return json(200, { ok: true })
}

// After a manager successfully pushes photos/cert to JN from the records
// page, persist the same "made it into JN" stamps the admin flow writes,
// so the push-status badges stick across a reload. Token-gated (the
// manager is already validated above). Only whitelisted timestamp columns
// can be written, and only on the inspections table.
async function markJnProgress(body) {
  const id = body.id
  if (!id) return json(400, { ok: false, error: 'id required' })
  const incoming = body.fields || {}
  const ALLOWED = ['jn_pushed_at', 'jn_cert_uploaded_at', 'jn_job_id']
  const patch = {}
  for (const k of ALLOWED) {
    if (incoming[k] !== undefined) patch[k] = incoming[k]
  }
  if (Object.keys(patch).length === 0) {
    return json(400, { ok: false, error: 'no writable fields' })
  }
  const url = `${SB_URL}/rest/v1/inspections?id=eq.${encodeURIComponent(id)}`
  const res = await fetch(url, {
    method: 'PATCH',
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify(patch),
  })
  if (!res.ok) {
    const txt = await res.text().catch(() => '')
    return json(500, { ok: false, error: `stamp failed: ${res.status} ${txt}` })
  }
  return json(200, { ok: true })
}

// ────────────────────────────────────────────────────────────────────
// Manager lookup

// ────────────────────────────────────────────────────────────────────
// Setter appointments → manager-assigns-a-rep flow.
//
// Setter bookings now land on the zone's regional manager (JN owner) with NO
// sales rep. listAppointments returns this manager's UNASSIGNED appointments
// (for the "Assign Appointments" section), his already-assigned upcoming ones
// (the "who's booked when" calendar), and his active reps (the dropdowns).
// assignAppointment writes the chosen OWNER + SALES REP back to the JN job and
// stamps the local row.

async function listAppointments(manager, body) {
  const zone = manager.zone
  const z = encodeURIComponent(zone)
  const view = ['today', 'tomorrow', 'needs'].includes(String(body && body.view)) ? body.view : 'needs'

  // Active reps in this manager's zone → the Owner + Sales Rep dropdowns.
  const repsInZone = await fetchRepsInZoneBridged(zone)
  const activeRows = await fetchTable('sales_reps', { select: 'name,jobnimbus_id,active', filter: 'active=eq.true', limit: 1000 })
  const activeJn = new Set((activeRows || []).map((r) => r.jobnimbus_id).filter(Boolean))
  const activeNames = new Set((activeRows || []).map((r) => normalizeName(r.name)).filter(Boolean))
  const reps = (repsInZone || [])
    .filter((r) => r.jobnimbus_id && (activeJn.has(r.jobnimbus_id) || activeNames.has(normalizeName(r.name))))
    .map((r) => ({ name: r.name, jobnimbus_id: r.jobnimbus_id }))
    .sort((a, b) => a.name.localeCompare(b.name))

  // ── Today / Tomorrow: the team's FULL appointment load for that day —
  //    app-booked (assigned or not) + whatever's already in JobNimbus for the
  //    team's reps (any source), merged + deduped by JN job. ──
  if (view === 'today' || view === 'tomorrow') {
    const { startIso, endIso, startSec, endSec } = etDayBounds(view === 'tomorrow' ? 1 : 0)
    const app = await fetchTable('setter_appointments', {
      select: 'id,homeowner_name,phone,address,appt_at,source,zone,jn_job_id,rep_jobnimbus_id,rep_name,owner_jobnimbus_id,owner_name',
      filter: `zone=eq.${z}&appt_at=gte.${encodeURIComponent(startIso)}&appt_at=lte.${encodeURIComponent(endIso)}`,
      order: 'appt_at.asc', limit: 300,
    })
    const appJobIds = new Set((app || []).map((a) => a.jn_job_id).filter(Boolean))
    const nameByJn = {}; for (const r of reps) nameByJn[r.jobnimbus_id] = r.name
    const jn = await jnTeamAppointments(reps.map((r) => r.jobnimbus_id), startSec, endSec, nameByJn)
    const items = []
    for (const a of (app || [])) {
      items.push({
        key: 'app:' + a.id, source: 'app', id: a.id, jn_job_id: a.jn_job_id || null,
        homeowner: a.homeowner_name, address: a.address, appt_at: a.appt_at, src: a.source || null,
        owner_id: a.owner_jobnimbus_id || null, owner_name: a.owner_name || null,
        sales_rep_id: a.rep_jobnimbus_id || null, sales_rep_name: a.rep_name || null,
        needs_assignment: !a.rep_jobnimbus_id,
      })
    }
    for (const t of jn) {
      if (t.job_id && appJobIds.has(t.job_id)) continue // already shown via the app row
      items.push({
        key: 'jn:' + t.id, source: 'jn', id: null, jn_job_id: t.job_id || null,
        homeowner: t.homeowner, address: null, appt_at: t.appt_at, src: 'JobNimbus',
        owner_id: t.owner_id || null, owner_name: t.owner_name || null,
        sales_rep_id: t.sales_rep_id || null, sales_rep_name: t.sales_rep_name || null,
        needs_assignment: !t.sales_rep_id,
      })
    }
    items.sort((x, y) => new Date(x.appt_at) - new Date(y.appt_at))
    return json(200, { ok: true, zone, view, reps, items })
  }

  // ── Default 'needs': everything awaiting a rep (any day) + assigned upcoming. ──
  const nowIso = new Date().toISOString()
  const unassigned = await fetchTable('setter_appointments', {
    select: 'id,homeowner_name,phone,address,appt_at,source,zone,jn_job_id',
    filter: `zone=eq.${z}&rep_jobnimbus_id=is.null&appt_at=gte.${encodeURIComponent(nowIso)}`,
    order: 'appt_at.asc', limit: 200,
  })
  const assigned = await fetchTable('setter_appointments', {
    select: 'id,homeowner_name,address,appt_at,rep_name,rep_jobnimbus_id,owner_name',
    filter: `zone=eq.${z}&rep_jobnimbus_id=not.is.null&appt_at=gte.${encodeURIComponent(nowIso)}`,
    order: 'appt_at.asc', limit: 300,
  })
  // Viviana backlog: JobNimbus appointments still owned by the setter (not yet
  // routed to a rep), today → +90 days, sorted by date. Shown to every manager.
  const { startSec } = etDayBounds(0)
  // Enrich (fetch each job) so the homeowner NAME shows — the appointment task
  // title is just "Initial Appointment"; the homeowner lives on the job.
  const vivRaw = await jnTeamAppointments([SETTER_VIVIANA_ID], startSec, startSec + 90 * 86400, {}, true)
  const viviana = vivRaw
    .map((t) => ({ key: 'viv:' + t.id, source: 'jn', id: null, jn_job_id: t.job_id || null, homeowner: t.homeowner, address: null, appt_at: t.appt_at, src: 'Viviana', owner_id: t.owner_id || null, owner_name: t.owner_name || 'Viviana', sales_rep_id: null, sales_rep_name: null, needs_assignment: true }))
    .sort((a, b) => new Date(a.appt_at) - new Date(b.appt_at))
  return json(200, { ok: true, zone, view: 'needs', reps, unassigned: unassigned || [], assigned: assigned || [], viviana })
}

// ET day window for today (offset 0) / tomorrow (offset 1). Netlify runs in UTC.
function etDayBounds(offsetDays) {
  const d = new Date(Date.now() + offsetDays * 86400000)
  const ymd = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(d) // YYYY-MM-DD
  const off = new Date(d.toLocaleString('en-US', { timeZone: 'UTC' })).getTime() - new Date(d.toLocaleString('en-US', { timeZone: 'America/New_York' })).getTime()
  const start = Date.parse(`${ymd}T00:00:00.000Z`) + off
  const end = start + 86400000 - 1
  return { startIso: new Date(start).toISOString(), endIso: new Date(end).toISOString(), startSec: Math.floor(start / 1000), endSec: Math.floor(end / 1000) }
}

// JN appointment tasks owned by any of the team's reps in [startSec, endSec],
// enriched with each task's JOB so we get the OWNER + SALES REP + homeowner
// (sales_rep lives on the job, not the appointment task). Per-rep `term` task
// query + a batched job fetch, all parallel.
async function jnTeamAppointments(ownerIds, startSec, endSec, nameByJn = {}, enrich = true) {
  if (!JN_KEY || !ownerIds.length) return []
  const headers = { Authorization: `bearer ${JN_KEY}` }
  const cleanName = (title) => title.replace(/^.*?appointment\s*[—-]\s*/i, '').trim() || title || 'Appointment'
  const tasksFor = async (rid) => {
    try {
      const filter = encodeURIComponent(JSON.stringify({ must: [{ range: { date_start: { gte: startSec, lte: endSec } } }, { term: { 'owners.id': rid } }] }))
      const r = await fetch(`${JN_BASE}/tasks?size=200&filter=${filter}`, { headers })
      if (!r.ok) return []
      const d = await r.json().catch(() => ({}))
      return d.results || d.tasks || d.data || []
    } catch { return [] }
  }
  const tasks = (await Promise.all(ownerIds.map(tasksFor))).flat()
  const seen = new Set(); const appts = []
  for (const t of tasks) {
    const tid = t.jnid || t.id
    if (!tid || seen.has(tid)) continue; seen.add(tid)
    if (!/appoint/i.test(String(t.record_type_name || t.title || ''))) continue
    const job = (t.related || []).find((x) => x.type === 'job') || {}
    const owner = (t.owners || [])[0] || {}
    appts.push({ task_id: tid, job_id: job.id || null, appt_at: new Date((Number(t.date_start) || 0) * 1000).toISOString(), title: String(t.title || ''), t_owner_id: owner.id || null, t_owner_name: owner.name || null })
  }
  // Light path (no job fetch) — used for the Viviana backlog (all unassigned).
  if (!enrich) {
    return appts.map((a) => ({
      id: a.task_id, job_id: a.job_id, appt_at: a.appt_at, homeowner: cleanName(a.title),
      owner_id: a.t_owner_id, owner_name: nameByJn[a.t_owner_id] || a.t_owner_name || null,
      sales_rep_id: null, sales_rep_name: null,
    }))
  }
  // Enriched — fetch each job for the OWNER + SALES REP + homeowner name.
  const jobIds = [...new Set(appts.map((a) => a.job_id).filter(Boolean))].slice(0, 60)
  const jobById = {}
  await Promise.all(jobIds.map(async (jid) => {
    try { const r = await fetch(`${JN_BASE}/jobs/${encodeURIComponent(jid)}`, { headers }); if (r.ok) jobById[jid] = await r.json().catch(() => null) } catch { /* skip */ }
  }))
  return appts.map((a) => {
    const j = jobById[a.job_id] || {}
    const ownerId = ((j.owners || [])[0] || {}).id || a.t_owner_id || null
    const repId = j.sales_rep || null
    return {
      id: a.task_id, job_id: a.job_id, appt_at: a.appt_at, homeowner: j.name || cleanName(a.title),
      owner_id: ownerId, owner_name: nameByJn[ownerId] || ((j.owners || [])[0] || {}).name || a.t_owner_name || null,
      sales_rep_id: repId, sales_rep_name: j.sales_rep_name || nameByJn[repId] || null,
    }
  })
}

async function assignAppointment(manager, body) {
  const ownerJnId = String(body.owner_jn_id || '').trim()
  const ownerName = String(body.owner_name || '').trim()
  const repJnId = String(body.sales_rep_jn_id || '').trim()
  const repName = String(body.sales_rep_name || '').trim()
  if (!ownerJnId || !repJnId) return json(400, { ok: false, error: 'Pick both an owner and a sales rep.' })
  if (!JN_KEY) return json(500, { ok: false, error: 'Server misconfigured (missing JobNimbus key)' })

  const apptId = String(body.appt_id || '').trim()
  let jobId = null, appt = null
  if (apptId) {
    // App appointment — load the row + verify zone, then update its job + stamp it.
    const rows = await fetchTable('setter_appointments', { select: 'id,zone,jn_job_id', filter: `id=eq.${encodeURIComponent(apptId)}`, limit: 1 })
    appt = (rows || [])[0]
    if (!appt) return json(404, { ok: false, error: 'Appointment not found' })
    if (appt.zone && manager.zone && appt.zone !== manager.zone) return json(403, { ok: false, error: 'That appointment isn’t in your zone.' })
    if (!appt.jn_job_id) return json(400, { ok: false, error: 'This appointment has no JobNimbus job to update.' })
    jobId = appt.jn_job_id
  } else {
    // JobNimbus-only row (reassign an existing JN appointment). Verify the job
    // currently belongs to one of THIS manager's zone reps before touching it.
    jobId = String(body.jn_job_id || '').trim()
    if (!jobId) return json(400, { ok: false, error: 'appt_id or jn_job_id required' })
    const reps = await fetchRepsInZoneBridged(manager.zone)
    const zoneJn = new Set((reps || []).map((r) => r.jobnimbus_id).filter(Boolean))
    try {
      const jr = await fetch(`${JN_BASE}/jobs/${encodeURIComponent(jobId)}`, { headers: { Authorization: `bearer ${JN_KEY}` } })
      const j = jr.ok ? await jr.json().catch(() => ({})) : {}
      const ownerIds = (j.owners || []).map((o) => o.id)
      // In zone if a zone rep owns it / sells it — OR it's the Viviana backlog
      // (still owned by the setter), which any manager may claim + assign.
      const inZone = ownerIds.some((id) => zoneJn.has(id)) || (j.sales_rep && zoneJn.has(j.sales_rep)) || ownerIds.includes(SETTER_VIVIANA_ID)
      if (!inZone) return json(403, { ok: false, error: 'That job isn’t in your zone.' })
    } catch { return json(502, { ok: false, error: 'Could not verify the JobNimbus job.' }) }
  }

  // JobNimbus: set the owner + sales rep on the job.
  const putBody = { jnid: jobId, owners: [{ id: ownerJnId }], sales_rep: repJnId }
  const jnRes = await fetch(`${JN_BASE}/jobs/${encodeURIComponent(jobId)}`, {
    method: 'PUT', headers: { Authorization: `bearer ${JN_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(putBody),
  })
  if (!jnRes.ok) { const t = await jnRes.text().catch(() => ''); return json(502, { ok: false, error: `JobNimbus update failed: ${jnRes.status} ${t}` }) }

  // Stamp the local row (app appointments only) so it reflects the assignment.
  if (appt) {
    const patch = { owner_jobnimbus_id: ownerJnId, owner_name: ownerName || null, rep_jobnimbus_id: repJnId, rep_name: repName || null, assigned_at: new Date().toISOString() }
    await fetch(`${SB_URL}/rest/v1/setter_appointments?id=eq.${encodeURIComponent(apptId)}`, {
      method: 'PATCH', headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' }, body: JSON.stringify(patch),
    }).catch(() => {})
  }
  return json(200, { ok: true, assigned: { owner: ownerName, sales_rep: repName } })
}

async function fetchManager(token) {
  const url =
    `${SB_URL}/rest/v1/regional_managers` +
    `?token=eq.${encodeURIComponent(token)}` +
    `&select=id,zone,name,phone&limit=1`
  const res = await fetch(url, {
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
  })
  if (!res.ok) return null
  const rows = await res.json().catch(() => [])
  return rows[0] || null
}

// ────────────────────────────────────────────────────────────────────
// Records build — Phase 1 read-only

async function buildRecords(manager) {
  // 1. Get every rep in this manager's zone, bridged through CCG's
  //    sales_reps table so we use CCG-side names (CCG is the constant
  //    per Neal — TMS names like 'James "Jimmy" Bates' don't always
  //    match the claims table's 'James Bates'). Bridge logic:
  //      TMS rep.jobnimbus_id + .name + .zone
  //        →  match against CCG sales_reps (jobnimbus_id primary,
  //           normalized name fallback)
  //        →  resulting CCG names get used in the IN filter below.
  //    Same pattern as generate-weekly-report-pdf.js so the two
  //    surfaces agree on who's in whose zone.
  const repsInZone = await fetchRepsInZoneBridged(manager.zone)

  // 2. Pull all relevant claims + inspections for those reps. We pull
  //    a fixed-size window (latest 500 per source) so the page stays
  //    fast even after a year of activity. Filter happens server-side.
  const repNames = repsInZone.map((r) => r.name).filter(Boolean)
  if (repNames.length === 0) {
    return json(200, {
      ok: true,
      manager,
      repsInZone: [],
      dealsByRep: {},
      pendingSignatures: [],
      totals: { deals: 0, pending_signatures: 0, needs_attention: 0 },
      message:
        'No reps mapped to this zone yet. As Hiring Manager assigns reps to your zone in TMS, ' +
        'they\'ll appear here.',
    })
  }

  // PostgREST `in.(name1,name2,…)` filter on sales_rep_name.
  const repListParam = repNames.map((n) => `"${n.replace(/"/g, '\\"')}"`).join(',')

  // Order by id desc as a proxy for "newest first" — id is a serial
  // primary key so it correlates with creation time, AND unlike
  // signed_at/result_at it has no NULLs that get demoted to the
  // bottom (which is what was hiding unsigned deals from the list).
  const [claims, inspections, salesRepRows] = await Promise.all([
    fetchTable('claims', {
      select:
        'id,client_name,address,city,state,zip,mobile,sales_rep_name,sales_rep_id,' +
        'signed_at,result,result_at,jn_status,jn_job_id,docs_signed,signed_pdfs,cancelled_at',
      filter: `sales_rep_name=in.(${repListParam})`,
      order: 'id.desc',
      limit: 500,
    }),
    fetchTable('inspections', {
      select:
        'id,client_name,address,city,state,zip,mobile,sales_rep_name,sales_rep_email,' +
        'inspection_result,result,result_at,signed_at,jn_status,jn_job_id,docs_signed,signed_pdfs,cancelled_at,' +
        // PA outcome + real JN-push timestamps (these columns live on
        // inspections, not claims — claim rows leave them null).
        'pa_status,pa_decision_at,pa_decision_reason,jn_pushed_at,jn_cert_uploaded_at',
      filter: `sales_rep_name=in.(${repListParam})`,
      order: 'id.desc',
      limit: 500,
    }),
    // "Inactive" = a rep the manager explicitly turned OFF in the in-app
    // Sales Rep Manager screen (its Deactivate button writes
    // sales_reps.active = false). That toggle is the ONLY signal.
    //
    // ⚠️ Do NOT use the `inspectors` table's `active` flag here — it means
    // "activated as an inspector" (home address confirmed), which is false
    // for ~140 of 147 real reps. Using it hid almost every rep's deals.
    fetchTable('sales_reps', { select: 'name,jobnimbus_id,active', limit: 1000 }),
  ])

  const inactiveNames = new Set()
  const inactiveJnIds = new Set()
  const activeNames = new Set()
  const activeJnIds = new Set()
  for (const r of salesRepRows || []) {
    if (r.active === false) {
      if (r.name) inactiveNames.add(normalizeName(r.name))
      if (r.jobnimbus_id) inactiveJnIds.add(r.jobnimbus_id)
    } else if (r.active === true) {
      if (r.name) activeNames.add(normalizeName(r.name))
      if (r.jobnimbus_id) activeJnIds.add(r.jobnimbus_id)
    }
  }
  const isInactiveSigner = (d) =>
    (d.sales_rep_id && inactiveJnIds.has(d.sales_rep_id)) ||
    inactiveNames.has(normalizeName(d.sales_rep_name || ''))
  // "Not an active sales rep" — the trigger for routing a damage deal to the
  // zone manager's pool. Covers inactive reps (William) AND signers absent from
  // the roster entirely (inspectors/trainers). Active = an active sales_reps row.
  const isActiveSigner = (d) =>
    (d.sales_rep_id && activeJnIds.has(d.sales_rep_id)) ||
    activeNames.has(normalizeName(d.sales_rep_name || ''))
  const isRetail = (d) => /retail/i.test(String(d.inspection_result || d.result || ''))
  const isLost = (d) => /lost/i.test(String(d.inspection_result || d.result || ''))
  // Damage = the word "damage" but NOT "no damage" (which contains it).
  const isDamage = (d) => {
    const r = String(d.inspection_result || d.result || '')
    return /damage/i.test(r) && !/no\s*damage/i.test(r)
  }
  // 3. Merge claims + inspections into a normalized "deal" shape so
  //    the UI doesn't have to special-case both. Inspection-only deals
  //    (didn't progress to PA forms) and claim-track deals both fit
  //    the same row layout — the bucketing tells them apart.
  const deals = []
  for (const c of claims || []) deals.push(normalizeDeal(c, 'claim'))
  for (const i of inspections || []) {
    // Dedup — if a claim and an inspection have the same jn_job_id,
    // prefer the claim row (it carries the LOR/PAC state). Otherwise
    // keep the inspection. Without dedup the same homeowner would
    // appear twice on the page.
    const dupe = deals.find(
      (d) => d.jn_job_id && d.jn_job_id === i.jn_job_id,
    )
    if (!dupe) deals.push(normalizeDeal(i, 'inspection'))
  }

  // 4. Bucket: pending signatures vs. needs attention vs. clean.
  const pendingSignatures = []
  for (const d of deals) {
    if (d.cancelled_at) continue
    if (isPendingSignatures(d)) {
      pendingSignatures.push(d)
    }
  }

  // 4b. Company leads to pass out: inspections signed by an inactive/departed
  //     rep. These aren't anyone's deal to work yet — they get pinned to the top
  //     of the manager page for reassignment to an active rep, and are pulled OUT
  //     of the per-rep grouping so an inactive person never shows as a working
  //     sales rep. A non-rep never appears as a working rep: ALL of their deals
  //     are hidden from per-rep grouping (hiddenInactiveKeys). Of those, the
  //     actionable ones surface as company leads —
  //       • Retail → hand to a rep to sell      (company_lead_kind 'retail')
  //       • Damage → hand to a rep to book the   (company_lead_kind 'damage')
  //                  adjuster appointment
  //     No Damage / still-unsigned from a non-rep stays hidden.
  //     (This loop only covers signers already in this zone's rep list; never-
  //      zoned signers like trainers are routed by county in 4b-2 below.)
  const companyLeads = []
  const companyLeadKeys = new Set()
  const hiddenInactiveKeys = new Set()
  for (const d of deals) {
    if (d.cancelled_at) continue
    if (!isInactiveSigner(d)) continue
    // Non-rep — never show them as a working sales rep.
    hiddenInactiveKeys.add(`${d.source}:${d.id}`)
    if (isLost(d)) continue
    if (isRetail(d)) {
      d.company_lead_kind = 'retail'
      companyLeads.push(d)
      companyLeadKeys.add(`${d.source}:${d.id}`)
    } else if (isDamage(d)) {
      // Damage from a non-active rep now routes straight to the manager pool to
      // assign — no longer gated on insurance approval. A rep takes it over and
      // books the adjuster appointment, off the PAs' plates.
      d.company_lead_kind = 'damage'
      companyLeads.push(d)
      companyLeadKeys.add(`${d.source}:${d.id}`)
    }
    // else: No Damage / still-unsigned from a non-rep stays hidden.
  }

  // 4b-2. Non-rep DAMAGE deals routed by the HOMEOWNER'S COUNTY (not the
  //   signer's zone). The loop above only sees deals signed by reps already in
  //   THIS zone; a never-zoned signer like William (trainer) would otherwise land
  //   in no manager's pool. So pull every signed damage inspection whose signer
  //   isn't an active rep and whose property county maps to this manager's zone,
  //   and surface it as a 'damage' company lead. PAs are left alone: any deal that
  //   already has an upcoming PA appointment is skipped (they keep working it).
  if (manager.zone && manager.zone !== 'Unassigned') {
    const since = new Date(Date.now() - 180 * 864e5).toISOString()
    const nonRepDamage = await fetchTable('inspections', {
      select:
        'id,client_name,address,city,state,zip,county,latitude,mobile,sales_rep_name,sales_rep_id,sales_rep_email,' +
        'inspection_result,result,result_at,signed_at,jn_status,jn_job_id,docs_signed,signed_pdfs,cancelled_at,' +
        'pa_status,pa_decision_at,pa_decision_reason,jn_pushed_at,jn_cert_uploaded_at',
      filter: `result=eq.damage&signed_at=not.is.null&cancelled_at=is.null&signed_at=gte.${since}`,
      order: 'id.desc',
      limit: 1000,
    })
    // Candidates for THIS zone whose signer isn't an active rep.
    const zoneCands = (nonRepDamage || []).filter(
      (r) => !r.cancelled_at && countyToZone(r.county, r.latitude) === manager.zone &&
        !isActiveSigner({ sales_rep_id: r.sales_rep_id, sales_rep_name: r.sales_rep_name }),
    )
    // Drop any that already have an upcoming PA appointment — leave those with the PA.
    const paBusy = new Set()
    const candIds = zoneCands.map((r) => r.id)
    if (candIds.length) {
      const appts = await fetchTable('pa_appointments', {
        select: 'inspection_id',
        filter: `status=eq.scheduled&start_at=gte.${new Date().toISOString()}&inspection_id=in.(${candIds.join(',')})`,
        limit: 5000,
      })
      for (const a of appts || []) if (a.inspection_id) paBusy.add(a.inspection_id)
    }
    const existingJobIds = new Set(deals.map((d) => d.jn_job_id).filter(Boolean))
    for (const r of zoneCands) {
      const d = normalizeDeal(r, 'inspection')
      const key = `${d.source}:${d.id}`
      if (paBusy.has(d.id)) continue                              // PA has an appointment → leave it
      if (companyLeadKeys.has(key)) continue                      // already surfaced via the zone-rep path
      if (d.jn_job_id && existingJobIds.has(d.jn_job_id)) continue // dup of a loaded deal
      d.company_lead_kind = 'damage'
      d.zone_routed = true
      companyLeads.push(d)
      companyLeadKeys.add(key)
      hiddenInactiveKeys.add(key)
    }
  }

  // 4c. Cancelled deals get their own bucket — pulled out of every rep
  //     group (and out of company leads) so a dead deal never clutters a
  //     rep's active work or keeps an inactive rep on the page. Shown in a
  //     separate collapsed "Cancelled" section at the bottom.
  const cancelledDeals = []
  const cancelledKeys = new Set()
  for (const d of deals) {
    if (d.cancelled_at) {
      cancelledDeals.push(d)
      cancelledKeys.add(`${d.source}:${d.id}`)
    }
  }

  // 5. Group by rep — sorted by deal count desc so the busiest reps
  //    bubble up. Within each rep, deals are already in date-desc
  //    order from the PostgREST query. Cancelled deals and every deal
  //    from a non-rep (company leads + hidden in-progress alike) are
  //    excluded.
  const dealsByRep = {}
  for (const d of deals) {
    if (cancelledKeys.has(`${d.source}:${d.id}`)) continue
    if (hiddenInactiveKeys.has(`${d.source}:${d.id}`)) continue
    const rep = d.sales_rep_name || '— Unknown —'
    if (!dealsByRep[rep]) dealsByRep[rep] = []
    dealsByRep[rep].push(d)
  }
  // Which of the remaining rep groups are inactive people (so the UI can
  // grey them out / tag them rather than show a green "active rep" dot).
  const inactiveReps = Object.keys(dealsByRep).filter((rep) =>
    inactiveNames.has(normalizeName(rep)),
  )

  // Active, in-zone reps that have a JobNimbus user id — the choices the
  // manager picks from when assigning a company lead. Excludes anyone
  // flipped inactive in either roster and anyone missing a JN id (can't
  // push without one).
  const assignableReps = (repsInZone || [])
    .filter((r) => r.name && r.jobnimbus_id && !inactiveNames.has(normalizeName(r.name)))
    .map((r) => ({ name: r.name, jobnimbus_id: r.jobnimbus_id }))
    .sort((a, b) => a.name.localeCompare(b.name))

  const totals = {
    deals: deals.length,
    pending_signatures: pendingSignatures.length,
    needs_attention: deals.filter(
      (d) => !hiddenInactiveKeys.has(`${d.source}:${d.id}`) && needsAttention(d),
    ).length,
    company_leads: companyLeads.length,
    cancelled: cancelledDeals.length,
    reps: Object.keys(dealsByRep).length,
  }

  return json(200, {
    ok: true,
    manager,
    repsInZone,
    dealsByRep,
    companyLeads,
    cancelledDeals,
    inactiveReps,
    assignableReps,
    pendingSignatures,
    totals,
  })
}

// ────────────────────────────────────────────────────────────────────
// Helpers

// Bridged rep → zone lookup. Returns CCG-side rep names that belong
// to the target zone. Mirrors generate-weekly-report-pdf.js so both
// surfaces resolve the same way.
//
// Resolution order per CCG sales_reps row:
//   1. jobnimbus_id match against TMS (most reliable — JN IDs don't
//      have nickname noise)
//   2. normalized-name match against TMS (strips quoted/parenthetical
//      nicknames: 'James "Jimmy" Bates' → 'james bates')
// If neither matches, the rep falls into "No Zone" and won't show on
// any manager view — admin needs to backfill their JN ID in TMS.
async function fetchRepsInZoneBridged(targetZone) {
  // a) TMS reps → maps from JN ID + normalized name to zone string
  let tmsReps = []
  try {
    const res = await fetch(TMS_REP_ZONES_URL)
    if (res.ok) {
      const j = await res.json()
      tmsReps = j.reps || []
    }
  } catch (e) {
    console.warn('TMS rep-zones fetch failed:', e.message || e)
  }
  const zoneByJnId = {}
  const zoneByNormalizedName = {}
  for (const r of tmsReps) {
    if (r.jobnimbus_id) zoneByJnId[r.jobnimbus_id] = r.zone
    if (r.name) zoneByNormalizedName[normalizeName(r.name)] = r.zone
  }

  // b) CCG sales_reps — our local roster of who's allowed to sign
  //    homeowners. Use their CCG-side name in the claims filter.
  const salesReps = await fetchTable('sales_reps', {
    select: 'name,jobnimbus_id',
    limit: 1000,
  })
  const result = []
  for (const sr of salesReps || []) {
    if (!sr.name) continue
    const jnZone = sr.jobnimbus_id ? zoneByJnId[sr.jobnimbus_id] : null
    const nameZone = zoneByNormalizedName[normalizeName(sr.name)]
    const zone = jnZone || nameZone
    if (zone === targetZone) {
      result.push({ name: sr.name, jobnimbus_id: sr.jobnimbus_id || null })
    }
  }
  return result
}

// Normalize for fuzzy name matching across systems. Strips:
//   • Quoted nicknames:  James "Jimmy" Bates → James Bates
//   • Parenthetical:     Mike (Junior) Smith → Mike Smith
//   • Curly quotes:      James "Jimmy" Bates → James Bates
//   • Punctuation, multi-space, case
// Same shape as the function in generate-weekly-report-pdf.js so the
// two surfaces collapse identical name variants to the same key.
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

async function fetchTable(table, { select, filter, order, limit }) {
  let url = `${SB_URL}/rest/v1/${table}?select=${encodeURIComponent(select)}`
  if (filter) url += `&${filter}`
  if (order) url += `&order=${encodeURIComponent(order)}`
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

// Normalize claim and inspection rows to a shared deal shape so the UI
// doesn't have to know which table they came from.
function normalizeDeal(row, source) {
  return {
    id: row.id,
    source, // 'claim' | 'inspection'
    homeowner_name: row.client_name || '',
    address: row.address || '',
    city: row.city || '',
    state: row.state || '',
    zip: row.zip || '',
    phone: row.mobile || '',
    sales_rep_name: row.sales_rep_name || '',
    sales_rep_email: row.sales_rep_email || null,
    sales_rep_id: row.sales_rep_id || null,
    inspection_result: row.inspection_result || row.result || null,
    result_at: row.result_at || null,
    signed_at: row.signed_at || null,
    jn_status: row.jn_status || null,
    jn_job_id: row.jn_job_id || null,
    docs_signed: row.docs_signed || null, // comma-separated 'insp,lor,pac'
    signed_pdfs: row.signed_pdfs || null, // jsonb / array of urls
    cancelled_at: row.cancelled_at || null,
    // PA outcome (inspections only) — the public-adjuster decision.
    pa_status: row.pa_status || null,
    pa_decision_at: row.pa_decision_at || null,
    pa_decision_reason: row.pa_decision_reason || null,
    // Real "made it into JN" timestamps — drive the push-status badges
    // and the enable/disable state of the per-deal push buttons.
    jn_pushed_at: row.jn_pushed_at || null,
    jn_cert_uploaded_at: row.jn_cert_uploaded_at || null,
  }
}

// A deal is "pending signatures" if the homeowner started signing
// (docs_signed includes 'lor' or 'pac' indicating PA forms were
// requested) BUT signed_at is NULL — meaning the signing flow didn't
// complete. This mirrors the stuck-state we fixed manually for
// Noel / Crystal / Marc earlier (docs_signed='insp,lor,pac', signed_at=NULL).
function isPendingSignatures(d) {
  const docs = String(d.docs_signed || '').toLowerCase()
  const wantsPaForms = docs.includes('lor') || docs.includes('pac')
  if (!wantsPaForms) return false
  return !d.signed_at
}

// A deal "needs attention" iff the manager actually owes a JobNimbus
// push on it — kept in lockstep with the frontend's actionFor().need so
// the top "Needs attention (N)" count matches the per-rep group counts.
// The manager's only jobs are getting photos + the certificate into JN;
// LOR/PAC signatures are the Public Adjuster's, so they never count here.
//
// Owed when (inspection-source, not cancelled, not lost):
//   • signed > 24h ago and STILL not in JN (auto-sync failed → re-sync)
//   • inspection result is in, but photos not yet in JN
//   • inspection result is in, but the certificate not yet in JN
// Claim-track deals are PA-pipeline only — the manager can't push, so
// they never count as attention.
const CERT_STATUSES = ['Cert Sent', 'Cert Uploaded', 'Awaiting Signature', 'Completed', 'Won']
function needsAttention(d) {
  if (d.cancelled_at) return false
  if (String(d.inspection_result || d.result || '').toLowerCase() === 'lost') return false
  if (d.source !== 'inspection') return false
  if (!d.signed_at) return false

  const hasResult = !!(d.inspection_result || d.result)
  const inJn = !!d.jn_job_id
  const signedHoursAgo = (Date.now() - new Date(d.signed_at).getTime()) / 3_600_000

  // Not inspected yet — only a stale (>24h) orphaned sync is owed.
  if (!hasResult) return !inJn && signedHoursAgo > 24

  // Inspected — the certificate is always owed until it lands in JN.
  // Photos are owed too, EXCEPT for "No Damage" (no damage = no photos to
  // show, so photos are optional there). Mirrors the frontend's
  // photosRequired() so the attention count agrees with the per-rep rows.
  const result = String(d.inspection_result || d.result || '')
  const photosReq = !/no\s*damage/i.test(result)
  const certIn = !!d.jn_cert_uploaded_at || (!!d.jn_status && CERT_STATUSES.includes(d.jn_status))
  if (photosReq && !d.jn_pushed_at) return true
  return !certIn
}

function json(status, body) {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify(body),
  }
}
