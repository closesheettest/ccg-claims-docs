// netlify/functions/bulk-sync-orphans.js
//
// ONE-TIME CLEANUP FUNCTION — safe version with dry-run + strict matching
//
// USAGE:
//   1. DRY RUN (no writes):
//        https://<site>.netlify.app/.netlify/functions/bulk-sync-orphans?dryRun=true
//      Returns a JSON report showing what WOULD happen. Review every match.
//
//   2. APPLY (after reviewing dry run):
//        https://<site>.netlify.app/.netlify/functions/bulk-sync-orphans
//      Writes the matches to Supabase.
//
// SAFETY RULES:
//   • Only touches records where jn_job_id IS NULL (orphans). Already-linked
//     records are never modified.
//   • A match requires BOTH the homeowner name AND the address (ZIP or street
//     number) to align. Single-token matches on just a common last name are
//     rejected.
//   • Never overwrites an existing result — only writes if the Supabase `result`
//     column is still NULL.
//   • If JN's cf_string_34 is empty, only `jn_job_id` gets written. `result`
//     stays NULL and the record stays as Pending in the UI (correct behavior
//     for inspections that haven't happened yet).

const JN_BASE = "https://app.jobnimbus.com/api1";
const JN_KEY  = process.env.JOBNIMBUS_API_KEY;
const SB_URL  = process.env.VITE_SUPABASE_URL;
const SB_KEY  = process.env.VITE_SUPABASE_ANON_KEY;

const sbHeaders = {
  apikey: SB_KEY,
  Authorization: `Bearer ${SB_KEY}`,
  "Content-Type": "application/json",
};
const jnHeaders = {
  Authorization: `bearer ${JN_KEY}`,
  "Content-Type": "application/json",
};

// ── Name normalization ───────────────────────────────────────────
const normName = (s) => (s || "").toLowerCase().replace(/\s+/g, " ").trim();
const nameTokens = (s) => normName(s).split(" ").filter(t => t.length > 1);

// Two names are considered the "same person" only if every significant token
// in the shorter name also appears in the longer one AND both have at least
// 2 tokens (first+last). Rejects single-token matches.
function namesMatch(a, b) {
  const ta = nameTokens(a);
  const tb = nameTokens(b);
  if (ta.length < 2 || tb.length < 2) return false;
  const shorter = ta.length <= tb.length ? ta : tb;
  const longer  = ta.length <= tb.length ? tb : ta;
  return shorter.every(t => longer.some(lt => lt === t || lt.startsWith(t) || t.startsWith(lt)));
}

// JN names are usually "Jane Doe - 123 Main St [tag]" — return plausible name
// candidates (the full string and each piece split on common separators)
function extractJobNames(jnJobName) {
  if (!jnJobName) return [];
  const cleaned = jnJobName.replace(/\[.*?\]/g, "").trim();
  const pieces = [cleaned, ...cleaned.split(/\s[-\u2014|]\s/)].map(s => s.trim()).filter(Boolean);
  return pieces;
}

// ── Address normalization ────────────────────────────────────────
const extractZip = (s) => {
  const m = String(s || "").match(/\b(\d{5})(?:-\d{4})?\b/);
  return m ? m[1] : "";
};

const extractStreetNumber = (s) => {
  const m = String(s || "").trim().match(/^(\d+)\b/);
  return m ? m[1] : "";
};

// Require ZIP match if both sides have a ZIP; else fall back to street number.
// Never accept a match where neither side has a usable address signal.
function addressMatch(orphanRow, jnJob) {
  const orphanZip = (orphanRow.zip || "").trim();
  const jnAddress = jnJob.address_line1 || jnJob.display_name || jnJob.name || "";
  const jnZip = jnJob.zip || extractZip(jnAddress);

  if (orphanZip && jnZip) return orphanZip === jnZip;

  const orphanNum = extractStreetNumber(orphanRow.address);
  const jnNum = extractStreetNumber(jnAddress);
  if (orphanNum && jnNum) return orphanNum === jnNum;

  return false;
}

