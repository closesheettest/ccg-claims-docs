// netlify/functions/harvest-pins.js
//
// Returns the Harvesting-Map pins a signed-in rep is ALLOWED to see. The map
// calls this instead of reading canvass_prospects directly, so a rep only ever
// gets the pin types their level can see (e.g. IQ → senior only).
//
//   GET ?rt=<rep token>       → that rep's allowed pins (level from rep-zones)
//   GET ?admin=<admin token>  → office view: every pin
// → { ok, rep:{name,level}, pins:[...], pin_types:[...] }
//
// Env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY

const REP_ZONES_URL = "https://trainingmanagementsys.netlify.app/.netlify/functions/rep-zones?include_inactive=1";
const PIN_SELECT = "id,name,address,city,state,zip,phone,email,latitude,longitude,status,status_by,status_updated_at,upload_id,notes,status_log,list_name,jn_job_id,extra,created_at";

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

  const p = event.queryStringParameters || {};
  const rt = (p.rt || "").trim();
  const adminTok = (p.admin || "").trim();

  let level = null, repName = null;
  try {
    if (adminTok) {
      const s = await sbGet(`app_settings?key=eq.harvest_admin_token&select=value&limit=1`);
      if (s[0]?.value && s[0].value === adminTok) { level = "admin"; repName = "Office"; }
    }
    const isUuid = (s) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
    if (!level && rt && isUuid(rt)) {
      const reps = await sbGet(`sales_reps?harvest_token=eq.${encodeURIComponent(rt)}&select=name,jobnimbus_id&limit=1`);
      if (reps[0]) {
        repName = reps[0].name || "Rep";
        level = "junior"; // default when untagged
        const jn = reps[0].jobnimbus_id;
        if (jn) {
          const rz = await fetch(REP_ZONES_URL).then((r) => (r.ok ? r.json() : { reps: [] })).catch(() => ({ reps: [] }));
          const match = (rz.reps || []).find((r) => r.jobnimbus_id === jn);
          const lv = (match?.rep_level || "").toLowerCase();
          if (lv === "senior" || lv === "junior") level = lv;
        }
      }
    }
  } catch (e) {
    return json(500, { ok: false, error: e.message || "lookup failed" });
  }
  if (!level) return json(401, { ok: false, error: "This link isn't valid. Ask your manager for your Harvesting Map link." });

  const types = await sbGet(`harvest_pin_types?select=*&order=sort`).catch(() => []);
  const visible = (types || [])
    .filter((t) => level === "admin" || !(t.visible_levels || []).length || (t.visible_levels || []).includes(level))
    .map((t) => t.key);

  let pins = [];
  if (visible.length) {
    const inList = visible.map((k) => `"${k}"`).join(",");
    pins = await sbGet(`canvass_prospects?status=in.(${inList})&latitude=not.is.null&select=${PIN_SELECT}&limit=10000`).catch(() => []);
  }

  return json(200, { ok: true, rep: { name: repName, level }, pins, pin_types: types });
};

function json(statusCode, obj) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) };
}
