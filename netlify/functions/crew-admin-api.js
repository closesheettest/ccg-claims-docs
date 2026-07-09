// netlify/functions/crew-admin-api.js
//
// Office side of roofing-crew (subcontractor) onboarding. US Shingle staff:
//   • create a crew (owner name/phone/email + the RATES US Shingle dictates),
//   • send the onboarding link to the crew owner (SMS + email),
//   • list crews + open one, adjust rates, resend the link.
//
// The crew fills everything else + signs via the /?crew=<token> portal
// (crew-onboarding-api.js).
//
// Reads/writes the locked-down crews table with the SERVICE-ROLE key (the anon
// key is blocked by RLS on purpose — SSN/EIN/bank live here). Request auth is a
// separate thing: the caller must pass the global dialer/visit token.
//
//   POST { token, action, ... }
//     action "create"       { owner_first, owner_last, owner_phone, owner_email, company_name?, rates? }
//     action "list"                              → { crews:[safe fields] }
//     action "get"          { id }               → { crew } (full, office view)
//     action "update_rates" { id, rates }
//     action "resend_link"  { id }
//
// Env: VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, URL. (Falls back to the
// anon key only to return a clear "add the service-role key" message.)

const crypto = require("crypto");

const SB_URL = process.env.VITE_SUPABASE_URL;
const SVC_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const KEY = SVC_KEY || ANON_KEY;
const sb = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };

const BUCKET = "crew-docs";
// Fields safe to show in the office list (NO ssn/bank).
const LIST_SEL = "id,created_at,status,token,owner_first,owner_last,owner_phone,owner_email,company_name,submitted_at,approved_at";

const DEFAULT_RATES = {
  shingle: 110, screw_down_metal: 180, standing_seam_metal: 220,
  permalock_aluminum_shingle: 180, decra_stone_coated: 250, tile: null,
  tpo: 120, base_and_cap: 110, plywood_replacement: 15, "1xs": 1.5,
  extra_story: 10, extra_layer_shingles: 10, additional_story: 10,
  steep_7_12: 10, trip_charge: 25,
};

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return cors(200, "");
  if (event.httpMethod !== "POST") return cors(405, JSON.stringify({ ok: false, error: "POST only" }));
  if (!SB_URL) return cors(500, JSON.stringify({ ok: false, error: "Supabase URL missing" }));
  if (!SVC_KEY) return cors(500, JSON.stringify({ ok: false, error: "Add SUPABASE_SERVICE_ROLE_KEY to Netlify env (Supabase → Project Settings → API → service_role) — the crew tables are RLS-locked and the anon key can't read them." }));

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { return cors(400, JSON.stringify({ ok: false, error: "bad JSON" })); }
  if (!(await okToken(body.token))) return cors(401, JSON.stringify({ ok: false, error: "Invalid link" }));

  const action = String(body.action || "").trim();
  const base = (process.env.URL || process.env.PUBLIC_SITE_URL || "https://free-roof-inspections.netlify.app").replace(/\/$/, "");

  try {
    if (action === "list") {
      const rows = await sbGet(`crews?select=${LIST_SEL}&order=created_at.desc&limit=500`);
      return cors(200, JSON.stringify({ ok: true, crews: rows }));
    }

    if (action === "get") {
      const id = String(body.id || "").trim();
      if (!id) return cors(400, JSON.stringify({ ok: false, error: "id required" }));
      const crew = (await sbGet(`crews?id=eq.${encodeURIComponent(id)}&select=*&limit=1`))[0];
      if (!crew) return cors(404, JSON.stringify({ ok: false, error: "crew not found" }));
      const docs = await sbGet(`crew_documents?crew_id=eq.${encodeURIComponent(id)}&select=id,doc_type,file_name,content_type,uploaded_at,file_path&order=uploaded_at`);
      return cors(200, JSON.stringify({ ok: true, crew, documents: docs }));
    }

    if (action === "create") {
      const owner_first = String(body.owner_first || "").trim();
      const owner_last = String(body.owner_last || "").trim();
      const owner_phone = String(body.owner_phone || "").trim();
      const owner_email = String(body.owner_email || "").trim();
      if (!owner_first || !owner_last) return cors(400, JSON.stringify({ ok: false, error: "Owner first and last name are required." }));
      if (!owner_phone && !owner_email) return cors(400, JSON.stringify({ ok: false, error: "A phone or email is required to send the link." }));
      const token = crypto.randomBytes(16).toString("hex");
      const rates = sanitizeRates(body.rates) || DEFAULT_RATES;
      const ins = await fetch(`${SB_URL}/rest/v1/crews`, {
        method: "POST", headers: { ...sb, Prefer: "return=representation" },
        body: JSON.stringify({
          token, status: "invited",
          owner_first, owner_last, owner_phone, owner_email,
          company_name: String(body.company_name || "").trim() || null,
          rates,
        }),
      });
      if (!ins.ok) return cors(502, JSON.stringify({ ok: false, error: `create ${ins.status}: ${(await ins.text()).slice(0, 200)}` }));
      const crew = (await ins.json().catch(() => []))[0];
      const sent = await sendLink(base, crew);
      return cors(200, JSON.stringify({ ok: true, crew: { id: crew.id, token: crew.token, ...safe(crew) }, sent }));
    }

    if (action === "update_rates") {
      const id = String(body.id || "").trim();
      const rates = sanitizeRates(body.rates);
      if (!id || !rates) return cors(400, JSON.stringify({ ok: false, error: "id and rates required" }));
      const r = await fetch(`${SB_URL}/rest/v1/crews?id=eq.${encodeURIComponent(id)}`, {
        method: "PATCH", headers: { ...sb, Prefer: "return=minimal" }, body: JSON.stringify({ rates }),
      });
      return cors(r.ok ? 200 : 500, JSON.stringify({ ok: r.ok }));
    }

    if (action === "resend_link") {
      const id = String(body.id || "").trim();
      const crew = (await sbGet(`crews?id=eq.${encodeURIComponent(id)}&select=id,token,owner_first,owner_last,owner_phone,owner_email&limit=1`))[0];
      if (!crew) return cors(404, JSON.stringify({ ok: false, error: "crew not found" }));
      const sent = await sendLink(base, crew);
      return cors(200, JSON.stringify({ ok: true, sent }));
    }

    // Short-lived signed URL for a file in the private crew-docs bucket (the
    // signed Agreement/W-9 PDFs + the uploaded certificates). Office-only (token
    // already checked). Path must be a crew-folder path.
    if (action === "file_url") {
      const path = String(body.path || "").trim();
      if (!/^[0-9a-fA-F-]{36}\/.+/.test(path)) return cors(400, JSON.stringify({ ok: false, error: "bad path" }));
      const r = await fetch(`${SB_URL}/storage/v1/object/sign/${BUCKET}/${path}`, { method: "POST", headers: sb, body: JSON.stringify({ expiresIn: 600 }) });
      if (!r.ok) return cors(502, JSON.stringify({ ok: false, error: `sign ${r.status}` }));
      const d = await r.json().catch(() => ({}));
      const rel = d.signedURL || d.signedUrl;
      if (!rel) return cors(502, JSON.stringify({ ok: false, error: "no signed url" }));
      const url = rel.startsWith("http") ? rel : `${SB_URL}/storage/v1${rel.startsWith("/") ? "" : "/"}${rel}`;
      return cors(200, JSON.stringify({ ok: true, url }));
    }

    // Countersign / approve a submitted crew (records the US Shingle signature).
    if (action === "approve") {
      const id = String(body.id || "").trim();
      const signName = String(body.sign_name || "").trim();
      if (!id || !signName) return cors(400, JSON.stringify({ ok: false, error: "id and sign_name required" }));
      const now = new Date().toISOString();
      const patch = { status: "approved", approved_at: now, us_shingle_signed_at: now, us_shingle_sign_name: signName, us_shingle_sign_title: String(body.sign_title || "").trim() || "US Shingle" };
      const r = await fetch(`${SB_URL}/rest/v1/crews?id=eq.${encodeURIComponent(id)}`, { method: "PATCH", headers: { ...sb, Prefer: "return=minimal" }, body: JSON.stringify(patch) });
      return cors(r.ok ? 200 : 500, JSON.stringify({ ok: r.ok }));
    }

    return cors(400, JSON.stringify({ ok: false, error: `Unknown action: ${action}` }));
  } catch (e) {
    return cors(500, JSON.stringify({ ok: false, error: e.message || "error" }));
  }
};

