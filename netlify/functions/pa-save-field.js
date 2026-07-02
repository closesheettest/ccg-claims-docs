// netlify/functions/pa-save-field.js
//
// Per-field autosave for the PA portal. When a Public Adjuster fills in
// one of the JobNimbus "Insurance" section milestone fields on a claim
// they own, the portal POSTs here and we:
//   1. Validate the field is one of the allowed 11 + that the PA owns
//      the claim (inspection.pa_id must match the PA making the call).
//   2. PUT the single custom field straight to the JobNimbus job.
//   3. Cache the value in inspections.pa_fields (jsonb) so the portal
//      can re-render instantly without re-reading JN.
//
// The cf_ key map below was discovered by writing distinct test values
// to a JN job and reading back which cf_ slot each label landed in
// (Phase 0, 2026-06-03). DO NOT renumber these without re-verifying.
//
// POST body: {
//   inspectionId: "<supabase inspections.id>",
//   paId:         "<supabase pas.id>",   // ownership check
//   field:        "pa_filed" | "ins_approved" | ... (see FIELD_MAP),
//   value:        <epoch seconds | null for date fields; string for text>
// }
// Response: { ok, field, cf_key, jn_updated, value }.
//
// Required env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, JOBNIMBUS_API_KEY.

const JN_BASE = "https://app.jobnimbus.com/api1";
import { jnFetch } from "./_jn.js";

// PA sign-up status ("Intro to Customer" dropdown in JobNimbus). The
// company is adding this dropdown to JN; once it exists, set this to the
// real cf_ key (run Phase 0 discovery or read it off the job) and the
// value will push to JN automatically. Until then it's null, so saves are
// cached locally only (the PA's pick still shows in the app). The dropdown
// OPTIONS in JN must match these strings EXACTLY: "Pending" (default),
// "Signed", "Refused to Sign".
const PA_SIGNUP_CF = null; // TODO: e.g. "cf_string_XX" once JN builds the dropdown.

// PA portal field key → { cf: JobNimbus custom-field key, type }.
// Confirmed Phase 0 (2026-06-03). Dates are unix epoch SECONDS; clear
// with 0. Strings clear with "".
const FIELD_MAP = {
  pa_signup:           { cf: PA_SIGNUP_CF, type: "string" }, // Pending | Signed | Refused to Sign
  inspection:          { cf: "cf_string_34", type: "string" }, // result (auto-set by inspector)
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

export const handler = async (event) => {
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
  const paId = (body.paId || "").trim();
  const field = (body.field || "").trim();
  let value = body.value;

  if (!inspectionId) return json(400, { ok: false, error: "inspectionId required" });
  if (!field || !FIELD_MAP[field]) {
    return json(400, { ok: false, error: `Unknown field "${field}". Allowed: ${Object.keys(FIELD_MAP).join(", ")}` });
  }
  const spec = FIELD_MAP[field];

  // Normalize the value per type.
  let jnValue;
  if (spec.type === "date") {
    if (value === null || value === "" || value === undefined) {
      jnValue = 0; // JN clears a date with 0
      value = null;
    } else {
      const n = Number(value);
      if (!Number.isFinite(n) || n < 0) {
        return json(400, { ok: false, error: "Date value must be unix epoch seconds (or null to clear)" });
      }
      jnValue = Math.floor(n);
      value = jnValue;
    }
  } else {
    jnValue = value == null ? "" : String(value);
    value = jnValue;
  }

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
  const JN_KEY = process.env.JOBNIMBUS_API_KEY;
  const sbHeaders = {
    apikey: SB_KEY,
    Authorization: `Bearer ${SB_KEY}`,
    "Content-Type": "application/json",
  };

  // 1. Load the claim + verify ownership.
  const lookup = await fetch(
    `${SB_URL}/rest/v1/inspections?id=eq.${inspectionId}&select=id,jn_job_id,pa_id,pa_fields&limit=1`,
    { headers: sbHeaders },
  );
  if (!lookup.ok) {
    return json(500, { ok: false, error: `Could not fetch inspection: ${await lookup.text()}` });
  }
  const rows = await lookup.json();
  const insp = rows?.[0];
  if (!insp) return json(404, { ok: false, error: "Inspection not found" });
  if (paId && insp.pa_id && insp.pa_id !== paId) {
    return json(403, { ok: false, error: "This claim belongs to a different PA" });
  }
  if (!insp.pa_id) {
    return json(409, { ok: false, error: "This claim isn't owned by any PA yet — claim it first" });
  }
  if (!insp.jn_job_id) {
    return json(400, { ok: false, error: "No JobNimbus job linked to this record" });
  }

  // 2. PUT the single custom field to JN — UNLESS this field's JN custom
  //    field hasn't been created yet (spec.cf is null, e.g. pa_signup
  //    before the "Intro to Customer" dropdown ships). In that case we
  //    skip the JN write and cache locally only; it'll sync to JN the
  //    moment PA_SIGNUP_CF is wired in.
  let jnUpdated = false;
  let jnError = null;
  let jnSkipped = false;
  if (!spec.cf) {
    jnSkipped = true;
  } else {
    try {
      const putRes = await jnFetch(JN_KEY, `jobs/${insp.jn_job_id}`, {
        method: "PUT",
        body: JSON.stringify({ jnid: insp.jn_job_id, [spec.cf]: jnValue }),
      });
      if (putRes.ok) {
        jnUpdated = true;
      } else {
        jnError = `JN PUT returned ${putRes.status}: ${(await putRes.text()).slice(0, 200)}`;
      }
    } catch (e) {
      jnError = e.message || "JN PUT network error";
    }

    if (!jnUpdated) {
      return json(502, { ok: false, error: jnError || "JN update failed", field, cf_key: spec.cf });
    }
  }

  // 3. Cache the value locally (merge into pa_fields jsonb).
  const merged = { ...(insp.pa_fields || {}), [field]: value };
  const patch = { pa_fields: merged };
  // Stamp pa_signed_at the first time the homeowner is marked "Signed"
  // (powers the scorecard's "avg days to signed"). Clear it if un-signed.
  if (field === "pa_signup") {
    if (value === "Signed") patch.pa_signed_at = new Date().toISOString();
    else patch.pa_signed_at = null;
  }
  await fetch(`${SB_URL}/rest/v1/inspections?id=eq.${inspectionId}`, {
    method: "PATCH",
    headers: sbHeaders,
    body: JSON.stringify(patch),
  }).catch(() => {});

  return json(200, { ok: true, field, cf_key: spec.cf, jn_updated: jnUpdated, jn_skipped: jnSkipped, value });
};

function json(status, body) {
  return {
    statusCode: status,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}
