// netlify/functions/bulk-generate-insp-reports-background.js
//
// Runs the per-job inspection report generator across every JN job that
// matches a chosen result (Damage / No Damage / Retail). The `-background`
// suffix in the filename promotes this to a Netlify Background Function
// (15-minute timeout vs 26 sec for a regular function), which is what we
// need because each report takes ~10–20 seconds and a status batch can
// easily hit 50+ jobs.
//
// Background functions return 202 Accepted immediately and finish the
// work asynchronously — the caller can't see results in real time. Status
// is logged to Netlify function logs. The companion list endpoint
// (bulk-list-insp-report-candidates.js) shows progress: as jobs complete,
// they pick up an "Inspection-Report-*.pdf" in their documents tab, so
// re-running the lister with skipExisting=true shows fewer remaining jobs.
//
// USAGE:
//   POST /.netlify/functions/bulk-generate-insp-reports-background
//   Body: {
//     result: "Damage" | "No Damage" | "Retail",   // required
//     sinceDays: 30 | 90 | 365 | 0,                 // 0 = all time, default 30
//     skipExisting: true,                           // default true
//     concurrency: 3,                               // default 3
//   }
//
// Returns: 202 Accepted immediately. Real progress in Netlify function logs.

const JN_BASE = "https://app.jobnimbus.com/api1";
const JN_KEY = process.env.JOBNIMBUS_API_KEY;
const BASE_URL = process.env.URL || process.env.DEPLOY_PRIME_URL || "https://ccg-claims-docs.netlify.app";

const jnHeaders = {
  Authorization: `bearer ${JN_KEY}`,
  "Content-Type": "application/json",
};

