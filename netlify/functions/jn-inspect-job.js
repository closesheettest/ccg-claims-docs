// netlify/functions/jn-inspect-job.js
//
// Diagnostic tool — fetches a single JN job by name and returns ALL its fields.
// Useful for figuring out why the inspection-checker cron isn't picking up a
// status change. Just look at the response and find the field that holds the
// actual inspection result ("Retail", "Damage", "No Damage", "Lost", etc.) —
// then we can update the cron if it's pointing at the wrong field.
//
// USAGE:
//   GET /.netlify/functions/jn-inspect-job?name=stahley
//   GET /.netlify/functions/jn-inspect-job?jnid=mocw3sv98tfei0wv5yv4n6a
//
// Returns: full JN job record (or array if multiple matches)

const JN_API_KEY = process.env.JOBNIMBUS_API_KEY;
const JN_BASE = "https://app.jobnimbus.com/api1";
const jnHeaders = {
  "Authorization": `Bearer ${JN_API_KEY}`,
  "Content-Type": "application/json",
};

exports.handler = async (event) => {
  const params = event.queryStringParameters || {};
  const name = params.name;
  const jnid = params.jnid;

  if (!name && !jnid) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: "Pass ?name=lastName or ?jnid=jobid" }),
    };
  }

  try {
    if (jnid) {
      // Direct fetch by jnid
      const r = await fetch(`${JN_BASE}/jobs/${jnid}`, { headers: jnHeaders });
      if (!r.ok) {
        const errText = await r.text();
        return { statusCode: r.status, body: JSON.stringify({ error: errText }) };
      }
      const job = await r.json();
      return {
        statusCode: 200,
        body: JSON.stringify({
          job,
          // Pull out the most likely "inspection result" fields so they're easy to spot
          interestingFields: extractInterestingFields(job),
        }, null, 2),
      };
    }

    // Search by name — fetch recent jobs and filter by name match
    // Look back 60 days to be safe for older records
    const since = Math.floor(Date.now() / 1000) - 60 * 24 * 60 * 60;
    const allJobs = [];
    const MAX_PAGES = 10;
    for (let page = 0; page < MAX_PAGES; page++) {
      const from = page * 100;
      const r = await fetch(
        `${JN_BASE}/jobs?size=100&from=${from}&sort=-date_updated&date_updated_after=${since}`,
        { headers: jnHeaders }
      );
      if (!r.ok) break;
      const data = await r.json();
      const pageJobs = data.results || data.jobs || [];
      if (pageJobs.length === 0) break;
      allJobs.push(...pageJobs);
      if (pageJobs.length < 100) break;
    }

    const needle = String(name).toLowerCase();
    const matches = allJobs.filter(j => (j.name || "").toLowerCase().includes(needle));

    if (matches.length === 0) {
      return {
        statusCode: 404,
        body: JSON.stringify({
          error: `No JN jobs found matching "${name}" in the last 60 days`,
          searched: allJobs.length,
        }),
      };
    }

    // Fetch full details for each match (the list endpoint omits cf_string_34)
    const detailed = await Promise.all(
      matches.slice(0, 5).map(async (m) => {
        try {
          const r = await fetch(`${JN_BASE}/jobs/${m.jnid}`, { headers: jnHeaders });
          if (!r.ok) return null;
          const full = await r.json();
          return {
            jnid: full.jnid,
            name: full.name,
            interestingFields: extractInterestingFields(full),
            allFields: full,
          };
        } catch (e) { return null; }
      })
    );

    return {
      statusCode: 200,
      body: JSON.stringify({
        found: matches.length,
        showing: Math.min(matches.length, 5),
        matches: detailed.filter(Boolean),
      }, null, 2),
    };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};

// Pull out fields likely to hold the inspection result so they're easy to find.
// Looks at every field whose name contains "result", "inspection", "status",
// "cf_string", "cf_text", "outcome", or "disposition" — and skips empty values.
function extractInterestingFields(job) {
  const wanted = ["result", "inspection", "status", "cf_string", "cf_text", "outcome", "disposition", "stage", "workflow"];
  const found = {};
  for (const [key, val] of Object.entries(job)) {
    if (val == null || val === "" || val === false || val === 0) continue;
    const keyLower = key.toLowerCase();
    if (wanted.some(w => keyLower.includes(w))) {
      found[key] = val;
    }
  }
  return found;
}