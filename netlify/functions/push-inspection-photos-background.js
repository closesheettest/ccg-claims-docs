// netlify/functions/push-inspection-photos-background.js
//
// Uploads an inspection's roof photos from Supabase Storage to the linked
// JobNimbus job — in the BACKGROUND. Netlify runs *-background functions for
// up to 15 minutes, so even a 300+ photo job finishes without timing out.
//
// Why this exists: inspector-submit-result used to upload every photo to JN
// synchronously, inside the inspector's Submit request. For big photo sets
// (90–328 photos) that blew past the ~26s function limit, so the phone got a
// timeout and showed "Try again — NOT SAVED YET" even though the inspection
// was already saved. The inspector then hammered Submit. Now the submit saves
// the result and fires THIS function, returning instantly; the photos flow to
// JN here on their own clock. cron-reconcile-jn-photos remains the daily net.
//
// POST body: { jnJobId, photo_paths: [..], photo_labels: [..], inspectionId? }
//
// Env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, JOBNIMBUS_API_KEY.
//
// Self-contained CJS (no local imports) so the ESM/CJS bundling rule can't 502 it.

const JN_FILES_UPLOADS = "https://api.jobnimbus.com/files/v1/uploads";
const JN_FILES_BASE = `${JN_FILES_UPLOADS}/url`;
const SIGNED_BUCKET = "signed-documents";

exports.handler = async (event) => {
  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { return json(400, { ok: false, error: "Invalid JSON" }); }

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
  const JN_KEY = process.env.JOBNIMBUS_API_KEY;
  if (!SB_URL || !SB_KEY || !JN_KEY) return json(500, { ok: false, error: "Missing env vars" });

  const jnHeaders = { Authorization: `bearer ${JN_KEY}`, "Content-Type": "application/json" };
  const jobId = (body.jnJobId || body.jn_job_id || "").trim();
  const photoPaths = Array.isArray(body.photo_paths) ? body.photo_paths : [];
  const photoLabels = Array.isArray(body.photo_labels) ? body.photo_labels : [];
  if (!jobId) return json(400, { ok: false, error: "jnJobId required" });
  if (!photoPaths.length) return json(200, { ok: true, uploaded: 0, message: "No photos to upload." });

  let uploaded = 0;
  const errors = [];
  for (let i = 0; i < photoPaths.length; i++) {
    const r = await uploadPhotoToJn({
      sbUrl: SB_URL, sbKey: SB_KEY, jnHeaders,
      jobId, path: photoPaths[i], label: photoLabels[i] || "Inspector roof photo",
    });
    if (r.success) uploaded++;
    else errors.push({ path: photoPaths[i], ...r.error });
  }

  if (uploaded < photoPaths.length) {
    console.error(`⚠ JN PHOTO SHORTFALL (background): ${uploaded}/${photoPaths.length} for job ${jobId}${body.inspectionId ? ` (insp ${body.inspectionId})` : ""}. Errors: ${JSON.stringify(errors).slice(0, 500)}`);
  } else {
    console.log(`push-inspection-photos-background: ${uploaded}/${photoPaths.length} uploaded for job ${jobId}.`);
  }

  return json(200, { ok: true, uploaded, expected: photoPaths.length, errors: errors.slice(0, 10) });
};

// Upload one Supabase-Storage photo to a JN job (3-step presigned flow, up to
// 3 attempts on transient JN 5xx/429). Mirrors inspector-submit-result.js.
async function uploadPhotoToJn({ sbUrl, sbKey, jnHeaders, jobId, path, label }) {
  const transient = (s) => s === 429 || (s >= 500 && s <= 599);
  let lastErr = { step: "unknown" };
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const dlRes = await fetch(`${sbUrl}/storage/v1/object/${SIGNED_BUCKET}/${path}`, {
        headers: { apikey: sbKey, Authorization: `Bearer ${sbKey}` },
      });
      if (!dlRes.ok) { lastErr = { step: "download", status: dlRes.status }; break; }
      const buf = Buffer.from(await dlRes.arrayBuffer());
      const filename = path.split("/").pop() || "photo.jpg";
      const contentType = filename.endsWith(".png") ? "image/png" : "image/jpeg";

      const initRes = await fetch(JN_FILES_BASE, {
        method: "POST", headers: jnHeaders,
        body: JSON.stringify({ related: [jobId], type: 1, filename, description: label }),
      });
      if (!initRes.ok) {
        lastErr = { step: "init", status: initRes.status, detail: (await initRes.text()).slice(0, 200) };
        if (transient(initRes.status) && attempt < 3) { await sleep(attempt * 800); continue; }
        break;
      }
      const initJson = await initRes.json().catch(() => ({}));
      const presignedUrl = initJson.data?.url || initJson.url || initJson.upload_url || initJson.presigned_url;
      const fileJnid = initJson.data?.jnid || initJson.jnid;
      if (!presignedUrl) { lastErr = { step: "init", error: "no presigned URL" }; break; }

      const putRes = await fetch(presignedUrl, { method: "PUT", headers: { "Content-Type": contentType }, body: buf });
      if (!putRes.ok) {
        lastErr = { step: "s3_put", status: putRes.status };
        if (transient(putRes.status) && attempt < 3) { await sleep(attempt * 800); continue; }
        break;
      }

      if (fileJnid) {
        await fetch(`${JN_FILES_UPLOADS}/${fileJnid}/complete`, { method: "POST", headers: jnHeaders, body: "{}" }).catch(() => {});
      }
      return { success: true };
    } catch (e) {
      lastErr = { step: "exception", error: e.message || "Unknown" };
      if (attempt < 3) { await sleep(attempt * 800); continue; }
    }
  }
  return { success: false, error: lastErr };
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function json(status, body) {
  return { statusCode: status, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}
