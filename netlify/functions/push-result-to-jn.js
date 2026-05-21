// netlify/functions/push-result-to-jn.js
//
// Push a recorded inspection result + the wizard photos to JobNimbus
// and trigger the cert generation. Designed for the manager-side
// "🔄 Push to JN" button on Record Lookup AND for auto-firing from
// submitInspectionResult when a manager statuses a record via the
// Set-result dropdown.
//
// What we do (in order, INLINE — no nested HTTP-to-our-own-functions
// for the photo step because each function has its own 10s budget):
//
//   1. PUT cf_string_34 on the JN job (fast, ~1s)
//   2. For each photo in inspection_photos JSON:
//      - Download from Supabase Storage
//      - Upload to JN /files (presigned URL + PUT to S3)
//      Done in parallel batches of 3 so 10 photos finish in ~4-6s
//      total instead of ~20s sequential.
//   3. Fire generate-and-upload-insp-report HTTP fetch as a separate
//      Lambda invocation (NOT awaited — Netlify spawns its own 10s
//      Lambda for that, independent of this one's budget). Returns
//      quickly to the client.
//
// Retail records short-circuit at the top — they get handed to
// process-retail-result which does the location + record-type
// transitions on top of the same cf_string_34 + cert work.
//
// POST body: { inspectionId }
//
// Required env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, JOBNIMBUS_API_KEY,
//               URL or PUBLIC_SITE_URL.

