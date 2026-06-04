// netlify/functions/push-result-to-jn.js
//
// Step 1 of the manager's "Push to JN" flow. Does ONLY the fast
// server-side work so Netlify's 10s timeout isn't a factor:
//
//   1. PUTs cf_string_34 on the linked JN job (~1s)
//   2. Returns the inspection_photos JSON + jn_job_id so the
//      client can fan out per-photo uploads in parallel (via
//      /.netlify/functions/upload-photo-to-jn, one Lambda per
//      photo — finishes in ~3-5s wall time for 28 photos)
//   3. After all photo uploads complete, the client should fire
//      /.netlify/functions/generate-and-upload-insp-report
//      directly to produce the cert PDF.
//
// Retail records short-circuit at the top — they get handed to
// process-retail-result for the additional record_type + location
// transitions. Retail's photo + cert flow may still need the
// per-photo orchestration if process-retail-result's inline cert
// path exceeds the budget; that's tracked separately.
//
// POST body: { inspectionId }
//
// Required env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, JOBNIMBUS_API_KEY.

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

  const inspRes = await fetch(
    `${SB_URL}/rest/v1/inspections?id=eq.${encodeURIComponent(inspectionId)}&select=id,jn_job_id,client_name,result,result_at,inspection_photos,inspector_name,lost_reason&limit=1`,
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

  // LOST short-circuit. A "Lost" result has no photos and no cert — the
  // cert generator only renders Damage / No Damage / Retail. So instead
  // of failing with "Unsupported result", mirror the inspector Lost path:
  // set cf_string_34 = "Lost" and drop a Note with the reason. Returns a
  // success shape (empty photos, no retail swap) so the client finalizes
  // cleanly without trying to upload photos or render a cert.
  if (insp.result === "lost") {
    const lostReason = (insp.lost_reason || "").trim() || "(no reason given)";
    const inspectedBy = (insp.inspector_name || "").trim();
    let jnUpdated = false;
    let jnNoteAdded = false;
    let jnError = null;
    try {
      const r = await fetch(`${JN_BASE}/jobs/${insp.jn_job_id}`, {
        method: "PUT",
        headers: jnHeaders,
        body: JSON.stringify({ jnid: insp.jn_job_id, cf_string_34: "Lost" }),
      });
      if (r.ok) jnUpdated = true;
      else jnError = `cf_string_34 PUT failed (${r.status}): ${(await r.text()).slice(0, 200)}`;
    } catch (e) {
      jnError = `cf_string_34 PUT exception: ${e.message}`;
    }
    const noteText = `🚫 Inspection LOST${inspectedBy ? ` (inspector: ${inspectedBy})` : ""}: ${lostReason}`;
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
      else jnError = (jnError ? jnError + "; " : "") + `note POST failed (${r.status}): ${(await r.text()).slice(0, 200)}`;
    } catch (e) {
      jnError = (jnError ? jnError + "; " : "") + `note POST exception: ${e.message}`;
    }
    return json(200, {
      ok: jnUpdated,
      inspection_id: inspectionId,
      jn_job_id: insp.jn_job_id,
      client_name: insp.client_name,
      result: "lost",
      lost: true,
      cf_string_34_set: "Lost",
      jn_updated: jnUpdated,
      jn_note_added: jnNoteAdded,
      jn_update_error: jnError,
      needs_retail_swap: false,
      photos_to_upload: [],
      photos_already_in_jn: 0,
      photos_total: 0,
    });
  }

  const base = (process.env.URL || process.env.PUBLIC_SITE_URL || "").replace(/\/$/, "");

  // Photo list — same for every result type. Client iterates and
  // fires upload-photo-to-jn per photo.
  // FIRST: ask JN which photos this job already has, so re-clicks
  // don't duplicate. Each photo's filename is deterministic (the
  // last segment of its Supabase Storage path), so we can match by
  // filename. Adds one JN API call up front but avoids 28 duplicates.
  const photos = Array.isArray(insp.inspection_photos) ? insp.inspection_photos : [];
  let existingJnFilenames = new Set();
  try {
    const listRes = await fetch(
      `${JN_BASE}/files?related=${encodeURIComponent(insp.jn_job_id)}&size=200`,
      { headers: jnHeaders },
    );
    if (listRes.ok) {
      const listData = await listRes.json().catch(() => ({}));
      const files = listData.files || listData.data || listData.results || [];
      for (const f of files) {
        const fname = (f.filename || f.name || "").trim().toLowerCase();
        if (fname) existingJnFilenames.add(fname);
      }
    }
  } catch (e) {
    console.warn("Existing-files lookup failed:", e.message);
  }

  let photosAlreadyInJn = 0;
  const photosToUpload = [];
  for (const p of photos) {
    if (!p.path) continue;
    const filename = (p.path.split("/").pop() || "photo.jpg").toLowerCase();
    if (existingJnFilenames.has(filename)) {
      photosAlreadyInJn++;
      continue;
    }
    photosToUpload.push({
      path: p.path,
      bucket: p.bucket || "signed-documents",
      label: p.label || "Inspector photo",
    });
  }

  // Always PUT cf_string_34 NOW — even for retail. The cert generator
  // refuses to render unless cf_string_34 is one of Damage / No Damage /
  // Retail. If we defer this PUT until the final retail swap, the cert
  // (which we fire BEFORE the swap, to attach it before the location
  // change) sees an empty result and 400s.
  //
  // For retail we set cf_string_34 here too; process-retail-result
  // does the remaining record_type + location swap later.
  const RESULT_LABELS = { damage: "Damage", no_damage: "No Damage", retail: "Retail" };
  const cfValue = RESULT_LABELS[insp.result];
  if (!cfValue) {
    return json(400, { ok: false, error: `Unsupported result "${insp.result}"` });
  }

  // Also stamp cf_date_22 ("Inspected Date" in JN's UI) with result_at
  // converted to Unix seconds, so JN's job record shows when the
  // inspector actually classified. If result_at is missing for some
  // reason, fall back to now — better than leaving the JN field blank.
  const inspectedUnix = (() => {
    const src = insp.result_at ? new Date(insp.result_at).getTime() : Date.now();
    return Number.isFinite(src) ? Math.floor(src / 1000) : Math.floor(Date.now() / 1000);
  })();

  // Also stamp cf_string_43 ("Inspected By") with the inspector's name
  // when we have it, so JN's job — and the PA portal — shows who did the
  // inspection. Only set it when present (office-classified records that
  // never went through the inspector app won't have a name).
  const inspectedBy = (insp.inspector_name || "").trim();

  let jnUpdated = false;
  let jnUpdateError = null;
  try {
    const putBody = {
      jnid: insp.jn_job_id,
      cf_string_34: cfValue,
      cf_date_22: inspectedUnix,
    };
    if (inspectedBy) putBody.cf_string_43 = inspectedBy;
    const putRes = await fetch(`${JN_BASE}/jobs/${insp.jn_job_id}`, {
      method: "PUT",
      headers: jnHeaders,
      body: JSON.stringify(putBody),
    });
    if (putRes.ok) {
      jnUpdated = true;
    } else {
      jnUpdateError = `JN PUT failed (${putRes.status}): ${(await putRes.text()).slice(0, 300)}`;
    }
  } catch (e) {
    jnUpdateError = `JN PUT exception: ${e.message}`;
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
    // True for retail only — tells the client to ALSO fire
    // process-retail-result at the end for the record_type +
    // location swap. cf_string_34 is already set so the swap
    // just touches the workflow fields.
    needs_retail_swap: insp.result === "retail",
    photos_to_upload: photosToUpload,
    photos_already_in_jn: photosAlreadyInJn,
    photos_total: photos.length,
  });
};

function json(status, body) {
  return {
    statusCode: status,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}
