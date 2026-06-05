// netlify/functions/leaderboard-blast-background.js
//
// Fans out one leaderboard hype SMS to the whole field: every active
// sales rep with a phone, plus every regional manager with a phone.
// Split out from leaderboard-notify as a *background* function so a
// large roster (many sequential GHL calls) can't blow the scheduled
// detector's short timeout — background functions get up to 15 min.
//
// Input (POST JSON): {
//   message,                       — the pre-composed text to send
//   extraRecipients?: [{name,phone}] — optional extra copies (e.g. an
//                                     admin who wants their own copy via
//                                     the Auto-SMS registry). Merged in
//                                     and deduped by phone with the field.
// }
// Recipients are gathered here from Supabase, deduped by phone, and
// each is sent via the existing ghl-sms function.
//
// Required env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, URL.

const SB_URL = process.env.VITE_SUPABASE_URL
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY

export const handler = async (event) => {
  let body
  try { body = JSON.parse(event.body || '{}') }
  catch { return json(400, { ok: false, error: 'Invalid JSON' }) }

  const message = body.message
  if (!message) return json(400, { ok: false, error: 'Missing: message' })
  if (!SB_URL || !SB_KEY) return json(500, { ok: false, error: 'Missing Supabase env' })

  const base =
    process.env.URL || process.env.DEPLOY_URL || process.env.PUBLIC_SITE_URL || ''

  // 1. Active sales reps with a phone. `active` may be null on older
  //    rows (treated as active, same as the admin app), so filter in JS
  //    rather than with active=eq.true which would drop nulls.
  const reps = await fetchTable(
    'sales_reps',
    'select=name,phone,active&limit=1000',
  )
  // 2. Regional managers with a phone.
  const managers = await fetchTable(
    'regional_managers',
    'select=name,phone&limit=200',
  )

  // 3. Merge + dedupe by normalized phone. A manager who is also a rep
  //    only gets one text.
  const byPhone = new Map()
  for (const r of reps) {
    if (r.active === false) continue
    addRecipient(byPhone, r.phone, r.name)
  }
  for (const m of managers) {
    addRecipient(byPhone, m.phone, m.name)
  }
  // 3b. Extra copy-recipients passed in (Auto-SMS registry). Deduped by
  //     phone, so an admin who is also a rep still only gets one text.
  const extras = Array.isArray(body.extraRecipients) ? body.extraRecipients : []
  for (const e of extras) {
    addRecipient(byPhone, e.phone, e.name)
  }
  const recipients = [...byPhone.values()]

  if (recipients.length === 0) {
    return json(200, { ok: true, sent: 0, note: 'No recipients with phones' })
  }

  // 4. Send sequentially via ghl-sms. Failures are logged but don't
  //    abort the run — one bad number shouldn't silence the whole team.
  let sent = 0
  const failures = []
  for (const rcpt of recipients) {
    try {
      const r = await fetch(`${base}/.netlify/functions/ghl-sms`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: rcpt.phone, name: rcpt.name, message }),
      })
      if (r.ok) sent++
      else { failures.push({ phone: rcpt.phone, status: r.status }) }
    } catch (e) {
      failures.push({ phone: rcpt.phone, error: e.message })
    }
  }

  console.log(`leaderboard-blast: sent ${sent}/${recipients.length}`, failures.length ? failures : '')
  return json(200, { ok: true, sent, total: recipients.length, failures })
}

function addRecipient(map, phone, name) {
  const key = normalizePhone(phone)
  if (!key) return
  if (!map.has(key)) map.set(key, { phone: key, name: name || 'Team' })
}

function normalizePhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '')
  if (digits.length === 10) return `+1${digits}`
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`
  if (digits.length < 10) return '' // junk / empty — skip
  return `+${digits}`
}

async function fetchTable(table, query) {
  try {
    const res = await fetch(`${SB_URL}/rest/v1/${table}?${query}`, {
      headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
    })
    if (!res.ok) {
      console.warn(`Supabase ${table} query failed: ${res.status}`)
      return []
    }
    return await res.json().catch(() => [])
  } catch (e) {
    console.warn(`Supabase ${table} threw:`, e.message)
    return []
  }
}

function json(status, body) {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }
}
