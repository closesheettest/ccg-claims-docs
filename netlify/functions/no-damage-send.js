// netlify/functions/no-damage-send.js
//
// No-Damage visit "Send to homeowner": emails + texts the homeowner their
// NO-DAMAGE certificate (with photos) and a Google review link, and saves any
// referrals the rep captured. Best-effort per channel.
//
// POST { token, inspection_id, referrals?:[{name,phone}], rep_name? }
//   → { ok, emailed, texted }
//
// Env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, plus URL for sibling fns.

const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const sb = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" };
const REVIEW_FALLBACK = "https://g.page/r/REPLACE_ME/review";

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return cors(200, "");
  if (event.httpMethod !== "POST") return cors(405, JSON.stringify({ ok: false, error: "POST only" }));
  if (!SB_URL || !SB_KEY) return cors(500, JSON.stringify({ ok: false, error: "env missing" }));

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { return cors(400, JSON.stringify({ ok: false, error: "bad JSON" })); }
  if (!(await okToken(body.token))) return cors(401, JSON.stringify({ ok: false, error: "Invalid link" }));

  const inspectionId = String(body.inspection_id || "").trim();
  if (!inspectionId) return cors(400, JSON.stringify({ ok: false, error: "inspection_id required" }));
  const repName = String(body.rep_name || "").trim();
  const referrals = Array.isArray(body.referrals) ? body.referrals : [];
  const base = process.env.URL || process.env.DEPLOY_URL || process.env.PUBLIC_SITE_URL || "";

  try {
    const insp = (await sbGet(`inspections?id=eq.${encodeURIComponent(inspectionId)}&select=id,client_name,mobile,email,jn_job_id&limit=1`))[0];
    if (!insp) return cors(404, JSON.stringify({ ok: false, error: "inspection not found" }));
    const reviewUrl = (await getSetting("google_review_url")) || REVIEW_FALLBACK;

    // Save referrals first (cheap, independent of sends).
    if (referrals.length) {
      const rows = referrals
        .filter((x) => x && (x.name || x.phone || x.address))
        .map((x) => ({ inspection_id: inspectionId, referred_by_name: insp.client_name || null, referral_name: x.name || null, referral_phone: x.phone || null, referral_address: x.address || null, captured_by_rep: repName || null }));
      if (rows.length) await fetch(`${SB_URL}/rest/v1/referrals`, { method: "POST", headers: { ...sb, Prefer: "return=minimal" }, body: JSON.stringify(rows) }).catch(() => {});
    }

    // Generate / fetch the No-Damage certificate PDF (with photos).
    let pdfUrl = null, pdfBase64 = null, filename = "no-damage-certificate.pdf";
    if (insp.jn_job_id && base) {
      try {
        const r = await fetch(`${base}/.netlify/functions/generate-and-upload-insp-report`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jnid: insp.jn_job_id, skip_jn_upload: true }),
        });
        const j = await r.json().catch(() => ({}));
        if (j && j.ok) {
          pdfUrl = j.pdf_signed_url || null;
          if (j.filename) filename = j.filename;
          if (pdfUrl) {
            const pr = await fetch(pdfUrl);
            if (pr.ok) pdfBase64 = Buffer.from(await pr.arrayBuffer()).toString("base64");
          }
        }
      } catch { /* best-effort; still send the review ask */ }
    }

    const first = (insp.client_name || "there").split(" ")[0];
    let emailed = false, texted = false;

    // Email with cert attached + review link.
    if (base && insp.email) {
      const html =
        `<p>Hi ${esc(first)},</p>` +
        `<p>Great news — your roof inspection showed <b>no storm damage</b>. Your No-Damage Certificate (with photos) is attached for your records.</p>` +
        `<p>If we earned it, a quick review would mean a lot:<br><a href="${reviewUrl}">${reviewUrl}</a></p>` +
        `<p>Thank you,<br>${esc(repName || "U.S. Shingle & Metal")}</p>`;
      const payload = { to: insp.email, subject: "Your Roof — No-Damage Certificate", html };
      if (pdfBase64) payload.attachments = [{ filename, content: pdfBase64 }];
      emailed = await postOk(`${base}/.netlify/functions/send-email`, payload);
    }

    // SMS with review link + cert link (SMS can't attach files).
    if (base && insp.mobile) {
      const msg = `Hi ${first}, good news — no storm damage found on your roof. ` +
        (pdfUrl ? `Your certificate: ${pdfUrl} ` : "") +
        `If we earned it, a quick review helps a ton: ${reviewUrl}`;
      texted = await postOk(`${base}/.netlify/functions/ghl-sms`, { to: insp.mobile, name: insp.client_name || "", message: msg });
    }

    return cors(200, JSON.stringify({ ok: true, emailed, texted, hadCert: !!pdfBase64 }));
  } catch (e) {
    return cors(500, JSON.stringify({ ok: false, error: e.message || "error" }));
  }
};

async function postOk(url, payload) {
  try { const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }); return r.ok; } catch { return false; }
}
function esc(s) { return String(s || "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c])); }
async function okToken(token) {
  token = String(token || "").trim();
  if (!token) return false;
  const [d, v] = await Promise.all([getSetting("dialer_token"), getSetting("visit_token")]);
  return token === d || token === v;
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
