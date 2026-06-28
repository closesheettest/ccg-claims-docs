// netlify/functions/pa-broadcast.js
//
// Admin "Notify PAs" — send a personalized email + SMS to every ACTIVE public
// adjuster. Used from the admin section's PA-notification composer.
//
// Personalization tokens in the message AND the optional html template:
//   {name}   → PA's first name
//   {region} → their zones joined (or "your assigned region" if none set)
//   {radius} → "<max_distance_miles> miles" (or "your set radius")
//   {portal} → their working portal link (…/?mode=pa&pa=<id>)
//   {link}   → their welcome/onboarding link (…/?pa_welcome=<id>)
//
// POST { token, subject, message, html?, test_to?, test_name? }
//   message: plain-text body — used for SMS, and (when no html) auto-wrapped for email.
//   html:    optional full HTML email template (tokens substituted per PA).
//   test_to: an email/phone to send a single preview to instead of all PAs.
//   → { ok, total, emailed, texted, errors? }
//
// Gate: token must equal app_settings.dialer_token OR visit_token.
// Env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY.

const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const sb = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" };

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return cors(200, "");
  if (event.httpMethod !== "POST") return cors(405, JSON.stringify({ ok: false, error: "POST only" }));
  if (!SB_URL || !SB_KEY) return cors(500, JSON.stringify({ ok: false, error: "env missing" }));

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { return cors(400, JSON.stringify({ ok: false, error: "bad JSON" })); }
  // Auth: a PA-company token scopes to that company's PAs; the global
  // dialer/visit token reaches every active PA.
  const token = String(body.token || "").trim();
  const company = token ? (await sbGet(`pa_companies?token=eq.${encodeURIComponent(token)}&select=id&limit=1`))[0] : null;
  const companyId = company?.id || null;
  if (!companyId && !(await matchesGlobalToken(token))) return cors(401, JSON.stringify({ ok: false, error: "Invalid token" }));

  const subject = String(body.subject || "").trim() || "A message from U.S. Shingle & Metal";
  const message = String(body.message || "").trim();
  if (!message) return cors(400, JSON.stringify({ ok: false, error: "message required" }));
  const base = process.env.URL || process.env.DEPLOY_URL || process.env.PUBLIC_SITE_URL || "";

  try {
    // Optional single test send (no personalization beyond a generic name).
    let pas;
    if (body.test_to) {
      const t = String(body.test_to).trim();
      pas = [{ id: body.test_id || "DEMO", name: body.test_name || "Test", email: t.includes("@") ? t : null, phone: t.includes("@") ? null : t, zones: [], max_distance_miles: null }];
    } else {
      let path = "pas?active=eq.true&select=id,name,email,phone,zones,max_distance_miles";
      if (companyId) path += `&pa_company_id=eq.${encodeURIComponent(companyId)}`;
      pas = await sbGet(path);
    }

    let emailed = 0, texted = 0;
    const errors = [];
    const htmlTpl = body.html ? String(body.html) : null; // optional full email template (tokens allowed)
    for (const pa of pas) {
      const link = base && pa.id ? `${base}/?pa_welcome=${pa.id}` : "";
      const portal = base && pa.id ? `${base}/?mode=pa&pa=${pa.id}` : (base ? `${base}/?mode=pa` : "");
      const repl = (s) => fill(s, pa).replace(/\{link\}/gi, link).replace(/\{portal\}/gi, portal);
      const personal = repl(message);
      if (pa.email) {
        const html = htmlTpl ? repl(htmlTpl) : toHtml(personal);
        const ok = await postOk(`${base}/.netlify/functions/send-email`, { to: pa.email, subject, html });
        if (ok) emailed++; else errors.push(`email ${pa.name}`);
      }
      if (pa.phone) {
        const ok = await postOk(`${base}/.netlify/functions/ghl-sms`, { to: pa.phone, name: pa.name || "", message: personal });
        if (ok) texted++; else errors.push(`sms ${pa.name}`);
      }
    }
    return cors(200, JSON.stringify({ ok: true, total: pas.length, emailed, texted, ...(errors.length ? { errors } : {}) }));
  } catch (e) {
    return cors(500, JSON.stringify({ ok: false, error: e.message || "error" }));
  }
};

function fill(msg, pa) {
  const first = String(pa.name || "there").trim().split(/\s+/)[0];
  const region = Array.isArray(pa.zones) && pa.zones.length ? pa.zones.join(", ") : "your assigned region";
  const radius = pa.max_distance_miles ? `${pa.max_distance_miles} miles` : "your set radius";
  return msg.replace(/\{name\}/gi, first).replace(/\{region\}/gi, region).replace(/\{radius\}/gi, radius);
}
function toHtml(text) {
  return text.split(/\n{2,}/).map((p) => `<p>${esc(p).replace(/\n/g, "<br>")}</p>`).join("");
}
function esc(s) { return String(s || "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c])); }
async function postOk(url, payload) {
  try { const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }); return r.ok; } catch { return false; }
}
async function matchesGlobalToken(token) {
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
