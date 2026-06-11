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
//                      how to render. NOTE: these are the lowercase
//                      DB tokens ('damage'/'retail'/'no_damage'), NOT
//                      the Title-Case cert display labels — an earlier
//                      version filtered on display names that never
//                      matched any row, so the catch-net silently
//                      retried nothing and certs piled up.
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
  const VALID_RESULTS = ['damage', 'retail', 'no_damage'];
  const resultInParam = VALID_RESULTS.map((r) => `"${r}"`).join(',');
  const cutoffIso = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  const q =
    `select=id,client_name,address,jn_job_id,result,result_at,inspector_id` +
    `&inspector_id=not.is.null` +
    `&result=in.(${encodeURIComponent(resultInParam)})` +
    `&jn_job_id=not.is.null` +
    `&cancelled_at=is.null` +
    `&jn_cert_uploaded_at=is.null` +
    // Do NOT touch HELD inspections (gated inspector, awaiting manager
    // confirmation). Nothing fires for those until a manager Confirms in
    // the "Inspections to confirm" tile — that's the whole point of the
    // review. Include null (non-gated) + false (already confirmed/cleared),
    // exclude true (held).
    `&or=(pending_confirmation.is.null,pending_confirmation.eq.false)` +
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
      // 2a. Re-push cf_string_34 to JN FIRST. The cert generator refuses
      //     to render unless the JN job's cf_string_34 is set to one of
      //     the three result labels. We've seen rows where jn_pushed_at
      //     was stamped but the JN field never actually landed (8 certs
      //     stuck 24h+, 2026-06-03), which left them in a dead zone:
      //     cron-push-pending-results skips them (jn_pushed_at set) and
      //     the generator 400s ("Needs Inspection"). push-result-to-jn
      //     is idempotent, so re-firing it here is safe and self-heals
      //     that case. (Retail's record_type/location swap is left to
      //     the push cron / manual flow — the cert only needs cf_string_34.)
      const pushRes = await fetch(`${base}/.netlify/functions/push-result-to-jn`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ inspectionId: rec.id }),
      });
      const pushBody = await pushRes.json().catch(() => ({}));
      if (!pushRes.ok || !pushBody.jn_updated) {
        failures.push({
          client_name: rec.client_name,
          jn_job_id: rec.jn_job_id,
          error: `cf_string_34 push failed: ${pushBody.jn_update_error || pushBody.error || `status ${pushRes.status}`}`,
        });
        continue;
      }

      const r = await fetch(`${base}/.netlify/functions/generate-and-upload-insp-report`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jnid: rec.jn_job_id }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok || !body.ok) {
        const errText = body.error || `status ${r.status}`;
        failures.push({
          client_name: rec.client_name,
          jn_job_id: rec.jn_job_id,
          error: errText,
          // "No photos found" can't be fixed by retrying — the inspector
          // classified a result but never uploaded photos, so no cert
          // can render until photos arrive (e.g. CYMONE Taylor Valmond
          // 2026-06-02). Don't SMS-spam every hour on it; we still
          // attempt generation each run so it auto-clears the moment
          // photos appear, and the daily orphan alert surfaces it once
          // a day for a human to chase the missing photos.
          noPhotos: /no photos found/i.test(errText),
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

  // 4. Quiet by default. Only text admin if a retry FAILED for a reason
  //    retrying could fix — successes are the silent happy path, and
  //    "no photos" failures are excluded (a human chasing photos is the
  //    only fix; the daily orphan alert covers those once a day). Same
  //    quiet-on-success pattern as cron-push-pending-results.
  const alertable = failures.filter((f) => !f.noPhotos);
  if (alertable.length > 0 && base) {
    // On/off + extra copy-recipients from the Auto-SMS registry (key
    // "cert_retry_alert"). Fail-open so a DB hiccup never silences the
    // alert. The ADMIN_ALERT_PHONE env is always included; extras add to
    // it (e.g. another admin who wants a copy).
    const cfg = await loadAutoSms("cert_retry_alert");
    if (cfg.enabled) {
      try {
        const items = alertable.slice(0, 5).map((f) => {
          const err = String(f.error || "unknown").slice(0, 60);
          return `${f.client_name || f.jn_job_id} (${err})`;
        });
        const more = alertable.length > items.length ? ` +${alertable.length - items.length} more` : "";
        const message =
          `⚠ Cert-retry failures: ${alertable.length}/${candidates.length}\n` +
          items.join("\n") +
          more +
          `\nCheck Netlify logs for full detail.`;
        const recipients = mergeRecipients(process.env.ADMIN_ALERT_PHONE, cfg.recipients);
        for (const rcpt of recipients) {
          await fetch(`${base}/.netlify/functions/ghl-sms`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ to: rcpt.phone, name: rcpt.name, message }),
          }).catch(() => {});
        }
      } catch (e) {
        console.warn("Admin SMS alert failed:", e.message);
      }
    }
  }

  const noPhotoCount = failures.filter((f) => f.noPhotos).length;
  console.log(
    `cron-retry-missing-certs: scanned=${candidates.length} succeeded=${succeeded} failed=${failures.length} (no-photo, non-alerted=${noPhotoCount})`,
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

// ── auto_sms registry helpers (fail-open) ───────────────────────────
async function loadAutoSms(key) {
  const SB_URL = process.env.VITE_SUPABASE_URL, SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
  if (!SB_URL || !SB_KEY) return { enabled: true, recipients: [] };
  try {
    const r = await fetch(
      `${SB_URL}/rest/v1/auto_sms?key=eq.${encodeURIComponent(key)}&select=enabled,recipients&limit=1`,
      { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` } },
    );
    if (!r.ok) return { enabled: true, recipients: [] };
    const rows = await r.json().catch(() => []);
    const row = rows[0];
    if (!row) return { enabled: true, recipients: [] };
    return { enabled: row.enabled !== false, recipients: Array.isArray(row.recipients) ? row.recipients : [] };
  } catch {
    return { enabled: true, recipients: [] };
  }
}

// Combine ADMIN_ALERT_PHONE (comma list) + extra recipients, deduped by
// normalized phone. Returns [{name, phone}].
function mergeRecipients(adminEnv, extras) {
  const byPhone = new Map();
  const norm = (p) => {
    const d = String(p || "").replace(/\D/g, "");
    if (d.length === 10) return `+1${d}`;
    if (d.length === 11 && d.startsWith("1")) return `+${d}`;
    if (d.length < 10) return "";
    return `+${d}`;
  };
  for (const p of String(adminEnv || "").split(",").map((s) => s.trim()).filter(Boolean)) {
    const k = norm(p); if (k && !byPhone.has(k)) byPhone.set(k, { phone: k, name: "Admin" });
  }
  for (const e of Array.isArray(extras) ? extras : []) {
    const k = norm(e.phone); if (k && !byPhone.has(k)) byPhone.set(k, { phone: k, name: e.name || "Admin" });
  }
  return [...byPhone.values()];
}

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
