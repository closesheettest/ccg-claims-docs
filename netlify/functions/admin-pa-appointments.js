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
    const qp = event.queryStringParameters || {};

    // ?scan_dupes=1 → every homeowner with 2+ SCHEDULED appointments across
    // DIFFERENT PAs (i.e. assigned to more than one PA). The cleanup worklist.
    if (event.httpMethod === "GET" && qp.scan_dupes) {
      const rows = await sbGet(`pa_appointments?status=eq.scheduled&select=id,pa_id,homeowner_name,homeowner_phone,address,start_at,inspection_id&order=start_at&limit=5000`);
      const paIds = [...new Set(rows.map((r) => r.pa_id).filter(Boolean))];
      const paName = {};
      for (let i = 0; i < paIds.length; i += 80) for (const p of await sbGet(`pas?id=in.(${paIds.slice(i, i + 80).map((x) => `"${x}"`).join(",")})&select=id,name,pa_company_id`)) paName[p.id] = p.name;
      const key = (r) => (r.homeowner_phone || "").replace(/\D/g, "").slice(-10) || (r.homeowner_name || "").trim().toLowerCase();
      const groups = {};
      for (const r of rows) { const k = key(r); if (k) (groups[k] = groups[k] || []).push(r); }
      const dupes = [];
      for (const [k, appts] of Object.entries(groups)) {
        const pas = new Set(appts.map((a) => a.pa_id));
        if (appts.length > 1 && pas.size > 1) {
          dupes.push({ homeowner: appts[0].homeowner_name, phone: appts[0].homeowner_phone || null, count: appts.length,
            appts: appts.map((a) => ({ id: a.id, pa: paName[a.pa_id] || a.pa_id, start_at: a.start_at, inspection_id: a.inspection_id })) });
        }
      }
      return cors(200, JSON.stringify({ ok: true, total_scheduled: rows.length, multi_pa: dupes.length, dupes }));
    }

    // ?inspection=<name> → the inspection(s) + current PA/company assignment.
    if (event.httpMethod === "GET" && qp.inspection) {
      const like = encodeURIComponent(`*${String(qp.inspection).replace(/[%*(),]/g, " ").trim()}*`);
      const rows = await sbGet(`inspections?client_name=ilike.${like}&select=id,client_name,pa_id,pa_company_id,pa_stage,cancelled_at,result&limit=20`);
      const paIds = [...new Set(rows.map((r) => r.pa_id).filter(Boolean))];
      const coIds = [...new Set(rows.map((r) => r.pa_company_id).filter(Boolean))];
      const paName = {}, coName = {};
      if (paIds.length) for (const p of await sbGet(`pas?id=in.(${paIds.map((x) => `"${x}"`).join(",")})&select=id,name,pa_company_id`)) paName[p.id] = { name: p.name, company: p.pa_company_id };
      if (coIds.length) for (const c of await sbGet(`pa_companies?id=in.(${coIds.map((x) => `"${x}"`).join(",")})&select=id,name`)) coName[c.id] = c.name;
      return cors(200, JSON.stringify({ ok: true, inspections: rows.map((r) => ({ ...r, pa_name: (paName[r.pa_id] || {}).name || null, pa_company_name: coName[r.pa_company_id] || null })) }));
    }

    // ?companies=1 → companies + their PAs (to find a reassignment target).
    if (event.httpMethod === "GET" && qp.companies) {
      const cos = await sbGet("pa_companies?select=id,name&order=name");
      const pas = await sbGet("pas?select=id,name,pa_company_id&order=name&limit=1000");
      return cors(200, JSON.stringify({ ok: true, companies: cos, pas }));
    }

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

      // Reassign an inspection to a PA and/or company, and set its pa_stage
      // (e.g. reactivate a wrongly-dead deal). Pass pa_id/pa_company_id (or null),
      // and optionally pa_stage.
      if (body.reassign) {
        const rq = body.reassign;
        if (!rq.inspection_id) return cors(400, JSON.stringify({ ok: false, error: "reassign.inspection_id required" }));
        const patch = {};
        if ("pa_id" in rq) { patch.pa_id = rq.pa_id || null; patch.pa_claimed_at = rq.pa_id ? new Date().toISOString() : null; }
        if ("pa_company_id" in rq) patch.pa_company_id = rq.pa_company_id || null;
        if (rq.pa_stage) { patch.pa_stage = rq.pa_stage; patch.pa_stage_at = new Date().toISOString(); }
        const r = await fetch(`${SB_URL}/rest/v1/inspections?id=eq.${encodeURIComponent(rq.inspection_id)}`, {
          method: "PATCH", headers: { ...sb, Prefer: "return=minimal" }, body: JSON.stringify(patch),
        });
        return cors(r.ok ? 200 : 500, JSON.stringify({ ok: r.ok, patch }));
      }

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
