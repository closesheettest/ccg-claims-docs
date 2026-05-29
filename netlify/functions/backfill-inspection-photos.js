// Netlify Function: backfill inspection_photos from JobNimbus
//
// Why: 18 damage records since 2026-05-01 have empty inspection_photos
// in Supabase BUT their photos exist in JN (inspector wizard wrote to
// JN but not to the Supabase column — separate bug, fix coming
// separately). The PA send and cert generator both pull from JN so
// the photos themselves are NOT lost. This backfill restores the
// bookkeeping: reads each affected record's JN photos, uploads them
// to Supabase Storage at the same path scheme as fresh wizard
// inspections, and writes the path metadata into inspection_photos.
//
// Net result: the admin "Photos" modal stops lying ("No photos on
// file") AND the PA send can use Supabase as fallback in the future
// for these records too.
//
// USAGE:
//   GET  /.netlify/functions/backfill-inspection-photos?secret=<CRON_SECRET>&dry_run=1
//        Dry-run: shows which records would be updated, no writes.
//   GET  /.netlify/functions/backfill-inspection-photos?secret=<CRON_SECRET>
//        Live: backfills every affected record.
//   GET  /.netlify/functions/backfill-inspection-photos?secret=<CRON_SECRET>&inspection_id=<uuid>
//        Backfill just one inspection (for spot checks).
//   GET  /.netlify/functions/backfill-inspection-photos?secret=<CRON_SECRET>&since=2026-05-01
//        Only check records signed >= the given date.
//
// Required env vars:
//   VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY  (read inspections, upload to Storage)
//   JOBNIMBUS_API_KEY                            (fetch JN photos)
//   CRON_SECRET                                  (auth gate)

