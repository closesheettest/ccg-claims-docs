// netlify/functions/cron-heal-signed-pdfs.js
//
// SELF-HEALING safety net for the signed agreement PDF — the one document
// that can never be regenerated (the homeowner's signature lives ONLY inside
// it). The signing flow now rides the signed PDF bytes along on the same DB
// insert that creates the inspection row (inspections.pending_pdf_b64), so a
// signed record can NEVER exist without its PDF. This cron is what then
// guarantees those bytes reach their durable homes:
//
//   1. Archive to Supabase Storage (signed-documents bucket) → recoverable
//      forever via the admin "Re-send Docs" button.
//   2. Re-attach the signed agreement to the JobNimbus job's Documents tab
//      (the exact gap that stranded Mchenry Loren + Williams Kimberly — job
//      existed, doc upload had silently failed, nothing re-tried it).
//
// Once a row is safely in Storage (+ JN when a job exists), pending_pdf_b64
// is cleared so the table stays lean. If archive still fails (a Storage
// outage), the bytes stay safe on the row and the next run retries — the
// signature is never lost.
//
// Trigger: Netlify scheduled function every 15 min. Idempotent + a no-op on
// clean days (nothing pending). Also callable by hand (GET/POST) to flush now.

const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const JN_KEY = process.env.JOBNIMBUS_API_KEY;
const BUCKET = "signed-documents";
const JN_API1 = "https://app.jobnimbus.com/api1";

const sb = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" };

function siteBase() {
  return process.env.URL || process.env.DEPLOY_PRIME_URL || "https://free-roof-inspections.netlify.app";
}

// Does the JN job already carry the signed agreement? Fail-OPEN (return false)
// so a JN hiccup never blocks re-attaching a genuinely-missing doc — and since
// we clear pending_pdf_b64 right after a successful heal, a row is processed at
// most once, so this can't loop into duplicate uploads.
async function jobHasAgreement(jobId) {
  try {
    const r = await fetch(`${JN_API1}/files?related=${encodeURIComponent(jobId)}&type=1&size=50`, {
      headers: { Authorization: `bearer ${JN_KEY}`, "Content-Type": "application/json" },
    });
    if (!r.ok) return false;
    const data = await r.json().catch(() => ({}));
    const files = data.files || data.results || [];
    return files.some((f) => {
      const fn = (f.filename || "").toLowerCase();
      const desc = (f.description || "").toLowerCase();
      return fn.includes("inspection-agreement") || desc.includes("inspection agreement");
    });
  } catch { return false; }
}

