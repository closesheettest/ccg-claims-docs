// netlify/functions/cron-push-pending-results.js
//
// Scheduled Netlify function — runs hourly. Finds every inspection
// where the inspector has classified a result (damage / no_damage /
// retail) AND the JN link exists (jn_job_id is set) AND it hasn't
// been pushed to JN yet (jn_pushed_at IS NULL), and fires the same
// push-result-to-jn path the manual button uses.
//
// Same idempotency contract as the manual button:
//   - push-result-to-jn does a JN PUT that's safe to re-fire (sets
//     the same cf_string_34 value).
//   - On success, jn_pushed_at is stamped client-side from
//     adminPushResultToJn so future cron passes skip the row.
//
// SCHEDULE: every hour at minute 5 (offset so the JN sync settles).
//
// Required env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY,
//               JOBNIMBUS_API_KEY, URL (or PUBLIC_SITE_URL)

const JN_BASE = "https://app.jobnimbus.com/api1";

// Netlify scheduled-function export format. The schedule string is
// also redundantly set in netlify.toml — having it here lets the
// function self-document its cadence.
const handler = async () => {
  const missing = [];
  for (const k of ["VITE_SUPABASE_URL", "VITE_SUPABASE_ANON_KEY", "JOBNIMBUS_API_KEY"]) {
    if (!process.env[k]) missing.push(k);
  }
  if (missing.length) {
    console.error("cron-push-pending-results missing env:", missing.join(", "));
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: `Missing env: ${missing.join(", ")}` }) };
  }

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
  const JN_KEY = process.env.JOBNIMBUS_API_KEY;
  const base = (process.env.URL || process.env.PUBLIC_SITE_URL || "").replace(/\/$/, "");
  if (!base) {
    console.error("cron-push-pending-results: no base URL configured");
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: "No base URL" }) };
  }

  const sbHeaders = {
    apikey: SB_KEY,
    Authorization: `Bearer ${SB_KEY}`,
    "Content-Type": "application/json",
  };

  // 1. Pull every inspection that NEEDS pushing.
  //    Filters mirror the UI's bulk button.
  const url =
    `${SB_URL}/rest/v1/inspections` +
    `?result=in.(damage,no_damage,retail)` +
    `&jn_job_id=not.is.null` +
    `&jn_pushed_at=is.null` +
    `&cancelled_at=is.null` +
    `&select=id,client_name,result,jn_job_id` +
    `&order=result_at.asc` +
    `&limit=100`;
  const sbRes = await fetch(url, { headers: sbHeaders });
  if (!sbRes.ok) {
    const err = (await sbRes.text()).slice(0, 300);
    console.error("Supabase fetch failed:", sbRes.status, err);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: `Supabase ${sbRes.status}` }) };
  }
  const pending = await sbRes.json();
  console.log(`cron-push-pending-results: ${pending.length} pending`);
  if (pending.length === 0) {
    return { statusCode: 200, body: JSON.stringify({ ok: true, pushed: 0, message: "Nothing pending." }) };
  }

  // 2. Push each via the existing function. Concurrency-limited
  //    parallel so we finish well inside Netlify's 30-second
  //    scheduled-function timeout. Per-record push touches JN twice
  //    (list files + PUT cf_string_34) for ~1.5-2s each — at
  //    CONCURRENCY=3 a batch of 10 finishes in ~7-10s.
  //
  //    PER_RUN_CAP is intentionally low (10) so each run has slack.
  //    The function runs hourly; anything not handled this run rolls
  //    into next hour's. With a normal weekly volume (~50 signings)
  //    and a 10/hour throughput, even the worst Monday-morning
  //    backlog clears in a few hours.
  const CONCURRENCY = 3;
  const PER_RUN_CAP = 10;
  const todo = pending.slice(0, PER_RUN_CAP);
  let okCount = 0;
  let failCount = 0;
  const failures = [];

  async function pushOne(rec) {
    try {
      const r = await fetch(`${base}/.netlify/functions/push-result-to-jn`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ inspectionId: rec.id }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.ok || !d.jn_updated) {
        failures.push({ id: rec.id, name: rec.client_name, error: d.error || d.jn_update_error || `HTTP ${r.status}` });
        failCount++;
        return;
      }
      // Stamp jn_pushed_at so subsequent runs skip this row. The
      // manual UI handler stamps this too; in cron context we do it
      // directly here since we're not going through React.
      try {
        await fetch(
          `${SB_URL}/rest/v1/inspections?id=eq.${encodeURIComponent(rec.id)}`,
          {
            method: "PATCH",
            headers: sbHeaders,
            body: JSON.stringify({ jn_pushed_at: new Date().toISOString() }),
          },
        );
      } catch (e) {
        console.warn("jn_pushed_at stamp failed:", rec.id, e.message);
      }
      // For retail records, also fire the swap. Fire-and-forget — its
      // own Lambda handles the work, and a failure here doesn't roll
      // back the cf_string_34 set above (manual retry is still available).
      if (d.needs_retail_swap) {
        fetch(`${base}/.netlify/functions/process-retail-result`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ inspectionId: rec.id, skip_cert: false }),
        }).catch((e) => console.warn("retail swap fire failed:", rec.id, e.message));
      }
      okCount++;
    } catch (e) {
      failures.push({ id: rec.id, name: rec.client_name, error: e.message });
      failCount++;
    }
  }

  // Run in concurrency-limited batches.
  for (let i = 0; i < todo.length; i += CONCURRENCY) {
    const batch = todo.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(pushOne));
  }

  const summary = {
    ok: true,
    total_pending: pending.length,
    processed: todo.length,
    pushed: okCount,
    failed: failCount,
    failures: failures.slice(0, 10),
    deferred_to_next_run: Math.max(0, pending.length - PER_RUN_CAP),
  };
  console.log("cron-push-pending-results done:", JSON.stringify(summary));
  return { statusCode: 200, body: JSON.stringify(summary) };
};

// Netlify v2 scheduled function: declare the cron schedule next to
// the handler. The toml also has this for redundancy.
exports.handler = handler;
exports.config = { schedule: "5 * * * *" }; // every hour at :05
