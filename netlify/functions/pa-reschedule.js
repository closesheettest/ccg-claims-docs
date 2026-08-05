// netlify/functions/pa-reschedule.js
//
// Homeowner self-reschedule after a MISSED PA appointment. A private per-appointment
// link (?mode=pareschedule&t=<reschedule_token>) lets the homeowner pick a new time
// themselves. All actions are scoped by the reschedule_token — the homeowner never
// sees any internal token; this function calls the shared scheduler (pa-schedule-api)
// server-side with the office visit token.
//
//   POST { action:"load",  t }                        → { ok, appt:{name,address,old_start_at,...} }
//   POST { action:"slots", t }                        → { ok, slots:[...] }
//   POST { action:"book",  t, pa_id, start_at }       → { ok } (cancels the old appt, books the new)
//   POST { action:"send",  appt_id, auth }            → { ok, sent } (cron/office: text+email the link)
//
// Env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, URL

const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const sb = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" };
const BASE = (process.env.URL || process.env.PUBLIC_SITE_URL || "https://free-roof-inspections.netlify.app").replace(/\/$/, "");

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return cors(200, "");
  if (event.httpMethod !== "POST") return cors(405, JSON.stringify({ ok: false, error: "POST only" }));
  if (!SB_URL || !SB_KEY) return cors(500, JSON.stringify({ ok: false, error: "Missing Supabase env" }));
  let body; try { body = JSON.parse(event.body || "{}"); } catch { return cors(400, JSON.stringify({ ok: false, error: "bad JSON" })); }
  const action = String(body.action || "").trim();

  try {
    if (action === "send") return await send(body);
    if (action === "preview") return await preview();   // office composer: token-less page preview
    const t = String(body.t || "").trim();
    if (!t) return cors(400, JSON.stringify({ ok: false, error: "link token required" }));
    const appt = (await sbGet(`pa_appointments?reschedule_token=eq.${encodeURIComponent(t)}&select=id,homeowner_name,homeowner_phone,address,start_at,pa_id,inspection_id,status&limit=1`))[0];
    if (!appt) return cors(404, JSON.stringify({ ok: false, error: "This reschedule link isn't valid." }));

    if (action === "load") {
      // Pull the inspection so the landing page can SHOW the homeowner why they need
      // this appointment: their damage photos + the fact it came back damaged. This is
      // the "here's the proof" persuasion before the "pick a time" ask.
      let city = null, result = null, photos = [];
      if (appt.inspection_id) {
        const i = (await sbGet(`inspections?id=eq.${encodeURIComponent(appt.inspection_id)}&select=city,result,inspection_photos&limit=1`))[0];
        city = (i && i.city) || null;
        result = (i && i.result) || null;
        let items = i && i.inspection_photos;
        if (typeof items === "string") { try { items = JSON.parse(items); } catch { items = []; } }
        if (Array.isArray(items) && items.length) {
          // Lead with the actual damage shots; push context photos (house number,
          // address, overview, selfies/ID) to the end. Cap at 12 for a tidy gallery.
          const isContext = (l) => /house ?number|address|overview|street\b|front of|selfie|driver|license|\bid\b/i.test(String(l || ""));
          const damage = items.filter((p) => p && p.path && !isContext(p.label));
          const context = items.filter((p) => p && p.path && isContext(p.label));
          const urls = await signSupabasePhotos([...damage, ...context].slice(0, 12), SB_URL, sb);
          photos = urls;
        }
      }
      // The "inspection result" pitch is EDITABLE by the office (app_settings key
      // 'pa_reschedule_pitch' = { headline, body }) — it's a sales message, so they
      // control every word. Falls back to a default. Tokens: {first_name} {address} {city}.
      let tpl = await getSetting("pa_reschedule_pitch");
      if (typeof tpl === "string") { try { tpl = JSON.parse(tpl); } catch { tpl = null; } }
      if (!tpl || typeof tpl !== "object") tpl = {};
      const firstName = String(appt.homeowner_name || "there").trim().split(/\s+/)[0] || "there";
      const addrFull = [appt.address, city].filter(Boolean).join(", ");
      const fill = (s) => String(s || "")
        .replace(/\{first[_ ]?name\}/gi, firstName)
        .replace(/\{address\}/gi, addrFull)
        .replace(/\{city\}/gi, city || "");
      const pitch = {
        headline: fill(tpl.headline || "Your roof came back with damage"),
        body: fill(tpl.body || "Hi {first_name} — our inspector documented damage on your roof at {address}. This is often covered by your insurance, and a licensed Public Adjuster can file the claim for you."),
      };
      return cors(200, JSON.stringify({ ok: true, appt: { name: appt.homeowner_name, address: appt.address, city, old_start_at: appt.start_at, result, photos, pitch } }));
    }
    if (action === "slots") {
      const visitTok = await getSetting("visit_token") || await getSetting("dialer_token");
      const r = await callScheduler({ action: "slots", token: visitTok, inspection_id: appt.inspection_id });
      return cors(200, JSON.stringify({ ok: true, slots: (r && r.slots) || [] }));
    }
    if (action === "book") {
      const visitTok = await getSetting("visit_token") || await getSetting("dialer_token");
      const r = await callScheduler({
        action: "book", token: visitTok, reschedule: true, force: true,
        pa_id: body.pa_id, start_at: body.start_at, inspection_id: appt.inspection_id,
        homeowner_name: appt.homeowner_name, homeowner_phone: appt.homeowner_phone, address: appt.address,
        booked_by: "Homeowner (reschedule link)",
      });
      if (!r || !r.ok) return cors(200, JSON.stringify({ ok: false, error: (r && r.error) || "Couldn't book that time — please try another." }));
      return cors(200, JSON.stringify({ ok: true, booked: r }));
    }
    return cors(400, JSON.stringify({ ok: false, error: `Unknown action: ${action}` }));
  } catch (e) {
    return cors(500, JSON.stringify({ ok: false, error: e.message || "error" }));
  }
};

