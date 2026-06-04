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

// PA sign-up status ("Intro to Customer" dropdown). null until JN builds
// the dropdown — mirror of pa-save-field.js PA_SIGNUP_CF. Until then the
// value lives in our pa_fields cache and we default to "Pending".
const PA_SIGNUP_CF = null;

// field key → JN cf_ key + type. Mirror of pa-save-field.js FIELD_MAP.
const FIELD_MAP = {
  pa_signup:           { cf: PA_SIGNUP_CF, type: "string" },
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
  // Fields-only fast path: the PA Decision queue cards only need the
  // PA-filed date, so they skip the (slower) photo resolution.
  const skipPhotos = body.skipPhotos === true;

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
  const JN_KEY = process.env.JOBNIMBUS_API_KEY;
  const sbHeaders = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" };

  // Always pull our inspection row when we have an id — it's the fallback
  // source for Inspected By / Inspected Date and for app-side photos
  // (captured in our app, stored in Supabase Storage) when JN has none.
  let insp = null;
  if (inspectionId) {
    const lookup = await fetch(
      `${SB_URL}/rest/v1/inspections?id=eq.${inspectionId}&select=jn_job_id,inspector_name,result_at,inspection_photos,pa_fields&limit=1`,
      { headers: sbHeaders },
    );
    if (lookup.ok) {
      const rows = await lookup.json();
      insp = rows?.[0] || null;
      if (!jnJobId) jnJobId = insp?.jn_job_id || "";
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

  // 1a. PA sign-up status. Its JN dropdown ("Intro to Customer") may not
  //     be wired yet (PA_SIGNUP_CF null), so JN returns nothing — fall
  //     back to our local pa_fields cache, then default to "Pending".
  if (!fields.pa_signup) {
    fields.pa_signup = insp?.pa_fields?.pa_signup || "Pending";
  }

  // 1b. Fill Inspected By / Inspected Date from our record when JN is
  //     blank — these are set by the inspector flow on our side but older
  //     records (classified before the cf_string_43 push shipped) have
  //     them missing in JN. Self-heal: write the fallback back to JN so
  //     it shows up there too, then return the merged value.
  const heal = {};
  if (!fields.inspected_by && insp?.inspector_name) {
    fields.inspected_by = String(insp.inspector_name).trim();
    if (fields.inspected_by) heal.cf_string_43 = fields.inspected_by;
  }
  if (!fields.inspected_date && insp?.result_at) {
    const t = new Date(insp.result_at).getTime();
    if (Number.isFinite(t)) {
      fields.inspected_date = Math.floor(t / 1000);
      heal.cf_date_22 = fields.inspected_date;
    }
  }
  if (Object.keys(heal).length > 0) {
    try {
      await fetch(`${JN_BASE}/jobs/${jnJobId}`, {
        method: "PUT",
        headers: jnHeaders,
        body: JSON.stringify({ jnid: jnJobId, ...heal }),
      });
    } catch { /* best-effort backfill; the value still returns below */ }
  }

  // 2. Photos. Prefer JN (canonical). If JN has none, fall back to the
  //    app-side photos we captured in our app (Supabase Storage) so the
  //    PA still sees the roof even before/if JN upload lagged. Skipped
  //    entirely on the fields-only fast path (Decision queue cards).
  let photos = [];
  let photoSource = null;
  // Whether this deal's photos are ALREADY copied into our own storage
  // (inspection_photos populated). When true, the "Save these photos to
  // the app" backfill button is pointless — the client uses this to hide
  // it so a PA isn't offered a save that just answers "already saved".
  const photosInApp = Array.isArray(insp?.inspection_photos) && insp.inspection_photos.length > 0;
  if (!skipPhotos) {
    photos = await fetchJobPhotos(jnJobId, jnHeaders);
    photoSource = photos.length > 0 ? "jobnimbus" : null;
    if (photos.length === 0 && photosInApp) {
      photos = await signSupabasePhotos(insp.inspection_photos, SB_URL, sbHeaders);
      if (photos.length > 0) photoSource = "app";
    }
  }

  return json(200, { ok: true, jn_job_id: jnJobId, fields, photos, photo_source: photoSource, photos_in_app: photosInApp, jn_error: jnError });
};

// Build temporary signed URLs for app-captured photos stored in Supabase
// Storage. Each entry is { path, bucket }. Returns absolute URLs the
// browser can use directly in <img src>.
async function signSupabasePhotos(items, sbUrl, sbHeaders) {
  const out = [];
  for (const p of items.slice(0, 24)) {
    if (!p?.path) continue;
    const bucket = p.bucket || "signed-documents";
    try {
      const res = await fetch(`${sbUrl}/storage/v1/object/sign/${bucket}/${p.path}`, {
        method: "POST",
        headers: sbHeaders,
        body: JSON.stringify({ expiresIn: 3600 }),
      });
      if (!res.ok) continue;
      const body = await res.json().catch(() => ({}));
      const rel = body.signedURL || body.signedUrl;
      if (rel) out.push(rel.startsWith("http") ? rel : `${sbUrl}/storage/v1${rel.startsWith("/") ? "" : "/"}${rel}`);
    } catch { /* skip this one */ }
  }
  return out;
}

async function fetchJobPhotos(jnJobId, jnHeaders) {
  try {
    const res = await fetch(`${JN_BASE}/files?related=${jnJobId}&type=2&size=30`, { headers: jnHeaders });
    if (!res.ok) return [];
    const data = await res.json();
    const files = data.data || data.files || data.results || [];
    const imageFiles = files.filter((f) => (f.content_type || "").startsWith("image/"));
    // Return PRESIGNED URLs, not base64. A full-res JN photo is ~1.2MB;
    // base64-ing 24 of them into our JSON blows past Netlify's 6MB Lambda
    // response cap. Instead we resolve each photo's presigned CloudFront
    // URL (the 302 target of GET /files/<jnid>) WITHOUT downloading the
    // bytes, and let the browser load images straight from CloudFront.
    const photoPromises = imageFiles.slice(0, 24).map(async (file) => {
      try {
        // Honor a direct URL field first if a future API ever adds one.
        const directUrl = file.presigned_url || file.url || file.download_url
          || file.file_url || file.original_url
          || file.src || file.link || file.public_url || file.signed_url;
        if (directUrl) return directUrl;
        const fileJnid = file.jnid || file.id;
        if (!fileJnid) return null;
        // redirect:"manual" so we capture the Location (presigned URL)
        // instead of following it and pulling the full image down here.
        const r = await fetch(`${JN_BASE}/files/${fileJnid}`, { headers: jnHeaders, redirect: "manual" });
        return r.headers.get("location") || null;
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
