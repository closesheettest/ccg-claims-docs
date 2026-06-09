// netlify/functions/cron-pa-company-stale.js
//
// Daily nudge to PA COMPANY admins about homeowners that aren't being worked.
// For each active company, any deal in their pool that has sat 48h+ without
// being OPENED or TOUCHED (no pa_opened_at, no notes) — whether still
// unassigned or assigned to a PA who's ignoring it — gets listed in a text to
// that company's admin. Quiet when a company has nothing stale.
//
// "Stale" = pa_company_at older than 48h AND pa_opened_at IS NULL AND no
// notes logged. Re-sends daily until the deals get worked (so they don't rot).
//
// On/off: auto_sms key 'pa_stale_alert' (enabled=false pauses). Default ON.
// Manual run: GET ?dry=1 → returns JSON, sends nothing.
// Schedule: 0 12 * * * UTC = 8 AM EDT (after the 7 AM sales audit).
//
// Required env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY.
//   Optional: URL/PUBLIC_SITE_URL (for ghl-sms).

const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const STALE_HOURS = 48;

exports.handler = async (event) => {
  if (!SB_URL || !SB_KEY) return json(500, { ok: false, error: "Missing Supabase env" });
  const sb = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" };
  const dry = (event?.queryStringParameters || {}).dry === "1";
  const base = (process.env.URL || process.env.PUBLIC_SITE_URL || "").replace(/\/$/, "");

  if (!dry && !(await flagEnabled(sb, "pa_stale_alert"))) {
    return json(200, { ok: true, paused: true });
  }

  const companies = await get(`${SB_URL}/rest/v1/pa_companies?select=id,name,admin_name,admin_phone&active=eq.true`, sb);
  const cutoffIso = new Date(Date.now() - STALE_HOURS * 3600000).toISOString();
  const now = Date.now();

  const report = [];
  for (const c of companies) {
    // Open pool deals that have sat 48h+ and were never opened.
    const deals = await get(
      `${SB_URL}/rest/v1/inspections?pa_company_id=eq.${c.id}` +
        `&cancelled_at=is.null&or=(pa_stage.is.null,pa_stage.neq.dead)` +
        `&pa_opened_at=is.null&pa_company_at=lt.${encodeURIComponent(cutoffIso)}` +
        `&select=id,client_name,pa_id,pa_company_at,pa_notes_log&order=pa_company_at.asc&limit=200`,
      sb,
    );
    // Belt-and-suspenders: also require no notes (truly untouched).
    const stale = (deals || []).filter((d) => !Array.isArray(d.pa_notes_log) || d.pa_notes_log.length === 0);
    if (!stale.length) continue;

    const lines = stale.map((d) => {
      const hrs = d.pa_company_at ? Math.floor((now - new Date(d.pa_company_at).getTime()) / 3600000) : null;
      const who = d.pa_id ? " (assigned)" : " (unassigned)";
      return `• ${d.client_name || "(no name)"}${who}${hrs != null ? ` — ${hrs}h` : ""}`;
    });
    const msg =
      `⚠️ ${c.name}: ${stale.length} homeowner${stale.length === 1 ? "" : "s"} not being worked (48h+):\n\n` +
      lines.join("\n") +
      `\n\nOpen your admin page to assign / follow up.`;

    let sent = null;
    if (!dry && base && c.admin_phone) {
      sent = await sendSms(base, c.admin_phone, c.admin_name || "Admin", msg);
    }
    report.push({ company: c.name, stale: stale.length, has_phone: !!c.admin_phone, sent: dry ? "(dry)" : (sent?.ok ? "yes" : sent?.error || "no") });
  }

  return json(200, { ok: true, dry, companies: companies.length, alerted: report.length, report });
};

async function flagEnabled(sb, key) {
  try {
    const rows = await get(`${SB_URL}/rest/v1/auto_sms?key=eq.${encodeURIComponent(key)}&select=enabled&limit=1`, sb);
    return !rows[0] || rows[0].enabled !== false; // default ON
  } catch { return true; }
}

async function sendSms(base, to, name, message) {
  try {
    const r = await fetch(`${base}/.netlify/functions/ghl-sms`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to, name, message }),
    });
    const rb = await r.json().catch(() => ({}));
    return { ok: r.ok, error: r.ok ? undefined : (rb.error || `status ${r.status}`) };
  } catch (e) { return { ok: false, error: e.message }; }
}

async function get(url, headers) {
  const r = await fetch(url, { headers });
  if (!r.ok) { console.warn(`query ${r.status}: ${(await r.text().catch(() => "")).slice(0, 160)}`); return []; }
  return await r.json().catch(() => []);
}

function json(status, body) {
  return { statusCode: status, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

exports.config = { schedule: "0 12 * * *" };