// Text + email the homeowner their private reschedule link. Gated to cron/office
// (must pass the harvest admin token OR the visit/dialer token) so it's not public.
async function send(body) {
  const auth = String(body.auth || "").trim();
  const [adminTok, visitTok, dialerTok] = await Promise.all([getSetting("harvest_admin_token"), getSetting("visit_token"), getSetting("dialer_token")]);
  if (!auth || ![adminTok, visitTok, dialerTok].includes(auth)) return cors(401, JSON.stringify({ ok: false, error: "unauthorized" }));
  const apptId = String(body.appt_id || "").trim();
  if (!apptId) return cors(400, JSON.stringify({ ok: false, error: "appt_id required" }));
  const appt = (await sbGet(`pa_appointments?id=eq.${encodeURIComponent(apptId)}&select=id,homeowner_name,homeowner_phone,address,reschedule_token,inspection_id&limit=1`))[0];
  if (!appt) return cors(404, JSON.stringify({ ok: false, error: "appt not found" }));

  const token = appt.reschedule_token || cryptoToken();
  const patch = { reschedule_token: token, reschedule_sent_at: new Date().toISOString() };
  await fetch(`${SB_URL}/rest/v1/pa_appointments?id=eq.${encodeURIComponent(apptId)}`, { method: "PATCH", headers: { ...sb, Prefer: "return=minimal" }, body: JSON.stringify(patch) }).catch(() => {});

  const link = `${BASE}/?mode=pareschedule&t=${token}`;
  const name = appt.homeowner_name || "there";
  const phone = appt.homeowner_phone || null;
  let email = null;
  if (appt.inspection_id) { const i = (await sbGet(`inspections?id=eq.${encodeURIComponent(appt.inspection_id)}&select=email&limit=1`))[0]; email = i && i.email || null; }
  const msg = `Hi ${name}, we missed you for your roof adjuster appointment. No problem — pick a new time here: ${link}`;
  let sms = false, mail = false;
  if (phone) { try { await fetch(`${BASE}/.netlify/functions/ghl-sms`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ to: phone, name, message: msg }) }); sms = true; } catch { /* best-effort */ } }
  if (email) { try { await fetch(`${BASE}/.netlify/functions/send-email`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ to: email, subject: "Reschedule your roof adjuster appointment", html: `<p>Hi ${name},</p><p>We missed you for your roof adjuster appointment. No problem — pick a new time that works for you:</p><p><a href="${link}">${link}</a></p>` }) }); mail = true; } catch { /* best-effort */ } }
  return cors(200, JSON.stringify({ ok: true, sent: sms || mail, sms, email: mail }));
}

