// netlify/functions/process-retail-result.js
//
// Fires when an inspector classifies a roof as Retail. Transitions
// the JN job out of the PA / insurance workflow and into the retail
// sale workflow, and attaches the inspection report.
//
// Transitions applied to the JN job:
//   1. cf_string_34       → "Retail"   (inspection-result custom field)
//   2. record_type_name   → "Lead"     (was "PA")
//   3. location.id        → JN_LOCATION_ID_RETAIL env  (was insurance)
//   4. Cert of inspection PDF + photos → uploaded to the JN job's
//      Documents tab via generate-and-upload-insp-report
//
// USAGE:
//   POST /.netlify/functions/process-retail-result
//   Body: { inspectionId: "<uuid>" }
//
// Called automatically from inspector-submit-result when result is
// "retail". Can also be re-fired manually if the JN side ever needs
// to be re-synced.
//
// Required env:
//   VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY
//   JOBNIMBUS_API_KEY
// Optional env:
//   JN_LOCATION_NAME_RETAIL — name of the JN location to move the
//     job into. Default "US Shingle and Metal LLC". The function
//     looks up the matching ID at runtime via /locations.
//   JN_LOCATION_ID_RETAIL — direct ID override. When set, skips the
//     name lookup. Use this if name-based resolution misbehaves.
//   URL or PUBLIC_SITE_URL — base used to internally call
//     generate-and-upload-insp-report.

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

  // 1. Fetch inspection to get the jn_job_id.
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
  if (insp.result !== "retail") {
    return json(400, { ok: false, error: `Inspection result is "${insp.result}", not "retail"` });
  }
  if (!insp.jn_job_id) {
    return json(400, { ok: false, error: "Inspection has no jn_job_id — sync to JN first" });
  }

  // 2. Resolve the retail location ID. Direct ID env wins; otherwise
  //    look up by name (default "US Shingle and Metal LLC") against
  //    JN's /account/locations endpoint.
  let retailLocationId = process.env.JN_LOCATION_ID_RETAIL || null;
  let locationLookupNote = null;
  if (!retailLocationId) {
    const targetName = (process.env.JN_LOCATION_NAME_RETAIL || "US Shingle and Metal LLC").trim();
    try {
      const locRes = await fetch("https://app.jobnimbus.com/api1/account/locations", {
        headers: jnHeaders,
      });
      if (locRes.ok) {
        const locData = await locRes.json().catch(() => ({}));
        const list = locData.locations || locData.results || locData.items || [];
        const match = list.find((l) =>
          (l.name || l.display_name || "").trim().toLowerCase() === targetName.toLowerCase(),
        );
        if (match) {
          retailLocationId = match.id || match.jnid || match.location_id;
          locationLookupNote = `Resolved "${targetName}" → location id ${retailLocationId}`;
        } else {
          locationLookupNote = `Could not find a JN location named "${targetName}". Available: ${list.map((l) => l.name || l.display_name).filter(Boolean).join(", ") || "(none)"}`;
        }
      } else {
        locationLookupNote = `JN /account/locations returned ${locRes.status} — could not resolve "${targetName}"`;
      }
    } catch (e) {
      locationLookupNote = `Location lookup threw: ${e.message}`;
    }
  } else {
    locationLookupNote = `Using JN_LOCATION_ID_RETAIL env override (${retailLocationId})`;
  }

  // Build the JN PUT body. Location is only included when resolved.
  const putBody = {
    jnid: insp.jn_job_id,
    cf_string_34: "Retail",
    record_type_name: "Lead",
  };
  if (retailLocationId) {
    putBody.location = { id: Number(retailLocationId) || retailLocationId };
  }
  const locationWarning = retailLocationId
    ? null
    : `JN location not changed — ${locationLookupNote}. Set JN_LOCATION_ID_RETAIL (or fix the name lookup) and re-fire.`;

  // 3. PUT the JN job.
  let jnUpdated = false;
  let jnUpdateError = null;
  try {
    const putRes = await fetch(`${JN_BASE}/jobs/${insp.jn_job_id}`, {
      method: "PUT",
      headers: jnHeaders,
      body: JSON.stringify(putBody),
    });
    if (!putRes.ok) {
      jnUpdateError = `JN PUT failed (${putRes.status}): ${(await putRes.text()).slice(0, 300)}`;
    } else {
      jnUpdated = true;
    }
  } catch (e) {
    jnUpdateError = `JN PUT exception: ${e.message}`;
  }

  // 4. Generate + upload the inspection-report PDF (cert + photos)
  //    to the JN job's Documents tab. Best-effort — failure here
  //    doesn't roll back the JN field updates.
  const base = (process.env.URL || process.env.PUBLIC_SITE_URL || "").replace(/\/$/, "");
  let certUploaded = false;
  let certError = null;
  if (base) {
    try {
      const certRes = await fetch(`${base}/.netlify/functions/generate-and-upload-insp-report`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jnid: insp.jn_job_id }),
      });
      const certBody = await certRes.json().catch(() => ({}));
      if (certRes.ok && certBody.ok) {
        certUploaded = true;
      } else {
        certError = certBody.error || `cert generator returned ${certRes.status}`;
      }
    } catch (e) {
      certError = e.message;
    }
  } else {
    certError = "No base URL configured — cert upload skipped";
  }

  return json(200, {
    ok: jnUpdated, // overall "did the important part work?"
    inspection_id: inspectionId,
    jn_job_id: insp.jn_job_id,
    client_name: insp.client_name,
    jn_updated: jnUpdated,
    jn_update_error: jnUpdateError,
    cert_uploaded: certUploaded,
    cert_error: certError,
    location_warning: locationWarning,
    location_lookup_note: locationLookupNote,
    fields_set: {
      cf_string_34: "Retail",
      record_type_name: "Lead",
      location_id: retailLocationId || null,
    },
  });
};

function json(status, body) {
  return {
    statusCode: status,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}