// Only the office-safe subset (never ssn/bank) for echoing back.
function safe(c) {
  return { status: c.status, owner_first: c.owner_first, owner_last: c.owner_last, owner_phone: c.owner_phone, owner_email: c.owner_email, company_name: c.company_name };
}

// Keep only known rate keys with numeric (or null) values.
function sanitizeRates(rates) {
  if (!rates || typeof rates !== "object") return null;
  const out = {};
  for (const k of Object.keys(DEFAULT_RATES)) {
    if (k in rates) {
      const v = rates[k];
      out[k] = (v === null || v === "" || v === undefined) ? null : (Number.isFinite(+v) ? +v : null);
    } else {
      out[k] = DEFAULT_RATES[k];
    }
  }
  return out;
}

async function sendLink(base, crew) {
  const link = `${base}/?crew=${crew.token}`;
  const first = String(crew.owner_first || "there").trim();
  const msg = `Hi ${first}! US Shingle & Metal here — please complete your crew onboarding (contact info, insurance/license uploads, W-9, and sign the agreement) here: ${link}`;
  const html =
    `<p>Hi ${first},</p>` +
    `<p>Welcome aboard! Please complete your subcontractor onboarding with US Shingle &amp; Metal — your contact info, insurance &amp; license uploads, W-9, and the agreement to sign.</p>` +
    `<p><a href="${link}" style="display:inline-block;padding:12px 22px;background:#1e3a6b;color:#fff;text-decoration:none;border-radius:8px;font-weight:700;">Complete onboarding →</a></p>` +
    `<p style="color:#64748b;font-size:13px;">Or paste this link into your browser:<br>${link}</p>`;
  const out = { sms: false, email: false };
  if (crew.owner_phone) out.sms = await postOk(`${base}/.netlify/functions/ghl-sms`, { to: crew.owner_phone, name: `${crew.owner_first || ""} ${crew.owner_last || ""}`.trim(), message: msg });
  if (crew.owner_email) out.email = await postOk(`${base}/.netlify/functions/send-email`, { to: crew.owner_email, subject: "Complete your US Shingle crew onboarding", html });
  return out;
}

async function postOk(url, payload) {
  try { const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }); return r.ok; } catch { return false; }
}
async function okToken(token) {
  token = String(token || "").trim();
  if (!token) return false;
  const [d, v] = await Promise.all([getSetting("dialer_token"), getSetting("visit_token")]);
  return (!!d && token === d) || (!!v && token === v);
}
async function getSetting(key) {
  const rows = await sbGet(`app_settings?key=eq.${encodeURIComponent(key)}&select=value&limit=1`);
  return rows[0]?.value || null;
}
async function sbGet(path) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: sb });
  if (!r.ok) return [];
  return r.json().catch(() => []);
}
function cors(status, body) {
  return { statusCode: status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" }, body };
}
