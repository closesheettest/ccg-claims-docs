// netlify/functions/zone-retail-conversions.js
//
// "Back-to-retail conversions" for a regional manager — the wins the live
// back-to-retail report can't show, because a deal drops off that list the
// moment it leaves "Sit Sold Insp". cron-track-retail-status snapshots those
// transitions into retail_status_tracking; this reads them back per zone,
// grouped by rep, so a manager can see which reps actually got their
// back-to-retail leads back on the calendar.
//
// GET ?zone=Zone%203[&days=90]
// → { ok, zone, days, total, appointments, reps:[{ rep, count, appt_count,
//      deals:[{ customer, address, converted_to, appointment, converted_label }] }] }
//
// Env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY.

const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const sb = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` };

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return cors(200, "");
  if (event.httpMethod !== "GET") return cors(405, JSON.stringify({ ok: false, error: "Method Not Allowed" }));
  if (!SB_URL || !SB_KEY) return cors(500, JSON.stringify({ ok: false, error: "Supabase env missing" }));

  const qp = event.queryStringParameters || {};
  const zone = (qp.zone || "").trim();
  if (!zone) return cors(400, JSON.stringify({ ok: false, error: "zone required" }));
  const days = Math.min(Math.max(parseInt(qp.days, 10) || 90, 7), 365);
  const since = new Date(Date.now() - days * 864e5).toISOString();

  try {
    const rows = await sbGet(
      `retail_status_tracking?zone=eq.${encodeURIComponent(zone)}&converted_at=gte.${encodeURIComponent(since)}` +
      `&converted_at=not.is.null&select=client_name,address,sales_rep_name,converted_to,appointment,converted_at&order=converted_at.desc&limit=2000`
    );

    const byRep = {};
    let appointments = 0;
    for (const r of rows) {
      const rep = (r.sales_rep_name || "").trim() || "(no rep)";
      if (r.appointment) appointments++;
      (byRep[rep] = byRep[rep] || []).push({
        customer: (r.client_name || "—").trim(),
        address: r.address || "",
        converted_to: r.converted_to || "(changed)",
        appointment: !!r.appointment,
        converted_label: r.converted_at ? dateLabel(new Date(r.converted_at)) : "—",
        converted_at: r.converted_at,
      });
    }

    const reps = Object.entries(byRep)
      .map(([rep, deals]) => ({
        rep, count: deals.length,
        appt_count: deals.filter((d) => d.appointment).length,
        deals: deals.sort((a, b) => (b.converted_at || "").localeCompare(a.converted_at || "")),
      }))
      .sort((a, b) => b.appt_count - a.appt_count || b.count - a.count || a.rep.localeCompare(b.rep));

    return cors(200, JSON.stringify({ ok: true, zone, days, total: rows.length, appointments, reps }));
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
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=120",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
    body,
  };
}
