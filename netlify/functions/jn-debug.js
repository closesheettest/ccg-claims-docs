// netlify/functions/jn-debug.js
//
// DIAGNOSTIC — does NOT write to Supabase.
// Shows a sample of JN job names and tries to find matches for specific
// homeowner names you pass in via query params.
//
// USAGE:
//   /jn-debug                          → shows a sample of 30 JN jobs
//   /jn-debug?name=Emma Freeman        → searches for Emma Freeman across all JN PA jobs
//   /jn-debug?name=Betty Perry,Danny Perry,Johnny Thomas  → multiple names at once

const JN_BASE = "https://app.jobnimbus.com/api1";
const JN_KEY  = process.env.JOBNIMBUS_API_KEY;

const jnHeaders = {
  Authorization: `bearer ${JN_KEY}`,
  "Content-Type": "application/json",
};

exports.handler = async (event) => {
  const params = event.queryStringParameters || {};
  const searchNames = (params.name || "").split(",").map(s => s.trim()).filter(Boolean);
  // ?rep=Tabitha Gregor → find every recent job CREDITED to that sales rep
  // (by sales_rep_name), with the fields the sales leaderboard reads, so we
  // can see why a rep is/ isn't showing as a weekly sale.
  const repQuery = (params.rep || "").trim().toLowerCase();

  // Fetch 60 days of JN jobs, paged
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

  // Show record_type distribution so we can see what filter should be
  const recordTypeCounts = {};
  allJnJobs.forEach(j => {
    const key = `${j.record_type || "?"}:${j.record_type_name || "?"}`;
    recordTypeCounts[key] = (recordTypeCounts[key] || 0) + 1;
  });

  // If they passed ?name=X, search through ALL jobs (not just PA-filtered)
  // and show anything whose name contains any token from the search
  const searchResults = {};
  if (searchNames.length > 0) {
    for (const searchName of searchNames) {
      const tokens = searchName.toLowerCase().split(/\s+/).filter(t => t.length > 2);
      const matches = allJnJobs
        .filter(j => {
          const jobName = (j.name || "").toLowerCase();
          const displayName = (j.display_name || "").toLowerCase();
          const firstName = (j.first_name || "").toLowerCase();
          const lastName = (j.last_name || "").toLowerCase();
          const primaryName = (j.primary && j.primary.name ? j.primary.name : "").toLowerCase();
          return tokens.some(t =>
            jobName.includes(t) ||
            displayName.includes(t) ||
            firstName.includes(t) ||
            lastName.includes(t) ||
            primaryName.includes(t)
          );
        })
        .slice(0, 20);

      searchResults[searchName] = matches.map(j => ({
        name: j.name,
        display_name: j.display_name,
        first_name: j.first_name,
        last_name: j.last_name,
        jnid: j.jnid || j.id,
        record_type: j.record_type,
        record_type_name: j.record_type_name,
        cf_string_34: j.cf_string_34,
        address_line1: j.address_line1,
        zip: j.zip,
        sales_rep_name: j.sales_rep_name,
        status_name: j.status_name,
        sold_date: j["Sold Date"] != null ? j["Sold Date"] : j.cf_date_5,
        approved_estimate_total: j.approved_estimate_total,
        primary: j.primary && j.primary.name,
      }));
    }
  }

  // ?rep=<name>: every recent job credited to that sales rep (the field the
  // sales leaderboard groups on), with the leaderboard-relevant fields.
  let repResults = null;
  if (repQuery) {
    repResults = allJnJobs
      .filter(j => (j.sales_rep_name || "").toLowerCase().includes(repQuery))
      .map(j => ({
        name: j.name,
        jnid: j.jnid || j.id,
        sales_rep_name: j.sales_rep_name,
        status_name: j.status_name,
        sold_date: j["Sold Date"] != null ? j["Sold Date"] : j.cf_date_5,
        sold_date_iso: (() => { const v = j["Sold Date"] != null ? j["Sold Date"] : j.cf_date_5; const n = Number(v); return Number.isFinite(n) && n > 0 ? new Date(n * 1000).toISOString() : null; })(),
        approved_estimate_total: j.approved_estimate_total,
        primary: j.primary && j.primary.name,
        record_type_name: j.record_type_name,
      }));
  }

  // Sample of 30 PA-filtered jobs so we can see their structure
  const paJobs = allJnJobs.filter(j =>
    j.record_type === 45 || j.record_type_name === "Lead" || j.record_type_name === "PA"
  );

  const sample = paJobs.slice(0, 30).map(j => ({
    name: j.name,
    display_name: j.display_name,
    first_name: j.first_name,
    last_name: j.last_name,
    record_type: j.record_type,
    record_type_name: j.record_type_name,
  }));

  return {
    statusCode: 200,
    body: JSON.stringify({
      totalJnJobs: allJnJobs.length,
      recordTypeCounts,
      paJobsCount: paJobs.length,
      samplePaJobs: sample,
      searchResults,
      repResults,
    }, null, 2),
  };
};