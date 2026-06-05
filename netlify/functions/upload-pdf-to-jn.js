// netlify/functions/upload-pdf-to-jn.js
//
// Step 2 of the split cert flow. Fetches a PDF from a Supabase signed
// URL (stashed there by generate-and-upload-insp-report when called
// with skip_jn_upload=true) and uploads it to a JN job's Documents tab.
//
// Why this is a separate Lambda: PDFShift render + JN upload combined
// was busting Netlify's 10s budget. And returning the PDF base64 in a
// JSON body OOM'd V8's heap. Stashing in Supabase Storage keeps each
// Lambda's memory small and lets each finish in its own 10s budget.
//
// POST body: { jnid, filename, pdf_url, pdf_storage_path? }
//   • pdf_url: signed URL to the stashed PDF (from Lambda A)
//   • pdf_storage_path: optional — when provided, we delete the temp
//     PDF from Supabase Storage after a successful JN upload

const JN_BASE = "https://app.jobnimbus.com/api1";
const JN_FILES_BASE = "https://api.jobnimbus.com";
const JN_KEY = process.env.JOBNIMBUS_API_KEY;
const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const SIGNED_BUCKET = "signed-documents";

const jnHeaders = { Authorization: `bearer ${JN_KEY}`, "Content-Type": "application/json" };

// Backstop dedup: ask JN whether this job already carries an Inspection
// Report document before we upload. The primary guard lives in Lambda A
// (generate-and-upload-insp-report), but a same-minute double-fire can
// have both Lambda A calls clear that guard before either uploads, so we
// re-check here right before the upload. Fail-OPEN on error so a JN hiccup
// never blocks a legitimate first cert. Mirrors the helper in Lambda A.
async function jobAlreadyHasReport(jnid) {
  try {
    const r = await fetch(`${JN_BASE}/files?related=${encodeURIComponent(jnid)}&type=1&size=50`, { headers: jnHeaders });
    if (!r.ok) return false;
    const data = await r.json().catch(() => ({}));
    const files = data.files || data.results || [];
    return files.some((f) => {
      const fn = (f.filename || "");
      const desc = (f.description || "");
      return fn.startsWith("Inspection-Report-") || desc.startsWith("Inspection Report (with photos)");
    });
  } catch {
    return false;
  }
}

// Delete the temp PDF stashed in Supabase Storage (best-effort, fire-and-forget).
function cleanupTempPdf(pdfStoragePath) {
  if (pdfStoragePath && SB_URL && SB_KEY) {
    fetch(`${SB_URL}/storage/v1/object/${SIGNED_BUCKET}/${pdfStoragePath}`, {
      method: "DELETE",
      headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
    }).catch(() => {});
  }
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ ok: false, error: "Method not allowed" }) };
  }
  if (!JN_KEY) return { statusCode: 500, body: JSON.stringify({ ok: false, error: "JOBNIMBUS_API_KEY not set" }) };

  let jnid, filename, pdfUrl, pdfStoragePath;
  try {
    const body = JSON.parse(event.body || "{}");
    jnid = (body.jnid || "").trim();
    filename = (body.filename || "").trim();
    pdfUrl = (body.pdf_url || "").trim();
    pdfStoragePath = (body.pdf_storage_path || "").trim();
  } catch {
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: "Invalid JSON body" }) };
  }
  if (!jnid)     return { statusCode: 400, body: JSON.stringify({ ok: false, error: "jnid required" }) };
  if (!filename) return { statusCode: 400, body: JSON.stringify({ ok: false, error: "filename required" }) };
  if (!pdfUrl)   return { statusCode: 400, body: JSON.stringify({ ok: false, error: "pdf_url required" }) };

  try {
    // Backstop idempotency: if JN already has an Inspection Report on this
    // job, don't upload a duplicate. Still clean up the temp PDF so it
    // doesn't linger in Storage.
    if (await jobAlreadyHasReport(jnid)) {
      cleanupTempPdf(pdfStoragePath);
      return { statusCode: 200, body: JSON.stringify({ ok: true, skipped: true, already_in_jn: true, jnid, filename }) };
    }

    // Fetch the PDF from Supabase. Stream to a Buffer.
    const pdfRes = await fetch(pdfUrl);
    if (!pdfRes.ok) {
      const txt = await pdfRes.text().catch(() => "");
      return {
        statusCode: 500,
        body: JSON.stringify({ ok: false, error: `Could not fetch PDF (${pdfRes.status}): ${txt.slice(0, 200)}` }),
      };
    }
    const fileBytes = Buffer.from(await pdfRes.arrayBuffer());
    if (fileBytes.length < 5 || fileBytes.slice(0, 5).toString() !== "%PDF-") {
      return {
        statusCode: 500,
        body: JSON.stringify({ ok: false, error: "Fetched URL did not return a PDF" }),
      };
    }

    const initRes = await fetch(`${JN_FILES_BASE}/files/v1/uploads/url`, {
      method: "POST",
      headers: { Authorization: `bearer ${JN_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        related: [jnid],
        type: 1,
        filename,
        description: "Inspection Report (with photos) — generated from app",
      }),
    });
    const initText = await initRes.text();
    if (!initRes.ok) {
      return { statusCode: 500, body: JSON.stringify({ ok: false, error: `Init ${initRes.status}: ${initText.slice(0, 300)}` }) };
    }
    const initData = JSON.parse(initText);
    const uploadUrl = initData.data?.url || initData.url || initData.upload_url;
    const fileJnid = initData.data?.jnid || initData.jnid;
    if (!uploadUrl) {
      return { statusCode: 500, body: JSON.stringify({ ok: false, error: "No upload URL: " + initText.slice(0, 200) }) };
    }

    const s3Res = await fetch(uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": "application/pdf" },
      body: fileBytes,
    });
    if (!s3Res.ok) {
      const s3Err = await s3Res.text();
      return { statusCode: 500, body: JSON.stringify({ ok: false, error: `S3 ${s3Res.status}: ${s3Err.slice(0, 200)}` }) };
    }

    if (fileJnid) {
      await fetch(`${JN_FILES_BASE}/files/v1/uploads/${fileJnid}/complete`, {
        method: "POST",
        headers: { Authorization: `bearer ${JN_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
    }

    // Best-effort cleanup of the temp PDF in Supabase Storage.
    if (pdfStoragePath && SB_URL && SB_KEY) {
      fetch(`${SB_URL}/storage/v1/object/${SIGNED_BUCKET}/${pdfStoragePath}`, {
        method: "DELETE",
        headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
      }).catch(() => {});
    }

    return { statusCode: 200, body: JSON.stringify({ ok: true, filename, jnid }) };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: e.message || "upload failed" }) };
  }
};
