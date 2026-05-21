// netlify/functions/push-result-to-jn.js
//
// Push the locally-recorded inspection result to JobNimbus and
// (for damage/no_damage) attach the cert + photos. Used in two
// places:
//
//   1. Per-row "🔄 Push result to JN" button on Record Lookup —
//      lets the manager retroactively sync results for records
//      that were statused before the auto-push existed, or for
//      records the manager themselves statused via Record Lookup
//      (which previously didn't push to JN at all).
//
//   2. Called from submitInspectionResult in App.jsx so the manager
//      setting a result via Record Lookup also auto-pushes to JN.
//
// Behavior per result:
//   • damage     → PUT cf_string_34 = "Damage" + generate cert + upload to JN Documents
//   • no_damage  → PUT cf_string_34 = "No Damage" + generate cert + upload to JN Documents
//   • retail     → delegate to process-retail-result (handles cf_string_34
//                  + record_type swap + location swap + cert in one shot)
//   • null/other → no-op with a clear "nothing to push" response
//
// POST body: { inspectionId }
//
// Required env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, JOBNIMBUS_API_KEY,
//               URL or PUBLIC_SITE_URL (for the internal callouts).

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

  // Fetch the inspection row.
  const inspRes = await fetch(
    `${SB_URL}/rest/v1/inspections?id=eq.${encodeURIComponent(inspectionId)}&select=id,jn_job_id,client_name,result&limit=1`,
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

  // Retail goes through its dedicated function (which sets cf_string_34
  // AND swaps record_type + location AND uploads the cert in one trip).
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

  // damage / no_damage path.
  const RESULT_LABELS = { damage: "Damage", no_damage: "No Damage" };
  const cfValue = RESULT_LABELS[insp.result];
  if (!cfValue) {
    return json(400, { ok: false, error: `Unsupported result "${insp.result}"` });
  }

  // 1. PUT cf_string_34 on the JN job.
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

  // 2. Fire the cert+photos upload via the BACKGROUND variant of
  //    the cert generator. Netlify Background Functions return 202
  //    immediately and run for up to 15 minutes — exactly what we
  //    need, since the regular function (PDFShift + photo downloads
  //    + JN upload) routinely exceeds the 10-second regular-function
  //    timeout and was returning 502 to the user-facing caller.
  let certFired = false;
  let certError = null;
  if (base) {
    try {
      const certRes = await fetch(`${base}/.netlify/functions/generate-and-upload-insp-report-background`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jnid: insp.jn_job_id }),
      });
      // Background functions return 202 on accept. Don't await a JSON
      // body — there isn't one yet.
      if (certRes.status === 202 || certRes.ok) {
        certFired = true;
      } else {
        certError = `cert background-queue returned ${certRes.status}`;
      }
    } catch (e) {
      certError = e.message;
    }
  } else {
    certError = "No base URL configured — cert upload skipped";
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
    cert_uploaded: certFired,
    cert_error: certError,
  });
};

function json(status, body) {
  return {
    statusCode: status,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}
