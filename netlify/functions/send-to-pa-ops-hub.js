// netlify/functions/send-to-pa-ops-hub.js
//
// When an inspection is statused as "Damage" in the app's Record Lookup
// flow, this function fires a Property Damage Notice (PDN) submission to
// the PA's Ops Hub intake endpoint. The PA's app then has a record they
// can pick up for back-office review.
//
// Endpoint (per PA's spec):
//   POST https://bgeovgtzwgtcyfemnsvh.supabase.co/functions/v1/submit-intake
//   Content-Type: multipart/form-data
//
// Required fields:
//   source=field_partner_hub
//   submitter_type=partner
//   consent_intake=true
//   consent_disclaimer_acknowledged=true
//   damage_type_slug=roof   (we only do roof inspections)
//
// What we attach beyond the required fields:
//   - All homeowner / property fields (name, address, phone, email, etc.)
//   - The signed Free Roof Inspection Agreement PDF (pulled from Supabase
//     Storage via the inspection record's signed_pdfs.insp path)
//   - All inspection photos (pulled from the linked JobNimbus job)
//
// USAGE:
//   POST /.netlify/functions/send-to-pa-ops-hub
//   Body: { inspectionId: "<uuid>" }
//
// Triggers:
//   - submitInspectionResult in App.jsx fires this as a fire-and-forget
//     POST whenever result === "damage" and the inspection has a signed
//     PDF + a linked JN job.
//   - Future: a "Re-send to PA Ops Hub" button in the Record Lookup view
//     for manual retries.
//
// Required env vars:
//   VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY  (read inspection + storage)
//   JOBNIMBUS_API_KEY                            (fetch JN photos)
// Optional:
//   PA_OPS_HUB_AUTH_TOKEN  (if PA later requires Authorization header)

const JN_BASE = 'https://app.jobnimbus.com/api1'
const JN_KEY = process.env.JOBNIMBUS_API_KEY
const SB_URL = process.env.VITE_SUPABASE_URL
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY
const PA_INTAKE_URL =
  'https://bgeovgtzwgtcyfemnsvh.supabase.co/functions/v1/submit-intake'
const SIGNED_BUCKET = 'signed-documents'

const sbHeaders = {
  apikey: SB_KEY,
  Authorization: `Bearer ${SB_KEY}`,
}
const jnHeaders = {
  Authorization: `bearer ${JN_KEY}`,
  'Content-Type': 'application/json',
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return json(405, { ok: false, error: 'Method not allowed' })
  }
  const missing = []
  for (const k of ['VITE_SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY']) {
    if (!process.env[k]) missing.push(k)
  }
  if (missing.length) return json(500, { ok: false, error: `Missing env vars: ${missing.join(', ')}` })

  let inspectionId
  try {
    const body = JSON.parse(event.body || '{}')
    inspectionId = (body.inspectionId || '').trim()
  } catch {
    return json(400, { ok: false, error: 'Invalid JSON body' })
  }
  if (!inspectionId) return json(400, { ok: false, error: 'inspectionId required' })

  console.log('=== send-to-pa-ops-hub START — inspectionId:', inspectionId)

  // ── 1. Fetch the inspection record ────────────────────────────────
  const insp = await fetchInspection(inspectionId)
  if (!insp) return json(404, { ok: false, error: 'Inspection not found' })
  // Gate on damage result — anything else shouldn't trigger a PDN.
  if (insp.result !== 'damage') {
    return json(400, {
      ok: false,
      error: `Inspection result is "${insp.result || 'null'}" — only "damage" inspections submit to PA Ops Hub.`,
    })
  }

  // ── 2. Download the signed Free Roof Inspection PDF (best-effort) ─
  // Stored in signed-documents bucket at signed_pdfs.insp path. If
  // missing, we still send the PDN but without the attachment — PA
  // can request the document separately if needed.
  let signedPdf = null
  const inspPath = insp.signed_pdfs?.insp
  if (inspPath) {
    signedPdf = await downloadFromSupabaseStorage(SIGNED_BUCKET, inspPath)
    if (!signedPdf) {
      console.warn('Could not download signed inspection PDF at path:', inspPath)
    }
  } else {
    console.warn('Inspection has no signed_pdfs.insp — submitting without PDF attachment')
  }

  // ── 3. Fetch inspection photos from JN (best-effort) ──────────────
  let photos = []
  if (insp.jn_job_id && JN_KEY) {
    photos = await fetchJnPhotos(insp.jn_job_id)
    console.log('JN photos fetched:', photos.length)
  } else {
    console.warn('No jn_job_id or missing JOBNIMBUS_API_KEY — submitting without photos')
  }

  // ── 4. Build the multipart/form-data body ─────────────────────────
  const form = new FormData()
  // Required fields per PA spec
  form.append('source', 'field_partner_hub')
  form.append('submitter_type', 'partner')
  form.append('consent_intake', 'true')
  form.append('consent_disclaimer_acknowledged', 'true')
  form.append('damage_type_slug', 'roof')

  // Homeowner + property — names chosen to match common PA intake
  // schemas. If PA's endpoint expects different field names, they can
  // tell us and we'll rename here (or the endpoint can accept whatever
  // and just ignore unknown fields).
  form.append('homeowner_name', insp.client_name || '')
  form.append('property_address', insp.address || '')
  form.append('property_city', insp.city || '')
  form.append('property_state', insp.state || '')
  form.append('property_zip', insp.zip || '')
  form.append('homeowner_phone', insp.mobile || insp.phone || '')
  form.append('homeowner_email', insp.email || '')

  // Reference back to our system + JN for cross-linking.
  form.append('partner_inspection_id', insp.id || '')
  if (insp.jn_job_id) form.append('partner_jn_job_id', insp.jn_job_id)
  if (insp.inspector_name) form.append('inspector_name', insp.inspector_name)
  if (insp.cert_number) form.append('cert_number', insp.cert_number)
  if (insp.sales_rep_name) form.append('sales_rep_name', insp.sales_rep_name)
  if (insp.result_at) form.append('damage_recorded_at', insp.result_at)

  // Signed inspection PDF — proof-of-property document.
  if (signedPdf) {
    form.append(
      'signed_inspection_pdf',
      new Blob([signedPdf.buffer], { type: 'application/pdf' }),
      'Free-Roof-Inspection-Agreement.pdf',
    )
  }

  // Photos — one form field per photo, indexed. PA's endpoint should
  // be able to read these as proof-of-property attachments.
  photos.forEach((p, i) => {
    form.append(
      `photo_${i + 1}`,
      new Blob([p.buffer], { type: p.contentType || 'image/jpeg' }),
      p.filename || `inspection-photo-${i + 1}.jpg`,
    )
  })

  // ── 5. POST to PA Ops Hub ─────────────────────────────────────────
  console.log('POSTing to PA Ops Hub:', PA_INTAKE_URL)
  let paRes
  try {
    const init = { method: 'POST', body: form }
    if (process.env.PA_OPS_HUB_AUTH_TOKEN) {
      init.headers = { Authorization: `Bearer ${process.env.PA_OPS_HUB_AUTH_TOKEN}` }
    }
    paRes = await fetch(PA_INTAKE_URL, init)
  } catch (err) {
    return json(502, { ok: false, error: 'Network error reaching PA Ops Hub', detail: err.message })
  }
  const paBodyText = await paRes.text().catch(() => '')
  if (!paRes.ok) {
    console.error('PA Ops Hub responded', paRes.status, paBodyText.slice(0, 400))
    return json(502, {
      ok: false,
      error: `PA Ops Hub returned ${paRes.status}`,
      detail: paBodyText.slice(0, 400),
    })
  }

  console.log('=== PA Ops Hub PDN submitted for inspection', inspectionId)
  return json(200, {
    ok: true,
    pa_response_status: paRes.status,
    pa_response_body: paBodyText.slice(0, 400),
    pdf_attached: !!signedPdf,
    photo_count: photos.length,
  })
}

