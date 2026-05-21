// netlify/functions/check-stale-claims.js
//
// Nightly cleanup + manager daily report. Does two things:
//   1. Auto-unclaims stale claims (inspector_id → NULL, claimed_at
//      → NULL) so they reappear on the "Available near me" list
//      tomorrow. "Stale" = claimed but not completed.
//   2. Sends ONE consolidated SMS to MANAGER_ALERT_PHONE with:
//        • Inspectors who sat on claims (with the addresses)
//        • Active inspectors who claimed NOTHING today
//      The SMS is only sent when there's something to flag —
//      a quiet day (everyone working, nothing stale) is silent.
//
// "Stale" = inspector_id IS NOT NULL AND result IS NULL AND
//           claimed_at IS NOT NULL AND claimed_at < now() - 2h
// "Idle today" = active inspector with no claim_at OR result_at in
//                the last 20 hours.
// The 2h stale buffer protects an inspector who claimed a job late
// in the evening and is still actively inspecting when the cron
// fires. The 20h "today" window matches the typical cron schedule
// (end-of-business-ET) without needing timezone math.
//
// Trigger:
//   • Wired via Netlify scheduled functions OR external cron hitting
//     the URL with ?secret=<CRON_SECRET>. Designed to run once a day
//     around end-of-business-day in Eastern Time.
//   • Idempotent — running it twice is safe (the second run finds
//     nothing because the first run already unclaimed everything).
//
// Required env:
//   • VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY
//   • MANAGER_ALERT_PHONE — phone number to text on stale claims.
//     Accepts a single number or comma-separated list of numbers.
//   • CRON_SECRET (optional) — when set, request must include
//     ?secret=<value> or X-Cron-Secret header.
//
// POST body (all optional):
//   { dry_run: true, hours_buffer: 2 }

const STALE_BUFFER_HOURS_DEFAULT = 2;

