// netlify/functions/all-retail-conversions.js
//
// Company-wide back-to-retail CONVERSIONS — every zone's wins in one view, for
// the admin "Regional Managers" page. Same data as zone-retail-conversions
// (retail_status_tracking, snapshotted by cron-track-retail-status) but across
// all zones, grouped zone → rep → deal, appointments flagged.
//
// GET [?days=90]
// → { ok, days, total, appointments, zones:[{ zone, count, appt_count,
//      reps:[{ rep, count, appt_count, deals:[{ customer, address,
//      converted_to, appointment, converted_label }] }] }] }
//
// Env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY.

const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const sb = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` };
const ZONE_ORDER = ["Zone 1", "Zone 2", "Zone 3", "Zone 4", "Unassigned"];

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return cors(200, "");
  if (event.httpMethod !== "GET") return cors(405, JSON.stringify({ ok: false, error: "Method Not Allowed" }));
  if (!SB_URL || !SB_KEY) return cors(500, JSON.stringify({ ok: false, error: "Supabase env missing" }));

  const qp = event.queryStringParameters || {};
  const days = Math.min(Math.max(parseInt(qp.days, 10) || 90, 7), 365);
  const since = new Date(Date.now() - days * 864e5).toISOString();

  try {
    const rows = await sbGet(
      `retail_status_tracking?converted_at=gte.${encodeURIComponent(since)}&converted_at=not.is.null` +
      `&select=client_name,address,zone,sales_rep_name,converted_to,appointment,converted_at&order=converted_at.desc&limit=5000`
    );

    let appointments = 0;
    const zoneMap = {}; // zone -> { rep -> deals[] }
    for (const r of rows) {
      const zone = r.zone || "Unassigned";
      const rep = (r.sales_rep_name || "").trim() || "(no rep)";
      if (r.appointment) appointments++;
      (zoneMap[zone] = zoneMap[zone] || {});
      (zoneMap[zone][rep] = zoneMap[zone][rep] || []).push({
        customer: (r.client_name || "—").trim(),
        address: r.address || "",
        converted_to: r.converted_to || "(changed)",
        appointment: !!r.appointment,
        converted_label: r.converted_at ? dateLabel(new Date(r.converted_at)) : "—",
        converted_at: r.converted_at,
      });
    }

    const zones = Object.entries(zoneMap).map(([zone, repMap]) => {
      const reps = Object.entries(repMap).map(([rep, deals]) => ({
        rep, count: deals.length,
        appt_count: deals.filter((d) => d.appointment).length,
        deals: deals.sort((a, b) => (b.converted_at || "").localeCompare(a.converted_at || "")),
      })).sort((a, b) => b.appt_count - a.appt_count || b.count - a.count || a.rep.localeCompare(b.rep));
      return {
        zone,
        count: reps.reduce((s, r) => s + r.count, 0),
        appt_count: reps.reduce((s, r) => s + r.appt_count, 0),
        reps,
      };
    }).sort((a, b) => ZONE_ORDER.indexOf(a.zone) - ZONE_ORDER.indexOf(b.zone));

    return cors(200, JSON.stringify({ ok: true, days, total: rows.length, appointments, zones }));
  } catch (e) {
    return cors(500, JSON.stringify({ ok: false, error: e.message || "error" }));
  }
};

async function sbGet(path) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: sb });
  if (!r.ok) return [];
  return r.json().catch(() => []);
}
function dateLabel(date) {
  const d = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric" }).format(date);
  const t = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" }).format(date);
  return `${d}, ${t}`;
}
function cors(status, body) {
  return {
    statusCode: status,
    headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=120", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" },
    body,
  };
}
