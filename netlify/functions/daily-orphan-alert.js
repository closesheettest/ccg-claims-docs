// netlify/functions/daily-orphan-alert.js
//
// Daily safety net for JN sync failures. Once a morning, looks at every
// inspection signed in the past 24h and checks whether each one made it
// into JobNimbus. Any "orphans" (signed in Supabase but no jn_job_id and
// no JN job found by name+date) get rolled into one SMS to the admin so
// the orphans can be cleared via the in-app "Sync to JN" retry button
// (or the /retry-jn-sync endpoint).
//
// Why this exists: the signing flow fires the JN sync fire-and-forget.
// Even with the 3-attempt retry we added on the client side, a homeowner
// closing their browser tab right after signing — or a JN outage longer
// than 14 seconds (1s + 3s + 10s backoff) — can still strand a row. This
// cron is the catch-net so those rows don't sit hidden for days.
//
// Trigger:
//   • Netlify scheduled function — fires daily at 12:00 UTC (= 8 AM EDT
//     / 7 AM EST). One SMS per day max; silent when there are no orphans.
//   • Can also be hit on-demand: GET /.netlify/functions/daily-orphan-alert
//     for a manual check (useful for debugging).
//
// Required env:
//   • VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY (used by the underlying
//     find-orphan-signings call)
//   • JOBNIMBUS_API_KEY (same)
//   • ADMIN_ALERT_PHONE — phone number to text on orphans. Accepts a
//     single number or comma-separated list. Same env var used by
//     cron-push-pending-results.js so existing setup is reused.
//   • URL (auto-set by Netlify) — base URL for internal function calls.
//
// Output: JSON { ok, orphans, alerted } so manual GETs are informative.

