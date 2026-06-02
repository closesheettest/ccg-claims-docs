// netlify/functions/cron-retry-missing-certs.js
//
// Hourly safety net for the cert-upload path. The normal flow is:
//   inspector classifies result → inspector-submit-result.js fires
//   generate-and-upload-insp-report-background → cert PDF lands in
//   the JN job's Documents tab → jn_cert_uploaded_at gets stamped.
//
// That background fire occasionally drops a cert on the floor (PDFShift
// hiccup, JN file upload timeout, Netlify cold-start past the budget).
// We've now seen it happen 3 times in a single week (Avlon Flax, Tu Cao,
// Anik Clemens — all 5/22-5/26).
//
// This cron is the catch-net: find any inspection where the cert SHOULD
// be in JN by now but isn't, and re-fire the generator. Most of the
// time this is a no-op (nothing to retry). When it does fire, it's the
// same idempotent call I've been making by hand.
//
// Detection criteria — all must be true:
//   • inspector_id     IS NOT NULL  (app ran on this job)
//   • result           IS one of the three terminal outcomes — see
//                      VALID_RESULTS below. We used to accept any
//                      non-null result, but that caught rows where
//                      `result` was a pre-inspection placeholder
//                      like 'Needs Service' (e.g. Priscilla Montalvo
//                      Garcia 2026-06-02). The cert generator can't
//                      do anything with those, so they'd fail every
//                      hour and spam the admin SMS. Lock the filter
//                      to the three values the cert template knows
//                      how to render.
//   • jn_job_id        IS NOT NULL  (JN job exists)
//   • cancelled_at     IS NULL      (not voided)
//   • jn_cert_uploaded_at IS NULL   (cert not in JN yet)
//   • result_at < now - 15 min      (don't race the original background fire)
//
// Schedule: hourly at :20 (avoids overlapping cron-push-pending-results
// at :05 and the 15-min inspection-checker on :00/:15/:30/:45).
//
// Caps:
//   • 5 retries per run — protects PDFShift/JN if there's a real backlog.
//     Anything beyond that gets caught next hour.
//
// Required env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY,
//               URL (auto-set by Netlify) for the internal function call,
//               JOBNIMBUS_API_KEY + PDFSHIFT_API_KEY (used by the cert
//               generator we call into).
//
// Optional env: ADMIN_ALERT_PHONE — when retries fail, sends one SMS
//               summarizing the failures (same env used by daily-orphan-alert
//               so existing wiring is reused). Skipped silently if not set.

