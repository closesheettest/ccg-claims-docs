// netlify/functions/inspect-pins.js
//
// Auth + pin loader for the INSPECTION MAP (?mode=inspectmap&it=<map_token>).
// Resolves an inspector by their map_token, and returns the inspections that
// still NEED inspecting — EXCLUDING any that another inspector has route-locked
// (a fresh route_claim that isn't this inspector's). Office view: ?admin=<token>.
//
//   GET ?it=<map_token>&authonly=1        → { ok, inspector:{id,name,lat,lng,...} }
//   GET ?it=<map_token>[&n&s&e&w]         → { ok, inspector, pins:[...] }
//   GET ?admin=<harvest_admin_token>...   → office view (sees all, no lock)
//
// Env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY

const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const sbH = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` };
const CLAIM_MS = 30 * 60 * 1000; // a route claim older than 30 min is stale → reopens
const isUuid = (s) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
const PIN_FIELDS = "id,client_name,address,city,state,zip,latitude,longitude,result,inspector_id,cancel_review_pending,sales_rep_name,mobile,email,jn_job_id,signed_at,route_claim_by,route_claim_by_jn,route_claim_at,inspector_notes";

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return cors(200, "");
  if (!SB_URL || !SB_KEY) return cors(500, JSON.stringify({ ok: false, error: "Missing Supabase env" }));
  const sbGet = async (path) => { const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: sbH }); if (!r.ok) return []; return r.json().catch(() => []); };

  const p = event.queryStringParameters || {};
  const it = (p.it || "").trim();
  const adminTok = (p.admin || "").trim();

  // Resolve identity.
  let inspector = null, isAdmin = false;
  try {
    if (adminTok) {
      const s = await sbGet(`app_settings?key=eq.harvest_admin_token&select=value&limit=1`);
      if (s[0]?.value && s[0].value === adminTok) { isAdmin = true; inspector = { id: null, name: "Office", level: "admin" }; }
    }
    if (!isAdmin && it && isUuid(it)) {
      const rows = await sbGet(`inspectors?map_token=eq.${encodeURIComponent(it)}&select=id,name,latitude,longitude,jn_user_id,active&limit=1`);
      if (rows[0]) inspector = { id: rows[0].id, name: rows[0].name || "Inspector", latitude: rows[0].latitude, longitude: rows[0].longitude, jn_id: rows[0].jn_user_id || null };
    }
  } catch (e) { return cors(500, JSON.stringify({ ok: false, error: e.message || "lookup failed" })); }
  if (!inspector) return cors(401, JSON.stringify({ ok: false, error: "This link isn't valid. Ask the office for your inspector map link." }));

  if (/^(1|true|yes)$/i.test((p.authonly || "").trim())) {
    return cors(200, JSON.stringify({ ok: true, inspector }));
  }

  // "Roofs Inspected" — this inspector's COMPLETED inspections (result set), most
  // recent first. Office view (admin) sees everyone's. Powers the map's report.
  if (/^(1|true|yes)$/i.test((p.done || "").trim())) {
    const who = isAdmin ? "" : `&inspector_id=eq.${encodeURIComponent(inspector.id)}`;
    const done = await sbGet(
      `inspections?result=not.is.null${who}&select=id,client_name,address,city,state,zip,result,result_at,signed_at,sales_rep_name&order=result_at.desc.nullslast&limit=500`,
    );
    return cors(200, JSON.stringify({ ok: true, inspector, inspected: done }));
  }

  // Load inspections that still need inspecting, within the viewport (or a newest
  // sample). result IS NULL, not cancelled, geocoded.
  const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
  const n = num(p.n), s = num(p.s), e = num(p.e), w = num(p.w);
  const hasBox = n != null && s != null && e != null && w != null && n > s && e > w;
  const box = hasBox ? `&latitude=gte.${s}&latitude=lte.${n}&longitude=gte.${w}&longitude=lte.${e}` : "";
  const rows = await sbGet(`inspections?result=is.null&cancelled_at=is.null&latitude=not.is.null${box}&select=${PIN_FIELDS}&order=signed_at.desc.nullslast&limit=2000`);

  const now = Date.now();
  const lockedByOther = (r) => {
    if (isAdmin) return false; // office sees everything
    if (!r.route_claim_at) return false;
    if (now - new Date(r.route_claim_at).getTime() > CLAIM_MS) return false; // stale → reopened
    const mine = (inspector.jn_id && r.route_claim_by_jn === String(inspector.jn_id)) || (inspector.name && r.route_claim_by === inspector.name);
    return !mine;
  };
  const pins = rows
    .filter((r) => !r.cancel_review_pending && r.latitude != null && r.longitude != null)
    .filter((r) => !lockedByOther(r));

  return cors(200, JSON.stringify({ ok: true, inspector, pins }));
};

function cors(status, body) {
  return { statusCode: status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" }, body };
}