const VALID_RESULTS = ["Damage", "No Damage", "Retail"];
const RESULT_RECORD_TYPES = [37, 45, 36];
const RESULT_RECORD_TYPE_NAMES = ["PA", "Lead", "Retail"];

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ ok: false, error: "Method not allowed" }) };
  }
  if (!JN_KEY) {
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: "JOBNIMBUS_API_KEY not set" }) };
  }

  let body;
  try { body = JSON.parse(event.body || "{}"); }
  catch { return { statusCode: 400, body: JSON.stringify({ ok: false, error: "Invalid JSON" }) }; }

  const result = (body.result || "").trim();
  if (!VALID_RESULTS.includes(result)) {
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: `result must be one of ${VALID_RESULTS.join(", ")}` }) };
  }
  const sinceDays = Number.isFinite(+body.sinceDays) ? +body.sinceDays : 30;
  const skipExisting = body.skipExisting !== false;
  // Concurrency >5 is asking for trouble — PDFShift starts to push back and
  // JN's upload step does a multi-step S3 dance per file that doesn't love
  // being parallelized too aggressively.
  const concurrency = Math.min(Math.max(+body.concurrency || 3, 1), 5);

  console.log("=== bulk-generate-insp-reports START — result:", result, "sinceDays:", sinceDays, "skipExisting:", skipExisting, "concurrency:", concurrency);
  const t0 = Date.now();

  // ── 1. List + filter candidates (same logic as the list endpoint,
  //       inlined here to avoid the extra HTTP hop and to keep the
  //       cf_string_34 read in one place) ─────────────────────────
  const sinceTs = sinceDays > 0
    ? Math.floor(Date.now() / 1000) - sinceDays * 24 * 60 * 60
    : 0;

  const allJobs = [];
  for (let page = 0; page < 10; page++) {
    const from = page * 100;
    const url = sinceTs > 0
      ? `${JN_BASE}/jobs?size=100&from=${from}&sort=-date_updated&date_updated_after=${sinceTs}`
      : `${JN_BASE}/jobs?size=100&from=${from}&sort=-date_updated`;
    const r = await fetch(url, { headers: jnHeaders });
    if (!r.ok) {
      console.error(`JN list page ${page} failed:`, r.status);
      break;
    }
    const data = await r.json();
    const pageJobs = data.results || data.jobs || [];
    allJobs.push(...pageJobs);
    if (pageJobs.length < 100) break;
  }
  console.log("JN list jobs fetched:", allJobs.length);

  const filterable = allJobs.filter(j =>
    RESULT_RECORD_TYPES.includes(j.record_type) ||
    RESULT_RECORD_TYPE_NAMES.includes(j.record_type_name)
  );

  const fullJobs = await batchMap(filterable, 20, async (j) => {
    const jnid = j.jnid || j.id;
    if (!jnid) return null;
    try {
      const r = await fetch(`${JN_BASE}/jobs/${jnid}`, { headers: jnHeaders });
      if (!r.ok) return null;
      return await r.json();
    } catch { return null; }
  });
  const matching = fullJobs.filter(j => j && j.cf_string_34 === result);
  console.log(`Jobs with cf_string_34 === "${result}":`, matching.length);

  // Pre-flight per-job filtering — cheap calls (counts only, no downloads).
  // We need the photo count to skip empties (per-job function will fail
  // on those) and the doc check to honor skipExisting.
  const preflighted = await batchMap(matching, 5, async (job) => {
    const jnid = job.jnid || job.id;
    const [photoCount, hasExistingReport] = await Promise.all([
      countJobPhotos(jnid),
      skipExisting ? jobHasInspectionReport(jnid) : Promise.resolve(false),
    ]);
    return { jnid, clientName: job.display_name || job.name, photoCount, hasExistingReport };
  });

  const skippedNoPhotos = preflighted.filter(c => c.photoCount === 0);
  const skippedExisting = preflighted.filter(c => c.photoCount > 0 && c.hasExistingReport);
  const queue = preflighted.filter(c => c.photoCount > 0 && !c.hasExistingReport);
  console.log(`Queue: ${queue.length} (skipped: ${skippedNoPhotos.length} no photos, ${skippedExisting.length} already have report)`);

  // ── 2. Process in parallel batches, calling the existing per-job
  //       function via internal HTTP. Same convention used by
  //       resend-signed-docs.js → regenerate-old-pdfs ──
  const results = { succeeded: [], failed: [] };
  for (let i = 0; i < queue.length; i += concurrency) {
    const batch = queue.slice(i, i + concurrency);
    const batchResults = await Promise.all(batch.map(async (c) => {
      try {
        const r = await fetch(`${BASE_URL}/.netlify/functions/generate-and-upload-insp-report`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jnid: c.jnid }),
        });
        const txt = await r.text();
        let d;
        try { d = JSON.parse(txt); } catch { d = { ok: false, error: "Non-JSON: " + txt.slice(0, 200) }; }
        if (!r.ok || !d.ok) {
          console.warn(`FAIL ${c.jnid} (${c.clientName}):`, d.error, d.detail || "");
          return { jnid: c.jnid, clientName: c.clientName, ok: false, error: d.error };
        }
        console.log(`OK ${c.jnid} (${c.clientName}): ${d.filename}`);
        return { jnid: c.jnid, clientName: c.clientName, ok: true, filename: d.filename };
      } catch (e) {
        console.warn(`FAIL ${c.jnid} (${c.clientName}):`, e.message);
        return { jnid: c.jnid, clientName: c.clientName, ok: false, error: e.message };
      }
    }));
    for (const r of batchResults) {
      if (r.ok) results.succeeded.push(r); else results.failed.push(r);
    }
    console.log(`Progress: ${i + batch.length} / ${queue.length} processed`);
  }

  const elapsed = Math.round((Date.now() - t0) / 1000);
  console.log("=== bulk-generate-insp-reports DONE — succeeded:", results.succeeded.length,
    "failed:", results.failed.length,
    "skipped(no_photos):", skippedNoPhotos.length,
    "skipped(existing):", skippedExisting.length,
    `(${elapsed}s)`);

  // Background functions: return value isn't sent to the original caller
  // (they got 202 immediately) but is logged.
  return {
    statusCode: 200,
    body: JSON.stringify({
      ok: true,
      result,
      total: queue.length,
      succeeded: results.succeeded.length,
      failed: results.failed.length,
      skippedNoPhotos: skippedNoPhotos.length,
      skippedExisting: skippedExisting.length,
      elapsedSeconds: elapsed,
      failures: results.failed,
    }),
  };
};

async function countJobPhotos(jnid) {
  try {
    const r = await fetch(`${JN_BASE}/files?related=${jnid}&type=2&size=30`, { headers: jnHeaders });
    if (!r.ok) return 0;
    const data = await r.json();
    const files = data.files || data.data || data.results || [];
    return files.filter(f => (f.content_type || "").startsWith("image/")).length;
  } catch { return 0; }
}

async function jobHasInspectionReport(jnid) {
  try {
    const r = await fetch(`${JN_BASE}/files?related=${jnid}&type=1&size=50`, { headers: jnHeaders });
    if (!r.ok) return false;
    const data = await r.json();
    const files = data.files || data.data || data.results || [];
    return files.some(f => (f.filename || "").startsWith("Inspection-Report-"));
  } catch { return false; }
}

async function batchMap(items, concurrency, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const slice = items.slice(i, i + concurrency);
    const results = await Promise.all(slice.map(fn));
    out.push(...results);
  }
  return out;
}
