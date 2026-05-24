// netlify/functions/find-orphan-signings.js
//
// READ-ONLY diagnostic. Finds inspections signed in a date range that
// have NO matching JN job — i.e. records where the JN sync's first
// step (create the job) silently failed. Different from records that
// have a JN job but a missing jn_job_id back-write — those still
// exist on the JN side; orphans don't.
//
// USAGE:
//   GET /.netlify/functions/find-orphan-signings
//   GET /.netlify/functions/find-orphan-signings?from=2026-05-18&to=2026-05-25
//
// Default window = last 7 days. Dates are signed_at (exclusive `to`).
//
// Required env: JOBNIMBUS_API_KEY, VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY

const JN_BASE = "https://app.jobnimbus.com/api1";

exports.handler = async (event) => {
  const JN_KEY = process.env.JOBNIMBUS_API_KEY;
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
  const missing = [];
  if (!JN_KEY) missing.push("JOBNIMBUS_API_KEY");
  if (!SB_URL) missing.push("VITE_SUPABASE_URL");
  if (!SB_KEY) missing.push("VITE_SUPABASE_ANON_KEY");
  if (missing.length) return json(500, { ok: false, error: `Missing env: ${missing.join(", ")}` });

  const qs = event.queryStringParameters || {};
  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const from = qs.from || sevenDaysAgo.toISOString().slice(0, 10);
  const to = qs.to || new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const sbHeaders = {
    apikey: SB_KEY,
    Authorization: `Bearer ${SB_KEY}`,
  };
  const jnHeaders = {
    Authorization: `bearer ${JN_KEY}`,
    "Content-Type": "application/json",
  };

  // 1. Pull every inspection signed in the window. Excludes cancelled
  //    rows (those don't show in the inspector view, and we shouldn't
  //    count them as missing-from-JN — they're voided drafts).
  const cols = "id,client_name,city,sales_rep_name,signed_at,result,jn_job_id,address,zip,cancelled_at";
  const sbUrl = `${SB_URL}/rest/v1/inspections?signed_at=gte.${from}&signed_at=lt.${to}&cancelled_at=is.null&select=${cols}&order=signed_at.desc`;
  const sbRes = await fetch(sbUrl, { headers: sbHeaders });
  if (!sbRes.ok) {
    return json(500, { ok: false, error: `Supabase: ${(await sbRes.text()).slice(0, 300)}` });
  }
  const signings = await sbRes.json();

  // 2. Pull JN jobs whose date_start (Sold Date) falls in the window.
  //    Previously this used date_updated which floated old jobs to the
  //    top whenever they were touched, blowing past the 2000-row
  //    safety cap with status-change noise and starving the cap of
  //    actual sold-this-week jobs. date_start moves only at sign time,
  //    so the result set is ~one row per signing — no noise, well
  //    under the cap.
  const fromUnix = Math.floor(new Date(`${from}T00:00:00Z`).getTime() / 1000) - 86400;
  const toUnix = Math.floor(new Date(`${to}T00:00:00Z`).getTime() / 1000) + 86400;
  const jnJobs = [];
  let pageFrom = 0;
  const PAGE_SIZE = 100;
  for (let safety = 0; safety < 30; safety++) {
    const url = `${JN_BASE}/jobs?size=${PAGE_SIZE}&from=${pageFrom}&sort=-date_start&date_start_after=${fromUnix}&date_start_before=${toUnix}`;
    const r = await fetch(url, { headers: jnHeaders });
    if (!r.ok) break;
    const body = await r.json().catch(() => ({}));
    const page = body.results || body.jobs || body.items || [];
    jnJobs.push(...page);
    if (page.length < PAGE_SIZE) break;
    pageFrom += PAGE_SIZE;
  }

  // 3. Build a lowercased name index for fast client-side matching.
  const jnByName = jnJobs.map((j) => ({
    jnid: j.jnid || j.id,
    name: j.name || "",
    nameLower: (j.name || "").toLowerCase(),
    date_start: j.date_start,
  }));

  // Max time delta between Supabase signed_at and JN date_start for a
  // name-based match to count as "the same record." Real syncs land in
  // 5-15 seconds; padding to 60 minutes covers retry / delayed-sync
  // edges while still cleanly rejecting unrelated old JN jobs of the
  // same person (e.g. Sue fox's months-old job that the prior scan
  // false-matched against a fresh 5/22 signing).
  const TIME_TOLERANCE_MS = 60 * 60 * 1000;

  function findJnFor(signing) {
    if (signing.jn_job_id) {
      const direct = jnByName.find((j) => j.jnid === signing.jn_job_id);
      if (direct) return { match: direct, reason: "linked by jn_job_id" };
    }
    const name = (signing.client_name || "").trim();
    if (!name) return null;
    const parts = name.split(/\s+/).filter(Boolean);
    const firstName = (parts[0] || "").toLowerCase();
    const lastName = (parts[parts.length - 1] || "").toLowerCase();
    if (lastName.length < 2) return null;
    // Strict: job name must contain the last name.
    let cands = jnByName.filter((j) => j.nameLower.includes(lastName));
    // Tighten by first name if any survivor has it.
    if (firstName && firstName !== lastName) {
      const tight = cands.filter((j) => j.nameLower.includes(firstName));
      if (tight.length > 0) cands = tight;
    }
    if (cands.length === 0) return null;
    // Final filter: the JN job's date_start must be within tolerance
    // of the Supabase signed_at. Without this, old JN records of the
    // same person false-match recent signings.
    const signedMs = signing.signed_at ? new Date(signing.signed_at).getTime() : null;
    if (signedMs == null || Number.isNaN(signedMs)) {
      return { match: cands[0], reason: `name match, no signed_at to compare (${cands.length})` };
    }
    const inWindow = cands
      .map((c) => ({
        c,
        deltaMs: c.date_start ? Math.abs(c.date_start * 1000 - signedMs) : Number.POSITIVE_INFINITY,
      }))
      .filter((x) => x.deltaMs <= TIME_TOLERANCE_MS)
      .sort((a, b) => a.deltaMs - b.deltaMs);
    if (inWindow.length === 0) {
      return null;
    }
    const best = inWindow[0];
    const deltaSec = Math.round(best.deltaMs / 1000);
    return { match: best.c, reason: `name + time match (${cands.length} name candidate${cands.length === 1 ? "" : "s"}, Δ${deltaSec}s)` };
  }

  const checked = signings.map((s) => {
    const m = findJnFor(s);
    if (m) return { signing: s, in_jn: true, reason: m.reason, matched_jnid: m.match.jnid };
    return { signing: s, in_jn: false, reason: "no JN match in window" };
  });

  const orphans = checked
    .filter((c) => c.in_jn === false)
    .map((c) => ({
      client_name: c.signing.client_name,
      city: c.signing.city,
      sales_rep_name: c.signing.sales_rep_name,
      signed_at: c.signing.signed_at,
      result: c.signing.result,
      address: c.signing.address,
      zip: c.signing.zip,
      inspection_id: c.signing.id,
    }));

  // Compact per-signing list — one line per record so you can eyeball
  // against a CSV pulled from JN. Sorted by signed_at desc.
  const all = checked
    .map((c) => ({
      client_name: c.signing.client_name,
      city: c.signing.city,
      signed_at: c.signing.signed_at,
      result: c.signing.result,
      sales_rep: c.signing.sales_rep_name,
      in_jn: c.in_jn,
      jnid: c.matched_jnid || c.signing.jn_job_id || null,
    }))
    .sort((a, b) => (b.signed_at || "").localeCompare(a.signed_at || ""));

  return json(200, {
    ok: true,
    window: { from, to },
    summary: {
      total_signings: signings.length,
      already_linked: checked.filter((c) => c.in_jn === true && c.reason === "linked by jn_job_id").length,
      matched_by_name: checked.filter((c) => c.in_jn === true && c.reason !== "linked by jn_job_id").length,
      orphans: orphans.length,
      jn_jobs_scanned: jnJobs.length,
    },
    orphans,
    all,
  });
};

function json(status, body) {
  return {
    statusCode: status,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}
