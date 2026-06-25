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
const JN_FILES_UPLOADS = "https://api.jobnimbus.com/files/v1/uploads";
const JN_FILES_BASE = `${JN_FILES_UPLOADS}/url`;
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
  // Free-text reason, required only when result === "lost".
  const lostReason = (body.lost_reason || "").trim();
  const photoPaths = Array.isArray(body.photo_paths) ? body.photo_paths : [];
  // Optional per-photo labels — when present, used as the JN file
  // description so attachments are named like "Left slope 1 damage"
  // instead of the generic "Inspector roof photo".
  const photoLabels = Array.isArray(body.photo_labels) ? body.photo_labels : [];
  if (!inspectionId) return json(400, { ok: false, error: "inspectionId required" });
  if (!["damage", "no_damage", "retail", "lost"].includes(result)) {
    return json(400, { ok: false, error: "result must be damage | no_damage | retail | lost" });
  }
  // A Lost result MUST carry a reason — that's the whole point of the
  // button (homeowner backed out at the door, etc.). No reason → reject.
  if (result === "lost" && !lostReason) {
    return json(400, { ok: false, error: "lost_reason is required for a Lost result" });
  }
  // Fail-safe: every actual inspection result (damage / no_damage /
  // retail) MUST have at least one photo — including No Damage. Only a
  // "lost" (the inspection never happened) is allowed with no photos.
  // The portal already blocks this client-side; this is the server guard.
  if (result !== "lost" && photoPaths.length === 0) {
    return json(400, { ok: false, error: "At least one photo is required for a damage, no damage, or retail result." });
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
    `${SB_URL}/rest/v1/inspections?id=eq.${inspectionId}&select=id,jn_job_id,client_name,inspection_photos,inspector_id&limit=1`,
    { headers: sbHeaders },
  );
  if (!inspRes.ok) {
    return json(500, { ok: false, error: `Could not fetch inspection: ${await inspRes.text()}` });
  }
  const rows = await inspRes.json();
  const insp = rows?.[0];
  if (!insp) return json(404, { ok: false, error: "Inspection not found" });

  // ── MANAGER-CONFIRMATION HOLD ──
  // If the inspector who claimed this job is flagged requires_confirmation
  // (e.g. a brand-new inspector we don't fully trust yet), we DON'T fire
  // ANY downstream action — no JN status push, no cert, no PA Ops Hub PDN,
  // no retail swap, no photo upload to JN. We only record what they
  // submitted (result + reason + photo metadata) into Supabase and flag
  // the row pending_confirmation=true. A manager then reviews it in the
  // "Inspections to confirm" tile and either Confirms (which replays the
  // full fan-out via confirm-inspection-result) or Rejects it.
  //
  // The hourly cron-push-pending-results is also gated on
  // pending_confirmation=false, so a held row can't sneak out that way.
  //
  // Skipped when mode === "confirm" (the manager's confirm call comes
  // back through confirm-inspection-result, not here) and for rows with
  // no inspector_id (office-classified records never hit this path).
  const mode = (body.mode || "submit").trim();
  if (mode !== "confirm" && insp.inspector_id) {
    let requiresConfirmation = false;
    try {
      const ir = await fetch(
        `${SB_URL}/rest/v1/inspectors?id=eq.${encodeURIComponent(insp.inspector_id)}&select=requires_confirmation&limit=1`,
        { headers: sbHeaders },
      );
      if (ir.ok) {
        const irows = await ir.json();
        requiresConfirmation = !!irows?.[0]?.requires_confirmation;
      }
    } catch (e) {
      console.warn("requires_confirmation lookup failed:", e.message);
    }

    if (requiresConfirmation) {
      const heldUpdates = {
        result,
        result_at: new Date().toISOString(),
        pending_confirmation: true,
      };
      if (inspectorName) heldUpdates.inspector_name = inspectorName;
      if (result === "lost") {
        heldUpdates.lost_reason = lostReason;
      } else {
        const prevPhotos = Array.isArray(insp.inspection_photos) ? insp.inspection_photos : [];
        const newPhotos = photoPaths.map((p, i) => ({
          path: p,
          bucket: SIGNED_BUCKET,
          captured_at: new Date().toISOString(),
          label: photoLabels[i] || null,
        }));
        heldUpdates.inspection_photos = [...prevPhotos, ...newPhotos];
      }
      const heldRes = await fetch(`${SB_URL}/rest/v1/inspections?id=eq.${inspectionId}`, {
        method: "PATCH",
        headers: sbHeaders,
        body: JSON.stringify(heldUpdates),
      });
      if (!heldRes.ok) {
        return json(500, { ok: false, error: `Could not save held result: ${await heldRes.text()}` });
      }
      return json(200, {
        ok: true,
        held: true,
        pending_confirmation: true,
        inspection_id: inspectionId,
        result,
        message: "Submitted. A manager will review and confirm before anything is sent.",
      });
    }
  }
  // ── END HOLD ──

  // ── LOST short-circuit ──
  // A "Lost" result means the inspection never happened (homeowner
  // changed their mind at the door, no-show, etc.). There are no roof
  // photos, no cert, and no PA/retail fan-out — just record WHY and
  // reflect it in JN. Handle it here so none of the photo/cert logic
  // below runs.
  if (result === "lost") {
    const lostUpdates = {
      result: "lost",
      result_at: new Date().toISOString(),
      lost_reason: lostReason,
    };
    if (inspectorName) lostUpdates.inspector_name = inspectorName;
    const lostRes = await fetch(`${SB_URL}/rest/v1/inspections?id=eq.${inspectionId}`, {
      method: "PATCH",
      headers: sbHeaders,
      body: JSON.stringify(lostUpdates),
    });
    if (!lostRes.ok) {
      return json(500, { ok: false, error: `Could not save Lost result: ${await lostRes.text()}` });
    }

    // Reflect in JN (best-effort): set the result field to "Lost" and drop
    // a Note on the job with the inspector's reason so the office sees why
    // the job died without leaving the app. These are AWAITED — on Netlify
    // the Lambda freezes the moment the handler returns, so a fire-and-
    // forget fetch would be killed mid-flight and the note would never land.
    let jnResultUpdated = false;
    let jnNoteAdded = false;
    if (insp.jn_job_id) {
      try {
        const r = await fetch(`${JN_BASE}/jobs/${insp.jn_job_id}`, {
          method: "PUT",
          headers: jnHeaders,
          body: JSON.stringify({ jnid: insp.jn_job_id, cf_string_34: "Lost" }),
        });
        if (r.ok) jnResultUpdated = true;
        else console.warn(`Lost cf_string_34 PUT failed (${r.status}):`, (await r.text()).slice(0, 200));
      } catch (e) {
        console.warn("Lost cf_string_34 PUT exception:", e.message);
      }

      const noteText =
        `🚫 Inspection LOST${inspectorName ? ` (inspector: ${inspectorName})` : ""}: ${lostReason}`;
      try {
        const r = await fetch(`${JN_BASE}/activities`, {
          method: "POST",
          headers: jnHeaders,
          body: JSON.stringify({
            record_type_name: "Note",
            note: noteText,
            primary: { id: insp.jn_job_id, type: "job" },
            related: [{ id: insp.jn_job_id, type: "job" }],
            is_status_change: false,
          }),
        });
        if (r.ok) jnNoteAdded = true;
        else console.warn(`Lost JN note POST failed (${r.status}):`, (await r.text()).slice(0, 200));
      } catch (e) {
        console.warn("Lost JN note POST exception:", e.message);
      }

      // Stamp jn_pushed_at on a successful sync so this lost record drops
      // out of the manager's "pending push" queue — otherwise a later
      // "Push to JN" would re-post a DUPLICATE Lost note.
      if (jnResultUpdated) {
        try {
          await fetch(`${SB_URL}/rest/v1/inspections?id=eq.${inspectionId}`, {
            method: "PATCH",
            headers: sbHeaders,
            body: JSON.stringify({ jn_pushed_at: new Date().toISOString() }),
          });
        } catch (e) {
          console.warn("Lost jn_pushed_at stamp failed:", e.message);
        }
      }
    }

    return json(200, {
      ok: true,
      inspection_id: inspectionId,
      result: "lost",
      jn_result_updated: jnResultUpdated,
      jn_note_added: jnNoteAdded,
    });
  }
  // ── END LOST ──

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
      const r = await uploadPhotoToJn({
        sbUrl: SB_URL, sbKey: SB_KEY, jnHeaders,
        jobId: insp.jn_job_id, path, label,
      });
      if (r.success) jnUploaded++;
      else jnErrors.push({ path, ...r.error });
    }
  }
  // Surface a JN photo-upload shortfall loudly. Historically this step
  // failed silently — JN returns the presigned URL nested under `data`,
  // so reading only top-level `url` found nothing and every photo was
  // skipped while the function still returned ok (the Mark Hamersly
  // incident, 2026-06). Now the upload reads the right field, retries
  // transient blips, and any remaining gap is logged + returned.
  if (insp.jn_job_id && photoPaths.length > 0 && jnUploaded < photoPaths.length) {
    console.error(
      `⚠ JN PHOTO SHORTFALL: ${jnUploaded}/${photoPaths.length} uploaded for job ${insp.jn_job_id} ("${insp.client_name}"). Errors: ${JSON.stringify(jnErrors).slice(0, 500)}`,
    );
  }

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
      // Push the result PLUS the Inspected Date (cf_date_22 = result_at)
      // and Inspected By (cf_string_43 = inspector name) in the same PUT,
      // so JN's job — and the PA portal that reads it — shows who did the
      // inspection and when, not just the Damage/No Damage classification.
      const cfBody = {
        jnid: insp.jn_job_id,
        cf_string_34: RESULT_LABELS[result],
        cf_date_22: Math.floor(Date.now() / 1000),
      };
      if (inspectorName) cfBody.cf_string_43 = inspectorName;
      fetch(`${JN_BASE}/jobs/${insp.jn_job_id}`, {
        method: "PUT",
        headers: jnHeaders,
        body: JSON.stringify(cfBody),
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
    // cert upload is fired from process-retail-result. Uses the
    // -background variant so the cert work continues after this
    // function returns (regular variant routinely exceeds the 10s
    // timeout, leaving the inspector with no feedback).
    if ((result === "damage" || result === "no_damage") && base) {
      fetch(`${base}/.netlify/functions/generate-and-upload-insp-report-background`, {
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
    // Go-back TASK on the JN job at the homeowner's preferred time
    // (review_availability from intake) — "Inspection Result Insurance PA"
    // (damage) / "…Back to Retail" (retail) / "…No Damage". Fire-and-forget.
    if (result === "damage" || result === "no_damage" || result === "retail") {
      fetch(`${base}/.netlify/functions/create-result-task`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ inspectionId }),
      }).catch((e) => console.warn("create-result-task trigger failed:", e.message));
    }
  }

  return json(200, {
    ok: true,
    inspection_id: inspectionId,
    result,
    photos_added: photoPaths.length,
    jn_photos_expected: insp.jn_job_id ? photoPaths.length : 0,
    jn_photos_uploaded: jnUploaded,
    jn_errors: jnErrors,
    jn_result_updated: jnResultUpdated,
    cert_upload_fired: certUploadFired,
    pa_pdn_fired: paPdnFired,
    retail_jn_fired: retailJnFired,
  });
};

