// netlify/functions/upload-photo-to-jn.js
//
// Upload ONE inspection photo from Supabase Storage to JobNimbus as
// an attachment on a JN job. Designed to be fired in parallel from
// the browser when push-result-to-jn returns the photo list — that
// way 28 photos finish in ~3-5 seconds wall time (limited by JN's
// concurrency, not by Netlify's 10s function timeout — each Lambda
// only handles a single photo, so each invocation comfortably fits).
//
// POST body:
//   { jn_job_id, path, bucket?, label? }
//
// Returns:
//   { ok, error? }
//
// Required env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, JOBNIMBUS_API_KEY

const SIGNED_BUCKET = "signed-documents";
const JN_FILES_INIT = "https://api.jobnimbus.com/files/v1/uploads/url";

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
  const jnJobId = (body.jn_job_id || "").trim();
  const path = (body.path || "").trim();
  const bucket = body.bucket || SIGNED_BUCKET;
  const label = (body.label || "Inspector photo").trim();
  if (!jnJobId || !path) return json(400, { ok: false, error: "jn_job_id and path required" });

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
  const JN_KEY = process.env.JOBNIMBUS_API_KEY;

  try {
    // 1. Download from Supabase Storage.
    const dlRes = await fetch(
      `${SB_URL}/storage/v1/object/${bucket}/${path}`,
      { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` } },
    );
    if (!dlRes.ok) {
      return json(200, { ok: false, error: `Storage download ${dlRes.status}` });
    }
    const buf = Buffer.from(await dlRes.arrayBuffer());
    const filename = path.split("/").pop() || "photo.jpg";
    const contentType = filename.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg";

    // 2. POST to JN /files to get a presigned S3 URL.
    const initRes = await fetch(JN_FILES_INIT, {
      method: "POST",
      headers: { Authorization: `bearer ${JN_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        related: [jnJobId],
        type: 1,
        filename,
        description: label,
      }),
    });
    const initText = await initRes.text();
    if (!initRes.ok) {
      return json(200, { ok: false, error: `JN init ${initRes.status}: ${initText.slice(0, 250)}` });
    }
    let initJson = {};
    try { initJson = JSON.parse(initText); } catch {}
    const presignedUrl =
      initJson.data?.url || initJson.url ||
      initJson.upload_url || initJson.presigned_url;
    if (!presignedUrl) {
      return json(200, { ok: false, error: `no presigned URL: ${initText.slice(0, 250)}` });
    }

    // 3. PUT bytes to S3 presigned URL.
    const putRes = await fetch(presignedUrl, {
      method: "PUT",
      headers: { "Content-Type": contentType },
      body: buf,
    });
    if (!putRes.ok) {
      const putErr = await putRes.text().catch(() => "");
      return json(200, { ok: false, error: `S3 PUT ${putRes.status}: ${putErr.slice(0, 200)}` });
    }

    // 4. Best-effort: tell JN the upload is complete (triggers thumbnail).
    const fileJnid = initJson.data?.jnid || initJson.jnid;
    if (fileJnid) {
      fetch(`https://api.jobnimbus.com/files/v1/uploads/${fileJnid}/complete`, {
        method: "POST",
        headers: { Authorization: `bearer ${JN_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }).catch((e) => console.warn("JN complete call failed:", e.message));
    }

    return json(200, { ok: true });
  } catch (e) {
    return json(200, { ok: false, error: e.message || "Unknown" });
  }
};

function json(status, body) {
  return {
    statusCode: status,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}
