// netlify/functions/list-no-photo-inspections.js
//
// Powers the admin "No-photo re-inspects" list. Returns every inspection with
// a real result (damage/no_damage/retail) but ZERO photos in BOTH the DB
// array AND Storage — the cases that need a manual re-inspect SMS (Bastos-
// style). Each row carries the inspector name/phone so the admin can send.
//
// GET → { ok, count, items:[{ id, client_name, address, result, signed_at,
//          inspector_id, inspector_name, inspector_phone, jnid }] }
//
// Env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY.

const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const JN_BASE = "https://app.jobnimbus.com/api1";
const JN_KEY = process.env.JOBNIMBUS_API_KEY;
const jnHeaders = { Authorization: `bearer ${JN_KEY}`, "Content-Type": "application/json" };
const BUCKET = "signed-documents";
const sb = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" };

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return cors(200, "");
  if (!SB_URL || !SB_KEY) return cors(500, JSON.stringify({ ok: false, error: "Supabase env missing" }));
  try {
    // Only "actually inspected, recently" cases: an inspector is assigned (so
    // photos SHOULD exist) and it's within the last 30 days. This targets real
    // photo-upload failures (Bastos) instead of old sales-marked retail deals
    // that never had an inspector. ?days= overrides the window.
    const days = Math.min(Math.max(parseInt((event.queryStringParameters || {}).days, 10) || 30, 1), 365);
    const cutoff = new Date(Date.now() - days * 864e5).toISOString();
    const rows = await sbGet(`inspections?cancelled_at=is.null&result=in.(damage,no_damage,retail)&inspector_id=not.is.null&signed_at=gte.${encodeURIComponent(cutoff)}&select=id,client_name,address,result,signed_at,inspector_id,jn_job_id,inspection_photos&order=signed_at.desc&limit=2000`);
    const emptyDb = rows.filter((r) => !(Array.isArray(r.inspection_photos) && r.inspection_photos.length > 0));

    const items = [];
    for (const r of emptyDb) {
      if ((await countStoragePhotos(r.id)) > 0) continue;      // photos in our Storage — fine
      if (JN_KEY && r.jn_job_id && (await jnHasPhotos(r.jn_job_id))) continue; // photos on the JN job — fine
      items.push(r);                                            // truly no photos anywhere
    }

    // Resolve inspector name/phone for the flagged rows.
    const ids = [...new Set(items.map((r) => r.inspector_id).filter(Boolean))];
    const insp = {};
    for (const id of ids) {
      const got = await sbGet(`inspectors?id=eq.${encodeURIComponent(id)}&select=name,phone&limit=1`);
      if (got[0]) insp[id] = got[0];
    }

    return cors(200, JSON.stringify({
      ok: true,
      count: items.length,
      items: items.map((r) => ({
        id: r.id,
        client_name: (r.client_name || "").trim(),
        address: r.address || "",
        result: r.result,
        signed_at: r.signed_at,
        inspector_id: r.inspector_id,
        inspector_name: insp[r.inspector_id]?.name || null,
        inspector_phone: insp[r.inspector_id]?.phone || null,
        jnid: r.jn_job_id || null,
      })),
    }));
  } catch (e) {
    return cors(500, JSON.stringify({ ok: false, error: e.message || "error" }));
  }
};

async function countStoragePhotos(inspectionId) {
  try {
    const res = await fetch(`${SB_URL}/storage/v1/object/list/${BUCKET}`, {
      method: "POST", headers: sb,
      body: JSON.stringify({ prefix: `inspection-photos/${inspectionId}/`, limit: 5 }),
    });
    if (!res.ok) return 0;
    const objs = await res.json().catch(() => []);
    return (Array.isArray(objs) ? objs : []).filter((o) => o && o.name && /\.(jpe?g|png|webp|heic)$/i.test(o.name)).length;
  } catch { return 0; }
}
// Does the JN job carry any photos (Files type=2)? If so it's NOT a no-photo
// case — the cert can be built from JN. Fail-safe: on error return true so we
// DON'T falsely flag a job we couldn't check.
async function jnHasPhotos(jnid) {
  try {
    const r = await fetch(`${JN_BASE}/files?related=${encodeURIComponent(jnid)}&type=2&size=3`, { headers: jnHeaders });
    if (!r.ok) return true;
    const d = await r.json().catch(() => ({}));
    const files = d.files || d.results || d.items || [];
    return Array.isArray(files) && files.length > 0;
  } catch { return true; }
}
async function sbGet(path) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: sb });
  if (!r.ok) return [];
  return r.json().catch(() => []);
}
function cors(status, body) {
  return { statusCode: status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" }, body };
}
