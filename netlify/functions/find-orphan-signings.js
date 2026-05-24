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

  // 2. Per-signing JN lookup. JN's /jobs?search returns the 50 most
  //    recent jobs that match the term (approximately) — we then
  //    strict-filter on last name + first name + date_start time
  //    tolerance to decide if any of them is the same record as our
  //    Supabase signing. Concurrency-limited so 50+ records finish
  //    inside Netlify's 10-second function timeout.
  //
  //    Why this over a batch scan: JN's account-wide /jobs scan can
  //    blow past any safety cap with old / unrelated jobs (date_updated
  //    floats touched-today old jobs to the top; date_start_after/before
  //    filters don't work). Per-name search lets us trust JN's own
  //    relevance ranking for the search term, then we just need to
  //    confirm time + name match client-side.
  const TIME_TOLERANCE_MS = 60 * 60 * 1000;

  async function searchJn(signing) {
    if (signing.jn_job_id) {
      return { match: { jnid: signing.jn_job_id }, reason: "linked by jn_job_id" };
    }
    const name = (signing.client_name || "").trim();
    if (!name) return null;
    const parts = name.split(/\s+/).filter(Boolean);
    const firstName = (parts[0] || "").toLowerCase();
    const lastName = (parts[parts.length - 1] || "").toLowerCase();
    if (lastName.length < 2) return null;
    const term = lastName.length >= 3 ? lastName : name;
    try {
      const r = await fetch(`${JN_BASE}/jobs?search=${encodeURIComponent(term)}&size=50`, { headers: jnHeaders });
      if (!r.ok) return null;
      const body = await r.json().catch(() => ({}));
      const raw = body.results || body.jobs || body.items || [];
      // Strict: job name must contain the last name.
      let cands = raw.filter((j) => (j.name || "").toLowerCase().includes(lastName));
      // Tighten by first name if any survivor has it.
      if (firstName && firstName !== lastName) {
        const tight = cands.filter((j) => (j.name || "").toLowerCase().includes(firstName));
        if (tight.length > 0) cands = tight;
      }
      if (cands.length === 0) return null;
      // Time match: JN's date_start must be within ±60 min of signed_at.
      // Kills the false-positive case where an old job of the same
      // person gets matched to a fresh signing.
      const signedMs = signing.signed_at ? new Date(signing.signed_at).getTime() : null;
      if (signedMs == null || Number.isNaN(signedMs)) {
        return { match: cands[0], reason: `name match, no signed_at to compare (${cands.length})` };
      }
      const ranked = cands
        .map((c) => ({
          c,
          deltaMs: c.date_start ? Math.abs(c.date_start * 1000 - signedMs) : Number.POSITIVE_INFINITY,
        }))
        .filter((x) => x.deltaMs <= TIME_TOLERANCE_MS)
        .sort((a, b) => a.deltaMs - b.deltaMs);
      if (ranked.length === 0) return null;
      const best = ranked[0];
      return {
        match: { jnid: best.c.jnid || best.c.id, name: best.c.name, date_start: best.c.date_start },
        reason: `name + time match (Δ${Math.round(best.deltaMs / 1000)}s)`,
      };
    } catch (e) {
      return { error: e.message };
    }
  }

  // Process in batches of 8 concurrent JN calls.
  const CONCURRENCY = 8;
  const checked = [];
  for (let i = 0; i < signings.length; i += CONCURRENCY) {
    const batch = signings.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map(async (s) => {
      const m = await searchJn(s);
      if (m && m.match) return { signing: s, in_jn: true, reason: m.reason, matched_jnid: m.match.jnid };
      return { signing: s, in_jn: false, reason: m?.error ? `JN error: ${m.error}` : "no JN match in window" };
    }));
    checked.push(...results);
  }

  // jnJobs no longer collected — keep summary field shape stable but
  // expose 0 so callers know we switched approaches.
  const jnJobs = [];

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
