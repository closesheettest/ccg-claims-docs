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
const { jnFetch } = require("./_jn.js");

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
  // Client can ask us to skip the cert kickoff — useful when the
  // calling UI has already fired the cert generator itself (e.g.
  // adminPushResultToJn does cert before us so order is photos →
  // cert → retail swap).
  const skipCert = !!body.skip_cert;

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

  // 2. Resolve the retail location ID. JN requires a NUMERIC id.
  //    Anything else (placeholder text, non-number strings) gets
  //    rejected with a 400 — so we validate hard before sending.
  let retailLocationId = null;
  let locationLookupNote = null;
  const envOverride = (process.env.JN_LOCATION_ID_RETAIL || "").trim();
  if (envOverride && /^\d+$/.test(envOverride)) {
    retailLocationId = envOverride;
    locationLookupNote = `Using JN_LOCATION_ID_RETAIL env override (${retailLocationId})`;
  } else {
    if (envOverride) {
      locationLookupNote = `JN_LOCATION_ID_RETAIL env value "${envOverride.slice(0, 80)}" is not numeric — ignoring it and looking up by name instead.`;
      console.warn(locationLookupNote);
    }
    const targetName = (process.env.JN_LOCATION_NAME_RETAIL || "US Shingle and Metal LLC").trim();
    // JN doesn't have a clean "/account/locations" endpoint (returns
    // 404). Try the most common variants in order — first one to
    // return a JSON list with our target name wins.
    const endpointCandidates = ["locations", "account/locations", "account"];
    let resolved = false;
    let endpointNotes = [];
    for (const url of endpointCandidates) {
      try {
        const locRes = await jnFetch(JN_KEY, url);
        if (!locRes.ok) {
          endpointNotes.push(`${url} → ${locRes.status}`);
          continue;
        }
        const locData = await locRes.json().catch(() => ({}));
        // Extract the list from any of the common shapes.
        const list = locData.locations || locData.results || locData.items
          || locData.data?.locations || locData.account?.locations || [];
        if (!Array.isArray(list) || list.length === 0) {
          endpointNotes.push(`${url} → empty list`);
          continue;
        }
        const match = list.find((l) =>
          (l.name || l.display_name || l.location_name || "").trim().toLowerCase() === targetName.toLowerCase(),
        );
        if (!match) {
          endpointNotes.push(`${url} → no match (available: ${list.map((l) => l.name || l.display_name || l.location_name).filter(Boolean).join(", ") || "(none)"})`);
          continue;
        }
        const rawId = match.id ?? match.jnid ?? match.location_id;
        const numStr = String(rawId).trim();
        if (rawId == null || !/^\d+$/.test(numStr)) {
          endpointNotes.push(`${url} → found but id "${rawId}" non-numeric`);
          continue;
        }
        retailLocationId = numStr;
        locationLookupNote = `${locationLookupNote ? locationLookupNote + " " : ""}Resolved "${targetName}" → location id ${retailLocationId} via ${url}`;
        resolved = true;
        break;
      } catch (e) {
        endpointNotes.push(`${url} → exception: ${e.message}`);
      }
    }
    // LAST RESORT: scan recent JN jobs for one whose location matches
    // our target. JN's job-list response shape varies — sometimes
    // location is { id, name }, sometimes just a number, sometimes
    // under location_id / location_name. Check every plausible
    // path AND dump what we actually see so the manager can give us
    // the numeric id even when no name field exists.
    if (!resolved) {
      try {
        const jobsRes = await jnFetch(JN_KEY, "jobs?size=100");
        if (jobsRes.ok) {
          const jobsData = await jobsRes.json().catch(() => ({}));
          const jobs = jobsData.results || jobsData.jobs || jobsData.items || [];
          const targetLower = targetName.toLowerCase();
          // Pull every possible name field per job; also collect the
          // raw location values so we can show the manager what shapes
          // JN actually uses on their account.
          const nameOf = (j) =>
            (j.location?.name || j.location_name || j.location?.display_name || j.location_display_name || "")
              .toString().trim().toLowerCase();
          const idOf = (j) => {
            const raw = j.location?.id ?? j.location_id ?? (typeof j.location === "number" ? j.location : null);
            return raw != null ? String(raw).trim() : null;
          };
          const sample = jobs.find((j) => nameOf(j) === targetLower);
          if (sample) {
            const numStr = idOf(sample);
            if (numStr && /^\d+$/.test(numStr)) {
              retailLocationId = numStr;
              locationLookupNote = `${locationLookupNote ? locationLookupNote + " " : ""}Discovered location id ${retailLocationId} by scanning JN jobs (sample job: ${sample.jnid || sample.id}).`;
              resolved = true;
            } else {
              endpointNotes.push(`jobs-scan → matched "${targetName}" on job ${sample.jnid || sample.id} but location id "${numStr}" is non-numeric`);
            }
          } else {
            // Group jobs by the location info we can see, however
            // shaped, so the manager can spot the right one even
            // when JN doesn't embed names.
            const seenById = new Map();   // id → {sampleName, sampleJobId, count}
            for (const j of jobs) {
              const id = idOf(j);
              const name = nameOf(j);
              if (!id && !name) continue;
              const key = id || `name:${name}`;
              const existing = seenById.get(key) || { id, name, sampleJobId: j.jnid || j.id, count: 0 };
              existing.count++;
              if (name && !existing.name) existing.name = name;
              seenById.set(key, existing);
            }
            const seenSummary = Array.from(seenById.values())
              .map((v) => `id=${v.id || "?"}${v.name ? ` (${v.name})` : ""} ×${v.count}${v.sampleJobId ? ` e.g. job ${v.sampleJobId}` : ""}`)
              .join("; ");
            endpointNotes.push(`jobs-scan (${jobs.length} jobs) → no name match for "${targetName}". Locations seen across scanned jobs: ${seenSummary || "(none)"}`);

            // FINAL fallback: GET the inspection's own JN job — its
            // detail response often has more fields than the list view.
            try {
              const detailRes = await jnFetch(JN_KEY, `jobs/${encodeURIComponent(insp.jn_job_id)}`);
              if (detailRes.ok) {
                const detailJob = await detailRes.json().catch(() => ({}));
                const detName = nameOf(detailJob);
                const detId = idOf(detailJob);
                endpointNotes.push(`detail of ${insp.jn_job_id}: location id="${detId || ""}" name="${detName || ""}" raw=${JSON.stringify(detailJob.location ?? detailJob.location_id ?? detailJob.location_name ?? null).slice(0, 200)}`);
              } else {
                endpointNotes.push(`detail of ${insp.jn_job_id} → ${detailRes.status}`);
              }
            } catch (e) {
              endpointNotes.push(`detail exception: ${e.message}`);
            }
          }
        } else {
          endpointNotes.push(`/jobs scan → ${jobsRes.status}`);
        }
      } catch (e) {
        endpointNotes.push(`/jobs scan exception: ${e.message}`);
      }
    }

    if (!resolved) {
      locationLookupNote = `${locationLookupNote ? locationLookupNote + " " : ""}Could not resolve "${targetName}" from any JN endpoint. Tried: ${endpointNotes.join("; ")}. Set JN_LOCATION_ID_RETAIL env to the numeric id manually.`;
    }
  }

  // Build the JN PUT body. Location is only included when we have a
  // valid numeric ID — otherwise we leave it alone (better than 400).
  //
  // date_start is explicitly NULLED here. On the initial PA sync we
  // pin date_start to the sold date so "new this week" reports work
  // for the insurance flow. When a job swaps to Retail it's leaving
  // that flow entirely (record_type → Lead, location → retail), and
  // the start-date should clear so JN's retail reports don't pick
  // these up under the old sold date.
  // Status MUST flip from 597 (PA workflow's Sit Sold Insp) to 599
  // (Lead workflow's Sit Sold Insp). Same display name, different
  // workflow binding. Without this, the record sits at a status that
  // doesn't belong to its new record_type and JN reports miss it
  // until admin manually re-clicks the dropdown option to re-bind.
  // 599 was identified by comparing a dropdown-clicked record
  // (Robert abbatecola) against an unfixed one (Maria class).
  const putBody = {
    jnid: insp.jn_job_id,
    cf_string_34: "Retail",
    record_type_name: "Lead",
    status: 599,
    status_name: "Sit Sold Insp",
    date_start: null,
  };
  if (retailLocationId) {
    putBody.location = { id: Number(retailLocationId) };
  }
  const locationWarning = retailLocationId
    ? null
    : `JN location not changed — ${locationLookupNote || "no valid numeric location id resolved"}. Set JN_LOCATION_ID_RETAIL to the numeric ID from JN to enable the location transition.`;

  // 3. PUT the JN job.
  let jnUpdated = false;
  let jnUpdateError = null;
  try {
    const putRes = await jnFetch(JN_KEY, `jobs/${insp.jn_job_id}`, {
      method: "PUT",
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
  // Cert generator — fire only if the caller didn't already do it.
  // adminPushResultToJn fires the cert itself for retail (so the
  // order is photos → cert → retail swap) and sets skip_cert=true
  // to avoid double-firing. Direct invocations (manual retry) still
  // get the cert kicked off here.
  let certUploaded = false;
  let certError = null;
  let certSkipped = false;
  if (skipCert) {
    certSkipped = true;
    certError = "skipped by request (skip_cert=true)";
  } else if (base) {
    try {
      const certRes = await fetch(`${base}/.netlify/functions/generate-and-upload-insp-report-background`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jnid: insp.jn_job_id }),
      });
      if (certRes.status === 202 || certRes.ok) {
        certUploaded = true;
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
    ok: jnUpdated, // overall "did the important part work?"
    inspection_id: inspectionId,
    jn_job_id: insp.jn_job_id,
    client_name: insp.client_name,
    jn_updated: jnUpdated,
    jn_update_error: jnUpdateError,
    cert_uploaded: certUploaded,
    cert_skipped: certSkipped,
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
