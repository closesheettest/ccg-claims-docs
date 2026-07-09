// netlify/functions/admin-pa-appointments.js
//
// Admin tool to inspect + resolve duplicate PA appointments (a homeowner booked
// to two PAs). Server-side (env creds) — no company token needed.
//
//   GET  ?homeowner=<name>
//     → { ok, appts:[{ id, pa_id, pa_name, start_at, homeowner_name,
//          homeowner_phone, inspection_id, status }] }   (scheduled only)
//
//   POST { cancel_ids:[...], keep_pa_id?, inspection_id?, reason? }
//     → cancels those pa_appointments (status=cancelled), and (when keep_pa_id +
//        inspection_id given) reassigns the inspection to the kept PA.
//
// Env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY.

const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const sb = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" };

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return cors(200, "");
  if (!SB_URL || !SB_KEY) return cors(500, JSON.stringify({ ok: false, error: "Missing env" }));

  try {
    if (event.httpMethod === "GET") {
      const name = String((event.queryStringParameters || {}).homeowner || "").trim();
      if (!name) return cors(400, JSON.stringify({ ok: false, error: "homeowner required" }));
      const like = encodeURIComponent(`*${name.replace(/[%*(),]/g, " ").trim()}*`);
      const rows = await sbGet(`pa_appointments?status=eq.scheduled&homeowner_name=ilike.${like}&select=id,pa_id,start_at,homeowner_name,homeowner_phone,address,inspection_id,status&order=start_at`);
      const paIds = [...new Set(rows.map((r) => r.pa_id).filter(Boolean))];
      const paName = {};
      if (paIds.length) for (const p of await sbGet(`pas?id=in.(${paIds.map((x) => `"${x}"`).join(",")})&select=id,name`)) paName[p.id] = p.name;
      return cors(200, JSON.stringify({ ok: true, appts: rows.map((r) => ({ ...r, pa_name: paName[r.pa_id] || null })) }));
    }

    if (event.httpMethod === "POST") {
      let body = {}; try { body = JSON.parse(event.body || "{}"); } catch { return cors(400, JSON.stringify({ ok: false, error: "bad JSON" })); }
      const cancelIds = Array.isArray(body.cancel_ids) ? body.cancel_ids : [];
      const reason = String(body.reason || "Duplicate appointment — removed").slice(0, 200);
      let cancelled = 0;
      for (const id of cancelIds) {
        const r = await fetch(`${SB_URL}/rest/v1/pa_appointments?id=eq.${encodeURIComponent(id)}`, {
          method: "PATCH", headers: { ...sb, Prefer: "return=minimal" },
          body: JSON.stringify({ status: "cancelled", notes: reason }),
        });
        if (r.ok) cancelled++;
      }
      let reassigned = false;
      if (body.inspection_id && body.keep_pa_id) {
        const r = await fetch(`${SB_URL}/rest/v1/inspections?id=eq.${encodeURIComponent(body.inspection_id)}`, {
          method: "PATCH", headers: { ...sb, Prefer: "return=minimal" },
          body: JSON.stringify({ pa_id: body.keep_pa_id, pa_company_id: null }),
        });
        reassigned = r.ok;
      }
      return cors(200, JSON.stringify({ ok: true, cancelled, reassigned }));
    }

    return cors(405, JSON.stringify({ ok: false, error: "GET or POST" }));
  } catch (e) {
    return cors(500, JSON.stringify({ ok: false, error: e.message || "error" }));
  }
};

async function sbGet(path) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: sb });
  if (!r.ok) return [];
  return r.json().catch(() => []);
}
function cors(status, body) {
  return { statusCode: status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" }, body };
}