// Upload one Supabase-Storage photo to a JN job. 3-step JN flow:
//   1. POST .../uploads/url  → presigned S3 URL + file jnid (NESTED under
//      `data` — the original code read top-level `url` and silently found
//      nothing, so no photo ever uploaded).
//   2. PUT the bytes to that URL.
//   3. POST .../uploads/<jnid>/complete → JN finalizes + renders the
//      attachment/thumbnail.
// Each photo gets up to 3 attempts so a transient JN 5xx/429 doesn't drop
// it. Returns { success } or { success:false, error:{ step, ... } }.
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
        method: "POST",
        headers: jnHeaders,
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

      const putRes = await fetch(presignedUrl, {
        method: "PUT",
        headers: { "Content-Type": contentType },
        body: buf,
      });
      if (!putRes.ok) {
        lastErr = { step: "s3_put", status: putRes.status };
        if (transient(putRes.status) && attempt < 3) { await sleep(attempt * 800); continue; }
        break;
      }

      // Finalize so JN renders the attachment. Best-effort: the bytes are
      // already in S3, so a complete-step blip doesn't fail the upload.
      if (fileJnid) {
        await fetch(`${JN_FILES_UPLOADS}/${fileJnid}/complete`, {
          method: "POST", headers: jnHeaders, body: "{}",
        }).catch(() => {});
      }
      return { success: true };
    } catch (e) {
      lastErr = { step: "exception", error: e.message || "Unknown" };
      if (attempt < 3) { await sleep(attempt * 800); continue; }
    }
  }
  return { success: false, error: lastErr };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function json(status, body) {
  return {
    statusCode: status,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}