const JN_BASE = "https://app.jobnimbus.com/api1";
const JN_FILES_BASE = "https://api.jobnimbus.com/files/v1/uploads/url";
const SIGNED_BUCKET = "signed-documents";

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
  if (!inspectionId) return json(400, { ok: false, error: "inspectionId required" });

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
  const JN_KEY = process.env.JOBNIMBUS_API_KEY;
  const sbHeaders = {
    apikey: SB_KEY,
    Authorization: `Bearer ${SB_KEY}`,
    "Content-Type": "application/json",
  };
  const jnHeaders = {
    Authorization: `bearer ${JN_KEY}`,
    "Content-Type": "application/json",
  };

  // Fetch the inspection row — need result + jn_job_id + inspection_photos.
  const inspRes = await fetch(
    `${SB_URL}/rest/v1/inspections?id=eq.${encodeURIComponent(inspectionId)}&select=id,jn_job_id,client_name,result,inspection_photos&limit=1`,
    { headers: sbHeaders },
  );
  if (!inspRes.ok) {
    return json(500, { ok: false, error: `Could not fetch inspection: ${await inspRes.text()}` });
  }
  const rows = await inspRes.json();
  const insp = rows?.[0];
  if (!insp) return json(404, { ok: false, error: "Inspection not found" });
  if (!insp.result) {
    return json(400, { ok: false, error: "No result on this inspection yet — nothing to push" });
  }
  if (!insp.jn_job_id) {
    return json(400, { ok: false, error: "Inspection has no jn_job_id — run Sync to JN first to link the record" });
  }

  const base = (process.env.URL || process.env.PUBLIC_SITE_URL || "").replace(/\/$/, "");

  // Retail → dedicated function (also does record_type / location swap).
  if (insp.result === "retail") {
    if (!base) return json(500, { ok: false, error: "No base URL configured for internal retail call" });
    const r = await fetch(`${base}/.netlify/functions/process-retail-result`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ inspectionId }),
    });
    const body2 = await r.json().catch(() => ({}));
    return json(r.ok ? 200 : 500, {
      ok: r.ok && body2.ok !== false,
      delegated_to: "process-retail-result",
      ...body2,
    });
  }

  const RESULT_LABELS = { damage: "Damage", no_damage: "No Damage" };
  const cfValue = RESULT_LABELS[insp.result];
  if (!cfValue) {
    return json(400, { ok: false, error: `Unsupported result "${insp.result}"` });
  }

  // ── 1. PUT cf_string_34 on the JN job ─────────────────────────────────
  let jnUpdated = false;
  let jnUpdateError = null;
  try {
    const putRes = await fetch(`${JN_BASE}/jobs/${insp.jn_job_id}`, {
      method: "PUT",
      headers: jnHeaders,
      body: JSON.stringify({ jnid: insp.jn_job_id, cf_string_34: cfValue }),
    });
    if (putRes.ok) {
      jnUpdated = true;
    } else {
      jnUpdateError = `JN PUT failed (${putRes.status}): ${(await putRes.text()).slice(0, 300)}`;
    }
  } catch (e) {
    jnUpdateError = `JN PUT exception: ${e.message}`;
  }

  // ── 2. Upload wizard photos to JN as attachments ──────────────────────
  // inspection_photos is the JSON array the wizard wrote when the
  // inspector submitted. Each entry: { path, bucket, label, captured_at }.
  // Parallel batches of 3 to keep within Netlify's 10s budget on 10+ photos.
  const photos = Array.isArray(insp.inspection_photos) ? insp.inspection_photos : [];
  const photoResults = []; // { ok, label, error? }
  if (photos.length > 0) {
    const BATCH_SIZE = 3;
    for (let i = 0; i < photos.length; i += BATCH_SIZE) {
      const batch = photos.slice(i, i + BATCH_SIZE);
      await Promise.all(batch.map(async (p) => {
        const label = p.label || "Inspector photo";
        try {
          const bucket = p.bucket || SIGNED_BUCKET;
          const dlRes = await fetch(
            `${SB_URL}/storage/v1/object/${bucket}/${p.path}`,
            { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` } },
          );
          if (!dlRes.ok) {
            photoResults.push({ ok: false, label, error: `Storage download ${dlRes.status}` });
            return;
          }
          const buf = Buffer.from(await dlRes.arrayBuffer());
          const filename = p.path.split("/").pop() || "photo.jpg";
          const contentType = filename.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg";

          const initRes = await fetch(JN_FILES_BASE, {
            method: "POST",
            headers: jnHeaders,
            body: JSON.stringify({
              related: [insp.jn_job_id],
              type: 1,
              filename,
              description: label,
            }),
          });
          if (!initRes.ok) {
            photoResults.push({ ok: false, label, error: `JN init ${initRes.status}` });
            return;
          }
          const initJson = await initRes.json().catch(() => ({}));
          const presignedUrl = initJson.url || initJson.upload_url || initJson.presigned_url;
          if (!presignedUrl) {
            photoResults.push({ ok: false, label, error: "no presigned URL" });
            return;
          }
          const putRes = await fetch(presignedUrl, {
            method: "PUT",
            headers: { "Content-Type": contentType },
            body: buf,
          });
          if (!putRes.ok) {
            photoResults.push({ ok: false, label, error: `S3 PUT ${putRes.status}` });
            return;
          }
          photoResults.push({ ok: true, label });
        } catch (e) {
          photoResults.push({ ok: false, label, error: e.message || "Unknown" });
        }
      }));
    }
  }
  const photosUploaded = photoResults.filter((r) => r.ok).length;
  const photosFailed = photoResults.filter((r) => !r.ok).length;

  // ── 3. Fire cert generation as a separate Lambda invocation ──────────
  // We DON'T await this. The fetch call hits Netlify's gateway which
  // routes to a new Lambda for generate-and-upload-insp-report. That
  // Lambda has its own 10s budget, independent of this one's. The
  // client gets back our response (with photo counts) within ~5-6s;
  // the cert lands in JN Documents asynchronously a few seconds later.
  let certKickedOff = false;
  if (base) {
    try {
      // Don't await — we want this Lambda to fire-and-go.
      fetch(`${base}/.netlify/functions/generate-and-upload-insp-report`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jnid: insp.jn_job_id }),
      }).catch((e) => console.warn("Cert kickoff failed:", e.message));
      certKickedOff = true;
    } catch (e) {
      console.warn("Cert kickoff exception:", e.message);
    }
  }

  return json(200, {
    ok: jnUpdated,
    inspection_id: inspectionId,
    jn_job_id: insp.jn_job_id,
    client_name: insp.client_name,
    result: insp.result,
    cf_string_34_set: cfValue,
    jn_updated: jnUpdated,
    jn_update_error: jnUpdateError,
    photos_total: photos.length,
    photos_uploaded: photosUploaded,
    photos_failed: photosFailed,
    photo_errors: photoResults.filter((r) => !r.ok).slice(0, 5),
    cert_kicked_off: certKickedOff,
  });
};

function json(status, body) {
  return {
    statusCode: status,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}
