// netlify/functions/verify-retail-swap.js
//
// READ-ONLY check. Pulls every inspections row where result="retail"
// and jn_pushed_at is set (i.e. the cron / manual push has run), then
// GETs each JN job directly and reports back which fields ARE / AREN'T
// properly cleared:
//
//   ✓ cf_string_34 == "Retail"
//   ✓ record_type_name == "Lead"
//   ✓ date_start == 0 or null (the field admin specifically wanted nulled)
//
// USAGE:
//   GET /.netlify/functions/verify-retail-swap
//   GET /.netlify/functions/verify-retail-swap?limit=20
//
// Default limit = 10. Returns each record's verification status so admin
// can spot any retail records where the swap didn't fully apply.
//
// Required env: JOBNIMBUS_API_KEY, VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY

const JN_BASE = "https://app.jobnimbus.com/api1";

exports.handler = async (event) => {
  const JN_KEY = process.env.JOBNIMBUS_API_KEY;
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
  if (!JN_KEY || !SB_URL || !SB_KEY) {
    return json(500, { ok: false, error: "Missing env vars" });
  }

  const qs = event.queryStringParameters || {};
  const limit = Math.min(50, Number(qs.limit) || 10);

  const sbHeaders = {
    apikey: SB_KEY,
    Authorization: `Bearer ${SB_KEY}`,
  };
  const jnHeaders = {
    Authorization: `bearer ${JN_KEY}`,
    "Content-Type": "application/json",
  };

  // Pull pushed retail records, newest first.
  const url =
    `${SB_URL}/rest/v1/inspections` +
    `?result=eq.retail` +
    `&jn_job_id=not.is.null` +
    `&jn_pushed_at=not.is.null` +
    `&cancelled_at=is.null` +
    `&select=id,client_name,jn_job_id,jn_pushed_at,result` +
    `&order=jn_pushed_at.desc` +
    `&limit=${limit}`;
  const sbRes = await fetch(url, { headers: sbHeaders });
  if (!sbRes.ok) {
    return json(500, { ok: false, error: `Supabase: ${(await sbRes.text()).slice(0, 300)}` });
  }
  const records = await sbRes.json();
  if (records.length === 0) {
    return json(200, { ok: true, checked: 0, message: "No pushed retail records to verify." });
  }

  // GET each JN job in parallel (concurrency 6 to stay under timeout).
  const CONCURRENCY = 6;
  const results = [];
  async function checkOne(rec) {
    try {
      const r = await fetch(`${JN_BASE}/jobs/${encodeURIComponent(rec.jn_job_id)}`, { headers: jnHeaders });
      if (!r.ok) {
        return {
          client_name: rec.client_name,
          jn_job_id: rec.jn_job_id,
          fetch_status: r.status,
          all_correct: false,
          issue: `JN GET failed (${r.status})`,
        };
      }
      const job = await r.json().catch(() => ({}));
      const cfOk = (job.cf_string_34 || "").toLowerCase() === "retail";
      // date_start "cleared" means null OR 0 OR missing — any of these
      // means the field won't show in JN's date-filtered reports.
      const dsValue = job.date_start;
      const dsCleared = dsValue == null || dsValue === 0;
      const rtOk = job.record_type_name === "Lead";
      const issues = [];
      if (!cfOk) issues.push(`cf_string_34="${job.cf_string_34}" (expected "Retail")`);
      if (!dsCleared) issues.push(`date_start=${dsValue} (expected null/0)`);
      if (!rtOk) issues.push(`record_type_name="${job.record_type_name}" (expected "Lead")`);
      return {
        client_name: rec.client_name,
        jn_job_id: rec.jn_job_id,
        pushed_at: rec.jn_pushed_at,
        cf_string_34: job.cf_string_34,
        record_type_name: job.record_type_name,
        date_start: dsValue,
        date_start_cleared: dsCleared,
        all_correct: cfOk && rtOk && dsCleared,
        issues: issues.length > 0 ? issues : null,
      };
    } catch (e) {
      return {
        client_name: rec.client_name,
        jn_job_id: rec.jn_job_id,
        all_correct: false,
        issue: `Exception: ${e.message}`,
      };
    }
  }
  for (let i = 0; i < records.length; i += CONCURRENCY) {
    const batch = records.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(batch.map(checkOne));
    results.push(...batchResults);
  }

  const summary = {
    total_checked: results.length,
    all_correct: results.filter((r) => r.all_correct).length,
    has_issues: results.filter((r) => !r.all_correct).length,
    issues_breakdown: {
      cf_string_34_wrong: results.filter((r) => r.cf_string_34 && r.cf_string_34.toLowerCase() !== "retail").length,
      date_start_not_cleared: results.filter((r) => !r.date_start_cleared && r.date_start !== undefined).length,
      record_type_wrong: results.filter((r) => r.record_type_name && r.record_type_name !== "Lead").length,
    },
  };

  return json(200, { ok: true, summary, results });
};

function json(status, body) {
  return {
    statusCode: status,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}