// Token-less PREVIEW for the office composer — the current pitch filled with a
// sample homeowner + real sample damage photos, so they can see the page as they edit.
async function preview() {
  let tpl = await getSetting("pa_reschedule_pitch");
  if (typeof tpl === "string") { try { tpl = JSON.parse(tpl); } catch { tpl = null; } }
  if (!tpl || typeof tpl !== "object") tpl = {};
  const S = { first_name: "Chris", address: "123 Main St, Tampa" };
  const fill = (s) => String(s || "").replace(/\{first[_ ]?name\}/gi, S.first_name).replace(/\{address\}/gi, S.address).replace(/\{city\}/gi, "Tampa");
  const pitch = {
    headline: fill(tpl.headline || "Your roof came back with damage"),
    body: fill(tpl.body || "Hi {first_name} — our inspector documented damage on your roof at {address}. This is often covered by your insurance, and a licensed Public Adjuster can file the claim for you."),
  };
  let photos = [];
  try {
    const dmg = (await sbGet(`inspections?result=eq.damage&inspection_photos=not.is.null&select=inspection_photos&limit=1`))[0];
    let items = dmg && dmg.inspection_photos;
    if (typeof items === "string") { try { items = JSON.parse(items); } catch { items = []; } }
    if (Array.isArray(items)) photos = await signSupabasePhotos(items.slice(0, 9), SB_URL, sb);
  } catch { /* no sample photos available */ }
  return cors(200, JSON.stringify({ ok: true, appt: { name: "Chris Sample", address: "123 Main St", city: "Tampa", result: "damage", pitch, photos, preview: true } }));
}

async function callScheduler(payload) {
  try {
    const r = await fetch(`${BASE}/.netlify/functions/pa-schedule-api`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    return await r.json().catch(() => ({ ok: false, error: "scheduler error" }));
  } catch (e) { return { ok: false, error: e.message || "scheduler error" }; }
}
// Temporary signed URLs for app-captured inspection photos (private Storage bucket)
// so the homeowner's browser can show them in <img src>. Mirrors pa-load-claim.js.
async function signSupabasePhotos(items, sbUrl, sbHeaders) {
  const out = [];
  for (const p of (items || []).slice(0, 12)) {
    if (!p?.path) continue;
    const bucket = p.bucket || "signed-documents";
    try {
      const res = await fetch(`${sbUrl}/storage/v1/object/sign/${bucket}/${p.path}`, {
        method: "POST", headers: sbHeaders, body: JSON.stringify({ expiresIn: 3600 }),
      });
      if (!res.ok) continue;
      const b = await res.json().catch(() => ({}));
      const rel = b.signedURL || b.signedUrl;
      if (rel) out.push(rel.startsWith("http") ? rel : `${sbUrl}/storage/v1${rel.startsWith("/") ? "" : "/"}${rel}`);
    } catch { /* skip */ }
  }
  return out;
}
async function getSetting(key) { const rows = await sbGet(`app_settings?key=eq.${encodeURIComponent(key)}&select=value&limit=1`); return rows[0]?.value || null; }
async function sbGet(path) { const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: sb }); if (!r.ok) return []; return r.json().catch(() => []); }
function cryptoToken() { try { return crypto.randomUUID(); } catch { return "rt-" + Math.abs(Date.parse(new Date().toISOString())).toString(36) + Math.random().toString(36).slice(2, 10); } }
function cors(status, body) { return { statusCode: status, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" }, body }; }
