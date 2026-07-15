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
    const levelByJn = {};
    for (const r of (rz.reps || [])) {
      const lv = (r.rep_level || "").toLowerCase();
      if (r.jobnimbus_id) levelByJn[r.jobnimbus_id] = (lv === "senior" || lv === "junior") ? lv : "junior";
    }
    const out = (reps || [])
      .filter((r) => r.harvest_token)
      .map((r) => ({
        name: r.name,
        level: r.jobnimbus_id ? (levelByJn[r.jobnimbus_id] || "junior") : "junior",
        link: `${base}/?mode=harvest&rt=${r.harvest_token}`,
      }));
    const adminTok = adminRow?.[0]?.value || "";
    return json(200, { ok: true, base, admin_link: adminTok ? `${base}/?mode=harvest&admin=${adminTok}` : "", reps: out });
  } catch (e) {
    return json(500, { ok: false, error: e.message || "error" });
  }
};

function json(statusCode, obj) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) };
}
