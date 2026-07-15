// netlify/functions/harvest-rep-links.js
//
// Office roster for the Harvesting Map: every active rep with their level
// (senior/junior, from rep-zones) and their personal map link — so the office
// can hand each rep their link. Also returns the office "view-all" link.
//
//   GET → { ok, base, admin_link, reps:[{ name, level, link }] }
//
// Env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY

const REP_ZONES_URL = "https://trainingmanagementsys.netlify.app/.netlify/functions/rep-zones?include_inactive=1";

export const handler = async (event) => {
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
  if (!SB_URL || !SB_KEY) return json(500, { ok: false, error: "Missing Supabase env" });
  const sbH = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` };
  const sbGet = async (path) => {
    const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: sbH });
    if (!r.ok) throw new Error(await r.text());
    return r.json();
  };

  const base = (process.env.URL || process.env.PUBLIC_SITE_URL || "https://free-roof-inspections.netlify.app").replace(/\/$/, "");

  try {
    const [reps, adminRow, rz] = await Promise.all([
      sbGet(`sales_reps?active=eq.true&select=name,jobnimbus_id,harvest_token&order=name`),
      sbGet(`app_settings?key=eq.harvest_admin_token&select=value&limit=1`),
      fetch(REP_ZONES_URL).then((r) => (r.ok ? r.json() : { reps: [] })).catch(() => ({ reps: [] })),
    ]);
    // Only ACTIVE field reps (rep-zones active flag) — sales_reps.active is set
    // on nearly everyone, so it's not a real "currently working" signal.
    const infoByJn = {};
    for (const r of (rz.reps || [])) {
      if (!r.active || !r.jobnimbus_id) continue;
      const lv = (r.rep_level || "").toLowerCase();
      infoByJn[r.jobnimbus_id] = {
        level: (lv === "senior" || lv === "junior") ? lv : "junior",
        region: (r.zone || "").toString().trim() || null,
      };
    }
    const levelRank = (lv) => (lv === "senior" ? 0 : 1); // senior first
    const out = (reps || [])
      .filter((r) => r.harvest_token && r.jobnimbus_id && infoByJn[r.jobnimbus_id])
      .map((r) => ({
        name: r.name,
        level: infoByJn[r.jobnimbus_id].level,
        region: infoByJn[r.jobnimbus_id].region,
        link: `${base}/?mode=harvest&rt=${r.harvest_token}`,
      }))
      // Sort: region → level (senior, then junior) → name (alphabetical).
      .sort((a, b) =>
        (a.region || "~").localeCompare(b.region || "~") ||
        (levelRank(a.level) - levelRank(b.level)) ||
        String(a.name || "").localeCompare(String(b.name || "")));
    const adminTok = adminRow?.[0]?.value || "";
    return json(200, { ok: true, base, admin_link: adminTok ? `${base}/?mode=harvest&admin=${adminTok}` : "", reps: out });
  } catch (e) {
    return json(500, { ok: false, error: e.message || "error" });
  }
};

function json(statusCode, obj) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) };
}