// 3-step JN file upload — copied faithfully from jobnimbus-sync.uploadFileToJob
// (kept inline so this cron stays a self-contained CJS function, no local imports).
async function uploadFileToJob(jobId, filename, base64Content) {
  try {
    const fileBytes = Buffer.from(base64Content, "base64");
    const initRes = await fetch("https://api.jobnimbus.com/files/v1/uploads/url", {
      method: "POST",
      headers: { Authorization: `bearer ${JN_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ related: [jobId], type: 1, filename, description: "Signed Inspection Agreement" }),
    });
    const initText = await initRes.text();
    if (!initRes.ok) return { success: false, error: `init ${initRes.status}: ${initText.slice(0, 200)}` };
    const initData = JSON.parse(initText);
    const uploadUrl = initData.data?.url || initData.url || initData.upload_url;
    const fileJnid = initData.data?.jnid || initData.jnid;
    if (!uploadUrl) return { success: false, error: "no upload url" };
    const s3Res = await fetch(uploadUrl, { method: "PUT", headers: { "Content-Type": "application/pdf" }, body: fileBytes });
    if (!s3Res.ok) return { success: false, error: `s3 ${s3Res.status}` };
    if (fileJnid) {
      await fetch(`https://api.jobnimbus.com/files/v1/uploads/${fileJnid}/complete`, {
        method: "POST", headers: { Authorization: `bearer ${JN_KEY}`, "Content-Type": "application/json" }, body: "{}",
      }).catch(() => {});
    }
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

exports.handler = async () => {
  if (!SB_URL || !SB_KEY) return json(500, { ok: false, error: "supabase env missing" });

  // Pull the pending rows (oldest signed first). Small batch — this is a
  // rare-failure catch-net, not a bulk job.
  const q = `${SB_URL}/rest/v1/inspections?pending_pdf_b64=not.is.null` +
    `&select=id,jn_job_id,client_name,signed_at,pending_pdf_b64,signed_pdfs&order=signed_at.asc.nullsfirst&limit=25`;
  const listRes = await fetch(q, { headers: sb });
  if (!listRes.ok) return json(500, { ok: false, error: `list ${listRes.status}: ${(await listRes.text()).slice(0, 200)}` });
  const rows = await listRes.json().catch(() => []);
  if (!rows.length) return json(200, { ok: true, pending: 0, healed: 0, message: "nothing pending" });

  const base = siteBase();
  let healed = 0, archivedOnly = 0, stillFailing = 0, jnAttached = 0;
  const stuck = [];

  for (const r of rows) {
    const pdfs = r.pending_pdf_b64 && typeof r.pending_pdf_b64 === "object" ? r.pending_pdf_b64 : null;
    if (!pdfs || !Object.keys(pdfs).length) {
      // Malformed/empty — clear so it stops showing up.
      await patch(r.id, { pending_pdf_b64: null });
      continue;
    }

    // 1. Durable Storage archive (writes signed_pdfs on the row).
    let archiveOk = false;
    try {
      const ar = await fetch(`${base}/.netlify/functions/archive-signed-docs`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ inspectionId: r.id, pdfs }),
      });
      const ab = await ar.json().catch(() => ({}));
      archiveOk = ar.ok && (ab.ok === true || (ab.uploaded || 0) > 0);
    } catch (e) {
      console.warn("archive threw for", r.id, e?.message);
    }
    if (!archiveOk) {
      stillFailing += 1;
      const ageH = r.signed_at ? (Date.now() - new Date(r.signed_at)) / 36e5 : null;
      if (ageH != null && ageH > 3) stuck.push({ id: r.id, name: r.client_name, ageH: Math.round(ageH) });
      continue; // bytes stay safe on the row; retry next run
    }

    // 2. Re-attach the signed agreement to JobNimbus (only when a job exists
    //    and the doc isn't already there). This is the piece nothing retried
    //    before. No jn_job_id yet → the daily-orphan-alert / find-orphan
    //    machinery handles job creation; the Storage copy is already safe.
    if (r.jn_job_id && JN_KEY) {
      const agreement = pdfs.insp || pdfs.lor || pdfs.pac || null;
      if (agreement?.base64 && !(await jobHasAgreement(r.jn_job_id))) {
        const up = await uploadFileToJob(r.jn_job_id, agreement.filename || "Free-Roof-Inspection-Agreement.pdf", agreement.base64);
        if (up.success) jnAttached += 1;
        else console.warn("JN re-attach failed for", r.id, up.error);
      }
    }

    // 3. Safely archived → drop the in-row copy.
    await patch(r.id, { pending_pdf_b64: null });
    healed += 1;
    if (!r.jn_job_id) archivedOnly += 1;
  }

  const result = { ok: true, pending: rows.length, healed, jnAttached, archivedOnly, stillFailing, stuck };
  console.log("cron-heal-signed-pdfs:", JSON.stringify(result));
  return json(200, result);
};

async function patch(id, body) {
  return fetch(`${SB_URL}/rest/v1/inspections?id=eq.${encodeURIComponent(id)}`, {
    method: "PATCH", headers: { ...sb, Prefer: "return=minimal" }, body: JSON.stringify(body),
  }).catch(() => {});
}

function json(statusCode, obj) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) };
}

// Netlify scheduled trigger — every 15 minutes.
exports.config = { schedule: "*/15 * * * *" };
