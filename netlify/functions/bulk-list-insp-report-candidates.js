// netlify/functions/bulk-list-insp-report-candidates.js
//
// Lists JN jobs that match a given inspection result (Damage / No Damage /
// Retail) and would be candidates for the bulk Inspection Report generator.
// This is the read-only counterpart to bulk-generate-insp-reports-background.js
// — it returns the list of jobs that *would* be processed, so the manager can
// review before kicking off the real run.
//
// USAGE:
//   POST /.netlify/functions/bulk-list-insp-report-candidates
//   Body: {
//     result: "Damage" | "No Damage" | "Retail",   // required
//     sinceDays: 30 | 90 | 365 | 0,                 // 0 = all time, default 30
//     skipExisting: true,                           // default true
//   }
//
// Returns:
//   { ok: true, total, candidates: [{ jnid, clientName, address, repName,
//     resultDate, photoCount, hasExistingReport }, ...] }

const JN_BASE = "https://app.jobnimbus.com/api1";
const JN_KEY = process.env.JOBNIMBUS_API_KEY;

const jnHeaders = {
  Authorization: `bearer ${JN_KEY}`,
  "Content-Type": "application/json",
};

const VALID_RESULTS = ["Damage", "No Damage", "Retail"];
// JN record_types that can carry an inspection result: PA (37), Lead (45),
// Retail (36). Mirrors the filter used in inspection-checker.js so we don't
// silently skip whole workflows.
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

  console.log("=== bulk-list candidates — result:", result, "sinceDays:", sinceDays, "skipExisting:", skipExisting);

  // ── 1. Page through JN jobs ─────────────────────────────────────
  const sinceTs = sinceDays > 0
    ? Math.floor(Date.now() / 1000) - sinceDays * 24 * 60 * 60
    : 0;

  const MAX_PAGES = 10; // 10 * 100 = 1000 jobs max
  const allJobs = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const from = page * 100;
    const url = sinceTs > 0
      ? `${JN_BASE}/jobs?size=100&from=${from}&sort=-date_updated&date_updated_after=${sinceTs}`
      : `${JN_BASE}/jobs?size=100&from=${from}&sort=-date_updated`;
    const r = await fetch(url, { headers: jnHeaders });
    if (!r.ok) {
      console.error(`JN list page ${page} failed:`, r.status);
      if (page === 0) {
        return { statusCode: 500, body: JSON.stringify({ ok: false, error: `JN returned ${r.status}` }) };
      }
      break;
    }
    const data = await r.json();
    const pageJobs = data.results || data.jobs || [];
    allJobs.push(...pageJobs);
    if (pageJobs.length < 100) break;
  }
  console.log("JN list jobs fetched:", allJobs.length);

  // ── 2. Filter to record types that can carry a result, then fetch
  //       full details to read cf_string_34 (not in list response) ──
  const filterable = allJobs.filter(j =>
    RESULT_RECORD_TYPES.includes(j.record_type) ||
    RESULT_RECORD_TYPE_NAMES.includes(j.record_type_name)
  );
  console.log("Filterable jobs (PA/Lead/Retail record types):", filterable.length);

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

  // ── 3. For each matching job, count photos & check for existing
  //       report. Done in parallel batches to stay polite on JN. ──
  const candidates = await batchMap(matching, 5, async (job) => {
    const jnid = job.jnid || job.id;
    const [photoCount, hasExistingReport] = await Promise.all([
      countJobPhotos(jnid),
      skipExisting ? jobHasInspectionReport(jnid) : Promise.resolve(false),
    ]);
    return {
      jnid,
      clientName: job.display_name || (job.name || "").split(" - ")[0] || "Homeowner",
      address: [job.address_line1, job.city, job.state_text, job.zip].filter(Boolean).join(", "),
      repName: job.sales_rep_name || "—",
      resultDate: job.cf_date_3 || job.date_updated || null, // cf_date_3 is JN's "result date" custom field
      photoCount,
      hasExistingReport,
    };
  });

  return {
    statusCode: 200,
    body: JSON.stringify({ ok: true, total: candidates.length, candidates }),
  };
};

// Fetch only the photo count for a job — uses the same files endpoint as
// the per-job function but doesn't download the bytes.
async function countJobPhotos(jnid) {
  try {
    const r = await fetch(`${JN_BASE}/files?related=${jnid}&type=2&size=30`, { headers: jnHeaders });
    if (!r.ok) return 0;
    const data = await r.json();
    const files = data.files || data.data || data.results || [];
    return files.filter(f => (f.content_type || "").startsWith("image/")).length;
  } catch {
    return 0;
  }
}

// Look at a job's documents tab for an existing Inspection-Report-*.pdf.
// We use this to skip jobs that have already been processed by the
// per-job function so re-running the bulk job doesn't pile duplicates.
async function jobHasInspectionReport(jnid) {
  try {
    const r = await fetch(`${JN_BASE}/files?related=${jnid}&type=1&size=50`, { headers: jnHeaders });
    if (!r.ok) return false;
    const data = await r.json();
    const files = data.files || data.data || data.results || [];
    return files.some(f => (f.filename || "").startsWith("Inspection-Report-"));
  } catch {
    return false;
  }
}

// Map an async function over a list with bounded concurrency.
async function batchMap(items, concurrency, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const slice = items.slice(i, i + concurrency);
    const results = await Promise.all(slice.map(fn));
    out.push(...results);
  }
  return out;
}
