// netlify/functions/backfill-inspected-date.js
//
// One-time backfill of JN cf_date_22 ("Inspected Date") for records
// that were classified + pushed BEFORE the forward fix in
// push-result-to-jn.js shipped. Without this, those records have a
// blank Inspected Date in JN's UI even though we have the timestamp
// locally on Supabase.
//
// USAGE:
//   GET  /.netlify/functions/backfill-inspected-date            → dry run
//   POST /.netlify/functions/backfill-inspected-date?go=1       → actually PUT
//
//   Optional ?from=YYYY-MM-DD&to=YYYY-MM-DD to scope. Default last 30 days.
//
// For each candidate record:
//   1. GET the JN job
//   2. If cf_date_22 is missing/0 → PUT cf_date_22 = result_at (Unix sec)
//   3. Skip if cf_date_22 is already set (don't overwrite manual edits)
//
// Required env: JOBNIMBUS_API_KEY, VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY

const JN_BASE = "https://app.jobnimbus.com/api1";
const INSPECTED_DATE_FIELD = "cf_date_22";

exports.handler = async (event) => {
  const JN_KEY = process.env.JOBNIMBUS_API_KEY;
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
  if (!JN_KEY || !SB_URL || !SB_KEY) {
    return json(500, { ok: false, error: "Missing env vars" });
  }

  const qs = new URLSearchParams(event.rawQuery || (event.queryStringParameters
    ? new URLSearchParams(event.queryStringParameters).toString()
    : ""));
  const dryRun = !(event.httpMethod === "POST" && qs.get("go") === "1");

  // Date window — default last 30 days so the 16-from-last-week batch
  // (and anything else from the past month) is covered.
  const now = new Date();
  const defaultFrom = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const from = qs.get("from") || defaultFrom.toISOString().slice(0, 10);
  const to = qs.get("to") || new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const sbHeaders = {
    apikey: SB_KEY,
    Authorization: `Bearer ${SB_KEY}`,
  };
  const jnHeaders = {
    Authorization: `bearer ${JN_KEY}`,
    "Content-Type": "application/json",
  };

  // 1. Pull every classified, JN-linked, non-cancelled record in the
  //    window. result_at is the source of truth for inspected date.
  const sbUrl =
    `${SB_URL}/rest/v1/inspections` +
    `?result=in.(damage,no_damage,retail)` +
    `&jn_job_id=not.is.null` +
    `&result_at=not.is.null` +
    `&result_at=gte.${from}` +
    `&result_at=lt.${to}` +
    `&cancelled_at=is.null` +
    `&select=id,client_name,jn_job_id,result,result_at` +
    `&order=result_at.desc` +
    `&limit=200`;
  const sbRes = await fetch(sbUrl, { headers: sbHeaders });
  if (!sbRes.ok) {
    return json(500, { ok: false, error: `Supabase: ${(await sbRes.text()).slice(0, 300)}` });
  }
  const records = await sbRes.json();
  if (records.length === 0) {
    return json(200, { ok: true, dry_run: dryRun, window: { from, to }, candidates: 0, message: "No classified records in this window." });
  }

  // 2. For each record, check current cf_date_22 in JN and queue an
  //    update if needed. Concurrency-limited so a batch of 16-30
  //    finishes in ~10s.
  const CONCURRENCY = 4;
  const results = [];

  async function checkOne(rec) {
    try {
      const gr = await fetch(`${JN_BASE}/jobs/${encodeURIComponent(rec.jn_job_id)}`, { headers: jnHeaders });
      if (!gr.ok) {
        return { record: rec, ok: false, action: null, error: `JN GET failed (${gr.status})` };
      }
      const job = await gr.json();
      const currentValue = job[INSPECTED_DATE_FIELD];
      const inspectedUnix = Math.floor(new Date(rec.result_at).getTime() / 1000);

      if (currentValue && Number(currentValue) > 0) {
        // Already populated — don't overwrite. Could be a manual JN edit
        // or a recent push that already had the forward fix.
        return {
          record: rec,
          ok: true,
          action: "skipped (cf_date_22 already set)",
          existing_value: Number(currentValue),
          existing_value_iso: new Date(Number(currentValue) * 1000).toISOString(),
        };
      }

      if (dryRun) {
        return {
          record: rec,
          ok: true,
          action: `WOULD set cf_date_22=${inspectedUnix} (${new Date(inspectedUnix * 1000).toISOString()})`,
          would_set: inspectedUnix,
        };
      }

      // Real run — PUT just the inspected date field.
      const pr = await fetch(`${JN_BASE}/jobs/${encodeURIComponent(rec.jn_job_id)}`, {
        method: "PUT",
        headers: jnHeaders,
        body: JSON.stringify({ jnid: rec.jn_job_id, [INSPECTED_DATE_FIELD]: inspectedUnix }),
      });
      if (!pr.ok) {
        return { record: rec, ok: false, action: null, error: `JN PUT failed (${pr.status}): ${(await pr.text()).slice(0, 200)}` };
      }
      return {
        record: rec,
        ok: true,
        action: `set cf_date_22=${inspectedUnix}`,
        set_value: inspectedUnix,
        set_value_iso: new Date(inspectedUnix * 1000).toISOString(),
      };
    } catch (e) {
      return { record: rec, ok: false, action: null, error: e.message };
    }
  }

  for (let i = 0; i < records.length; i += CONCURRENCY) {
    const batch = records.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(batch.map(checkOne));
    results.push(...batchResults);
  }

  const summary = {
    dry_run: dryRun,
    window: { from, to },
    candidates: records.length,
    would_set: results.filter((r) => r.action?.startsWith("WOULD set")).length,
    set: results.filter((r) => r.action?.startsWith("set ")).length,
    skipped_already_set: results.filter((r) => r.action?.startsWith("skipped")).length,
    errors: results.filter((r) => !r.ok).length,
  };

  // Compact per-record output — name + jnid + action/error.
  const details = results.map((r) => ({
    client_name: r.record.client_name,
    jn_job_id: r.record.jn_job_id,
    result_at: r.record.result_at,
    action: r.action,
    error: r.error || null,
    existing_value_iso: r.existing_value_iso || null,
  }));

  return json(200, { ok: true, summary, results: details });
};

function json(status, body) {
  return {
    statusCode: status,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}
