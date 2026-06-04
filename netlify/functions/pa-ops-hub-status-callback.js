// netlify/functions/pa-ops-hub-status-callback.js
//
// Webhook endpoint the PA's Ops Hub app POSTs to when their team
// updates the status of a Property Damage Notice (PDN) we previously
// submitted via send-to-pa-ops-hub.js.
//
// When the PA's user clicks one of the two buttons in their app:
//   "Customer signed PA forms"  → pa_status = "signed"
//   "Refused to sign"           → pa_status = "refused"
// the PA's app fires a POST to this endpoint and we update the matching
// inspection record so the status shows up in our Record Lookup view.
// Until they click either button, the PDN sits in "pending" — the
// default we set when we first submitted it from send-to-pa-ops-hub.
//
// REQUEST FORMAT (what the PA needs to send us):
//   POST /.netlify/functions/pa-ops-hub-status-callback
//   Content-Type: application/json
//   Authorization: Bearer <PA_OPS_HUB_CALLBACK_SECRET>
//   Body: {
//     partner_inspection_id: "<uuid we originally sent in the PDN>",
//     pa_status: "signed" | "refused" | "pending",
//     notes: "optional free-text context"
//   }
//
// RESPONSE:
//   200 { ok: true, updated: 1 }
//   400 { ok: false, error: "..." }       (bad payload)
//   401 { ok: false, error: "..." }       (bad/missing auth)
//   404 { ok: false, error: "..." }       (inspection not found)
//
// Idempotent — re-sending the same status is fine. Each call also
// stamps pa_status_updated_at so we can show "Signed 2 hours ago"
// type UI.
//
// Required env vars:
//   VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY  (write the update)
//   PA_OPS_HUB_CALLBACK_SECRET                  (shared secret, both sides know it)

const SB_URL = process.env.VITE_SUPABASE_URL
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY
const SECRET = process.env.PA_OPS_HUB_CALLBACK_SECRET

const ALLOWED_STATUSES = new Set(['signed', 'refused', 'pending'])

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return json(405, { ok: false, error: 'Method not allowed' })
  }
  const missing = []
  for (const k of ['VITE_SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY', 'PA_OPS_HUB_CALLBACK_SECRET']) {
    if (!process.env[k]) missing.push(k)
  }
  if (missing.length) {
    return json(500, { ok: false, error: `Server misconfigured: missing ${missing.join(', ')}` })
  }

  // ── 1. Shared-secret auth ──────────────────────────────────────────
  // The PA app must send Authorization: Bearer <secret>. Stops the
  // outside world from arbitrarily marking inspections as signed.
  const auth =
    event.headers.authorization ||
    event.headers.Authorization ||
    ''
  const token = auth.replace(/^Bearer\s+/i, '').trim()
  if (!token || token !== SECRET) {
    return json(401, { ok: false, error: 'Invalid or missing Authorization bearer token' })
  }

  // ── 2. Parse + validate body ───────────────────────────────────────
  let body
  try {
    body = JSON.parse(event.body || '{}')
  } catch {
    return json(400, { ok: false, error: 'Invalid JSON body' })
  }
  const inspectionId = (body.partner_inspection_id || '').trim()
  const status = (body.pa_status || '').trim().toLowerCase()
  const notes = body.notes ? String(body.notes).slice(0, 2000) : null
  if (!inspectionId) {
    return json(400, { ok: false, error: 'partner_inspection_id required' })
  }
  if (!ALLOWED_STATUSES.has(status)) {
    return json(400, {
      ok: false,
      error: `pa_status must be one of: ${Array.from(ALLOWED_STATUSES).join(', ')}`,
    })
  }

  // ── 3. Update the inspection ───────────────────────────────────────
  const nowIso = new Date().toISOString()
  const patch = {
    pa_status: status,
    pa_status_updated_at: nowIso,
    pa_status_notes: notes,
  }
  // A refusal from the external PA Ops Hub isn't a dead end — park the deal
  // in the "PA Decision Needed" queue so US Shingle can reassign it to an
  // active internal PA. (A manager who later reinstates it sets
  // pa_decision_resolved_at, which the reconcile cron then respects.)
  if (status === 'refused') {
    patch.pa_decision_needed = true
    patch.pa_decision_reason = 'PA Ops Hub: refused to sign'
    patch.pa_decision_at = nowIso
  }
  const url = `${SB_URL}/rest/v1/inspections?id=eq.${encodeURIComponent(inspectionId)}`
  const res = await fetch(url, {
    method: 'PATCH',
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify(patch),
  })
  if (!res.ok) {
    const errText = await res.text().catch(() => '')
    return json(500, {
      ok: false,
      error: `Supabase update ${res.status}`,
      detail: errText.slice(0, 400),
    })
  }
  const rows = await res.json().catch(() => [])
  if (!Array.isArray(rows) || rows.length === 0) {
    return json(404, {
      ok: false,
      error: 'No inspection found with that partner_inspection_id',
    })
  }

  return json(200, {
    ok: true,
    updated: rows.length,
    inspection_id: inspectionId,
    pa_status: status,
    pa_status_updated_at: patch.pa_status_updated_at,
  })
}

function json(status, body) {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }
}
