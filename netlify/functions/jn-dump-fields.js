// netlify/functions/jn-dump-fields.js
//
// READ-ONLY probe. Dumps every cf_* (custom field) on a given JN
// job so we can identify which numbered field corresponds to a
// labeled field in JN's UI (e.g. "Inspected Date" → cf_date_NN).
//
// USAGE:
//   GET /.netlify/functions/jn-dump-fields?id=<jn_job_id>
//
// Workflow to find "Inspected Date":
//   1. Open one job in JN, set the Inspected Date to 5/24/2026
//   2. Save
//   3. Run this probe with that job's id
//   4. Look at the cf_date_NN that came back with 1748044800 (the
//      Unix-seconds for 5/24/2026 in your timezone) — that's the field.
//
// Required env: JOBNIMBUS_API_KEY

const JN_BASE = "https://app.jobnimbus.com/api1";

exports.handler = async (event) => {
  const JN_KEY = process.env.JOBNIMBUS_API_KEY;
  if (!JN_KEY) return json(500, { ok: false, error: "JOBNIMBUS_API_KEY not set" });

  const qs = event.queryStringParameters || {};
  const id = (qs.id || "").trim();
  if (!id) {
    return json(400, {
      ok: false,
      error: "Pass ?id=<jn_job_id>. e.g. ?id=mpfynhz1ktlpvp8n5uju8jx (Amanda smith retail).",
    });
  }

  const jnHeaders = {
    Authorization: `bearer ${JN_KEY}`,
    "Content-Type": "application/json",
  };

  try {
    const r = await fetch(`${JN_BASE}/jobs/${encodeURIComponent(id)}`, { headers: jnHeaders });
    if (!r.ok) {
      return json(r.status, { ok: false, error: `JN GET failed (${r.status}): ${(await r.text()).slice(0, 300)}` });
    }
    const job = await r.json();

    // Pull out every cf_* field, separating dates from strings/ints.
    const cfDates = {};
    const cfStrings = {};
    const cfOther = {};
    for (const [k, v] of Object.entries(job)) {
      if (!k.startsWith("cf_")) continue;
      if (k.startsWith("cf_date_")) {
        cfDates[k] = {
          unix: v,
          iso: v && Number(v) > 0 ? new Date(Number(v) * 1000).toISOString() : null,
          local: v && Number(v) > 0 ? new Date(Number(v) * 1000).toLocaleString() : null,
        };
      } else if (k.startsWith("cf_string_")) {
        cfStrings[k] = v;
      } else {
        cfOther[k] = v;
      }
    }

    // Surface every field whose name has "status", "record_type", or
    // "workflow" in it. JN sometimes stores the bound workflow status
    // separately from the loose status value — having both visible
    // here lets us see if they're aligned.
    const statusFields = Object.fromEntries(
      Object.entries(job).filter(([k]) =>
        /status|record_type|workflow|stage|state/i.test(k),
      ),
    );

    return json(200, {
      ok: true,
      jn_job_id: id,
      name: job.name,
      status_name: job.status_name,
      record_type_name: job.record_type_name,
      // Built-in date fields for context.
      builtin_dates: {
        date_created: job.date_created,
        date_updated: job.date_updated,
        date_start: job.date_start,
        date_end: job.date_end,
      },
      // EVERY status/record-type/workflow-related field — for diagnosing
      // the "displays correct, reports miss" status-binding bug.
      status_block: statusFields,
      cf_dates: cfDates,
      cf_strings: cfStrings,
      cf_other: cfOther,
      // Top-level fields whose name suggests "inspection" — surface
      // anything obvious so we don't miss a non-cf_* field.
      possibly_inspection_fields: Object.fromEntries(
        Object.entries(job).filter(([k]) => /inspect/i.test(k)),
      ),
    });
  } catch (e) {
    return json(500, { ok: false, error: e.message });
  }
};

function json(status, body) {
  return {
    statusCode: status,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}
