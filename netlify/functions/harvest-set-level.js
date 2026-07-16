// netlify/functions/harvest-set-level.js
//
// Office control: set a rep's Harvesting-Map access level (view-all admin, or
// senior/junior), or clear the override. Called from the Rep Links page.
//
//   POST { rep_id, level }   level ∈ 'admin' | 'senior' | 'junior' | 'none'
//   → { ok, rep:{ id, name, level, link } }
//
// 'none' clears the override (rep falls back to their rep-zones level). If the
// rep has no harvest_token yet, one is minted so they immediately get a link.
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
  const repId = (body.rep_id || "").trim();
  const raw = (body.level || "").toLowerCase().trim();
  if (!repId) return json(400, { ok: false, error: "rep_id required" });
  const level = raw === "none" ? null : (["admin", "senior", "junior"].includes(raw) ? raw : undefined);
  if (level === undefined) return json(400, { ok: false, error: "level must be admin|senior|junior|none" });

  const base = (process.env.URL || process.env.PUBLIC_SITE_URL || "https://free-roof-inspections.netlify.app").replace(/\/$/, "");

  try {
    const cur = await sbGet(SB_URL, sb, `sales_reps?id=eq.${encodeURIComponent(repId)}&select=id,name,harvest_token&limit=1`);
    const rep = cur[0];
    if (!rep) return json(404, { ok: false, error: "rep not found" });

    const patch = { harvest_level: level };
    // Mint a token if they don't have one, so the link works right away.
    if (!rep.harvest_token) patch.harvest_token = crypto.randomUUID();

    const upRes = await fetch(`${SB_URL}/rest/v1/sales_reps?id=eq.${encodeURIComponent(repId)}`, {
      method: "PATCH",
      headers: { ...sb, Prefer: "return=representation" },
      body: JSON.stringify(patch),
    });
    if (!upRes.ok) return json(500, { ok: false, error: (await upRes.text().catch(() => "")).slice(0, 300) || "update failed" });
    const updated = (await upRes.json().catch(() => []))[0] || {};
    const token = updated.harvest_token || rep.harvest_token;

    return json(200, {
      ok: true,
      rep: {
        id: repId,
        name: updated.name || rep.name,
        level: level || null,
        link: token ? `${base}/?mode=harvest&rt=${token}` : "",
      },
    });
  } catch (e) {
    return json(500, { ok: false, error: e.message || "error" });
  }
};

async function sbGet(url, headers, path) {
  const r = await fetch(`${url}/rest/v1/${path}`, { headers });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

function json(statusCode, obj) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) };
}
