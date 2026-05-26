// netlify/functions/repair-clobbered-result-at.js
//
// One-time repair. inspection-checker had a bug (now fixed) where it
// would overwrite inspections.result_at with NOW any time it pulled
// the JN cf_string_34, even when the inspector had already classified
// via the app. That clobbered the inspector's original submission
// timestamp.
//
// Recovery: inspection_photos[].captured_at is set at submission time
// by inspector-submit-result.js and never touched by the checker. So
// the latest captured_at per record approximates the original
// submission time (within seconds — all photos go in together).
//
// USAGE:
//   GET  /.netlify/functions/repair-clobbered-result-at            → dry run
//   POST /.netlify/functions/repair-clobbered-result-at?go=1       → actually PATCH
//
// Only touches records where:
//   • result is set (classified inspection)
//   • inspection_photos has at least one entry with captured_at
//   • current result_at is more than CLOBBER_THRESHOLD_HOURS later
//     than the latest captured_at (clear evidence of overwrite)
//
// Required env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY

// If result_at is later than the latest captured_at by more than this,
// it's almost certainly a clobber. Submissions happen within seconds
// of photo uploads, so a 1-hour gap is well beyond any plausible
// legitimate delay (e.g., admin manually setting result much later).
const CLOBBER_THRESHOLD_HOURS = 1;

exports.handler = async (event) => {
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
  if (!SB_URL || !SB_KEY) {
    return json(500, { ok: false, error: "Supabase env not set" });
  }
  const sbHeaders = {
    apikey: SB_KEY,
    Authorization: `Bearer ${SB_KEY}`,
  };
  const sbWriteHeaders = {
    ...sbHeaders,
    "Content-Type": "application/json",
    Prefer: "return=representation",
  };

  const qs = new URLSearchParams(event.rawQuery || (event.queryStringParameters
    ? new URLSearchParams(event.queryStringParameters).toString()
    : ""));
  const dryRun = !(event.httpMethod === "POST" && qs.get("go") === "1");

  // Pull every classified inspection that has photos. We compare
  // result_at vs photo captured_at in JS since the comparison is
  // inside JSON.
  const url =
    `${SB_URL}/rest/v1/inspections` +
    `?result=not.is.null` +
    `&result_at=not.is.null` +
    `&inspection_photos=not.is.null` +
    `&cancelled_at=is.null` +
    `&select=id,client_name,result,result_at,inspection_photos&limit=500`;
  const r = await fetch(url, { headers: sbHeaders });
  if (!r.ok) {
    return json(500, { ok: false, error: `Supabase: ${(await r.text()).slice(0, 300)}` });
  }
  const rows = await r.json();

  const candidates = [];
  for (const row of rows) {
    const photos = Array.isArray(row.inspection_photos) ? row.inspection_photos : [];
    if (photos.length === 0) continue;
    // Pick the LATEST captured_at — that's closest to actual submission.
    let latestPhotoMs = null;
    for (const p of photos) {
      if (!p?.captured_at) continue;
      const ms = new Date(p.captured_at).getTime();
      if (!Number.isNaN(ms) && (latestPhotoMs == null || ms > latestPhotoMs)) {
        latestPhotoMs = ms;
      }
    }
    if (latestPhotoMs == null) continue;
    const resultMs = new Date(row.result_at).getTime();
    if (Number.isNaN(resultMs)) continue;
    const gapHours = (resultMs - latestPhotoMs) / (1000 * 60 * 60);
    if (gapHours <= CLOBBER_THRESHOLD_HOURS) continue;
    candidates.push({
      id: row.id,
      client_name: row.client_name,
      result: row.result,
      result_at_current: row.result_at,
      latest_photo_captured_at: new Date(latestPhotoMs).toISOString(),
      gap_hours: Math.round(gapHours * 10) / 10,
      photo_count: photos.length,
    });
  }

  if (candidates.length === 0) {
    return json(200, { ok: true, dry_run: dryRun, candidates: 0, message: "No clobbered records detected." });
  }

  // Sort by gap_hours desc so the worst offenders are at the top.
  candidates.sort((a, b) => b.gap_hours - a.gap_hours);

  if (dryRun) {
    return json(200, {
      ok: true,
      dry_run: true,
      candidates: candidates.length,
      message: `WOULD reset result_at for ${candidates.length} records. Re-run with POST ?go=1 to apply.`,
      preview: candidates,
    });
  }

  // Real run — PATCH each.
  let updated = 0;
  let failed = 0;
  const failures = [];
  for (const c of candidates) {
    try {
      const ur = await fetch(
        `${SB_URL}/rest/v1/inspections?id=eq.${encodeURIComponent(c.id)}`,
        {
          method: "PATCH",
          headers: sbWriteHeaders,
          body: JSON.stringify({ result_at: c.latest_photo_captured_at }),
        },
      );
      if (ur.ok) updated++;
      else {
        failed++;
        failures.push({ id: c.id, name: c.client_name, error: `HTTP ${ur.status}` });
      }
    } catch (e) {
      failed++;
      failures.push({ id: c.id, name: c.client_name, error: e.message });
    }
  }

  return json(200, {
    ok: true,
    dry_run: false,
    candidates: candidates.length,
    updated,
    failed,
    failures: failures.slice(0, 10),
  });
};

function json(status, body) {
  return {
    statusCode: status,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}
