// netlify/functions/clear-retail-date-start.js
//
// One-off bulk fix: clear date_start on the JN jobs created from the
// 5/22-5/23/26 batch of Retail-result inspections. Earlier sync code
// pinned date_start to the sold date even when the inspection swapped
// to Retail — the "new this week" reports were picking those up. This
// function nulls date_start on the matching jobs so the reports skip
// them. The forward fix lives in process-retail-result.js.
//
// USAGE:
//   GET  /.netlify/functions/clear-retail-date-start              → dry run
//   POST /.netlify/functions/clear-retail-date-start?go=1         → actually update
//
// Returns per-row outcome: matched JN job id, before/after date_start,
// or "not found" / "skipped" with a reason. Dry-run mode does the
// lookup but never PUTs.
//
// Required env: JOBNIMBUS_API_KEY

const JN_BASE = "https://app.jobnimbus.com/api1";

// Names captured from the spreadsheet the user pasted. Match against
// JN job names by case-insensitive substring on the full name (JN
// names look like "Paul Alphonse - 123 Main St, Orlando FL"). City is
// kept as a secondary signal — if multiple jobs match the name, we
// prefer the one whose city/address contains this string.
const TARGETS = [
  { name: "Paul Alphonse",       city: "Orlando" },
  { name: "Christopher Zepeda",  city: "Ruskin" },
  { name: "Paul Guzman",         city: "Ruskin" },
  { name: "Gary Ramella",        city: "Ruskin" },
  { name: "Felicia Price",       city: "Tampa" },
  { name: "Ariel Alvarez",       city: "West Park" },
  { name: "Claudia Madsen",      city: "Summerfield" },
  { name: "Ariel Alvarez Perez", city: "West Park" },
  { name: "Gerard Senor",        city: "Sunrise" },
  { name: "Charles Owens",       city: "Summerfield" },
  { name: "Bridgette Johnson",   city: "Sunrise" },
  { name: "Rainer Jakob",        city: "Inverness" },
  { name: "Willine Arnold",      city: "Palmetto" },
  { name: "Stephen Shreim",      city: "Sunrise" },
  { name: "Arlette Direny",      city: "Sunrise" },
  { name: "Jane Ann Davis",      city: "Summerfield" },
  { name: "Lakesha Jordan",      city: "Tampa" },
  { name: "David Callow",        city: "Inverness" },
  { name: "Gayla Hence",         city: "Inverness" },
  { name: "Avlon Flax",          city: "Palmetto" },
];

exports.handler = async (event) => {
  const JN_KEY = process.env.JOBNIMBUS_API_KEY;
  if (!JN_KEY) return json(500, { ok: false, error: "JOBNIMBUS_API_KEY not set" });

  // GET = dry run; POST with ?go=1 = real run. Belt + suspenders so a
  // stray browser GET can't blow up data.
  const qs = new URLSearchParams(event.rawQuery || (event.queryStringParameters
    ? new URLSearchParams(event.queryStringParameters).toString()
    : ""));
  const dryRun = !(event.httpMethod === "POST" && qs.get("go") === "1");

  const headers = {
    Authorization: `bearer ${JN_KEY}`,
    "Content-Type": "application/json",
  };

  const results = [];

  for (const target of TARGETS) {
    const result = { target, matched: null, action: null, error: null };
    try {
      // Look up the JN job. Search by name — JN's job-search endpoint
      // takes a `name` query (substring match). We page through up to
      // 50 hits; if there's more than one we disambiguate by city.
      const searchUrl = `${JN_BASE}/jobs?size=50&filter=${encodeURIComponent(
        JSON.stringify({
          must: [{ match: { name: target.name } }],
        }),
      )}`;
      const sRes = await fetch(searchUrl, { headers });
      let jobs = [];
      if (sRes.ok) {
        const body = await sRes.json().catch(() => ({}));
        jobs = body.results || body.jobs || body.items || [];
      } else {
        // Fallback: brute scan recent jobs and filter by name.
        const scanRes = await fetch(`${JN_BASE}/jobs?size=100`, { headers });
        if (scanRes.ok) {
          const sb = await scanRes.json().catch(() => ({}));
          const all = sb.results || sb.jobs || sb.items || [];
          const needle = target.name.toLowerCase();
          jobs = all.filter((j) => (j.name || "").toLowerCase().includes(needle));
        }
      }

      if (!jobs.length) {
        result.error = "no matching JN job found";
        results.push(result);
        continue;
      }

      // Prefer jobs whose name OR address contains the target city.
      const cityLc = target.city.toLowerCase();
      const cityMatch = jobs.find((j) =>
        (j.name || "").toLowerCase().includes(cityLc) ||
        (j.city || j.address_line1 || "").toLowerCase().includes(cityLc),
      );
      const job = cityMatch || jobs[0];
      const jobId = job.jnid || job.id;
      result.matched = {
        jn_job_id: jobId,
        name: job.name,
        city: job.city || null,
        cf_string_34: job.cf_string_34 || null,
        date_start_before: job.date_start ?? null,
        date_start_iso_before: unixToIso(job.date_start),
        ambiguous: jobs.length > 1 && !cityMatch,
        candidate_count: jobs.length,
      };

      if (job.date_start == null) {
        result.action = "skipped (date_start already empty)";
        results.push(result);
        continue;
      }

      if (dryRun) {
        result.action = "WOULD clear date_start (dry run)";
        results.push(result);
        continue;
      }

      // PUT date_start: null
      const putRes = await fetch(`${JN_BASE}/jobs/${jobId}`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ jnid: jobId, date_start: null }),
      });
      if (!putRes.ok) {
        result.error = `JN PUT failed (${putRes.status}): ${(await putRes.text()).slice(0, 200)}`;
        results.push(result);
        continue;
      }
      result.action = "cleared date_start";
    } catch (e) {
      result.error = e.message;
    }
    results.push(result);
  }

  const summary = {
    dry_run: dryRun,
    total_targets: TARGETS.length,
    matched: results.filter((r) => r.matched).length,
    cleared: results.filter((r) => r.action === "cleared date_start").length,
    would_clear: results.filter((r) => r.action === "WOULD clear date_start (dry run)").length,
    skipped_already_empty: results.filter((r) => r.action?.startsWith("skipped")).length,
    not_found: results.filter((r) => r.error === "no matching JN job found").length,
    errors: results.filter((r) => r.error && r.error !== "no matching JN job found").length,
  };

  return json(200, { ok: true, summary, results });
};

function unixToIso(secs) {
  if (secs == null || secs === 0) return null;
  const n = Number(secs);
  if (!Number.isFinite(n)) return null;
  return new Date(n * 1000).toISOString();
}

function json(status, body) {
  return {
    statusCode: status,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}
