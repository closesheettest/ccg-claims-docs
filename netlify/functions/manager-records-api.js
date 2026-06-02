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
const TMS_REP_ZONES_URL =
  'https://trainingmanagementsys.netlify.app/.netlify/functions/rep-zones'

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
  return json(400, { ok: false, error: `Unknown action: ${action}` })
}

// ────────────────────────────────────────────────────────────────────
// Manager lookup

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
  const [claims, inspections] = await Promise.all([
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
        'inspection_result,result,result_at,jn_status,jn_job_id,docs_signed,signed_pdfs,cancelled_at',
      filter: `sales_rep_name=in.(${repListParam})`,
      order: 'id.desc',
      limit: 500,
    }),
  ])

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

  // 5. Group by rep — sorted by deal count desc so the busiest reps
  //    bubble up. Within each rep, deals are already in date-desc
  //    order from the PostgREST query.
  const dealsByRep = {}
  for (const d of deals) {
    const rep = d.sales_rep_name || '— Unknown —'
    if (!dealsByRep[rep]) dealsByRep[rep] = []
    dealsByRep[rep].push(d)
  }

  const totals = {
    deals: deals.length,
    pending_signatures: pendingSignatures.length,
    needs_attention: deals.filter((d) => needsAttention(d)).length,
    reps: Object.keys(dealsByRep).length,
  }

  return json(200, {
    ok: true,
    manager,
    repsInZone,
    dealsByRep,
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

// A deal "needs attention" if it's stuck somewhere:
//   • Pending signatures (PA forms requested, never completed)
//   • Signed but never made it to JN (no jn_job_id after 24h)
//   • Signed and in JN but cert is still missing after 24h
// The UI uses this to badge rows in red + auto-expand the rep group.
function needsAttention(d) {
  if (d.cancelled_at) return false
  if (isPendingSignatures(d)) return true
  const signedHoursAgo = d.signed_at
    ? (Date.now() - new Date(d.signed_at).getTime()) / 3_600_000
    : null
  if (signedHoursAgo != null && signedHoursAgo > 24 && !d.jn_job_id) return true
  if (signedHoursAgo != null && signedHoursAgo > 24 && d.jn_status === 'Awaiting Cert') return true
  return false
}

function json(status, body) {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify(body),
  }
}
