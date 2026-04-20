// netlify/functions/bulk-sync-orphans.js
//
// ONE-TIME CLEANUP FUNCTION
// Finds Supabase inspection records that have no jn_job_id (orphans) and
// attempts to link them to JN jobs by fuzzy-matching the homeowner name.
// If the matched JN job has a result set in cf_string_34, also writes that
// result back to Supabase.
//
// TO RUN: After deploy, visit
//   https://<your-site>.netlify.app/.netlify/functions/bulk-sync-orphans
// or curl it. Safe to re-run — only touches orphans (records with NULL jn_job_id).
//
// Returns a JSON report: { matched, unmatched, resultsWritten, details[] }

const JN_BASE     = "https://app.jobnimbus.com/api1";
const JN_KEY      = process.env.JOBNIMBUS_API_KEY;
const SB_URL      = process.env.VITE_SUPABASE_URL;
const SB_KEY      = process.env.VITE_SUPABASE_ANON_KEY;

const sbHeaders = {
  apikey: SB_KEY,
  Authorization: `Bearer ${SB_KEY}`,
  "Content-Type": "application/json",
};
const jnHeaders = {
  Authorization: `bearer ${JN_KEY}`,
  "Content-Type": "application/json",
};

// Normalize a homeowner name for fuzzy comparison
const normName = (s) => (s || "")
  .toLowerCase()
  .replace(/\s+/g, " ")
  .trim();

// Pull first + last name tokens for more reliable matching
const nameTokens = (s) => {
  const n = normName(s);
  if (!n) return [];
  return n.split(" ").filter(t => t.length > 1); // drop initials
};

// Check if two names are "the same person" — bidirectional token containment
function namesMatch(a, b) {
  const ta = nameTokens(a);
  const tb = nameTokens(b);
  if (ta.length === 0 || tb.length === 0) return false;
  // Every significant token in the shorter name must appear in the longer name
  const shorter = ta.length <= tb.length ? ta : tb;
  const longer  = ta.length <= tb.length ? tb : ta;
  return shorter.every(t => longer.some(lt => lt === t || lt.startsWith(t) || t.startsWith(lt)));
}

// JN job names typically include the homeowner name first: "Jane Doe - 123 Main St"
function extractJobNames(jnJobName) {
  if (!jnJobName) return [];
  const cleaned = jnJobName.replace(/\[TEST\]?\s*-?\s*/gi, "").trim();
  // split on common separators (" - ", " — ", " | ")
  return [cleaned, ...cleaned.split(/\s-\s|\s—\s|\s\|\s/)].map(s => s.trim()).filter(Boolean);
}

exports.handler = async (event) => {
  console.log("=== Bulk Sync Orphans: START ===");

  // 1. Pull all orphan inspection records from Supabase
  const sbRes = await fetch(
    `${SB_URL}/rest/v1/inspections?jn_job_id=is.null&result=is.null&signed_at=not.is.null&select=id,client_name,address,city,state,zip,signed_at`,
    { headers: sbHeaders }
  );
  if (!sbRes.ok) {
    const t = await sbRes.text();
    return { statusCode: 500, body: JSON.stringify({ error: "Supabase fetch failed", detail: t }) };
  }
  const orphans = await sbRes.json();
  console.log("Orphans found:", orphans.length);
  if (orphans.length === 0) {
    return { statusCode: 200, body: JSON.stringify({ message: "No orphans to sync", matched: 0 }) };
  }

  // 2. Fetch all JN jobs in the last 60 days (wider than the regular cron's 7 days
  //    since orphans can be old). Paged, up to 1000 jobs.
  const since = Math.floor(Date.now() / 1000) - 60 * 24 * 60 * 60;
  const allJnJobs = [];
  for (let page = 0; page < 10; page++) {
    const from = page * 100;
    const r = await fetch(
      `${JN_BASE}/jobs?size=100&from=${from}&sort=-date_updated&date_updated_after=${since}`,
      { headers: jnHeaders }
    );
    if (!r.ok) break;
    const d = await r.json();
    const rows = d.results || d.jobs || [];
    allJnJobs.push(...rows);
    if (rows.length < 100) break;
  }
  console.log("JN jobs fetched:", allJnJobs.length);

  // 3. Filter to PA workflow jobs
  const paJobs = allJnJobs.filter(j =>
    j.record_type === 45 || j.record_type_name === "Lead" || j.record_type_name === "PA"
  );
  console.log("PA/Lead jobs to check:", paJobs.length);

  // 4. Fetch full details for each PA job in batches of 20 (to get cf_string_34)
  const BATCH = 20;
  const jobDetails = [];
  for (let i = 0; i < paJobs.length; i += BATCH) {
    const batch = paJobs.slice(i, i + BATCH);
    const results = await Promise.all(
      batch.map(async (j) => {
        const id = j.jnid || j.id;
        try {
          const r = await fetch(`${JN_BASE}/jobs/${id}`, { headers: jnHeaders });
          if (!r.ok) return null;
          return await r.json();
        } catch { return null; }
      })
    );
    jobDetails.push(...results.filter(Boolean));
  }
  console.log("JN job details fetched:", jobDetails.length);

  // 5. For each orphan, find the best-matching JN job by name
  const details = [];
  let matched = 0;
  let resultsWritten = 0;

  const resultMap = {
    "Damage": "damage",
    "No Damage": "no_damage",
    "Retail": "retail",
  };

  for (const orphan of orphans) {
    let bestMatch = null;
    for (const job of jobDetails) {
      const candidates = extractJobNames(job.name);
      if (candidates.some(c => namesMatch(c, orphan.client_name))) {
        bestMatch = job;
        break;
      }
    }

    if (!bestMatch) {
      details.push({ orphan: orphan.client_name, address: orphan.address, matched: false });
      continue;
    }

    const jnid = bestMatch.jnid || bestMatch.id;
    const jnResult = bestMatch.cf_string_34 || null;
    const uiResult = resultMap[jnResult] || null;

    // Build the update payload
    const payload = { jn_job_id: jnid };
    if (jnResult) {
      payload.inspection_result = jnResult;
    }
    if (uiResult) {
      payload.result = uiResult;
      payload.result_at = new Date().toISOString();
    }

    const updRes = await fetch(`${SB_URL}/rest/v1/inspections?id=eq.${orphan.id}`, {
      method: "PATCH",
      headers: { ...sbHeaders, Prefer: "return=minimal" },
      body: JSON.stringify(payload),
    });

    if (updRes.ok) {
      matched++;
      if (uiResult) resultsWritten++;
      details.push({
        orphan: orphan.client_name,
        address: orphan.address,
        matched: true,
        jnName: bestMatch.name,
        jnid,
        resultSet: uiResult || "(none)",
      });
    } else {
      const t = await updRes.text();
      details.push({
        orphan: orphan.client_name,
        address: orphan.address,
        matched: true,
        jnName: bestMatch.name,
        jnid,
        updateError: t.slice(0, 200),
      });
    }
  }

  console.log(`=== Bulk Sync Complete: matched ${matched}/${orphans.length}, results written ${resultsWritten} ===`);

  return {
    statusCode: 200,
    body: JSON.stringify({
      orphansFound: orphans.length,
      matched,
      unmatched: orphans.length - matched,
      resultsWritten,
      details,
    }, null, 2),
  };
};