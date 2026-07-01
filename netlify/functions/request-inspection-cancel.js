// netlify/functions/request-inspection-cancel.js
//
// Inspector "Homeowner cancelled" → does NOT cancel. It records a pending
// cancel review on the inspection and TEXTS the manager a link to a review
// page (/?cancel_review=<id>) where they read the note and choose Confirm
// cancel or Send to Retail. This replaces the old destructive "Lost" button.
//
// POST { inspectionId, note, inspector_name?, photo_paths? }  → { ok }
//
// Open (no token) — same as inspector-submit-result, part of the inspector app.
// Env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, ADMIN_ALERT_PHONE, URL.

const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const sb = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" };
const SIGNED_BUCKET = "signed-documents";
const TMS_REP_ZONES_URL = "https://trainingmanagementsys.netlify.app/.netlify/functions/rep-zones";

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return cors(200, "");
  if (event.httpMethod !== "POST") return cors(405, JSON.stringify({ ok: false, error: "POST only" }));
  if (!SB_URL || !SB_KEY) return cors(500, JSON.stringify({ ok: false, error: "env missing" }));

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { return cors(400, JSON.stringify({ ok: false, error: "bad JSON" })); }
  const inspectionId = String(body.inspectionId || "").trim();
  const note = String(body.note || "").trim();
  const inspectorName = String(body.inspector_name || "").trim() || "Inspector";
  const photoPaths = Array.isArray(body.photo_paths) ? body.photo_paths : [];
  if (!inspectionId) return cors(400, JSON.stringify({ ok: false, error: "inspectionId required" }));
  if (!note) return cors(400, JSON.stringify({ ok: false, error: "A note is required." }));

  try {
    const insp = (await sbGet(`inspections?id=eq.${encodeURIComponent(inspectionId)}&select=id,client_name,address,inspection_photos,sales_rep_id,sales_rep_name&limit=1`))[0];
    if (!insp) return cors(404, JSON.stringify({ ok: false, error: "inspection not found" }));

    const nowIso = new Date().toISOString();
    const prevPhotos = Array.isArray(insp.inspection_photos) ? insp.inspection_photos : [];
    const newPhotos = photoPaths.map((p) => ({ path: p, bucket: SIGNED_BUCKET, captured_at: nowIso, label: "Cancel-review" }));
    const patch = {
      cancel_review_pending: true,
      cancel_review_note: note,
      cancel_review_by: inspectorName,
      cancel_review_at: nowIso,
      inspection_photos: [...prevPhotos, ...newPhotos],
    };
    const up = await fetch(`${SB_URL}/rest/v1/inspections?id=eq.${encodeURIComponent(inspectionId)}`, {
      method: "PATCH", headers: { ...sb, Prefer: "return=minimal" }, body: JSON.stringify(patch),
    });
    if (!up.ok) return cors(500, JSON.stringify({ ok: false, error: `Save failed: ${(await up.text()).slice(0, 160)}` }));

    // Text the ZONE'S regional manager a review link (the actual point of this
    // flow) PLUS the admin monitor number. Resolve rep → zone → manager the same
    // way pa-refused-to-sign.js does. Previously it only texted ADMIN_ALERT_PHONE
    // (admin), so the real regional managers never got it.
    const base = (process.env.URL || process.env.PUBLIC_SITE_URL || "https://free-roof-inspections.netlify.app").replace(/\/$/, "");
    const link = `${base}/?cancel_review=${insp.id}`;
    const msg = `🚫 Cancel review: ${inspectorName} says ${insp.client_name || "a homeowner"}${insp.address ? ` (${insp.address})` : ""} cancelled.\n"${note}"\nReview & decide: ${link}`;

    const rep = await resolveRep(SB_URL, sb, insp.sales_rep_id, insp.sales_rep_name);
    const zone = await resolveZone(rep, insp.sales_rep_name);
    const manager = zone ? await fetchManager(SB_URL, sb, zone) : null;

    const recipients = [];
    if (manager?.phone) recipients.push({ phone: manager.phone, name: manager.name || "Manager" });
    if (process.env.ADMIN_ALERT_PHONE) recipients.push({ phone: process.env.ADMIN_ALERT_PHONE, name: "Admin" });
    const seen = new Set();
    const sms_results = [];
    for (const rcpt of recipients) {
      const key = String(rcpt.phone).replace(/\D/g, "");
      if (!key || seen.has(key)) continue;
      seen.add(key);
      try {
        const r = await fetch(`${base}/.netlify/functions/ghl-sms`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ to: rcpt.phone, name: rcpt.name, message: msg }),
        });
        const jr = await r.json().catch(() => ({}));
        sms_results.push({ to: rcpt.name, ok: !!jr.success, error: jr.success ? undefined : (jr.error || `ghl-sms ${r.status}`) });
      } catch (e) { sms_results.push({ to: rcpt.name, ok: false, error: e.message || "fetch failed" }); }
    }
    return cors(200, JSON.stringify({ ok: true, zone: zone || null, manager_texted: !!manager?.phone, sms_results }));
  } catch (e) {
    return cors(500, JSON.stringify({ ok: false, error: e.message || "error" }));
  }
};

async function sbGet(path) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: sb });
  if (!r.ok) return [];
  return r.json().catch(() => []);
}
// Rep → zone → regional-manager resolution (mirrors pa-refused-to-sign.js).
async function resolveRep(SB_URL, headers, salesRepId, salesRepName) {
  const sel = "id,name,phone,jobnimbus_id";
  const get = async (q) => {
    const res = await fetch(`${SB_URL}/rest/v1/sales_reps?${q}&select=${sel}&limit=1`, { headers });
    if (!res.ok) return null;
    return (await res.json().catch(() => []))?.[0] || null;
  };
  let rep = null;
  if (salesRepId) {
    rep = await get(`jobnimbus_id=eq.${encodeURIComponent(salesRepId)}`);
    if (!rep) rep = await get(`id=eq.${encodeURIComponent(salesRepId)}`);
  }
  if (!rep && salesRepName) rep = await get(`name=ilike.${encodeURIComponent(salesRepName)}`);
  return rep;
}
async function resolveZone(rep, fallbackName) {
  let tmsReps = [];
  try { const res = await fetch(TMS_REP_ZONES_URL); if (res.ok) tmsReps = (await res.json()).reps || []; }
  catch (e) { console.warn("TMS rep-zones fetch failed:", e.message || e); }
  const byJnId = {}, byName = {};
  for (const r of tmsReps) { if (r.jobnimbus_id) byJnId[r.jobnimbus_id] = r.zone; if (r.name) byName[normalizeName(r.name)] = r.zone; }
  const jnId = rep?.jobnimbus_id;
  const name = rep?.name || fallbackName;
  return (jnId && byJnId[jnId]) || (name && byName[normalizeName(name)]) || null;
}
async function fetchManager(SB_URL, headers, zone) {
  const res = await fetch(`${SB_URL}/rest/v1/regional_managers?zone=eq.${encodeURIComponent(zone)}&select=zone,name,phone&limit=1`, { headers });
  if (!res.ok) return null;
  return (await res.json().catch(() => []))?.[0] || null;
}
function normalizeName(s) {
  return String(s || "").toLowerCase()
    .replace(/["“”]([^"“”]*)["“”]/g, "").replace(/'([^']*)'/g, "").replace(/\(([^)]*)\)/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
}
function cors(status, body) {
  return { statusCode: status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" }, body };
}
