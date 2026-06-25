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

const JN_BASE = "https://app.jobnimbus.com/api1";

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
  // Optional: manager corrected the inspector's call before confirming.
  // When set and different from the stored result, the confirm path
  // re-files the JN job to match the NEW result instead of just
  // clearing the hold (see CHANGE flow below).
  const overrideResult = (body.override_result || "").trim();
  const VALID_RESULTS = ["damage", "no_damage", "retail", "lost"];
  if (!inspectionId) return json(400, { ok: false, error: "inspectionId required" });
  if (!["confirm", "reject"].includes(action)) {
    return json(400, { ok: false, error: 'action must be "confirm" or "reject"' });
  }
  if (overrideResult && !VALID_RESULTS.includes(overrideResult)) {
    return json(400, { ok: false, error: `override_result must be one of ${VALID_RESULTS.join(", ")}` });
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
      `&select=id,jn_job_id,client_name,result,result_at,inspection_photos,inspector_name,lost_reason,pending_confirmation,jn_pushed_at&limit=1`,
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

  // Did the manager correct the inspector's call? A real change means we
  // re-file JN to match the NEW result (undo the old result's structural
  // swap, set the new result field, replace the cert, fire the new
  // downstream) — even if the row was already pushed once.
  const changing = overrideResult && overrideResult !== insp.result;
  const changeNotes = [];

  // SAFETY RAIL — already-fired short-circuit.
  // If this row was already pushed to JN once (jn_pushed_at is set), it
  // got into the confirm queue retroactively (e.g. a manager flagged an
  // inspector's back-catalog for review). Re-running the fan-out would
  // duplicate the PA Ops Hub PDN, re-upload the cert, etc. So we DON'T
  // re-fire — Confirm here just means "reviewed, looks good": clear the
  // hold and stamp confirmed_at. Nothing is re-sent to JN.
  // EXCEPTION: when the manager is CHANGING the result, we must re-file
  // regardless of jn_pushed_at, so skip the short-circuit.
  if (!changing && insp.jn_pushed_at) {
    await stampConfirmed(SB_URL, sbHeaders, inspectionId, true);
    return json(200, {
      ok: true,
      action: "confirm",
      inspection_id: inspectionId,
      client_name: insp.client_name,
      result: insp.result,
      already_fired: true,
      message: "Already pushed to JobNimbus earlier — marked reviewed. Nothing was re-sent.",
    });
  }

  if (!base) {
    return json(500, { ok: false, error: "No base URL configured — cannot fan out." });
  }

  // ── CHANGE flow ──
  // Manager corrected the inspector's result. Persist the new result
  // FIRST (every downstream building-block function reads result fresh
  // from Supabase), then undo any structural swap the OLD result applied
  // to the JN job. Execution then falls through to the normal fan-out
  // below — which now fires for the NEW result (correct cf_string_34,
  // a fresh cert, and the new result's downstream).
  if (changing) {
    const oldResult = insp.result;
    // Clear jn_cert_uploaded_at so the NEW result's cert actually
    // re-renders. generate-and-upload-insp-report now skips rendering
    // when this stamp is set (a PDFShift credit-saver guard), so a
    // corrected result would otherwise keep the stale cert. Nulling it
    // also hands the cert to the retry cron as a safety net if this
    // inline re-render hiccups.
    const pr = await fetch(`${SB_URL}/rest/v1/inspections?id=eq.${encodeURIComponent(inspectionId)}`, {
      method: "PATCH",
      headers: sbHeaders,
      body: JSON.stringify({ result: overrideResult, jn_cert_uploaded_at: null }),
    });
    if (!pr.ok) {
      return json(500, { ok: false, error: `Could not save corrected result: ${await pr.text()}` });
    }
    insp.result = overrideResult; // local copy for the result-specific checks below
    changeNotes.push(`result changed ${oldResult} → ${overrideResult}`);

    // If the OLD result was retail, it moved the JN job into the retail
    // workflow (record_type Lead, status 599, retail location, date_start
    // nulled). Moving away from retail must restore the insurance/PA
    // workflow or the job stays misfiled.
    if (oldResult === "retail" && overrideResult !== "retail") {
      changeNotes.push(await reverseRetailSwap(insp.jn_job_id));
    }
    // NOTE: if the OLD result was "damage", a PA Ops Hub PDN already went
    // to the external partner and CANNOT be recalled here — the UI warns
    // the manager about this before they confirm.
    if (oldResult === "damage") {
      changeNotes.push("⚠️ prior PA Ops Hub damage notice was already sent and cannot be auto-recalled");
    }
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
    return json(200, { ok: steps.jn_pushed, action: "confirm", inspection_id: inspectionId, result: "lost", changed: changing, change_notes: changeNotes, steps, errors });
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
    // Background variant — the retail transition (PDFShift cert + JN swap +
    // file upload) is slow; awaiting it could exceed the request timeout and
    // throw a false 502 even though it completed. Fire it to the background
    // function (returns 202 immediately) so the confirm responds fast.
    try {
      await fetch(`${base}/.netlify/functions/process-retail-result-background`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ inspectionId, skip_cert: false }),
      });
      steps.retail_fired = true;
    } catch (e) {
      errors.push(`retail processing: ${e.message}`);
    }
  }

  // 4b. Go-back result TASK on the JN job at the homeowner's preferred time
  //     (review_availability) — same as inspector-submit-result.
  if (insp.result === "damage" || insp.result === "no_damage" || insp.result === "retail") {
    try {
      await fetch(`${base}/.netlify/functions/create-result-task`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ inspectionId }),
      });
      steps.result_task_fired = true;
    } catch (e) {
      errors.push(`result task: ${e.message}`);
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
    changed: changing,
    change_notes: changeNotes,
    steps,
    errors,
  });
};

// Undo the retail swap (process-retail-result) so a job corrected away
// from "retail" goes back into the insurance/PA workflow. Restores
// record_type "PA", status 597 (Sit Sold Insp), insurance location id 3,
// and date_start from cf_date_5 (the original sold date). Best-effort —
// returns a human-readable note for the response.
async function reverseRetailSwap(jnJobId) {
  if (!jnJobId) return "no jn_job_id — retail swap not reversed";
  const jnHeaders = {
    Authorization: `bearer ${process.env.JOBNIMBUS_API_KEY}`,
    "Content-Type": "application/json",
  };
  // Read the job to recover the sold date so date_start can be restored.
  let dateStart = null;
  try {
    const r = await fetch(`${JN_BASE}/jobs/${encodeURIComponent(jnJobId)}`, { headers: jnHeaders });
    if (r.ok) {
      const j = await r.json().catch(() => ({}));
      const raw = j.cf_date_5 || j.date_start || null;
      if (raw && Number(raw) > 0) dateStart = Number(raw);
    }
  } catch { /* fall through — restore without date_start */ }

  const putBody = {
    jnid: jnJobId,
    record_type_name: "PA",
    status: 597,
    status_name: "Sit Sold Insp",
    location: { id: 3 },
  };
  if (dateStart) putBody.date_start = dateStart;
  try {
    const r = await fetch(`${JN_BASE}/jobs/${encodeURIComponent(jnJobId)}`, {
      method: "PUT",
      headers: jnHeaders,
      body: JSON.stringify(putBody),
    });
    if (!r.ok) return `retail swap reverse FAILED (HTTP ${r.status}): ${(await r.text()).slice(0, 160)}`;
    return `retail swap reversed → record_type PA, status Sit Sold Insp, insurance location${dateStart ? ", date_start restored" : ""}`;
  } catch (e) {
    return `retail swap reverse exception: ${e.message}`;
  }
}

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
