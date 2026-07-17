// netlify/functions/cron-unassigned-results-alert.js
//
// Daily aging alert for inspected results (damage / no-damage / retail) sitting
// UNASSIGNED — no active territory rep, so they show for nobody and can rot for
// months (some were 80+ days old when we first looked). Reuses manager-damage-queue
// per zone (same orphan definition + the manager's own "assign" screen), then texts
// a per-zone digest so the backlog gets worked instead of silently piling up.
//
// Only counts orphans aged >= MIN_AGE_DAYS so a result signed today (still being
// assigned normally) doesn't nag. Silent when nothing's aged.
//
// Recipients: ADMIN_ALERT_PHONE + any extras in auto_sms key "unassigned_results_alert"
// (add each zone manager's phone there to route it to them). Fail-open / opt-out.
//
// Env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, JOBNIMBUS_API_KEY, ADMIN_ALERT_PHONE, URL

const ZONES = ["Zone 1", "Zone 2", "Zone 3", "Zone 4"];
const MIN_AGE_DAYS = 7;
const RES_LABEL = { damage: "damage", no_damage: "no-damage", retail: "retail" };

exports.handler = async (event) => {
  if (event.httpMethod && !["GET", "POST"].includes(event.httpMethod)) return json(405, { ok: false, error: "Method not allowed" });
  const base = process.env.URL || process.env.DEPLOY_URL || process.env.PUBLIC_SITE_URL || "https://free-roof-inspections.netlify.app";

  // Pull each zone's orphan queue (same source as the manager screen).
  const perZone = [];
  for (const zone of ZONES) {
    try {
      const r = await fetch(`${base}/.netlify/functions/manager-damage-queue`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "load", zone }),
      });
      const d = await r.json().catch(() => ({}));
      if (!d.ok) continue;
      const aged = (d.deals || []).filter((x) => (x.age_days || 0) >= MIN_AGE_DAYS);
      if (aged.length) perZone.push({ zone, aged });
    } catch { /* skip zone */ }
  }

  const totalAged = perZone.reduce((n, z) => n + z.aged.length, 0);
  if (!totalAged) return json(200, { ok: true, aged: 0, alerted: false });

  // Compose one digest: a line per zone with count, oldest, and result mix.
  const lines = perZone.map(({ zone, aged }) => {
    const oldest = Math.max(...aged.map((x) => x.age_days || 0));
    const mix = {};
    for (const x of aged) mix[x.result] = (mix[x.result] || 0) + 1;
    const mixStr = Object.entries(mix).map(([k, v]) => `${v} ${RES_LABEL[k] || k}`).join(", ");
    return `• ${zone}: ${aged.length} unassigned (${mixStr}) — oldest ${oldest}d`;
  });
  const message = `🗂️ ${totalAged} inspected result${totalAged === 1 ? "" : "s"} unassigned ${MIN_AGE_DAYS}d+:\n` +
    lines.join("\n") +
    `\nAssign them: Manager console → "Inspected deals needing a rep".`;

  const cfg = await loadAutoSms("unassigned_results_alert");
  if (!cfg.enabled) return json(200, { ok: true, aged: totalAged, alerted: false, note: "disabled in auto_sms" });
  const recipients = mergeRecipients(process.env.ADMIN_ALERT_PHONE, cfg.recipients);
  if (!recipients.length) return json(200, { ok: true, aged: totalAged, alerted: false, note: "no recipients", message });

  let sentTo = 0;
  for (const rcpt of recipients) {
    try {
      const r = await fetch(`${base}/.netlify/functions/ghl-sms`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ to: rcpt.phone, name: rcpt.name, message }) });
      if (r.ok) sentTo++;
    } catch { /* skip */ }
  }
  return json(200, { ok: true, aged: totalAged, alerted: sentTo, zones: perZone.map((z) => ({ zone: z.zone, n: z.aged.length })) });
};

async function loadAutoSms(key) {
  const SB_URL = process.env.VITE_SUPABASE_URL, SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
  if (!SB_URL || !SB_KEY) return { enabled: true, recipients: [] };
  try {
    const r = await fetch(`${SB_URL}/rest/v1/auto_sms?key=eq.${encodeURIComponent(key)}&select=enabled,recipients&limit=1`, { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` } });
    if (!r.ok) return { enabled: true, recipients: [] };
    const row = (await r.json().catch(() => []))[0];
    if (!row) return { enabled: true, recipients: [] };
    return { enabled: row.enabled !== false, recipients: Array.isArray(row.recipients) ? row.recipients : [] };
  } catch { return { enabled: true, recipients: [] }; }
}
function mergeRecipients(adminEnv, extras) {
  const byPhone = new Map();
  const norm = (p) => { const d = String(p || "").replace(/\D/g, ""); if (d.length === 10) return `+1${d}`; if (d.length === 11 && d.startsWith("1")) return `+${d}`; if (d.length < 10) return ""; return `+${d}`; };
  for (const p of String(adminEnv || "").split(",").map((s) => s.trim()).filter(Boolean)) { const k = norm(p); if (k && !byPhone.has(k)) byPhone.set(k, { phone: k, name: "Admin" }); }
  for (const e of Array.isArray(extras) ? extras : []) { const k = norm(e.phone); if (k && !byPhone.has(k)) byPhone.set(k, { phone: k, name: e.name || "Manager" }); }
  return [...byPhone.values()];
}
function json(status, body) { return { statusCode: status, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }; }

// Daily at 13:00 UTC (9 AM EDT / 8 AM EST) — after the morning sync settles.
exports.config = { schedule: "0 13 * * *" };
