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
    const insp = (await sbGet(`inspections?id=eq.${encodeURIComponent(inspectionId)}&select=id,client_name,address,inspection_photos&limit=1`))[0];
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

    // Text the manager a review link.
    const base = (process.env.URL || process.env.PUBLIC_SITE_URL || "https://free-roof-inspections.netlify.app").replace(/\/$/, "");
    const mgrPhone = process.env.ADMIN_ALERT_PHONE;
    if (mgrPhone) {
      const link = `${base}/?cancel_review=${insp.id}`;
      const msg = `🚫 Cancel review: ${inspectorName} says ${insp.client_name || "a homeowner"}${insp.address ? ` (${insp.address})` : ""} cancelled.\n"${note}"\nReview & decide: ${link}`;
      try {
        await fetch(`${base}/.netlify/functions/ghl-sms`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ to: mgrPhone, name: "Manager", message: msg }),
        });
      } catch { /* best-effort */ }
    }
    return cors(200, JSON.stringify({ ok: true }));
  } catch (e) {
    return cors(500, JSON.stringify({ ok: false, error: e.message || "error" }));
  }
};

async function sbGet(path) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: sb });
  if (!r.ok) return [];
  return r.json().catch(() => []);
}
function cors(status, body) {
  return { statusCode: status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" }, body };
}
