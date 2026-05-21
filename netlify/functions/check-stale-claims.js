// netlify/functions/check-stale-claims.js
//
// Nightly cleanup: every inspection that was claimed by an inspector
// but never completed gets:
//   1. Auto-unclaimed (inspector_id → NULL, claimed_at → NULL) so it
//      reappears on the "Available near me" list for the next day.
//   2. Reported to the manager via SMS — one consolidated message
//      per inspector listing the addresses they sat on.
//
// "Stale" = inspector_id IS NOT NULL AND result IS NULL AND
//           claimed_at IS NOT NULL AND claimed_at < now() - 2h
// The 2h buffer protects an inspector who claimed a job late in the
// evening and is still actively inspecting when the cron fires.
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
  const listRes = await fetch(listUrl, { headers: sbHeaders });
  if (!listRes.ok) {
    return json(500, { ok: false, error: `List failed: ${await listRes.text()}` });
  }
  const stale = await listRes.json();

  // 2. Group by inspector.
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

  // 3. Dry run: just report.
  if (dryRun) {
    return json(200, {
      ok: true,
      dry_run: true,
      cutoff,
      stale_count: stale.length,
      groups,
    });
  }

  const base = (process.env.URL || process.env.PUBLIC_SITE_URL || "").replace(/\/$/, "");
  const managerPhones = (process.env.MANAGER_ALERT_PHONE || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const smsResults = [];
  for (const g of groups) {
    if (managerPhones.length === 0 || !base) {
      smsResults.push({ inspector_id: g.inspector_id, skipped: "no manager phone or base URL set" });
      continue;
    }
    const lines = g.jobs.map((j) => `• ${j.client} — ${j.address}`).join("\n");
    const message =
      `🚨 Stale-claim alert (auto):\n` +
      `${g.inspector_name} claimed ${g.jobs.length} inspection${g.jobs.length === 1 ? "" : "s"} but didn't complete any today. ` +
      `They've been unclaimed so other inspectors can pick them up:\n\n${lines}`;
    for (const phone of managerPhones) {
      try {
        const r = await fetch(`${base}/.netlify/functions/ghl-sms`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ to: phone, name: "Manager", message }),
        });
        const rb = await r.json().catch(() => ({}));
        smsResults.push({
          inspector_id: g.inspector_id,
          to: phone,
          ok: r.ok,
          status: r.status,
          error: r.ok ? undefined : (rb.error || `status ${r.status}`),
        });
      } catch (e) {
        smsResults.push({ inspector_id: g.inspector_id, to: phone, ok: false, error: e.message });
      }
    }
  }

  // 4. Unclaim every stale row in one bulk PATCH per group (in.(id,id,..)).
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
    stale_count: stale.length,
    unclaimed,
    inspectors_notified: groups.length,
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
