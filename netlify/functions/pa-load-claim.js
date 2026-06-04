// netlify/functions/pa-load-claim.js
//
// Loads everything the PA pipeline detail screen needs for one claim:
//   • the CURRENT values of the 11 "Insurance" custom fields straight
//     from the JobNimbus job (the source of truth — our pa_fields cache
//     can be empty for older damage deals that already have values in JN),
//   • the inspection photos (base64 data URLs, same as send-pa-email).
//
// JN omits empty custom fields entirely, so any field missing from the
// job response is simply unset (returned as null here).
//
// POST body: { inspectionId } (preferred) or { jnJobId }.
// Response: { ok, jn_job_id, fields: {field_key: value|null}, photos: [...] }.
//   Date fields come back as unix epoch seconds (or null). String fields
//   come back as strings (or null).
//
// Required env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, JOBNIMBUS_API_KEY.

const JN_BASE = "https://app.jobnimbus.com/api1";

// field key → JN cf_ key + type. Mirror of pa-save-field.js FIELD_MAP.
const FIELD_MAP = {
  inspection:          { cf: "cf_string_34", type: "string" },
  inspected_date:      { cf: "cf_date_22",   type: "date" },
  inspected_by:        { cf: "cf_string_43", type: "string" },
  sold_date:           { cf: "cf_date_5",    type: "date" },
  pa_filed:            { cf: "cf_date_20",   type: "date" },
  ins_approved:        { cf: "cf_date_21",   type: "date" },
  iss_uploaded:        { cf: "cf_date_28",   type: "date" },
  correction_needed:   { cf: "cf_date_29",   type: "date" },
  install_paperwork:   { cf: "cf_date_30",   type: "date" },
  move_back_to_retail: { cf: "cf_date_36",   type: "date" },
  advanced:            { cf: "cf_date_24",   type: "date" },
  second_advance:      { cf: "cf_date_38",   type: "date" },
};

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
  let jnJobId = (body.jnJobId || "").trim();
  const inspectionId = (body.inspectionId || "").trim();

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
  const JN_KEY = process.env.JOBNIMBUS_API_KEY;

  if (!jnJobId && inspectionId) {
    const sbHeaders = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" };
    const lookup = await fetch(
      `${SB_URL}/rest/v1/inspections?id=eq.${inspectionId}&select=jn_job_id&limit=1`,
      { headers: sbHeaders },
    );
    if (lookup.ok) {
      const rows = await lookup.json();
      jnJobId = rows?.[0]?.jn_job_id || "";
    }
  }
  if (!jnJobId) return json(400, { ok: false, error: "No jnJobId (and inspectionId had none)" });

  const jnHeaders = { Authorization: `bearer ${JN_KEY}`, "Content-Type": "application/json" };

  // 1. Read the job for current custom-field values.
  const fields = {};
  for (const k of Object.keys(FIELD_MAP)) fields[k] = null;
  let jnError = null;
  try {
    const jobRes = await fetch(`${JN_BASE}/jobs/${jnJobId}`, { headers: jnHeaders });
    if (jobRes.ok) {
      const job = await jobRes.json();
      for (const [key, spec] of Object.entries(FIELD_MAP)) {
        const raw = job[spec.cf];
        if (raw === undefined || raw === null || raw === "" || raw === 0) {
          fields[key] = null;
        } else if (spec.type === "date") {
          const n = Number(raw);
          fields[key] = Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
        } else {
          fields[key] = String(raw);
        }
      }
    } else {
      jnError = `JN job read returned ${jobRes.status}`;
    }
  } catch (e) {
    jnError = e.message || "JN job read error";
  }

  // 2. Photos (best-effort; never fail the load over photos).
  const photos = await fetchJobPhotos(jnJobId, jnHeaders);

  return json(200, { ok: true, jn_job_id: jnJobId, fields, photos, jn_error: jnError });
};

async function fetchJobPhotos(jnJobId, jnHeaders) {
  try {
    const res = await fetch(`${JN_BASE}/files?related=${jnJobId}&type=2&size=30`, { headers: jnHeaders });
    if (!res.ok) return [];
    const data = await res.json();
    const files = data.data || data.files || data.results || [];
    const imageFiles = files.filter((f) => (f.content_type || "").startsWith("image/"));
    const photoPromises = imageFiles.slice(0, 24).map(async (file) => {
      try {
        const url = file.presigned_url || file.url || file.download_url
          || file.file_url || file.original_url
          || file.src || file.link || file.public_url || file.signed_url;
        if (!url) return null;
        const imgRes = await fetch(url);
        if (!imgRes.ok) return null;
        const buffer = await imgRes.arrayBuffer();
        const ct = imgRes.headers.get("content-type") || file.content_type || "image/jpeg";
        return `data:${ct};base64,${Buffer.from(buffer).toString("base64")}`;
      } catch { return null; }
    });
    return (await Promise.all(photoPromises)).filter(Boolean);
  } catch {
    return [];
  }
}

function json(status, body) {
  return {
    statusCode: status,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}
