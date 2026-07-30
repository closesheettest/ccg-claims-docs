// netlify/functions/harvest-gobacks-only.js
//
// Manager override: set a rep's Door Dispatcher map to GO-BACKS ONLY (or clear it).
// When on, that rep's map shows only their post-inspection go-backs — no IQ /
// inspection-lead / harvest work. Called per-rep from the Rep Links page; the
// "whole team" button loops this over each rep in a region.
//
//   POST { rep_id, on: true|false }
//   → { ok, rep_id, gobacks_only }
//
// Env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY

export const handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { ok: false, error: "POST only" });
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
  if (!SB_URL || !SB_KEY) return json(500, { ok: false, error: "Missing Supabase env" });
  const sb = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" };

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { return json(400, { ok: false, error: "bad JSON" }); }
  const repId = String(body.rep_id || "").trim();
  const on = body.on === true || body.on === "true";
  if (!repId) return json(400, { ok: false, error: "rep_id required" });

  try {
    const r = await fetch(`${SB_URL}/rest/v1/sales_reps?id=eq.${encodeURIComponent(repId)}`, {
      method: "PATCH",
      headers: { ...sb, Prefer: "return=representation" },
      body: JSON.stringify({ harvest_gobacks_only: on }),
    });
    if (!r.ok) return json(500, { ok: false, error: (await r.text().catch(() => "")).slice(0, 300) || "update failed" });
    const row = (await r.json().catch(() => []))[0] || {};
    return json(200, { ok: true, rep_id: repId, gobacks_only: !!row.harvest_gobacks_only });
  } catch (e) {
    return json(500, { ok: false, error: e.message || "error" });
  }
};

function json(statusCode, obj) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) };
}
