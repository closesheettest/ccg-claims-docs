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
      const q =
        `select=client_name,address,city,sales_rep_name,result,result_at,jn_job_id` +
        `&inspector_id=not.is.null` +
        `&result=not.is.null` +
        `&jn_job_id=not.is.null` +
        `&cancelled_at=is.null` +
        `&jn_cert_uploaded_at=is.null` +
        `&result_at=lt.${encodeURIComponent(cutoff24h)}` +
        `&order=result_at.asc` +
        `&limit=20`;
      const sbRes = await fetch(`${SB_URL_2}/rest/v1/inspections?${q}`, {
        headers: { apikey: SB_KEY_2, Authorization: `Bearer ${SB_KEY_2}` },
      });
      if (sbRes.ok) {
        stuckCerts = await sbRes.json();
      } else {
        console.warn("Stuck-cert query failed:", sbRes.status);
      }
    } catch (e) {
      console.warn("Stuck-cert query threw:", e.message);
    }
  }
  console.log(`daily-orphan-alert: ${stuckCerts.length} stuck certs (24h+)`);

  // 4. Quiet day → no SMS. Now requires BOTH lists empty before staying
  //    silent so we don't miss a stuck cert on a day with no orphans.
  if (orphans.length === 0 && stuckCerts.length === 0) {
    return json(200, {
      ok: true,
      orphans: 0,
      stuck_certs: 0,
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

  const message = sections.join("\n\n");

  // 5. Send SMS to ADMIN_ALERT_PHONE (comma-sep list ok). Skips silently
  //    if the env var isn't set so this cron stays usable on a fresh
  //    deploy where alerts haven't been wired yet — the orphan list is
  //    still surfaced in the JSON response.
  const phoneList = (process.env.ADMIN_ALERT_PHONE || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (phoneList.length === 0) {
    console.warn("ADMIN_ALERT_PHONE not set — skipping SMS");
    return json(200, {
      ok: true,
      orphans: orphans.length,
      stuck_certs: stuckCerts.length,
      alerted: false,
      note: "ADMIN_ALERT_PHONE not configured; no SMS sent.",
      orphan_names: orphans.map((o) => o.client_name),
      stuck_names: stuckCerts.map((s) => s.client_name),
    });
  }

  let sentTo = 0;
  for (const phone of phoneList) {
    try {
      const r = await fetch(`${base}/.netlify/functions/ghl-sms`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to: phone, name: "Admin", message }),
      });
      if (r.ok) sentTo++;
      else console.warn(`SMS to ${phone} returned ${r.status}`);
    } catch (e) {
      console.warn(`SMS to ${phone} threw:`, e.message);
    }
  }

  return json(200, {
    ok: true,
    orphans: orphans.length,
    stuck_certs: stuckCerts.length,
    alerted: sentTo,
    orphan_names: orphans.map((o) => o.client_name),
    stuck_names: stuckCerts.map((s) => s.client_name),
  });
};

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
