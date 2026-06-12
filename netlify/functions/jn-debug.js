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

  // ?jobid=<jnid> → dump the FULL raw job object (all custom fields), so we
  // can see exactly which fields exist + are populated when designing the
  // daily sales-audit checklist. Returns the non-empty fields first.
  if (params.jobid) {
    const r = await fetch(`${JN_BASE}/jobs/${params.jobid.trim()}`, { headers: jnHeaders });
    if (!r.ok) {
      return { statusCode: r.status, body: JSON.stringify({ error: `JN job fetch ${r.status}` }) };
    }
    const job = await r.json();
    const filled = {}, empty = [];
    for (const [k, v] of Object.entries(job)) {
      if (v === null || v === "" || v === 0 || (Array.isArray(v) && v.length === 0)) empty.push(k);
      else filled[k] = v;
    }
    return { statusCode: 200, body: JSON.stringify({ filled, empty_keys: empty }, null, 2) };
  }

  // ?jnsearch=<text> → server-side JN search (finds a job regardless of how
  // long ago it was updated, unlike the 60-day local scan below). Returns the
  // exact fields the sales leaderboard reads, so we can see why a specific
  // job is/isn't counted.
  if (params.jnsearch) {
    const r = await fetch(`${JN_BASE}/jobs?search=${encodeURIComponent(params.jnsearch.trim())}&size=15`, { headers: jnHeaders });
    const d = await r.json().catch(() => ({}));
    const rows = d.results || d.jobs || [];
    const fmt = (sec) => (sec ? new Date(sec * 1000).toLocaleString("en-US", { timeZone: "America/New_York" }) : null);
    const out = rows.map((j) => ({
      name: j.name, number: j.number, jnid: j.jnid || j.id,
      status_name: j.status_name, record_type_name: j.record_type_name,
      sales_rep_name: j.sales_rep_name, sales_rep: j.sales_rep,
      location: j.location && j.location.id,
      cf_date_5: j.cf_date_5, cf_date_5_et: fmt(j.cf_date_5),
      date_start: j.date_start, date_start_et: fmt(j.date_start),
      date_updated: j.date_updated, date_updated_et: fmt(j.date_updated),
    }));
    return { statusCode: 200, body: JSON.stringify({ q: params.jnsearch, count: out.length, jobs: out }, null, 2) };
  }

  const wantFieldCatalog = params.fields === "1";
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

  // ?fields=1 → catalog every distinct FRIENDLY field LABEL JN echoes across
  // recent jobs (the human labels + ALLCAPS/single-word custom fields), with
  // a sample value, value samples, and how many jobs had it. Used to map the
  // sales-audit checklist to exact JN field names. Excludes cf_ raw keys +
  // snake_case system keys.
  if (wantFieldCatalog) {
    const isFriendly = (k) =>
      !k.startsWith("cf_") &&
      (/[ #?()*\/]/.test(k) || k === k.toUpperCase() || /^[A-Z]/.test(k)) &&
      !/^[a-z]/.test(k);
    const cat = {};
    for (const j of allJnJobs) {
      for (const [k, v] of Object.entries(j)) {
        if (!isFriendly(k)) continue;
        if (v === null || v === "" || (Array.isArray(v) && !v.length)) continue;
        if (!cat[k]) cat[k] = { count: 0, values: new Set() };
        cat[k].count++;
        let sv = v;
        if (typeof v === "object") sv = JSON.stringify(v).slice(0, 40);
        if (cat[k].values.size < 6) cat[k].values.add(String(sv).slice(0, 30));
      }
    }
    const out = Object.entries(cat)
      .map(([label, d]) => ({ label, count: d.count, sample_values: [...d.values] }))
      .sort((a, b) => b.count - a.count);
    return { statusCode: 200, body: JSON.stringify({ scanned: allJnJobs.length, fieldCount: out.length, fields: out }, null, 2) };
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