const JN_BASE = 'https://app.jobnimbus.com/api1'
const JN_KEY = process.env.JOBNIMBUS_API_KEY
const SB_URL = process.env.VITE_SUPABASE_URL
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY
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
  const params = event.queryStringParameters || {}

  if (process.env.CRON_SECRET && params.secret !== process.env.CRON_SECRET) {
    return json(401, { ok: false, error: 'Unauthorized' })
  }
  const missing = ['VITE_SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY', 'JOBNIMBUS_API_KEY']
    .filter((k) => !process.env[k])
  if (missing.length) return json(500, { ok: false, error: `Missing env vars: ${missing.join(', ')}` })

  const dryRun = params.dry_run === '1' || params.dry_run === 'true'
  const since = params.since || '2026-05-01'
  const inspectionIdOnly = params.inspection_id || null

  // 1. Find target inspections
  const cols = 'id,client_name,address,jn_job_id,result,signed_at,result_at,inspection_photos'
  let url = `${SB_URL}/rest/v1/inspections?result=eq.damage&signed_at=gte.${since}&select=${cols}&order=signed_at.desc`
  if (inspectionIdOnly) {
    url = `${SB_URL}/rest/v1/inspections?id=eq.${inspectionIdOnly}&select=${cols}`
  }
  const listRes = await fetch(url, { headers: sbHeaders })
  if (!listRes.ok) {
    return json(500, { ok: false, error: `Supabase list failed: ${await listRes.text()}` })
  }
  const allRows = await listRes.json()
  // Filter to records with empty inspection_photos AND a jn_job_id
  const targets = (allRows || []).filter((r) => {
    if (!r.jn_job_id) return false
    if (!r.inspection_photos) return true
    if (Array.isArray(r.inspection_photos) && r.inspection_photos.length === 0) return true
    return false
  })

  if (targets.length === 0) {
    return json(200, { ok: true, message: 'No records need backfill', scanned: allRows.length })
  }

  if (dryRun) {
    // Hit JN once per record to get a fast photo COUNT (no downloads).
    // Surfaces records with suspiciously few photos so we can spot
    // an inspector-workflow problem (vs just a bookkeeping gap).
    const enriched = await Promise.all(
      targets.map(async (r) => {
        const photoCount = await countJnPhotos(r.jn_job_id)
        return {
          id: r.id,
          client_name: r.client_name,
          address: r.address,
          signed_at: r.signed_at,
          jn_job_id: r.jn_job_id,
          jn_photo_count: photoCount,
          flag_low_photos: photoCount < 10 ? '⚠ FEWER THAN 10 PHOTOS' : null,
        }
      }),
    )
    // Summary distribution so Neal can see at a glance.
    const distribution = {
      '0_photos': enriched.filter((r) => r.jn_photo_count === 0).length,
      '1_to_3': enriched.filter((r) => r.jn_photo_count >= 1 && r.jn_photo_count <= 3).length,
      '4_to_9': enriched.filter((r) => r.jn_photo_count >= 4 && r.jn_photo_count <= 9).length,
      '10_to_19': enriched.filter((r) => r.jn_photo_count >= 10 && r.jn_photo_count <= 19).length,
      '20_plus': enriched.filter((r) => r.jn_photo_count >= 20).length,
    }
    return json(200, {
      ok: true,
      dry_run: true,
      scanned: allRows.length,
      would_backfill: targets.length,
      photo_count_distribution: distribution,
      records: enriched.sort((a, b) => a.jn_photo_count - b.jn_photo_count),
    })
  }

  // 2. For each target, pull JN photos, upload to Supabase, write column
  const results = []
  for (const insp of targets) {
    try {
      const jnPhotos = await fetchJnPhotos(insp.jn_job_id)
      if (jnPhotos.length === 0) {
        results.push({ id: insp.id, client_name: insp.client_name, status: 'skipped', reason: 'JN had 0 photos for this job' })
        continue
      }
      // Upload each JN photo to Supabase Storage at inspection-photos/<id>/<filename>
      const uploaded = []
      for (let i = 0; i < jnPhotos.length; i++) {
        const photo = jnPhotos[i]
        // Filename: use the JN filename if reasonable, else synthesize one
        const safeName = photo.filename.replace(/[^a-zA-Z0-9._-]/g, '_')
        const path = `inspection-photos/${insp.id}/jn-backfill-${i + 1}-${safeName}`
        const upRes = await fetch(
          `${SB_URL}/storage/v1/object/${SIGNED_BUCKET}/${path}`,
          {
            method: 'POST',
            headers: {
              apikey: SB_KEY,
              Authorization: `Bearer ${SB_KEY}`,
              'Content-Type': photo.contentType || 'image/jpeg',
              'x-upsert': 'true',  // overwrite if path exists (rerun-safe)
            },
            body: photo.buffer,
          },
        )
        if (!upRes.ok) {
          console.warn(`Upload failed for ${insp.id} #${i + 1}:`, upRes.status, await upRes.text())
          continue
        }
        uploaded.push({
          path,
          bucket: SIGNED_BUCKET,
          captured_at: new Date().toISOString(),
          label: `JN backfill ${i + 1} of ${jnPhotos.length}`,
        })
      }

      if (uploaded.length === 0) {
        results.push({ id: insp.id, client_name: insp.client_name, status: 'failed', reason: 'All Supabase uploads failed' })
        continue
      }

      // Update inspection_photos column
      const updRes = await fetch(
        `${SB_URL}/rest/v1/inspections?id=eq.${insp.id}`,
        {
          method: 'PATCH',
          headers: { ...sbHeaders, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
          body: JSON.stringify({ inspection_photos: uploaded }),
        },
      )
      if (!updRes.ok) {
        results.push({ id: insp.id, client_name: insp.client_name, status: 'failed', reason: `PATCH failed: ${await updRes.text()}` })
        continue
      }
      results.push({
        id: insp.id,
        client_name: insp.client_name,
        status: 'backfilled',
        jn_photo_count: jnPhotos.length,
        uploaded_count: uploaded.length,
      })
    } catch (e) {
      results.push({ id: insp.id, client_name: insp.client_name, status: 'error', error: e.message })
    }
  }

  const summary = {
    backfilled: results.filter((r) => r.status === 'backfilled').length,
    skipped: results.filter((r) => r.status === 'skipped').length,
    failed: results.filter((r) => r.status === 'failed').length,
    errors: results.filter((r) => r.status === 'error').length,
  }
  return json(200, { ok: true, summary, results })
}

// Count image files on a JN job without downloading them — much
// faster than fetchJnPhotos for the dry-run summary.
async function countJnPhotos(jnJobId) {
  try {
    const listRes = await fetch(
      `${JN_BASE}/files?related=${jnJobId}&type=2&size=50`,
      { headers: jnHeaders },
    )
    if (!listRes.ok) return -1  // signals error vs zero
    const data = await listRes.json()
    const files = data.files || data.data || data.results || []
    return files.filter((f) => (f.content_type || '').startsWith('image/')).length
  } catch {
    return -1
  }
}

async function fetchJnPhotos(jnJobId) {
  try {
    const listRes = await fetch(
      `${JN_BASE}/files?related=${jnJobId}&type=2&size=30`,
      { headers: jnHeaders },
    )
    if (!listRes.ok) return []
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
        if (!dlRes.ok) return null
        const ab = await dlRes.arrayBuffer()
        return {
          buffer: Buffer.from(ab),
          contentType: file.content_type || 'image/jpeg',
          filename: file.filename || `photo-${fileJnid}.jpg`,
        }
      } catch {
        return null
      }
    })
    return (await Promise.all(downloads)).filter(Boolean)
  } catch {
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