// ── Main handler ─────────────────────────────────────────────────
exports.handler = async (event) => {
  const params = event.queryStringParameters || {};
  const dryRun = params.dryRun === "true" || params.dryRun === "1";
  const mode = dryRun ? "DRY RUN" : "APPLY";
  console.log(`=== Bulk Sync Orphans: START [${mode}] ===`);

  const sbRes = await fetch(
    `${SB_URL}/rest/v1/inspections?jn_job_id=is.null&result=is.null&signed_at=not.is.null&select=id,client_name,address,city,state,zip,signed_at`,
    { headers: sbHeaders }
  );
  if (!sbRes.ok) {
    return { statusCode: 500, body: JSON.stringify({ error: "Supabase fetch failed", detail: await sbRes.text() }) };
  }
  const orphans = await sbRes.json();
  console.log("Orphans found:", orphans.length);
  if (orphans.length === 0) {
    return { statusCode: 200, body: JSON.stringify({ mode, message: "No orphans to sync", matched: 0 }) };
  }

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

  const paJobs = allJnJobs.filter(j =>
    j.record_type === 45 || j.record_type_name === "Lead" || j.record_type_name === "PA"
  );
  console.log("PA/Lead jobs:", paJobs.length);

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
  console.log("Full details fetched:", jobDetails.length);

  const resultMap = {
    "Damage": "damage",
    "No Damage": "no_damage",
    "Retail": "retail",
  };

  const details = [];
  let matched = 0;
  let wouldWriteResult = 0;
  let writtenOk = 0;

  for (const orphan of orphans) {
    const nameMatches = jobDetails.filter(job => {
      const candidates = extractJobNames(job.name);
      return candidates.some(c => namesMatch(c, orphan.client_name));
    });

    const goodMatches = nameMatches.filter(job => addressMatch(orphan, job));

    if (goodMatches.length === 0) {
      details.push({
        orphan: orphan.client_name,
        address: orphan.address,
        zip: orphan.zip,
        status: nameMatches.length > 0 ? "name_match_but_address_mismatch" : "no_jn_match",
        nameCandidatesSeen: nameMatches.slice(0, 3).map(m => m.name),
      });
      continue;
    }

    if (goodMatches.length > 1) {
      details.push({
        orphan: orphan.client_name,
        address: orphan.address,
        status: "ambiguous_multiple_matches",
        matches: goodMatches.map(m => ({ name: m.name, jnid: m.jnid || m.id })),
      });
      continue;
    }

    const match = goodMatches[0];
    const jnid = match.jnid || match.id;
    const jnResult = match.cf_string_34 || null;
    const uiResult = resultMap[jnResult] || null;

    const payload = { jn_job_id: jnid };
    if (jnResult) payload.inspection_result = jnResult;
    if (uiResult) {
      payload.result = uiResult;
      payload.result_at = new Date().toISOString();
    }

    const detail = {
      orphan: orphan.client_name,
      address: orphan.address,
      zip: orphan.zip,
      status: "match_found",
      jnName: match.name,
      jnid,
      willSet: {
        jn_job_id: jnid,
        result: uiResult || "(staying NULL — JN has no result yet)",
      },
    };

    if (dryRun) {
      matched++;
      if (uiResult) wouldWriteResult++;
      details.push(detail);
      continue;
    }

    // Defensive: the WHERE clause requires jn_job_id is still NULL, so even if
    // something else fills it between our fetch and now, we never clobber.
    const updRes = await fetch(
      `${SB_URL}/rest/v1/inspections?id=eq.${orphan.id}&jn_job_id=is.null`,
      {
        method: "PATCH",
        headers: { ...sbHeaders, Prefer: "return=minimal" },
        body: JSON.stringify(payload),
      }
    );

    if (updRes.ok) {
      matched++;
      writtenOk++;
      if (uiResult) wouldWriteResult++;
      details.push({ ...detail, status: "written" });
    } else {
      details.push({ ...detail, status: "write_failed", error: (await updRes.text()).slice(0, 200) });
    }
  }

  console.log(`=== [${mode}] matched ${matched}/${orphans.length}, results ${wouldWriteResult} ===`);

  return {
    statusCode: 200,
    body: JSON.stringify({
      mode,
      orphansFound: orphans.length,
      matched,
      unmatched: orphans.length - matched,
      resultsSet: wouldWriteResult,
      writtenToDatabase: dryRun ? 0 : writtenOk,
      details,
    }, null, 2),
  };
};