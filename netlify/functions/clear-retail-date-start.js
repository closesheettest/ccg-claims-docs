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

  // Supabase creds — used to look up the app-side inspection.result
  // for each matched JN job (so the dry-run shows both sides of the
  // sync). Failure to read isn't fatal; we just leave app_result null.
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
  const sbHeaders = SB_URL && SB_KEY ? {
    apikey: SB_KEY,
    Authorization: `Bearer ${SB_KEY}`,
  } : null;

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
      // Look up the JN job. JN's /jobs?search=<term> isn't a strict name
      // match — even when the term doesn't appear anywhere, it returns
      // the page's worth of recent jobs (every dry-run target came back
      // with 50 candidates). So we have to STRICTLY post-filter on the
      // last name (must literally appear in the job's name string), and
      // require the first name too when present to avoid the
      // same-last-name and same-city collisions.
      const parts = target.name.split(/\s+/).filter(Boolean);
      const firstName = (parts[0] || "").toLowerCase();
      const lastName = (parts[parts.length - 1] || "").toLowerCase();
      async function tryJnSearch(term) {
        const r = await fetch(`${JN_BASE}/jobs?search=${encodeURIComponent(term)}&size=50`, { headers });
        if (!r.ok) return [];
        const body = await r.json().catch(() => ({}));
        return body.results || body.jobs || body.items || [];
      }
      // Query by the more-distinctive last name. JN's search may still
      // return noise, but it's at least biased toward our intended hit.
      const raw = await tryJnSearch(lastName.length >= 3 ? lastName : target.name);
      // Strict filter: the JN job's name field must contain the LAST
      // name. Catches the false-positive case where /jobs?search just
      // returned 50 recent jobs unfiltered.
      let jobs = raw.filter((j) => (j.name || "").toLowerCase().includes(lastName));
      // If the target's first name is distinct and present in any of
      // the survivors, tighten further to those — guards against
      // "Zepeda" matching a different "Zepeda" who happens to be in JN.
      if (firstName && firstName !== lastName) {
        const tightened = jobs.filter((j) => (j.name || "").toLowerCase().includes(firstName));
        if (tightened.length > 0) jobs = tightened;
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

  // Enrich every matched row with the app-side inspection result
  // (one batched Supabase request — `in.(<id1>,<id2>,...)`).
  if (sbHeaders) {
    const jobIds = results
      .filter((r) => r.matched?.jn_job_id)
      .map((r) => r.matched.jn_job_id);
    if (jobIds.length > 0) {
      const inList = jobIds.map((id) => `"${id}"`).join(",");
      const url = `${SB_URL}/rest/v1/inspections?jn_job_id=in.(${encodeURIComponent(inList)})&select=jn_job_id,id,result,signed_at,client_name`;
      const debug = { url, status: null, row_count: null, sample: null, error: null };
      try {
        const r = await fetch(url, { headers: sbHeaders });
        debug.status = r.status;
        if (r.ok) {
          const rows = await r.json().catch(() => []);
          debug.row_count = Array.isArray(rows) ? rows.length : -1;
          debug.sample = (rows || []).slice(0, 2);
          const byJobId = new Map();
          for (const row of rows) byJobId.set(row.jn_job_id, row);
          for (const res of results) {
            if (!res.matched) continue;
            const row = byJobId.get(res.matched.jn_job_id);
            res.matched.app_result = row?.result ?? null;
            res.matched.app_inspection_id = row?.id ?? null;
            res.matched.app_signed_at = row?.signed_at ?? null;
          }
        } else {
          debug.error = (await r.text()).slice(0, 300);
          for (const res of results) {
            if (res.matched) res.matched.app_lookup_error = `Supabase ${r.status}`;
          }
        }
      } catch (e) {
        debug.error = e.message;
        for (const res of results) {
          if (res.matched) res.matched.app_lookup_error = e.message;
        }
      }
      // Diagnostic: probe each TARGET in the `claims` table by the
      // homeowner1 field (case-insensitive substring). PA agreements
      // live in `claims`; the JN job gets created when the PA is
      // signed and BEFORE any inspection row exists, so the absence
      // from inspections + presence in claims is the expected shape
      // for "Sit Sold Insp" stage. Read-only.
      if (sbHeaders) {
        // Sanity check first: can we read the claims table at all?
        try {
          const sUrl = `${SB_URL}/rest/v1/claims?select=id,homeowner1,address,city,signed_at,jn_job_id&limit=3`;
          const sr = await fetch(sUrl, { headers: sbHeaders });
          debug.claims_sanity = {
            status: sr.status,
            body: sr.ok ? await sr.json().catch(() => []) : (await sr.text()).slice(0, 300),
          };
        } catch (e) {
          debug.claims_sanity = { error: e.message };
        }

        // Per-target probes — capture status + body excerpt on failure.
        debug.claims_probes = [];
        for (const t of TARGETS) {
          const lastWord = t.name.split(/\s+/).pop();
          const probe = {
            target: t.name,
            by_full: null,
            by_full_status: null,
            by_full_err: null,
            by_last: null,
            by_last_status: null,
            by_last_err: null,
          };
          const cols = "id,homeowner1,homeowner2,address,city,state,zip,signed_at,jn_job_id";
          try {
            const u1 = `${SB_URL}/rest/v1/claims?or=(homeowner1.ilike.${encodeURIComponent(`%${t.name}%`)},homeowner2.ilike.${encodeURIComponent(`%${t.name}%`)})&select=${cols}&limit=3`;
            const r1 = await fetch(u1, { headers: sbHeaders });
            probe.by_full_status = r1.status;
            if (r1.ok) probe.by_full = await r1.json().catch(() => []);
            else probe.by_full_err = (await r1.text()).slice(0, 200);
          } catch (e) {
            probe.by_full_err = e.message;
          }
          if ((!probe.by_full || probe.by_full.length === 0) && lastWord && lastWord !== t.name) {
            try {
              const u2 = `${SB_URL}/rest/v1/claims?or=(homeowner1.ilike.${encodeURIComponent(`%${lastWord}%`)},homeowner2.ilike.${encodeURIComponent(`%${lastWord}%`)})&select=${cols}&limit=3`;
              const r2 = await fetch(u2, { headers: sbHeaders });
              probe.by_last_status = r2.status;
              if (r2.ok) probe.by_last = await r2.json().catch(() => []);
              else probe.by_last_err = (await r2.text()).slice(0, 200);
            } catch (e) {
              probe.by_last_err = e.message;
            }
          }
          debug.claims_probes.push(probe);
        }
      }
      // Tucked into a module-scoped slot so it surfaces in the
      // response (arrays don't keep arbitrary props through JSON).
      globalThis.__sbDebug = debug;
    }
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

  return json(200, { ok: true, summary, supabase_debug: globalThis.__sbDebug || null, results });
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
