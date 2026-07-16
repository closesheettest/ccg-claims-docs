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
// status_log (a growing array) is intentionally left out of the bulk map load —
// it's the heaviest field and the map doesn't render it; keeps the show-all
// payload well under Netlify's ~6MB limit as the pin count grows.
const PIN_SELECT = "id,name,address,city,state,zip,phone,email,latitude,longitude,status,status_by,status_updated_at,upload_id,notes,list_name,jn_job_id,extra,created_at";

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
  // Paged fetch — PostgREST caps every response at 1000 rows (max-rows), so a
  // `limit=10000` still stops at 1000. Walk Range windows until fully drained.
  const sbGetAll = async (path, pageSize = 1000, maxRows = Infinity) => {
    const out = [];
    for (let from = 0; from < maxRows; from += pageSize) {
      const r = await fetch(`${SB_URL}/rest/v1/${path}`, {
        headers: { ...sbH, "Range-Unit": "items", Range: `${from}-${from + pageSize - 1}` },
      });
      if (!r.ok) break;
      const batch = await r.json().catch(() => []);
      if (!Array.isArray(batch) || batch.length === 0) break;
      out.push(...batch);
      if (batch.length < pageSize) break;
    }
    return out;
  };

  const p = event.queryStringParameters || {};
  const rt = (p.rt || "").trim();
  const adminTok = (p.admin || "").trim();

  let level = null, repName = null, repJn = null, repEmail = null;
  try {
    if (adminTok) {
      const s = await sbGet(`app_settings?key=eq.harvest_admin_token&select=value&limit=1`);
      if (s[0]?.value && s[0].value === adminTok) { level = "admin"; repName = "Office"; }
    }
    const isUuid = (s) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
    if (!level && rt && isUuid(rt)) {
      const reps = await sbGet(`sales_reps?harvest_token=eq.${encodeURIComponent(rt)}&select=name,jobnimbus_id,email&limit=1`);
      if (reps[0]) {
        repName = reps[0].name || "Rep";
        repEmail = reps[0].email || null;
        level = "junior"; // default when untagged
        const jn = reps[0].jobnimbus_id;
        repJn = jn || null;
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

  // Viewport loading — scales to 100k+ pins. The map sends its current bounds
  // (n/s/e/w) and we return only what's in view, capped. Without bounds (initial
  // load) we return a global newest sample just so the map can fit to the data.
  // Office "Show all" overview (?all=1) ignores the viewport + cap and returns
  // every pin — fine for clustered rendering at today's scale, guarded by a
  // safety ceiling so it can't run away if the table ever hits six figures.
  const showAll = /^(1|true|yes)$/i.test((p.all || "").trim());
  const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
  const n = num(p.n), s = num(p.s), e = num(p.e), w = num(p.w);
  const hasBox = !showAll && n != null && s != null && e != null && w != null && n > s && e > w;
  const box = hasBox ? `&latitude=gte.${s}&latitude=lte.${n}&longitude=gte.${w}&longitude=lte.${e}` : "";
  // show-all ceiling kept under Netlify's HARD ~6MB response limit. Each pin is
  // ~640B on the wire, so ~9.4k pins is the real cap for a single buffered
  // response; 9000 leaves margin for the installs layer. (To show more than this
  // at once we'd need a streamed/paginated Show-all — the platform limit can't be
  // raised via config.) / in-view cap / initial global sample.
  const CAP = showAll ? 9000 : hasBox ? 6000 : 3000;

  let pins = [];
  if (visible.length) {
    const inList = visible.map((k) => `"${k}"`).join(",");
    pins = await sbGetAll(`canvass_prospects?status=in.(${inList})&latitude=not.is.null${box}&select=${PIN_SELECT}&order=created_at.desc`, 1000, CAP);
  }
  const pinsCapped = pins.length >= CAP;

  // Installs — read-only gold-star reference layer (every level). Same viewport
  // treatment so they don't balloon the payload at scale.
  const installs = await sbGetAll(
    `installs?latitude=not.is.null&longitude=not.is.null${box}&select=id,jnid,address_line,city,product_type,color,latitude,longitude&order=id`,
    1000, CAP,
  ).catch(() => []);

  return json(200, { ok: true, rep: { name: repName, level, jn_id: repJn, email: repEmail }, pins, pin_types: types, installs, capped: pinsCapped || installs.length >= CAP, viewport: hasBox });
};

function json(statusCode, obj) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) };
}
