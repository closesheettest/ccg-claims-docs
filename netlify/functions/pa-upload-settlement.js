// netlify/functions/pa-upload-settlement.js
//
// A PA uploads a settlement / iink document straight from the claim in their
// portal, and it lands as an attachment on the JobNimbus job. The file comes
// up from the browser as base64 in the JSON body (Netlify functions don't do
// multipart cleanly), and we push it to JN with the same 3-step presigned-S3
// flow the photo uploader uses (init → PUT bytes → complete).
//
// POST body:
//   { inspectionId, paId, filename, contentType, dataBase64 }
//
// Returns: { ok, error? }
//
// Required env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, JOBNIMBUS_API_KEY

const JN_FILES_INIT = "https://api.jobnimbus.com/files/v1/uploads/url";
const MAX_BYTES = 18 * 1024 * 1024; // ~18MB — comfortably inside Netlify's payload limit

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { ok: false, error: "Method not allowed" });
  for (const k of ["VITE_SUPABASE_URL", "VITE_SUPABASE_ANON_KEY", "JOBNIMBUS_API_KEY"]) {
    if (!process.env[k]) return json(500, { ok: false, error: `Missing env: ${k}` });
  }

  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch { return json(400, { ok: false, error: "Invalid JSON body" }); }
  const inspectionId = (body.inspectionId || "").trim();
  const paId = (body.paId || "").trim();
  let filename = (body.filename || "settlement.pdf").trim().replace(/[^\w.\-() ]+/g, "_").slice(0, 120);
  const contentType = (body.contentType || "application/octet-stream").trim();
  const dataBase64 = body.dataBase64 || "";
  if (!inspectionId || !dataBase64) return json(400, { ok: false, error: "inspectionId and dataBase64 required" });

  const buf = Buffer.from(dataBase64, "base64");
  if (!buf.length) return json(400, { ok: false, error: "Empty file" });
  if (buf.length > MAX_BYTES) return json(413, { ok: false, error: "File too large (max ~18MB)." });

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
  const JN_KEY = process.env.JOBNIMBUS_API_KEY;
  const sbH = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` };

  // 1. Resolve + verify: the deal must belong to this PA and have a JN job.
  const rows = await (await fetch(
    `${SB_URL}/rest/v1/inspections?id=eq.${inspectionId}&select=id,jn_job_id,pa_id,client_name&limit=1`,
    { headers: sbH },
  )).json().catch(() => []);
  const insp = rows?.[0];
  if (!insp) return json(404, { ok: false, error: "Claim not found" });
  if (paId && insp.pa_id && insp.pa_id !== paId) return json(403, { ok: false, error: "This claim belongs to a different PA" });
  if (!insp.jn_job_id) return json(400, { ok: false, error: "This claim isn't linked to a JobNimbus job yet." });

  try {
    // 2. Ask JN for a presigned upload URL for this job.
    const initRes = await fetch(JN_FILES_INIT, {
      method: "POST",
      headers: { Authorization: `bearer ${JN_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ related: [insp.jn_job_id], type: 1, filename, description: "Settlement / iink document (PA upload)" }),
    });
    const initText = await initRes.text();
    if (!initRes.ok) return json(502, { ok: false, error: `JN init ${initRes.status}: ${initText.slice(0, 250)}` });
    let initJson = {};
    try { initJson = JSON.parse(initText); } catch {}
    const presignedUrl = initJson.data?.url || initJson.url || initJson.upload_url || initJson.presigned_url;
    if (!presignedUrl) return json(502, { ok: false, error: `No presigned URL from JN: ${initText.slice(0, 200)}` });

    // 3. PUT the bytes to S3.
    const putRes = await fetch(presignedUrl, { method: "PUT", headers: { "Content-Type": contentType }, body: buf });
    if (!putRes.ok) return json(502, { ok: false, error: `S3 PUT ${putRes.status}: ${(await putRes.text().catch(() => "")).slice(0, 200)}` });

    // 4. Best-effort completion (triggers JN thumbnailing / finalization).
    const fileJnid = initJson.data?.jnid || initJson.jnid;
    if (fileJnid) {
      await fetch(`https://api.jobnimbus.com/files/v1/uploads/${fileJnid}/complete`, {
        method: "POST", headers: { Authorization: `bearer ${JN_KEY}`, "Content-Type": "application/json" }, body: JSON.stringify({}),
      }).catch(() => {});
    }
    return json(200, { ok: true, filename });
  } catch (e) {
    return json(502, { ok: false, error: e.message || "Upload failed" });
  }
};

function json(status, obj) {
  return { statusCode: status, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) };
}
