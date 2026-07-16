// netlify/functions/harvest-rep-links.js
//
// Office roster for the Harvesting Map. Returns everyone with a personal map
// link, split into two lists the office can hand out:
//   • admins → view-all links (harvest_level='admin')
//   • reps   → level links (senior/junior)
// plus the office "view-all" link. The effective level is the office override
// (sales_reps.harvest_level) when set, else the rep-zones level, else junior.
//
//   GET → { ok, base, admin_link, admins:[...], reps:[...], all:[...] }
//     each entry: { id, name, level, override, region, active, link }
//     all[] = every sales_rep (id, name, has_token) for the "assign someone" picker
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
    // Pull every rep (name/token/level). harvest_level may not exist yet — fall
    // back to the base select so this keeps working before the migration runs.
    const allReps = await sbGet(`sales_reps?select=id,name,jobnimbus_id,harvest_token,active,harvest_level&order=name`).catch(() =>
      sbGet(`sales_reps?select=id,name,jobnimbus_id,harvest_token,active&order=name`));

    const [adminRow, rz] = await Promise.all([
      sbGet(`app_settings?key=eq.harvest_admin_token&select=value&limit=1`).catch(() => []),
      fetch(REP_ZONES_URL).then((r) => (r.ok ? r.json() : { reps: [] })).catch(() => ({ reps: [] })),
    ]);

    const infoByJn = {};
    for (const r of (rz.reps || [])) {
      if (!r.active || !r.jobnimbus_id) continue;
      const lv = (r.rep_level || "").toLowerCase();
      infoByJn[r.jobnimbus_id] = {
        level: (lv === "senior" || lv === "junior") ? lv : "junior",
        region: (r.zone || "").toString().trim() || null,
      };
    }

    // A rep gets a link card if they're an active field rep (in rep-zones) OR the
    // office has explicitly assigned them a harvest_level (so a trainer/manager
    // not in rep-zones, or an inactive one, still shows once assigned).
    const norm = (v) => { const s = (v || "").toLowerCase(); return (s === "admin" || s === "senior" || s === "junior") ? s : null; };
    const cards = [];
    for (const r of (allReps || [])) {
      if (!r.harvest_token) continue;
      const override = norm(r.harvest_level);
      const zoneInfo = r.jobnimbus_id ? infoByJn[r.jobnimbus_id] : null;
      if (!override && !zoneInfo) continue; // not an active field rep and not assigned → skip
      const level = override || zoneInfo?.level || "junior";
      cards.push({
        id: r.id,
        name: r.name || "Rep",
        level,
        override,                       // the explicit office assignment, if any
        region: zoneInfo?.region || null,
        active: r.active !== false,
        link: `${base}/?mode=harvest&rt=${r.harvest_token}`,
      });
    }

    const levelRank = (lv) => (lv === "senior" ? 0 : 1); // senior first
    const byName = (a, b) => String(a.name || "").localeCompare(String(b.name || ""));
    const admins = cards.filter((c) => c.level === "admin").sort(byName);
    const reps = cards.filter((c) => c.level !== "admin").sort((a, b) =>
      (a.region || "~").localeCompare(b.region || "~") ||
      (levelRank(a.level) - levelRank(b.level)) || byName(a, b));

    // Lightweight roster for the "assign someone new" picker — every rep by name,
    // whether or not they have a token yet (the assign call mints one).
    const all = (allReps || [])
      .map((r) => ({ id: r.id, name: r.name || "Rep", has_token: !!r.harvest_token, override: norm(r.harvest_level) }))
      .sort(byName);

    const adminTok = adminRow?.[0]?.value || "";
    return json(200, {
      ok: true,
      base,
      admin_link: adminTok ? `${base}/?mode=harvest&admin=${adminTok}` : "",
      admins,
      reps,
      all,
    });
  } catch (e) {
    return json(500, { ok: false, error: e.message || "error" });
  }
};

function json(statusCode, obj) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) };
}
