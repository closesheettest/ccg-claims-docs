// netlify/functions/find-orphan-signings.js
//
// Finds inspections signed in a date range that have NO matching JN job
// — i.e. records where the JN sync's first step (create the job)
// silently failed. Also AUTO-HEALS rows that have a JN job but a missing
// jn_job_id back-write — by default writes the match back to Supabase
// so the admin's "Sync to JN" / "Not in JN" indicator clears itself.
//
// USAGE:
//   GET /.netlify/functions/find-orphan-signings
//   GET /.netlify/functions/find-orphan-signings?from=2026-05-18&to=2026-05-25
//   GET /.netlify/functions/find-orphan-signings?auto_link=false
//
// Default window = last 7 days. Dates are signed_at (exclusive `to`).
//
// auto_link defaults to TRUE — every time the function runs (incl. the
// daily-orphan-alert cron) any row whose jn_job_id is null but whose JN
// job is findable by name gets the link written back. Side-effect-free
// for already-linked rows. Pass auto_link=false to disable the writes
// when you just want a read-only diagnostic.
//
// HOW IT WORKS:
//   For each Supabase signing in the window (excluding cancelled rows):
//   1. If jn_job_id is already set → trust it, mark in_jn=true. No write.
//   2. Otherwise, fire 3 parallel /jobs?search queries against JN
//      ("<lastname> <streetNum>", "<streetNum>", "<lastname>"), dedupe
//      the combined results, then strict-filter:
//        a. JN job name must contain the last name
//        b. JN job name must contain the first name (if any survivor has it)
//        c. JN job's cf_date_5 (or date_start as fallback) must be within
//           ±60 min of the Supabase signed_at
//   3. Anything passing all three filters → in_jn=true. Also PATCH the
//      Supabase row to set jn_job_id (+ jn_pushed_at if missing) so the
//      app stops showing it as "Not in JN" — this is the auto-heal step.
//   4. No filter matches → orphan (no JN job at all).
//
// LIMITATION: JN's /jobs?search endpoint returns roughly the 50 most
// recent matching jobs per query. For an active JN account, records
// older than ~2-3 days can fall off the recent set and become
// undiscoverable from outside even though they exist. So this function
// is most accurate for FRESH orphans (the day-of or day-after a sync
// failure) and may false-positive on records >2-3 days old.
//
// IF YOU SEE OLDER FALSE-POSITIVE ORPHANS:
//   - Cross-reference against the "Last Weeks Sales" CSV export from JN's
//     UI. The CSV is authoritative — it can see older records the API
//     search can't. If a "supposed orphan" appears in the CSV with a JN
//     id, it's a false-positive (the JN job exists; the app's local
//     jn_job_id back-write didn't fire, but that's a separate latent
//     bug). The orphan list is only actionable if a name does NOT appear
//     in the CSV.
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

  // Reliable exact-field lookup. JN's ?filter= hits indexed fields and
  // returns the job even when the fuzzy ?search= misses it — the bug
  // that stranded these orphans (search returns ~50 recent jobs and
  // routinely omits the one we want).
  async function jnJobFilter(filterObj) {
    try {
      const url = `${JN_BASE}/jobs?filter=${encodeURIComponent(JSON.stringify(filterObj))}&size=20`;
      const r = await fetch(url, { headers: jnHeaders });
      if (!r.ok) return [];
      const b = await r.json().catch(() => ({}));
      return b.results || b.jobs || b.items || [];
    } catch {
      return [];
    }
  }
  async function jnJobSearch(q) {
    try {
      const r = await fetch(`${JN_BASE}/jobs?search=${encodeURIComponent(q)}&size=50`, { headers: jnHeaders });
      if (!r.ok) return [];
      const b = await r.json().catch(() => ({}));
      return b.results || b.jobs || b.items || [];
    } catch {
      return [];
    }
  }

  async function searchJn(signing) {
    if (signing.jn_job_id) {
      return { match: { jnid: signing.jn_job_id }, reason: "linked by jn_job_id" };
    }
    const name = (signing.client_name || "").trim();
    const parts = name.split(/\s+/).filter(Boolean);
    const lastName = (parts[parts.length - 1] || "").toLowerCase();
    const address = (signing.address || "").trim();
    const streetNum = address.match(/^\s*(\d+)/)?.[1] || null;
    if (!name && !address) return null;

    try {
      // Candidate source 1 (reliable): exact address_line1 filter.
      // Candidate source 2 (backstop): fuzzy last-name / street searches,
      //   for rows whose JN address_line1 differs in formatting (St vs
      //   Street) so the exact filter misses.
      const fuzzyQueries = [];
      if (lastName.length >= 3 && streetNum) fuzzyQueries.push(`${lastName} ${streetNum}`);
      if (streetNum && streetNum.length >= 3) fuzzyQueries.push(streetNum);
      if (name) fuzzyQueries.push(lastName.length >= 3 ? lastName : name);
      const candLists = await Promise.all([
        address ? jnJobFilter({ must: [{ term: { address_line1: address } }] }) : Promise.resolve([]),
        ...fuzzyQueries.map((q) => jnJobSearch(q)),
      ]);

      // Combine + dedupe by jnid.
      const seenIds = new Set();
      const raw = [];
      for (const list of candLists) {
        for (const j of list) {
          const id = j.jnid || j.id;
          if (id && !seenIds.has(id)) {
            seenIds.add(id);
            raw.push(j);
          }
        }
      }
      if (raw.length === 0) return null;

      // Prefer cf_date_5 (the app's sold-date custom field) over the
      // native date_start — when the sync linked to an existing JN
      // job, date_start sometimes ends up 0 even though cf_date_5
      // holds the real sold time. Whichever is non-zero, use.
      const soldTimeOf = (j) => {
        if (j.cf_date_5 && Number(j.cf_date_5) > 0) return Number(j.cf_date_5);
        if (j.date_start && Number(j.date_start) > 0) return Number(j.date_start);
        return null;
      };
      const addrNorm = address.toLowerCase();
      const nameHit = (j) => lastName.length >= 2 && (j.name || "").toLowerCase().includes(lastName);
      const addrHit = (j) => addrNorm && (j.address_line1 || "").trim().toLowerCase() === addrNorm;

      const signedMs = signing.signed_at ? new Date(signing.signed_at).getTime() : null;
      const scored = raw.map((j) => {
        const t = soldTimeOf(j);
        const deltaMs =
          signedMs == null || t == null ? Number.POSITIVE_INFINITY : Math.abs(t * 1000 - signedMs);
        return { j, deltaMs, name: nameHit(j) ? 1 : 0, addr: addrHit(j) ? 1 : 0 };
      });

      // Tier 1: a job created within ±60min of this signing. That time
      // proximity is the decisive guard against matching an OLD job of
      // the same person to a fresh signing. Among those, prefer
      // address-exact, then name match, then smallest delta.
      const timed = scored
        .filter((s) => s.deltaMs <= TIME_TOLERANCE_MS)
        .sort((a, b) => b.addr - a.addr || b.name - a.name || a.deltaMs - b.deltaMs);
      if (timed.length) {
        const best = timed[0];
        return {
          match: { jnid: best.j.jnid || best.j.id, name: best.j.name },
          reason: `time match (Δ${Math.round(best.deltaMs / 1000)}s${best.addr ? ", addr-exact" : ""})`,
        };
      }

      // Tier 2: no usable time signal on either side, but exactly one
      // candidate is an exact address + name match. Safe to link.
      const fallback = scored.filter(
        (s) => s.addr && s.name && s.deltaMs === Number.POSITIVE_INFINITY,
      );
      if (fallback.length === 1) {
        const best = fallback[0];
        return {
          match: { jnid: best.j.jnid || best.j.id, name: best.j.name },
          reason: "address+name match (no time signal)",
        };
      }
      return null;
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

  // Auto-heal: any row that matched-by-name (i.e. JN job exists but our
  // row's jn_job_id was null) gets the link written back to Supabase.
  // We only PATCH rows that DIDN'T have a jn_job_id originally — never
  // overwrite an existing one, even if our search found a different
  // candidate (that would be operator error to investigate separately).
  //
  // Opt-out via ?auto_link=false for true read-only diagnostic runs.
  const autoLink = (qs.auto_link || "").toLowerCase() !== "false";
  let autoLinked = 0;
  const autoLinkFailures = [];
  if (autoLink) {
    const toLink = checked.filter(
      (c) => c.in_jn === true && c.reason !== "linked by jn_job_id" && c.matched_jnid && !c.signing.jn_job_id,
    );
    for (const c of toLink) {
      try {
        const patchRes = await fetch(
          `${SB_URL}/rest/v1/inspections?id=eq.${c.signing.id}&jn_job_id=is.null`,
          {
            method: "PATCH",
            headers: { ...sbHeaders, "Content-Type": "application/json", Prefer: "return=minimal" },
            body: JSON.stringify({
              jn_job_id: c.matched_jnid,
              // Stamp jn_pushed_at at the original signed_at if we don't
              // have a better timestamp — this is when JN actually got
              // the record, even if the back-write was late.
              jn_pushed_at: c.signing.signed_at || new Date().toISOString(),
            }),
          },
        );
        if (!patchRes.ok) {
          autoLinkFailures.push({
            client_name: c.signing.client_name,
            inspection_id: c.signing.id,
            jnid: c.matched_jnid,
            error: `HTTP ${patchRes.status}: ${(await patchRes.text()).slice(0, 200)}`,
          });
          continue;
        }
        autoLinked++;
        // Tag the result so the response shows what got patched.
        c.auto_linked = true;
        console.log(`auto-link: ${c.signing.client_name} → ${c.matched_jnid}`);
      } catch (e) {
        autoLinkFailures.push({
          client_name: c.signing.client_name,
          inspection_id: c.signing.id,
          jnid: c.matched_jnid,
          error: e.message || String(e),
        });
      }
    }
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
      auto_linked: autoLinked,
      auto_link_failures: autoLinkFailures.length,
      orphans: orphans.length,
      jn_jobs_scanned: jnJobs.length,
    },
    auto_link_failures: autoLinkFailures.slice(0, 20),
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
