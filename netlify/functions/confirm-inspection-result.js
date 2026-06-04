// netlify/functions/confirm-inspection-result.js
//
// Manager action for a result that was HELD because the inspector is
// flagged requires_confirmation (see inspector-submit-result.js). The
// inspector's submission is already saved in Supabase with
// pending_confirmation=true and NOTHING was fired. This function
// replays the exact same downstream fan-out the inspector app would
// have fired, then clears the hold:
//
//   action: "confirm"  → push to JN, upload photos, gen cert, fire
//                        PA Ops Hub PDN (damage) / retail swap (retail),
//                        stamp jn_pushed_at, clear pending_confirmation.
//   action: "reject"   → wipe the submitted result (result, result_at,
//                        photos stay for the record but result is
//                        cleared) and clear pending_confirmation so the
//                        job is re-openable. Fires nothing to JN.
//
// POST body: { inspectionId, action: "confirm" | "reject", token? }
//
// Reuses the same building-block functions the manual "Push to JN"
// flow and the inspector app use, so behavior stays identical:
//   • push-result-to-jn               (cf_string_34 + handles lost note)
//   • upload-photo-to-jn              (one call per photo)
//   • generate-and-upload-insp-report-background (cert PDF → JN docs)
//   • send-to-pa-ops-hub             (damage → PA PDN)
//   • process-retail-result          (retail → record_type/location swap)
//
// Required env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY,
//               JOBNIMBUS_API_KEY, URL (or PUBLIC_SITE_URL).

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
  const action = (body.action || "confirm").trim();
  if (!inspectionId) return json(400, { ok: false, error: "inspectionId required" });
  if (!["confirm", "reject"].includes(action)) {
    return json(400, { ok: false, error: 'action must be "confirm" or "reject"' });
  }

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
  const base = (process.env.URL || process.env.PUBLIC_SITE_URL || "").replace(/\/$/, "");
  const sbHeaders = {
    apikey: SB_KEY,
    Authorization: `Bearer ${SB_KEY}`,
    "Content-Type": "application/json",
  };

  // Fetch the held inspection.
  const inspRes = await fetch(
    `${SB_URL}/rest/v1/inspections?id=eq.${encodeURIComponent(inspectionId)}` +
      `&select=id,jn_job_id,client_name,result,result_at,inspection_photos,inspector_name,lost_reason,pending_confirmation&limit=1`,
    { headers: sbHeaders },
  );
  if (!inspRes.ok) {
    return json(500, { ok: false, error: `Could not fetch inspection: ${await inspRes.text()}` });
  }
  const insp = (await inspRes.json())?.[0];
  if (!insp) return json(404, { ok: false, error: "Inspection not found" });
  if (!insp.pending_confirmation) {
    return json(409, { ok: false, error: "This inspection isn't pending confirmation (already handled)." });
  }

  // ── REJECT ──
  // Clear the submitted result so the job can be re-inspected/re-statused.
  // We keep the photos (harmless, and useful evidence of the bad call) but
  // null out result/result_at and clear the hold. Nothing fires to JN.
  if (action === "reject") {
    const patch = {
      result: null,
      result_at: null,
      pending_confirmation: false,
      confirmed_at: null,
    };
    const r = await fetch(`${SB_URL}/rest/v1/inspections?id=eq.${encodeURIComponent(inspectionId)}`, {
      method: "PATCH",
      headers: sbHeaders,
      body: JSON.stringify(patch),
    });
    if (!r.ok) return json(500, { ok: false, error: `Reject failed: ${await r.text()}` });
    return json(200, { ok: true, action: "reject", inspection_id: inspectionId });
  }

  // ── CONFIRM ──
  if (!insp.result) {
    return json(400, { ok: false, error: "No result on this held inspection — nothing to confirm." });
  }
  if (!base) {
    return json(500, { ok: false, error: "No base URL configured — cannot fan out." });
  }

  const steps = { jn_pushed: false, photos_uploaded: 0, photos_total: 0, cert_fired: false, pa_pdn_fired: false, retail_fired: false };
  const errors = [];

  // 1. push-result-to-jn — sets cf_string_34 (+ handles the lost note),
  //    returns the photo list to upload and whether a retail swap is needed.
  let pushData = {};
  try {
    const pr = await fetch(`${base}/.netlify/functions/push-result-to-jn`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ inspectionId }),
    });
    pushData = await pr.json().catch(() => ({}));
    steps.jn_pushed = !!pushData.jn_updated;
    if (!pushData.jn_updated) errors.push(`push-result-to-jn: ${pushData.jn_update_error || pushData.error || `HTTP ${pr.status}`}`);
  } catch (e) {
    errors.push(`push-result-to-jn exception: ${e.message}`);
  }

  // Lost results are done after the push (no photos, no cert, no fan-out).
  if (insp.result === "lost") {
    await stampConfirmed(SB_URL, sbHeaders, inspectionId, steps.jn_pushed);
    return json(200, { ok: steps.jn_pushed, action: "confirm", inspection_id: inspectionId, result: "lost", steps, errors });
  }

  // 2. Upload each photo JN doesn't already have.
  const toUpload = Array.isArray(pushData.photos_to_upload) ? pushData.photos_to_upload : [];
  steps.photos_total = pushData.photos_total || toUpload.length;
  if (insp.jn_job_id && toUpload.length) {
    for (const p of toUpload) {
      try {
        const ur = await fetch(`${base}/.netlify/functions/upload-photo-to-jn`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jn_job_id: insp.jn_job_id, path: p.path, bucket: p.bucket, label: p.label }),
        });
        const ud = await ur.json().catch(() => ({}));
        if (ud.ok) steps.photos_uploaded++;
        else errors.push(`photo ${p.path}: ${ud.error || `HTTP ${ur.status}`}`);
      } catch (e) {
        errors.push(`photo ${p.path} exception: ${e.message}`);
      }
    }
  }

  // 3. Cert PDF → JN Documents. Damage / No Damage go through the generic
  //    cert generator; retail's cert is produced inside process-retail-result.
  if (insp.result === "damage" || insp.result === "no_damage") {
    try {
      await fetch(`${base}/.netlify/functions/generate-and-upload-insp-report-background`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jnid: insp.jn_job_id }),
      });
      steps.cert_fired = true;
    } catch (e) {
      errors.push(`cert trigger: ${e.message}`);
    }
  }

  // 4. Result-specific fan-out — identical to inspector-submit-result.
  if (insp.result === "damage") {
    try {
      await fetch(`${base}/.netlify/functions/send-to-pa-ops-hub`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ inspectionId }),
      });
      steps.pa_pdn_fired = true;
    } catch (e) {
      errors.push(`PA Ops Hub: ${e.message}`);
    }
  } else if (insp.result === "retail") {
    try {
      await fetch(`${base}/.netlify/functions/process-retail-result`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ inspectionId, skip_cert: false }),
      });
      steps.retail_fired = true;
    } catch (e) {
      errors.push(`retail processing: ${e.message}`);
    }
  }

  // 5. Clear the hold + stamp jn_pushed_at so the cron skips this row.
  await stampConfirmed(SB_URL, sbHeaders, inspectionId, steps.jn_pushed);

  return json(200, {
    ok: steps.jn_pushed,
    action: "confirm",
    inspection_id: inspectionId,
    client_name: insp.client_name,
    result: insp.result,
    steps,
    errors,
  });
};

// Clear pending_confirmation, stamp confirmed_at, and (on a successful
// JN push) stamp jn_pushed_at so the hourly cron doesn't re-push.
async function stampConfirmed(SB_URL, sbHeaders, inspectionId, jnPushed) {
  const patch = {
    pending_confirmation: false,
    confirmed_at: new Date().toISOString(),
  };
  if (jnPushed) patch.jn_pushed_at = new Date().toISOString();
  try {
    await fetch(`${SB_URL}/rest/v1/inspections?id=eq.${encodeURIComponent(inspectionId)}`, {
      method: "PATCH",
      headers: sbHeaders,
      body: JSON.stringify(patch),
    });
  } catch (e) {
    console.warn("stampConfirmed failed:", e.message);
  }
}

function json(status, body) {
  return {
    statusCode: status,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}
