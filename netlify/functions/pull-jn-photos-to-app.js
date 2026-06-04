// netlify/functions/pull-jn-photos-to-app.js
//
// One-off normalizer: copy a historical inspection's photos from
// JobNimbus INTO our own Supabase Storage, then write the
// inspections.inspection_photos jsonb so the record looks exactly like a
// modern app-captured one. Needed because older damage deals were
// classified before in-app photo capture shipped — their roof photos
// live only in JN. New inspections already capture app-side, so this
// backfill is self-limiting.
//
// Idempotent: skips a record that already has app-side photos (unless
// { force: true }). Each JN file maps to a deterministic storage path
// (keyed by the JN file id) and is uploaded with upsert, so re-running
// never duplicates.
//
// POST body: { inspectionId, force? }
// Response:  { ok, inspection_id, copied, skipped_reason?, total_in_jn, photos }
//
// Required env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, JOBNIMBUS_API_KEY.

const JN_BASE = "https://app.jobnimbus.com/api1";
const SIGNED_BUCKET = "signed-documents";
const PHOTO_PATH_PREFIX = "inspection-photos";
const MAX_PHOTOS = 30;
const BATCH = 6;

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return json(405, { ok: false, error: "Method not allowed" });
  }
  const missing = [];
  for (const k of ["VITE_SUPABASE_URL", "VITE_SUPABASE_ANON_KEY", "JOBNIMBUS_API_KEY"]) {
    if (!process.env[k]) missing.push(k);
  }
  if (missing.length) return json(500, { ok: false, error: `Missing env: ${missing.join(", ")}` });

  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch {
    return json(400, { ok: false, error: "Invalid JSON body" });
  }
  const inspectionId = (body.inspectionId || "").trim();
  const force = !!body.force;
  if (!inspectionId) return json(400, { ok: false, error: "inspectionId required" });

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
  const JN_KEY = process.env.JOBNIMBUS_API_KEY;
  const sbHeaders = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" };
  const jnHeaders = { Authorization: `bearer ${JN_KEY}`, "Content-Type": "application/json" };

  // 1. Load the inspection.
  const lookup = await fetch(
    `${SB_URL}/rest/v1/inspections?id=eq.${encodeURIComponent(inspectionId)}&select=id,jn_job_id,inspection_photos&limit=1`,
    { headers: sbHeaders },
  );
  if (!lookup.ok) return json(500, { ok: false, error: `Could not fetch inspection: ${await lookup.text()}` });
  const insp = (await lookup.json())?.[0];
  if (!insp) return json(404, { ok: false, error: "Inspection not found" });
  if (!insp.jn_job_id) return json(400, { ok: false, error: "Inspection has no jn_job_id" });

  const existing = Array.isArray(insp.inspection_photos) ? insp.inspection_photos : [];
  if (existing.length > 0 && !force) {
    return json(200, { ok: true, inspection_id: inspectionId, copied: 0, skipped_reason: "already_app_side", total_in_jn: null, photos: existing.length });
  }

  // 2. List the JN photos.
  let files = [];
  try {
    const listRes = await fetch(`${JN_BASE}/files?related=${encodeURIComponent(insp.jn_job_id)}&type=2&size=${MAX_PHOTOS}`, { headers: jnHeaders });
    if (!listRes.ok) return json(502, { ok: false, error: `JN file list ${listRes.status}` });
    const data = await listRes.json();
    const all = data.data || data.files || data.results || [];
    files = all.filter((f) => (f.content_type || "").startsWith("image/")).slice(0, MAX_PHOTOS);
  } catch (e) {
    return json(502, { ok: false, error: `JN file list error: ${e.message}` });
  }
  if (files.length === 0) {
    return json(200, { ok: true, inspection_id: inspectionId, copied: 0, skipped_reason: "no_jn_photos", total_in_jn: 0, photos: existing.length });
  }

  // 3. Download each from JN, upload into our bucket. Deterministic path
  //    per JN file id → re-runs upsert the same object (no dupes).
  const results = new Array(files.length).fill(null);
  async function pullOne(i) {
    const file = files[i];
    const fileJnid = file.jnid || file.id;
    if (!fileJnid) return;
    try {
      const dl = await fetch(`${JN_BASE}/files/${fileJnid}`, { headers: jnHeaders }); // follows 302 → presigned
      if (!dl.ok) return;
      const buf = Buffer.from(await dl.arrayBuffer());
      const ct = dl.headers.get("content-type") || file.content_type || "image/jpeg";
      const ext = extFor(ct, file.filename);
      const path = `${PHOTO_PATH_PREFIX}/${inspectionId}/jn_${fileJnid}.${ext}`;
      const up = await fetch(`${SB_URL}/storage/v1/object/${SIGNED_BUCKET}/${path}`, {
        method: "POST",
        headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": ct, "x-upsert": "true" },
        body: buf,
      });
      if (!up.ok) return;
      results[i] = {
        path,
        bucket: SIGNED_BUCKET,
        label: "JobNimbus photo",
        source: "jobnimbus",
        captured_at: jnDateToIso(file.date_created) || jnDateToIso(file.date_file_created) || null,
      };
    } catch { /* skip this one */ }
  }
  for (let i = 0; i < files.length; i += BATCH) {
    await Promise.all(files.slice(i, i + BATCH).map((_, k) => pullOne(i + k)));
  }
  const copied = results.filter(Boolean);

  if (copied.length === 0) {
    return json(502, { ok: false, error: "Found JN photos but none could be copied", total_in_jn: files.length });
  }

  // 4. Write inspection_photos. When forcing a re-pull we replace; on a
  //    normal run the record had none, so this is the full set.
  const patchRes = await fetch(`${SB_URL}/rest/v1/inspections?id=eq.${encodeURIComponent(inspectionId)}`, {
    method: "PATCH",
    headers: { ...sbHeaders, Prefer: "return=minimal" },
    body: JSON.stringify({ inspection_photos: copied }),
  });
  if (!patchRes.ok) {
    return json(500, { ok: false, error: `Uploaded photos but could not save inspection_photos: ${(await patchRes.text()).slice(0, 200)}`, copied: copied.length });
  }

  return json(200, { ok: true, inspection_id: inspectionId, copied: copied.length, total_in_jn: files.length, photos: copied.length });
};

function extFor(contentType, filename) {
  const ct = (contentType || "").toLowerCase();
  if (ct.includes("png")) return "png";
  if (ct.includes("webp")) return "webp";
  if (ct.includes("heic")) return "heic";
  if (ct.includes("gif")) return "gif";
  if (ct.includes("jpeg") || ct.includes("jpg")) return "jpg";
  const fromName = (filename || "").split(".").pop();
  if (fromName && fromName.length <= 5 && /^[a-z0-9]+$/i.test(fromName)) return fromName.toLowerCase();
  return "jpg";
}

// JN date fields are unix epoch SECONDS (sometimes ms). Return an ISO
// string, or null if absent/unparseable.
function jnDateToIso(v) {
  if (v == null) return null;
  let n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n < 1e12) n *= 1000; // seconds → ms
  const d = new Date(n);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function json(status, body) {
  return { statusCode: status, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}
