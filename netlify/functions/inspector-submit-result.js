// netlify/functions/inspector-submit-result.js
//
// Called from the mobile Inspector app when an inspector finishes a job:
// uploads roof photos (already in Supabase Storage) to the linked JN
// job, writes the result fields back to the inspection row, and (if
// result === "damage") fires the PA Ops Hub PDN as a fire-and-forget.
//
// Why a server function instead of doing it all in the browser:
//   • Photo uploads to JN need the JN API key (server-only).
//   • PA Ops Hub PDN is server-driven.
// The browser only uploads photo bytes to Supabase Storage (which works
// with the anon key), then calls this with the storage paths.
//
// POST body: {
//   inspectionId: "<uuid>",
//   result: "damage" | "no_damage" | "retail",
//   inspector_name: "Optional override",
//   photo_paths: [
//     "inspection-photos/<inspection_id>/<ts>_front.jpg",
//     ...
//   ]
// }
//
// Response: { ok: true, jn_photos_uploaded: N, pa_pdn_fired: boolean }
//
// Required env vars: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY,
//                    JOBNIMBUS_API_KEY.

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
  if (missing.length) return json(500, { ok: false, error: `Missing env vars: ${missing.join(", ")}` });

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return json(400, { ok: false, error: "Invalid JSON body" });
  }
  const inspectionId = (body.inspectionId || "").trim();
  const result = (body.result || "").trim();
  const inspectorName = (body.inspector_name || "").trim();
  const photoPaths = Array.isArray(body.photo_paths) ? body.photo_paths : [];
  // Optional per-photo labels — when present, used as the JN file
  // description so attachments are named like "Left slope 1 damage"
  // instead of the generic "Inspector roof photo".
  const photoLabels = Array.isArray(body.photo_labels) ? body.photo_labels : [];
  if (!inspectionId) return json(400, { ok: false, error: "inspectionId required" });
  if (!["damage", "no_damage", "retail"].includes(result)) {
    return json(400, { ok: false, error: "result must be damage | no_damage | retail" });
  }

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

  // 1. Fetch the inspection.
  const inspRes = await fetch(
    `${SB_URL}/rest/v1/inspections?id=eq.${inspectionId}&select=id,jn_job_id,client_name,inspection_photos&limit=1`,
    { headers: sbHeaders },
  );
  if (!inspRes.ok) {
    return json(500, { ok: false, error: `Could not fetch inspection: ${await inspRes.text()}` });
  }
  const rows = await inspRes.json();
  const insp = rows?.[0];
  if (!insp) return json(404, { ok: false, error: "Inspection not found" });

  // 2. Update the inspection result.
  const updates = {
    result,
    result_at: new Date().toISOString(),
  };
  if (inspectorName) updates.inspector_name = inspectorName;
  // Merge new photo paths into inspection_photos JSON column.
  const prevPhotos = Array.isArray(insp.inspection_photos) ? insp.inspection_photos : [];
  const newPhotos = photoPaths.map((p, i) => ({
    path: p,
    bucket: SIGNED_BUCKET,
    captured_at: new Date().toISOString(),
    label: photoLabels[i] || null,
  }));
  updates.inspection_photos = [...prevPhotos, ...newPhotos];
  const updRes = await fetch(`${SB_URL}/rest/v1/inspections?id=eq.${inspectionId}`, {
    method: "PATCH",
    headers: sbHeaders,
    body: JSON.stringify(updates),
  });
  if (!updRes.ok) {
    return json(500, { ok: false, error: `Could not update inspection: ${await updRes.text()}` });
  }

  // 3. Upload each photo to JN (if linked).
  let jnUploaded = 0;
  const jnErrors = [];
  if (insp.jn_job_id) {
    for (let i = 0; i < photoPaths.length; i++) {
      const path = photoPaths[i];
      const label = photoLabels[i] || "Inspector roof photo";
      try {
        // Download from Supabase Storage. Storage object URL pattern:
        // {SB_URL}/storage/v1/object/{bucket}/{path}
        const dlRes = await fetch(
          `${SB_URL}/storage/v1/object/${SIGNED_BUCKET}/${path}`,
          { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` } },
        );
        if (!dlRes.ok) {
          jnErrors.push({ path, step: "download", status: dlRes.status });
          continue;
        }
        const buf = Buffer.from(await dlRes.arrayBuffer());
        const filename = path.split("/").pop() || "photo.jpg";
        const contentType = filename.endsWith(".png") ? "image/png" : "image/jpeg";

        // JN file upload: 2-step. Ask JN for a presigned URL, then PUT
        // the bytes to that URL. The `description` uses the wizard
        // label so JN attachments are human-readable.
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
          jnErrors.push({ path, step: "init", status: initRes.status, detail: (await initRes.text()).slice(0, 200) });
          continue;
        }
        const initJson = await initRes.json().catch(() => ({}));
        const presignedUrl = initJson.url || initJson.upload_url || initJson.presigned_url;
        if (!presignedUrl) {
          jnErrors.push({ path, step: "init", error: "no presigned URL" });
          continue;
        }
        const putRes = await fetch(presignedUrl, {
          method: "PUT",
          headers: { "Content-Type": contentType },
          body: buf,
        });
        if (!putRes.ok) {
          jnErrors.push({ path, step: "s3_put", status: putRes.status });
          continue;
        }
        jnUploaded++;
      } catch (e) {
        jnErrors.push({ path, error: e.message || "Unknown" });
      }
    }
  }
  // We're done iterating photoPaths here; loop variables are scoped.

  // 4. Push the result back to JN and trigger the result-specific
  //    fan-out. Everything fire-and-forget so the inspector's
  //    Submit button isn't blocked on slow downstream calls.
  //
  // For ALL results (damage / no_damage / retail) — when there's a
  // linked JN job:
  //   • PUT cf_string_34 = "Damage" | "No Damage" | "Retail"
  //     (so JN reflects the result the inspector logged in the app —
  //     previously the JN job stayed at "Needs Inspection" forever)
  //   • Generate the inspection-report cert + upload to JN Documents
  //     via /.netlify/functions/generate-and-upload-insp-report
  //
  // PLUS result-specific extras:
  //   • damage → send-to-pa-ops-hub (PA gets homeowner + photos + PDF)
  //   • retail → process-retail-result (also swaps record_type PA→Lead
  //              and location insurance→retail; sets cf_string_34 +
  //              uploads the cert itself, so we skip the generic
  //              cf_string_34 PUT + cert-upload for retail to avoid
  //              double-firing)
  const base = process.env.URL || process.env.PUBLIC_SITE_URL || "";
  const RESULT_LABELS = { damage: "Damage", no_damage: "No Damage", retail: "Retail" };
  let paPdnFired = false;
  let retailJnFired = false;
  let jnResultUpdated = false;
  let certUploadFired = false;

  if (insp.jn_job_id) {
    // For damage + no_damage, push cf_string_34 directly. Retail goes
    // through process-retail-result which handles cf_string_34 + the
    // record_type/location transitions in one PUT.
    if (result === "damage" || result === "no_damage") {
      fetch(`${JN_BASE}/jobs/${insp.jn_job_id}`, {
        method: "PUT",
        headers: jnHeaders,
        body: JSON.stringify({
          jnid: insp.jn_job_id,
          cf_string_34: RESULT_LABELS[result],
        }),
      })
        .then(async (r) => {
          if (!r.ok) {
            console.warn(`cf_string_34 PUT failed (${r.status}):`, (await r.text()).slice(0, 200));
          }
        })
        .catch((e) => console.warn("cf_string_34 PUT exception:", e.message));
      jnResultUpdated = true;
    }

    // Cert + photos to JN Documents — for damage + no_damage. Retail's
    // cert upload is fired from process-retail-result.
    if ((result === "damage" || result === "no_damage") && base) {
      fetch(`${base}/.netlify/functions/generate-and-upload-insp-report`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jnid: insp.jn_job_id }),
      }).catch((e) => console.warn("Cert upload trigger failed:", e.message));
      certUploadFired = true;
    }
  }

  if (base) {
    if (result === "damage") {
      fetch(`${base}/.netlify/functions/send-to-pa-ops-hub`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ inspectionId }),
      }).catch((e) => console.warn("PA Ops Hub trigger failed:", e.message));
      paPdnFired = true;
    } else if (result === "retail") {
      fetch(`${base}/.netlify/functions/process-retail-result`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ inspectionId }),
      }).catch((e) => console.warn("Retail processing trigger failed:", e.message));
      retailJnFired = true;
    }
  }

  return json(200, {
    ok: true,
    inspection_id: inspectionId,
    result,
    photos_added: photoPaths.length,
    jn_photos_uploaded: jnUploaded,
    jn_errors: jnErrors,
    jn_result_updated: jnResultUpdated,
    cert_upload_fired: certUploadFired,
    pa_pdn_fired: paPdnFired,
    retail_jn_fired: retailJnFired,
  });
};

function json(status, body) {
  return {
    statusCode: status,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}