exports.handler = async (event) => {
  // Scheduled invocations have no httpMethod; manual GET/POST both fine.
  if (event.httpMethod && event.httpMethod !== "GET" && event.httpMethod !== "POST") {
    return json(405, { ok: false, error: "Method not allowed" });
  }

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
  const missing = [];
  if (!SB_URL) missing.push("VITE_SUPABASE_URL");
  if (!SB_KEY) missing.push("VITE_SUPABASE_ANON_KEY");
  if (missing.length) return json(500, { ok: false, error: `Missing env: ${missing.join(", ")}` });

  const sbHeaders = {
    apikey: SB_KEY,
    Authorization: `Bearer ${SB_KEY}`,
    "Content-Type": "application/json",
  };
  const base =
    process.env.URL || process.env.DEPLOY_URL || process.env.PUBLIC_SITE_URL || "";

  // 1. Find candidates. The 15-minute fence on result_at is the
  //    backpressure that keeps us from racing the original background
  //    fire — if the result was set just seconds ago, the background
  //    function might still be running. Wait 15 min before assuming
  //    it dropped.
  //
  //    The result IN filter is the defensive fix for the Priscilla-
  //    style false alarm. Pre-inspection placeholder strings like
  //    'Needs Service' / 'Needs Sales Visit' / 'Needs <anything>'
  //    sometimes land in `result` before the inspector classifies.
  //    The cert generator can't render those (only the three real
  //    inspection outcomes have certificate templates), so retrying
  //    them is wasted work + a daily false-positive admin SMS.
  const VALID_RESULTS = ['No Damage', 'Wear & Tear', 'Storm Damage'];
  const resultInParam = VALID_RESULTS.map((r) => `"${r}"`).join(',');
  const cutoffIso = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  const q =
    `select=id,client_name,address,jn_job_id,result,result_at,inspector_id` +
    `&inspector_id=not.is.null` +
    `&result=in.(${encodeURIComponent(resultInParam)})` +
    `&jn_job_id=not.is.null` +
    `&cancelled_at=is.null` +
    `&jn_cert_uploaded_at=is.null` +
    `&result_at=lt.${encodeURIComponent(cutoffIso)}` +
    `&order=result_at.asc` +
    `&limit=5`;
  const sbRes = await fetch(`${SB_URL}/rest/v1/inspections?${q}`, { headers: sbHeaders });
  if (!sbRes.ok) {
    return json(500, {
      ok: false,
      error: `Could not query inspections: ${(await sbRes.text()).slice(0, 300)}`,
    });
  }
  const candidates = await sbRes.json();
  if (!candidates || candidates.length === 0) {
    return json(200, { ok: true, scanned: 0, retried: 0, succeeded: 0, failed: 0 });
  }

  // 2. For each candidate, fire the synchronous cert generator. Sequential
  //    rather than parallel — PDFShift has per-second rate limits and
  //    JN's file upload is heavy.
  let succeeded = 0;
  const failures = [];
  const successes = [];
  for (const rec of candidates) {
    try {
      const r = await fetch(`${base}/.netlify/functions/generate-and-upload-insp-report`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jnid: rec.jn_job_id }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok || !body.ok) {
        failures.push({
          client_name: rec.client_name,
          jn_job_id: rec.jn_job_id,
          error: body.error || `status ${r.status}`,
        });
        continue;
      }
      // 3. Stamp jn_cert_uploaded_at so we don't re-fire next hour.
      const nowIso = new Date().toISOString();
      const upRes = await fetch(
        `${SB_URL}/rest/v1/inspections?id=eq.${rec.id}`,
        {
          method: "PATCH",
          headers: { ...sbHeaders, Prefer: "return=minimal" },
          body: JSON.stringify({ jn_cert_uploaded_at: nowIso }),
        },
      );
      if (!upRes.ok) {
        failures.push({
          client_name: rec.client_name,
          jn_job_id: rec.jn_job_id,
          error: `Cert uploaded but jn_cert_uploaded_at write failed: ${(await upRes.text()).slice(0, 200)}`,
        });
        continue;
      }
      succeeded++;
      successes.push({
        client_name: rec.client_name,
        photo_count: body.photoCount,
      });
    } catch (e) {
      failures.push({
        client_name: rec.client_name,
        jn_job_id: rec.jn_job_id,
        error: e.message || String(e),
      });
    }
  }

  // 4. Quiet by default. Only text admin if a retry FAILED — successes
  //    are the silent happy path. Same pattern as cron-push-pending-results.
  if (failures.length > 0 && process.env.ADMIN_ALERT_PHONE && base) {
    try {
      const items = failures.slice(0, 5).map((f) => {
        const err = String(f.error || "unknown").slice(0, 60);
        return `${f.client_name || f.jn_job_id} (${err})`;
      });
      const more = failures.length > items.length ? ` +${failures.length - items.length} more` : "";
      const message =
        `⚠ Cert-retry failures: ${failures.length}/${candidates.length}\n` +
        items.join("\n") +
        more +
        `\nCheck Netlify logs for full detail.`;
      const phones = (process.env.ADMIN_ALERT_PHONE || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      for (const phone of phones) {
        await fetch(`${base}/.netlify/functions/ghl-sms`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ to: phone, name: "Admin", message }),
        }).catch(() => {});
      }
    } catch (e) {
      console.warn("Admin SMS alert failed:", e.message);
    }
  }

  console.log(
    `cron-retry-missing-certs: scanned=${candidates.length} succeeded=${succeeded} failed=${failures.length}`,
  );
  return json(200, {
    ok: true,
    scanned: candidates.length,
    retried: candidates.length,
    succeeded,
    failed: failures.length,
    successes,
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

// Netlify v2 scheduled function — hourly at :20. Offset from the other
// crons (:05 push-pending-results, :00/:15/:30/:45 inspection-checker,
// :00 daily-orphan-alert) so we don't bunch requests against PDFShift/JN.
exports.config = { schedule: "20 * * * *" };