exports.handler = async (event) => {
  // The Netlify scheduler invokes with no body and no httpMethod we
  // care about; manual GETs / POSTs both fine. Anything else is rejected.
  if (event.httpMethod && event.httpMethod !== "GET" && event.httpMethod !== "POST") {
    return json(405, { ok: false, error: "Method not allowed" });
  }

  const base =
    process.env.URL ||
    process.env.DEPLOY_URL ||
    process.env.PUBLIC_SITE_URL ||
    "";

  // 1. Compute the 24h window. The orphan finder takes from/to as YYYY-MM-DD
  //    (signed_at >= from, signed_at < to). For a daily 8 AM ET run we want
  //    "yesterday morning through this morning" — which we approximate by
  //    pulling the last 36h to absorb timezone slop without missing edges.
  const now = new Date();
  const yesterday = new Date(now.getTime() - 36 * 60 * 60 * 1000);
  const fmt = (d) => d.toISOString().slice(0, 10);
  const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const from = fmt(yesterday);
  const to = fmt(tomorrow); // exclusive

  // 2. Call the existing orphan finder. It does the JN name search per
  //    row and returns { orphans: [...] }. We deliberately re-use this
  //    endpoint instead of duplicating its logic so any future fix to
  //    the matching algorithm benefits both call paths.
  const finderUrl = `${base}/.netlify/functions/find-orphan-signings?from=${from}&to=${to}`;
  let finderData;
  try {
    const r = await fetch(finderUrl);
    finderData = await r.json();
    if (!r.ok || !finderData.ok) {
      console.error("Orphan finder failed:", r.status, finderData);
      return json(500, {
        ok: false,
        error: `find-orphan-signings returned ${r.status}`,
        detail: finderData,
      });
    }
  } catch (e) {
    console.error("Orphan finder threw:", e);
    return json(500, { ok: false, error: `Could not reach orphan finder: ${e.message}` });
  }

  const orphans = finderData.orphans || [];
  console.log(
    `daily-orphan-alert: window ${from}..${to}, ${finderData.summary?.total_signings || 0} signings, ${orphans.length} orphans`
  );

  // 3. ALSO check for "stuck certs" — inspections classified 24+ hours
  //    ago whose cert never made it to JN. The hourly cron
  //    cron-retry-missing-certs is supposed to handle these
  //    automatically; if a row is STILL stuck 24h later, something is
  //    genuinely broken (PDFShift down, JN API issues, etc.) and it
  //    needs Neal's eyes. Daily heartbeat means he sees it next
  //    morning, not days later.
  const SB_URL_2 = process.env.VITE_SUPABASE_URL;
  const SB_KEY_2 = process.env.VITE_SUPABASE_ANON_KEY;
  let stuckCerts = [];
  if (SB_URL_2 && SB_KEY_2) {
    try {
      const cutoff24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      // Only flag results that actually GET a cert. Must mirror
      // cron-retry-missing-certs' VALID_RESULTS exactly — otherwise we
      // alarm on rows the retry will never touch, so they're "stuck"
      // forever. The big offender: result='lost' (deal lost — no cert
      // exists, nothing to generate). Other placeholder/terminal states
      // ('Needs Service', etc.) are excluded for the same reason. Without
      // this, 13 'lost' deals false-alarmed daily (2026-06-10).
      const VALID_RESULTS = ['damage', 'retail', 'no_damage'];
      const resultIn = encodeURIComponent(VALID_RESULTS.map((r) => `"${r}"`).join(','));
      const q =
        `select=client_name,address,city,sales_rep_name,result,result_at,jn_job_id,jn_status` +
        `&inspector_id=not.is.null` +
        `&result=in.(${resultIn})` +
        `&jn_job_id=not.is.null` +
        `&cancelled_at=is.null` +
        `&jn_cert_uploaded_at=is.null` +
        // Exclude HELD inspections (gated inspector awaiting manager confirm) —
        // the retry cron skips these on purpose, so they're not "failing,"
        // they're waiting on a manager. Mirror cron-retry-missing-certs.
        `&or=(pending_confirmation.is.null,pending_confirmation.eq.false)` +
        `&result_at=lt.${encodeURIComponent(cutoff24h)}` +
        `&order=result_at.asc` +
        `&limit=20`;
      const sbRes = await fetch(`${SB_URL_2}/rest/v1/inspections?${q}`, {
        headers: { apikey: SB_KEY_2, Authorization: `Bearer ${SB_KEY_2}` },
      });
      if (sbRes.ok) {
        // Drop DEAD deals (Lost / Dead / BTR-NI) — they don't need a cert, so
        // they're not really "stuck." Mirrors cron-retry-missing-certs.
        const isDead = (s) => /^(lost|dead)$/i.test(String(s || "").trim()) || /btr\s*-\s*ni/i.test(String(s || ""));
        stuckCerts = (await sbRes.json()).filter((r) => !isDead(r.jn_status));
      } else {
        console.warn("Stuck-cert query failed:", sbRes.status);
      }
    } catch (e) {
      console.warn("Stuck-cert query threw:", e.message);
    }
  }
  console.log(`daily-orphan-alert: ${stuckCerts.length} stuck certs (24h+)`);

  // 3b. ALSO check for "missing agreements" — inspections that DID reach
  //     JobNimbus (jn_job_id set) but whose signed inspection agreement
  //     never archived (signed_pdfs.insp is null). This is the Mark
  //     Hamersly failure mode (2026-06): contact+job synced, the homeowner
  //     signed, but the agreement PDF was never produced/attached — so the
  //     inspector drove out to a job with no paperwork. The signing flow
  //     archives the agreement within seconds of signing, so by the next
  //     morning any synced+non-cancelled inspection still missing its insp
  //     PDF is genuinely broken, not just slow. Same 36h window as orphans.
  let missingAgreements = [];
  if (SB_URL_2 && SB_KEY_2) {
    try {
      const since = new Date(Date.now() - 36 * 60 * 60 * 1000).toISOString();
      const q =
        `select=client_name,address,city,sales_rep_name,signed_at,jn_job_id,signed_pdfs` +
        `&jn_job_id=not.is.null` +
        `&cancelled_at=is.null` +
        `&signed_at=gte.${encodeURIComponent(since)}` +
        `&signed_pdfs->>insp=is.null` +
        `&order=signed_at.asc` +
        `&limit=20`;
      const sbRes = await fetch(`${SB_URL_2}/rest/v1/inspections?${q}`, {
        headers: { apikey: SB_KEY_2, Authorization: `Bearer ${SB_KEY_2}` },
      });
      if (sbRes.ok) {
        missingAgreements = await sbRes.json();
      } else {
        console.warn("Missing-agreement query failed:", sbRes.status);
      }
    } catch (e) {
      console.warn("Missing-agreement query threw:", e.message);
    }
  }
  console.log(`daily-orphan-alert: ${missingAgreements.length} missing agreements (synced, no insp PDF)`);

  // 4. Quiet day → no SMS. Requires ALL lists empty before staying silent
  //    so we don't miss a stuck cert or missing agreement on an
  //    otherwise-quiet day.
  if (orphans.length === 0 && stuckCerts.length === 0 && missingAgreements.length === 0) {
    return json(200, {
      ok: true,
      orphans: 0,
      stuck_certs: 0,
      missing_agreements: 0,
      alerted: false,
    });
  }

  // 5. Compose ONE SMS combining both lists. Each line: name · city ·
  //    rep. Capped per category so the message stays under ~3 SMS
  //    segments even on a bad day.
  const PER_ITEM_LIMIT = 6;
  const sections = [];

  if (orphans.length > 0) {
    const items = orphans.slice(0, PER_ITEM_LIMIT).map((o) => {
      const name = o.client_name || "?";
      const city = o.city || "";
      const rep = o.sales_rep_name || "Unassigned";
      return `• ${name}${city ? " · " + city : ""} (${rep})`;
    });
    const more =
      orphans.length > PER_ITEM_LIMIT
        ? `\n+${orphans.length - PER_ITEM_LIMIT} more`
        : "";
    sections.push(
      `⚠ ${orphans.length} JN sync orphan${orphans.length === 1 ? "" : "s"}:\n` +
        items.join("\n") +
        more +
        `\nFix: app → record list → "Sync to JN".`,
    );
  }

  if (stuckCerts.length > 0) {
    const items = stuckCerts.slice(0, PER_ITEM_LIMIT).map((s) => {
      const name = s.client_name || "?";
      const city = s.city || "";
      const result = s.result || "?";
      const ageHours = Math.round(
        (Date.now() - new Date(s.result_at).getTime()) / 3600000,
      );
      return `• ${name}${city ? " · " + city : ""} (${result}, ${ageHours}h stuck)`;
    });
    const more =
      stuckCerts.length > PER_ITEM_LIMIT
        ? `\n+${stuckCerts.length - PER_ITEM_LIMIT} more`
        : "";
    sections.push(
      `🛟 ${stuckCerts.length} cert${stuckCerts.length === 1 ? "" : "s"} stuck 24h+:\n` +
        items.join("\n") +
        more +
        `\nThe hourly retry has been failing on these. Check Netlify logs OR fire generate-and-upload-insp-report manually with the jnid.`,
    );
  }

  if (missingAgreements.length > 0) {
    const items = missingAgreements.slice(0, PER_ITEM_LIMIT).map((m) => {
      const name = m.client_name || "?";
      const city = m.city || "";
      const rep = m.sales_rep_name || "Unassigned";
      return `• ${name}${city ? " · " + city : ""} (${rep})`;
    });
    const more =
      missingAgreements.length > PER_ITEM_LIMIT
        ? `\n+${missingAgreements.length - PER_ITEM_LIMIT} more`
        : "";
    sections.push(
      `📄 ${missingAgreements.length} signed, agreement may be MISSING:\n` +
        items.join("\n") +
        more +
        `\nThese synced to JN but the signed agreement never archived — usually means it never attached to the JN job either. Open each JN job: if the agreement isn't there, the homeowner must re-sign (rep returns or send a re-sign link) before the inspector goes out.`,
    );
  }

  const message = sections.join("\n\n");

  // 5. Send SMS to ADMIN_ALERT_PHONE (comma-sep list ok). Skips silently
  //    if the env var isn't set so this cron stays usable on a fresh
  //    deploy where alerts haven't been wired yet — the orphan list is
  //    still surfaced in the JSON response.
  // On/off + extra copy-recipients from the Auto-SMS registry (key
  // "daily_orphan_alert"). Fail-open. ADMIN_ALERT_PHONE is always
  // included; extras add their own copies.
  const cfg = await loadAutoSms("daily_orphan_alert");
  if (!cfg.enabled) {
    return json(200, {
      ok: true,
      orphans: orphans.length,
      stuck_certs: stuckCerts.length,
      missing_agreements: missingAgreements.length,
      alerted: false,
      note: "daily_orphan_alert disabled in auto_sms; no SMS sent.",
      orphan_names: orphans.map((o) => o.client_name),
      stuck_names: stuckCerts.map((s) => s.client_name),
      missing_agreement_names: missingAgreements.map((m) => m.client_name),
    });
  }
  const recipients = mergeRecipients(process.env.ADMIN_ALERT_PHONE, cfg.recipients);
  if (recipients.length === 0) {
    console.warn("No recipients (ADMIN_ALERT_PHONE unset + no extras) — skipping SMS");
    return json(200, {
      ok: true,
      orphans: orphans.length,
      stuck_certs: stuckCerts.length,
      missing_agreements: missingAgreements.length,
      alerted: false,
      note: "No recipients configured; no SMS sent.",
      orphan_names: orphans.map((o) => o.client_name),
      stuck_names: stuckCerts.map((s) => s.client_name),
      missing_agreement_names: missingAgreements.map((m) => m.client_name),
    });
  }

  let sentTo = 0;
  for (const rcpt of recipients) {
    try {
      const r = await fetch(`${base}/.netlify/functions/ghl-sms`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to: rcpt.phone, name: rcpt.name, message }),
      });
      if (r.ok) sentTo++;
      else console.warn(`SMS to ${rcpt.phone} returned ${r.status}`);
    } catch (e) {
      console.warn(`SMS to ${rcpt.phone} threw:`, e.message);
    }
  }

  return json(200, {
    ok: true,
    orphans: orphans.length,
    stuck_certs: stuckCerts.length,
    missing_agreements: missingAgreements.length,
    alerted: sentTo,
    orphan_names: orphans.map((o) => o.client_name),
    stuck_names: stuckCerts.map((s) => s.client_name),
    missing_agreement_names: missingAgreements.map((m) => m.client_name),
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

// Netlify v2 scheduled function — fires daily at 12:00 UTC.
// That's 8 AM EDT in summer / 7 AM EST in winter, which lands the alert
// in the admin's inbox first thing in the morning year-round.
exports.config = { schedule: "0 12 * * *" };