// ── Helpers ───────────────────────────────────────────────────────────

async function fetchInspection(id) {
  const url = `${SB_URL}/rest/v1/inspections?id=eq.${encodeURIComponent(id)}&select=id,client_name,address,city,state,zip,mobile,phone,email,sales_rep_name,inspector_name,cert_number,result,result_at,jn_job_id,signed_pdfs`
  const res = await fetch(url, { headers: sbHeaders })
  if (!res.ok) return null
  const arr = await res.json().catch(() => [])
  return Array.isArray(arr) ? arr[0] || null : null
}

async function downloadFromSupabaseStorage(bucket, path) {
  const url = `${SB_URL}/storage/v1/object/${bucket}/${path}`
  const res = await fetch(url, { headers: sbHeaders })
  if (!res.ok) {
    console.warn(`Storage download ${res.status} for ${bucket}/${path}`)
    return null
  }
  const ab = await res.arrayBuffer()
  return { buffer: Buffer.from(ab) }
}

// Pulls inspection photos from a JobNimbus job — same flow as
// generate-and-upload-insp-report.js, simplified to return raw buffers
// instead of base64 (FormData wants the binary).
async function fetchJnPhotos(jnJobId) {
  try {
    const listRes = await fetch(
      `${JN_BASE}/files?related=${jnJobId}&type=2&size=30`,
      { headers: jnHeaders },
    )
    if (!listRes.ok) {
      console.warn('JN photo list failed:', listRes.status)
      return []
    }
    const data = await listRes.json()
    const files = data.files || data.data || data.results || []
    const imageFiles = files.filter((f) => (f.content_type || '').startsWith('image/'))
    const ts = (f) => Number(f.date_created || f.date_uploaded || f.date_added || 0)
    const sorted = [...imageFiles].sort((a, b) => ts(b) - ts(a))

    const downloads = sorted.slice(0, 20).map(async (file) => {
      const fileJnid = file.jnid || file.id
      if (!fileJnid) return null
      try {
        const dlRes = await fetch(`${JN_BASE}/files/${fileJnid}`, { headers: jnHeaders })
        if (!dlRes.ok) {
          console.warn('JN photo download failed for', fileJnid, ':', dlRes.status)
          return null
        }
        const ab = await dlRes.arrayBuffer()
        const bytes = new Uint8Array(ab)
        if (!bytes.length) return null
        return {
          buffer: Buffer.from(ab),
          contentType: file.content_type || 'image/jpeg',
          filename: file.filename || `photo-${fileJnid}.jpg`,
        }
      } catch (e) {
        console.warn('JN photo download error for', fileJnid, ':', e.message)
        return null
      }
    })

    const results = await Promise.all(downloads)
    return results.filter(Boolean)
  } catch (e) {
    console.warn('fetchJnPhotos error:', e.message)
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