exports.handler = async (event) => {
  if (event.httpMethod !== "POST" && event.httpMethod !== "GET") {
    return json(405, { ok: false, error: "Method not allowed" });
  }
  const required = process.env.CRON_SECRET;
  if (required) {
    const provided =
      event.headers["x-cron-secret"] ||
      event.headers["X-Cron-Secret"] ||
      event.queryStringParameters?.secret;
    if (provided !== required) return json(401, { ok: false, error: "Unauthorized" });
  }

  const missing = [];
  for (const k of ["VITE_SUPABASE_URL", "VITE_SUPABASE_ANON_KEY"]) {
    if (!process.env[k]) missing.push(k);
  }
  if (missing.length) return json(500, { ok: false, error: `Missing env: ${missing.join(", ")}` });

  const body = event.httpMethod === "POST" ? safeJson(event.body) : {};
  const dryRun = !!body.dry_run || event.queryStringParameters?.dry_run === "1";
  const hoursBuffer = Number.isFinite(body.hours_buffer)
    ? body.hours_buffer
    : STALE_BUFFER_HOURS_DEFAULT;

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
  const sbHeaders = {
    apikey: SB_KEY,
    Authorization: `Bearer ${SB_KEY}`,
    "Content-Type": "application/json",
  };

  const cutoff = new Date(Date.now() - hoursBuffer * 3600 * 1000).toISOString();
  const todayWindowStart = new Date(Date.now() - 20 * 3600 * 1000).toISOString();

  // 1. Fetch every stale claim, joining inspector name in one round-trip.
  // PostgREST embed syntax: inspector:inspectors(name) follows the FK.
  const listUrl =
    `${SB_URL}/rest/v1/inspections` +
    `?select=id,client_name,address,city,inspector_id,claimed_at,inspector:inspectors(name)` +
    `&inspector_id=not.is.null` +
    `&result=is.null` +
    `&claimed_at=not.is.null` +
    `&claimed_at=lt.${encodeURIComponent(cutoff)}` +
    `&order=claimed_at.asc` +
    `&limit=500`;

  // 2. Today's activity per inspector — anything claimed or completed
  //    in the last 20h. Used to figure out who was actually working.
  const activityUrl =
    `${SB_URL}/rest/v1/inspections` +
    `?select=inspector_id,claimed_at,result_at` +
    `&inspector_id=not.is.null` +
    `&or=(claimed_at.gte.${encodeURIComponent(todayWindowStart)},result_at.gte.${encodeURIComponent(todayWindowStart)})` +
    `&limit=5000`;

  // 3. All active+setup-done inspectors — these are the ones we expect
  //    to have done something today. Anyone in this list with no entry
  //    in the activity set is "idle".
  const inspectorsUrl =
    `${SB_URL}/rest/v1/inspectors` +
    `?select=id,name` +
    `&active=eq.true` +
    `&info_updated_at=not.is.null` +
    `&order=name`;

  const [listRes, activityRes, inspectorsRes] = await Promise.all([
    fetch(listUrl, { headers: sbHeaders }),
    fetch(activityUrl, { headers: sbHeaders }),
    fetch(inspectorsUrl, { headers: sbHeaders }),
  ]);
  if (!listRes.ok) {
    return json(500, { ok: false, error: `List failed: ${await listRes.text()}` });
  }
  if (!activityRes.ok) {
    return json(500, { ok: false, error: `Activity failed: ${await activityRes.text()}` });
  }
  if (!inspectorsRes.ok) {
    return json(500, { ok: false, error: `Inspectors failed: ${await inspectorsRes.text()}` });
  }
  const stale = await listRes.json();
  const activityRows = await activityRes.json();
  const allInspectors = await inspectorsRes.json();

  // Group stale claims by inspector.
  const byInspector = new Map();
  for (const row of stale) {
    const k = row.inspector_id;
    const entry = byInspector.get(k) || {
      inspector_id: k,
      inspector_name: row.inspector?.name || "(unknown inspector)",
      jobs: [],
    };
    entry.jobs.push({
      id: row.id,
      client: row.client_name || "(no name)",
      address: [row.address, row.city].filter(Boolean).join(", ") || "(no address)",
      claimed_at: row.claimed_at,
    });
    byInspector.set(k, entry);
  }
  const groups = Array.from(byInspector.values());

  // Find idle inspectors: active+setup-done but no claim/result today.
  const activeInspectorIds = new Set(
    activityRows
      .filter((r) => r.claimed_at >= todayWindowStart || r.result_at >= todayWindowStart)
      .map((r) => r.inspector_id),
  );
  const idleInspectors = allInspectors.filter((i) => !activeInspectorIds.has(i.id));

  // Dry run: just report what would happen.
  if (dryRun) {
    return json(200, {
      ok: true,
      dry_run: true,
      cutoff,
      today_window_start: todayWindowStart,
      stale_count: stale.length,
      groups,
      idle_inspectors: idleInspectors.map((i) => ({ id: i.id, name: i.name })),
      total_active_setup_done: allInspectors.length,
    });
  }

  const base = (process.env.URL || process.env.PUBLIC_SITE_URL || "").replace(/\/$/, "");
  const managerPhones = (process.env.MANAGER_ALERT_PHONE || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  // Compose ONE consolidated daily-report SMS. Only sent when there's
  // something noteworthy — quiet days (no stale, nobody idle) are silent.
  const smsResults = [];
  let reportSent = false;
  if ((groups.length > 0 || idleInspectors.length > 0) && managerPhones.length > 0 && base) {
    const sections = ["🚨 Daily inspector report:"];
    if (groups.length > 0) {
      const staleSummary = groups
        .map((g) => {
          const jobLines = g.jobs.map((j) => `   • ${j.client} — ${j.address}`).join("\n");
          return `${g.inspector_name} (${g.jobs.length}):\n${jobLines}`;
        })
        .join("\n\n");
      sections.push(`🔴 Sat on claims (auto-unclaimed):\n${staleSummary}`);
    }
    if (idleInspectors.length > 0) {
      const idleList = idleInspectors.map((i) => `• ${i.name}`).join("\n");
      sections.push(`🟡 Claimed nothing today:\n${idleList}`);
    }
    const message = sections.join("\n\n");

    for (const phone of managerPhones) {
      try {
        const r = await fetch(`${base}/.netlify/functions/ghl-sms`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ to: phone, name: "Manager", message }),
        });
        const rb = await r.json().catch(() => ({}));
        smsResults.push({
          to: phone,
          ok: r.ok,
          status: r.status,
          error: r.ok ? undefined : (rb.error || `status ${r.status}`),
        });
      } catch (e) {
        smsResults.push({ to: phone, ok: false, error: e.message });
      }
    }
    reportSent = true;
  }

  // Unclaim every stale row in one bulk PATCH per group.
  let unclaimed = 0;
  const unclaimErrors = [];
  for (const g of groups) {
    if (g.jobs.length === 0) continue;
    const ids = g.jobs.map((j) => j.id).join(",");
    const patchRes = await fetch(
      `${SB_URL}/rest/v1/inspections?id=in.(${ids})`,
      {
        method: "PATCH",
        headers: sbHeaders,
        body: JSON.stringify({ inspector_id: null, claimed_at: null }),
      },
    );
    if (!patchRes.ok) {
      unclaimErrors.push({ inspector_id: g.inspector_id, error: await patchRes.text() });
    } else {
      unclaimed += g.jobs.length;
    }
  }

  return json(200, {
    ok: true,
    cutoff,
    today_window_start: todayWindowStart,
    stale_count: stale.length,
    unclaimed,
    inspectors_with_stale_claims: groups.length,
    idle_inspectors: idleInspectors.map((i) => i.name),
    report_sent: reportSent,
    sms_results: smsResults,
    unclaim_errors: unclaimErrors,
  });
};

function safeJson(s) {
  try { return JSON.parse(s || "{}"); } catch { return {}; }
}
function json(status, body) {
  return {
    statusCode: status,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}
