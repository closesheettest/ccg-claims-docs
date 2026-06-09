// netlify/functions/cron-sync-orphans.js
//
// Auto-heals JobNimbus "orphans" — signed inspections that never got a
// jn_job_id because the at-signing JN sync silently failed (timeout, rate
// limit, brief outage). These don't show in the main system (JN), which
// breaks payroll/reporting until someone manually presses "Sync to JN".
//
// Every 15 min this finds every signed, not-cancelled inspection with NO
// jn_job_id (REGARDLESS of result — the older bulk-sync-orphans only handled
// result-less ones, so resulted orphans like a Damage that never synced were
// missed) and re-runs the sync via retry-jn-sync (the same path the admin
// "Sync to JN" button uses). It only TEXTS the admin about ones it still
// couldn't sync after trying — those need a human. Quiet when all heal.
//
// On/off: auto_sms key 'orphan_autosync' (enabled=false pauses). Default ON.
// Manual: GET ?dry=1 → lists orphans, syncs nothing.
// Schedule: every 15 min. Env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY,
//   URL/PUBLIC_SITE_URL. Optional: ADMIN_ALERT_PHONE.

const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const PER_RUN = 50;

exports.handler = async (event) => {
  if (!SB_URL || !SB_KEY) return json(500, { ok: false, error: "Missing Supabase env" });
  const sb = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" };
  const dry = (event?.queryStringParameters || {}).dry === "1";
  const base = (process.env.URL || process.env.PUBLIC_SITE_URL || "").replace(/\/$/, "");

  if (!dry && !(await flagEnabled(sb, "orphan_autosync"))) return json(200, { ok: true, paused: true });

  // Orphans: signed, not cancelled, no JN job — any result.
  const orphans = await get(
    `${SB_URL}/rest/v1/inspections?signed_at=not.is.null&jn_job_id=is.null&cancelled_at=is.null` +
      `&select=id,client_name,address,city,state,zip,signed_at,result&order=signed_at.desc&limit=${PER_RUN}`,
    sb,
  );
  if (!orphans.length) return json(200, { ok: true, orphans: 0, synced: 0, failed: 0 });
  if (dry) return json(200, { ok: true, dry: true, orphans: orphans.length, list: orphans.map((o) => ({ name: o.client_name, addr: o.address, result: o.result })) });

  if (!base) return json(500, { ok: false, error: "No base URL — can't call retry-jn-sync" });

  const synced = [], failed = [];
  for (const o of orphans) {
    try {
      const r = await fetch(`${base}/.netlify/functions/retry-jn-sync`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ inspectionId: o.id }),
      });
      const b = await r.json().catch(() => ({}));
      if (r.ok && b.ok && b.jobId) synced.push(o);
      else failed.push({ ...o, error: b.error || `HTTP ${r.status}` });
    } catch (e) { failed.push({ ...o, error: e.message }); }
  }

  // Only text the admin about ones that STILL aren't in JN (need a human).
  let alerted = false;
  if (failed.length) {
    const admins = String(process.env.ADMIN_ALERT_PHONE || "").split(",").map((s) => s.trim()).filter(Boolean);
    if (base && admins.length) {
      const lines = failed.slice(0, 20).map((o) => `• ${o.client_name || "(no name)"}${o.address ? ` — ${o.address}` : ""}`);
      const msg =
        `⚠️ ${failed.length} signing${failed.length === 1 ? "" : "s"} still NOT in JobNimbus after auto-sync ` +
        `(${synced.length} auto-fixed this run). These need a manual Sync / JN check:\n\n` + lines.join("\n");
      for (const a of admins) { await sendSms(base, a, "Admin", msg); alerted = true; }
    }
  }

  console.log(`cron-sync-orphans: orphans=${orphans.length} synced=${synced.length} failed=${failed.length}`);
  return json(200, { ok: true, orphans: orphans.length, synced: synced.length, failed: failed.length, alerted });
};

async function flagEnabled(sb, key) {
  try {
    const rows = await get(`${SB_URL}/rest/v1/auto_sms?key=eq.${encodeURIComponent(key)}&select=enabled&limit=1`, sb);
    return !rows[0] || rows[0].enabled !== false;
  } catch { return true; }
}
async function sendSms(base, to, name, message) {
  try {
    const r = await fetch(`${base}/.netlify/functions/ghl-sms`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to, name, message }),
    });
    return r.ok;
  } catch { return false; }
}
async function get(url, headers) {
  const r = await fetch(url, { headers });
  if (!r.ok) { console.warn(`query ${r.status}`); return []; }
  return await r.json().catch(() => []);
}
function json(status, body) {
  return { statusCode: status, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

exports.config = { schedule: "*/15 * * * *" };
