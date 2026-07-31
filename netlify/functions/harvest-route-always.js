// netlify/functions/harvest-route-always.js
//
// Manager permission: let a rep use "Route an area" ANY time — even with an
// appointment today or required go-back stops — instead of being forced into
// Start-my-day + the manager's plan. Default OFF; a manager flips it on for reps
// who've earned the trust. The map (CanvassMap) reads sales_reps.harvest_route_always
// through harvest-pins auth. Toggled per rep from the Regional-Manager dashboard.
//
//   GET  ?jn_ids=a,b,c            → { ok, flags: { <jobnimbus_id>: bool } }   (dashboard reads current state)
//   POST { rep_id? , jn_id?, on } → { ok, on }                                (set one rep)
//
// CORS-open (the TMS dashboard is a separate origin), same unauthenticated shape
// as harvest-gobacks-only. Env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY.

export const handler = async (event) => {
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
  if (event.httpMethod === "OPTIONS") return json(200, {});
  if (!SB_URL || !SB_KEY) return json(500, { ok: false, error: "Missing Supabase env" });
  const sb = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" };

  // Batch read — the dashboard passes its reps' JobNimbus ids to show each toggle's state.
  if (event.httpMethod === "GET") {
    const jnIds = String((event.queryStringParameters || {}).jn_ids || "").split(",").map((s) => s.trim()).filter(Boolean);
    if (!jnIds.length) return json(200, { ok: true, flags: {} });
    const inList = jnIds.map((id) => `"${id}"`).join(",");
    try {
      const r = await fetch(`${SB_URL}/rest/v1/sales_reps?jobnimbus_id=in.(${encodeURIComponent(inList)})&select=jobnimbus_id,harvest_route_always`, { headers: sb });
      const rows = r.ok ? await r.json().catch(() => []) : [];
      const flags = {};
      for (const row of rows) if (row.jobnimbus_id) flags[row.jobnimbus_id] = !!row.harvest_route_always;
      return json(200, { ok: true, flags });
    } catch (e) { return json(500, { ok: false, error: e.message || "error" }); }
  }

  if (event.httpMethod !== "POST") return json(405, { ok: false, error: "GET or POST" });
  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { return json(400, { ok: false, error: "bad JSON" }); }
  const repId = String(body.rep_id || "").trim();
  const jnId = String(body.jn_id || "").trim();
  const on = body.on === true || body.on === "true";
  if (!repId && !jnId) return json(400, { ok: false, error: "rep_id or jn_id required" });
  const filter = repId ? `id=eq.${encodeURIComponent(repId)}` : `jobnimbus_id=eq.${encodeURIComponent(jnId)}`;
  try {
    const r = await fetch(`${SB_URL}/rest/v1/sales_reps?${filter}`, {
      method: "PATCH", headers: { ...sb, Prefer: "return=representation" },
      body: JSON.stringify({ harvest_route_always: on }),
    });
    if (!r.ok) return json(500, { ok: false, error: (await r.text().catch(() => "")).slice(0, 300) || "update failed" });
    const row = (await r.json().catch(() => []))[0] || {};
    return json(200, { ok: true, on: !!row.harvest_route_always });
  } catch (e) {
    return json(500, { ok: false, error: e.message || "error" });
  }
};

function json(statusCode, obj) {
  return { statusCode, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" }, body: JSON.stringify(obj) };
}
