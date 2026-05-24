// netlify/functions/clear-retail-date-start.js
//
// Bulk backfill: for the 5/22-5/23/26 batch of 20 PA-signed records,
// find each one's JN job and write the JN job id onto its
// inspections.jn_job_id column. The JN sync that ran when these were
// signed succeeded in creating the JN job, but the follow-up PATCH on
// the inspection row (App.jsx ~line 5953) silently didn't persist, so
// all 20 inspections are sitting with jn_job_id = null and the
// downstream Retail-swap fix can't find them when the inspector
// eventually classifies the roof.
//
// (File name still says "clear-retail-date-start" because the URL is
// already in the user's shell history — original purpose changed once
// diagnostics revealed the records are pre-inspection, not Retail.)
//
// USAGE:
//   GET  /.netlify/functions/clear-retail-date-start            → dry run
//   POST /.netlify/functions/clear-retail-date-start?go=1       → actually PATCH
//
// Per-target output:
//   - matched: JN job info + chosen inspection row
//   - action: what was done (or would be done in dry run) / skip reason
//   - error: per-target failure message, if any
//
// Required env: JOBNIMBUS_API_KEY, VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY

const JN_BASE = "https://app.jobnimbus.com/api1";

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

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
  if (!SB_URL || !SB_KEY) return json(500, { ok: false, error: "Supabase env not set" });
  const sbHeaders = {
    apikey: SB_KEY,
    Authorization: `Bearer ${SB_KEY}`,
  };
  const sbWriteHeaders = {
    ...sbHeaders,
    "Content-Type": "application/json",
    Prefer: "return=representation",
  };

  // GET = dry run. POST ?go=1 = real run. Belt + suspenders so a
  // stray browser GET can't write to either system.
  const qs = new URLSearchParams(event.rawQuery || (event.queryStringParameters
    ? new URLSearchParams(event.queryStringParameters).toString()
    : ""));
  const dryRun = !(event.httpMethod === "POST" && qs.get("go") === "1");

  const jnHeaders = {
    Authorization: `bearer ${JN_KEY}`,
    "Content-Type": "application/json",
  };

  const results = [];

  for (const target of TARGETS) {
    const result = { target, matched: null, inspection: null, action: null, error: null };
    try {
      // === Step 1: find the JN job by name ===
      const parts = target.name.split(/\s+/).filter(Boolean);
      const firstName = (parts[0] || "").toLowerCase();
      const lastName = (parts[parts.length - 1] || "").toLowerCase();
      const searchTerm = lastName.length >= 3 ? lastName : target.name;
      const sr = await fetch(`${JN_BASE}/jobs?search=${encodeURIComponent(searchTerm)}&size=50`, { headers: jnHeaders });
      const raw = sr.ok ? (await sr.json().catch(() => ({}))).results || [] : [];
      // Post-filter: last name must literally appear in the job name.
      let jobs = raw.filter((j) => (j.name || "").toLowerCase().includes(lastName));
      if (firstName && firstName !== lastName) {
        const tight = jobs.filter((j) => (j.name || "").toLowerCase().includes(firstName));
        if (tight.length > 0) jobs = tight;
      }
      if (!jobs.length) {
        result.error = "no matching JN job found";
        results.push(result);
        continue;
      }
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
        date_start: job.date_start ?? null,
        date_start_iso: unixToIso(job.date_start),
        cf_string_34: job.cf_string_34 || null,
      };

      // === Step 2: find the inspection row in Supabase by name ===
      const cols = "id,client_name,jn_job_id,result,signed_at,city";
      const ir = await fetch(
        `${SB_URL}/rest/v1/inspections?client_name=ilike.${encodeURIComponent(`%${target.name}%`)}&select=${cols}&limit=10`,
        { headers: sbHeaders },
      );
      const rows = ir.ok ? (await ir.json().catch(() => [])) : [];
      if (rows.length === 0) {
        result.error = "no matching inspections row found in Supabase";
        results.push(result);
        continue;
      }
      // Pick the inspection whose signed_at is closest to the JN job's
      // date_start (handles the dup-signing case — e.g. Rainer Jakob
      // signed twice; only the later signing produced the JN job).
      const jnTs = (job.date_start || 0) * 1000;
      const candidates = rows.map((r) => ({
        ...r,
        delta_ms: r.signed_at ? Math.abs(new Date(r.signed_at).getTime() - jnTs) : Number.POSITIVE_INFINITY,
      }));
      candidates.sort((a, b) => a.delta_ms - b.delta_ms);
      const insp = candidates[0];
      result.inspection = {
        id: insp.id,
        client_name: insp.client_name,
        city: insp.city,
        signed_at: insp.signed_at,
        jn_job_id_before: insp.jn_job_id,
        delta_seconds: Number.isFinite(insp.delta_ms) ? Math.round(insp.delta_ms / 1000) : null,
        other_candidates: candidates.slice(1).map((c) => ({
          id: c.id,
          signed_at: c.signed_at,
          delta_seconds: Number.isFinite(c.delta_ms) ? Math.round(c.delta_ms / 1000) : null,
        })),
      };

      // === Step 3: decide action ===
      if (insp.jn_job_id === jobId) {
        result.action = "skipped (already linked)";
        results.push(result);
        continue;
      }
      if (insp.jn_job_id && insp.jn_job_id !== jobId) {
        result.action = `skipped (inspection already linked to a DIFFERENT jn job ${insp.jn_job_id})`;
        results.push(result);
        continue;
      }
      if (dryRun) {
        result.action = `WOULD link inspection ${insp.id} → jn_job_id ${jobId}`;
        results.push(result);
        continue;
      }

      // === Step 4: PATCH inspections.jn_job_id ===
      const patchRes = await fetch(
        `${SB_URL}/rest/v1/inspections?id=eq.${encodeURIComponent(insp.id)}`,
        {
          method: "PATCH",
          headers: sbWriteHeaders,
          body: JSON.stringify({ jn_job_id: jobId }),
        },
      );
      if (!patchRes.ok) {
        result.error = `Supabase PATCH failed (${patchRes.status}): ${(await patchRes.text()).slice(0, 200)}`;
        results.push(result);
        continue;
      }
      result.action = `linked inspection ${insp.id} → jn_job_id ${jobId}`;
    } catch (e) {
      result.error = e.message;
    }
    results.push(result);
  }

  const summary = {
    dry_run: dryRun,
    total_targets: TARGETS.length,
    matched_jn: results.filter((r) => r.matched).length,
    matched_inspection: results.filter((r) => r.inspection).length,
    would_link: results.filter((r) => (r.action || "").startsWith("WOULD link")).length,
    linked: results.filter((r) => (r.action || "").startsWith("linked")).length,
    already_linked: results.filter((r) => r.action === "skipped (already linked)").length,
    skipped_other: results.filter((r) => (r.action || "").startsWith("skipped (inspection already linked to a DIFFERENT")).length,
    no_jn_match: results.filter((r) => r.error === "no matching JN job found").length,
    no_insp_match: results.filter((r) => r.error === "no matching inspections row found in Supabase").length,
    errors: results.filter((r) => r.error && !["no matching JN job found", "no matching inspections row found in Supabase"].includes(r.error)).length,
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
