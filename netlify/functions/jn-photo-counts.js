// Netlify Function: bulk JN photo counts
//
// Why: pre-wizard inspection records have their photos in JobNimbus
// but NOT in Supabase's inspection_photos column. Our PA Handoff
// page shows "❗ 0 photos" for these even though JN has plenty —
// misleading. This function lets the page fetch real JN counts in
// bulk so the badge can show the truth.
//
// USAGE:
//   POST /.netlify/functions/jn-photo-counts
//   Body: { jn_job_ids: ["jnid1", "jnid2", ...] }
//   Returns: { counts: { jnid1: 18, jnid2: 0, ... } }
//
// Notes:
//   - Counts image files only (content_type starts with "image/")
//   - Caps the JN listing at size=50 per call — matches what the
//     PA send fetches (which is itself capped at 20 sent)
//   - Returns 0 for any jn_job_id that errors or has no images
//   - Returns 0 (not -1) so the calling UI can simply trust the
//     number without special-casing errors

const JN_BASE = 'https://app.jobnimbus.com/api1'
const JN_KEY = process.env.JOBNIMBUS_API_KEY

const jnHeaders = {
  Authorization: `bearer ${JN_KEY}`,
  'Content-Type': 'application/json',
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return json(405, { ok: false, error: 'POST only' })
  }
  if (!JN_KEY) {
    return json(500, { ok: false, error: 'JOBNIMBUS_API_KEY missing' })
  }

  let jnJobIds
  try {
    const body = JSON.parse(event.body || '{}')
    jnJobIds = Array.isArray(body.jn_job_ids) ? body.jn_job_ids : []
  } catch {
    return json(400, { ok: false, error: 'Invalid JSON body' })
  }
  if (jnJobIds.length === 0) {
    return json(200, { ok: true, counts: {} })
  }
  // Sanity cap so the function can't be DoS'd with a giant list.
  // 100 covers any reasonable page of records.
  if (jnJobIds.length > 100) {
    jnJobIds = jnJobIds.slice(0, 100)
  }

  // Fan out the count queries in parallel. Each one is a single GET
  // against JN's /files endpoint — much cheaper than fetchJnPhotos
  // since we never download the image bytes.
  const results = await Promise.all(
    jnJobIds.map(async (jnid) => {
      if (!jnid) return [jnid, 0]
      try {
        const res = await fetch(
          `${JN_BASE}/files?related=${jnid}&type=2&size=50`,
          { headers: jnHeaders },
        )
        if (!res.ok) return [jnid, 0]
        const data = await res.json()
        const files = data.files || data.data || data.results || []
        const imageCount = files.filter((f) =>
          (f.content_type || '').startsWith('image/'),
        ).length
        return [jnid, imageCount]
      } catch (e) {
        console.warn(`jn-photo-counts error for ${jnid}:`, e?.message)
        return [jnid, 0]
      }
    }),
  )

  const counts = Object.fromEntries(results)
  return json(200, { ok: true, counts })
}

function json(status, body) {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }
}
