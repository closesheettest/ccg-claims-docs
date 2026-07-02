// netlify/functions/create-pending-signing.js
//
// Rep taps "Send to homeowner" on the Free Roof Inspection form. We DON'T write
// to inspections or JobNimbus yet — we stash the rep-entered data in
// pending_signings, mint a random token, and text + email the homeowner a
// /?sign_insp=<token> link (expires in 72h). Also handles action:"resend".
//
// POST { action?:"create"|"resend", token?, data:{ client_name, mobile, email,
//        address, city, state, zip, date, roof_type, lead_source, spanish_only,
//        sales_rep_name, sales_rep_id, sales_rep_email, obvious_damage,
//        has_insurance, review_availability, document_version } }
// → { ok, token, sent:["sms","email"], link }
//
// Env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY (+ ghl-sms / send-email funcs)

import crypto from "crypto";
import { SB_URL, sb, siteBase, loadByToken, patchByToken, json, sendSms, sendEmail, escapeHtml } from "./_pending.js";

const EXPIRY_MS = 72 * 60 * 60 * 1000;

export const handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { ok: false, error: "Method not allowed" });
  for (const k of ["VITE_SUPABASE_URL", "VITE_SUPABASE_ANON_KEY"]) {
    if (!process.env[k]) return json(500, { ok: false, error: `Missing env: ${k}` });
  }
  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch { return json(400, { ok: false, error: "Invalid JSON body" }); }

  if ((body.action || "create") === "resend") return await resend(body);

  const d = body.data || body;
  const client_name = (d.client_name || d.clientName || "").trim();
  const mobileDigits = String(d.mobile || "").replace(/\D/g, "");
  const email = (d.email || "").trim();
  if (!client_name) return json(400, { ok: false, error: "client_name required" });
  if (mobileDigits.length < 10 && !email) return json(400, { ok: false, error: "a mobile (10+ digits) or email is required to send the link" });

  const token = crypto.randomBytes(16).toString("hex");
  const nowIso = new Date().toISOString();
  const row = {
    token, status: "sent",
    client_name,
    mobile: (d.mobile || "").trim(),
    email: email || null,
    address: (d.address || "").trim() || null,
    city: (d.city || "").trim() || null,
    state: (d.state || "").trim() || null,
    zip: (d.zip || "").trim() || null,
    date: (d.date || "").trim() || null,
    roof_type: (d.roof_type || "Shingle").trim(),
    lead_source: (d.lead_source || "").trim() || null,
    spanish_only: !!d.spanish_only,
    sales_rep_name: (d.sales_rep_name || "").trim() || null,
    sales_rep_id: (d.sales_rep_id || "").trim() || null,
    sales_rep_email: (d.sales_rep_email || "").trim() || null,
    obvious_damage: !!d.obvious_damage,
    has_insurance: (d.has_insurance || "").trim() || null,
    review_availability: (d.review_availability || "").trim() || null,
    document_version: (d.document_version || "insp-v1").trim(),
    prepared_by_rep_name: (d.sales_rep_name || "").trim() || null,
    prepared_at: nowIso,
    expires_at: new Date(Date.now() + EXPIRY_MS).toISOString(),
    created_at: nowIso,
  };

  const ins = await fetch(`${SB_URL}/rest/v1/pending_signings`, {
    method: "POST", headers: { ...sb, Prefer: "return=representation" }, body: JSON.stringify(row),
  });
  if (!ins.ok) return json(500, { ok: false, error: `Insert failed: ${(await ins.text()).slice(0, 200)}` });
  const created = (await ins.json().catch(() => []))[0] || row;

  const sent = await sendLink(created);
  await patchByToken(token, { sent_channels: sent.join("+") || null, sent_at: sent.length ? new Date().toISOString() : null });

  if (!sent.length) return json(200, { ok: true, token, sent, warning: "Saved, but the link wasn't delivered (no valid phone/email or send failed)." });
  return json(200, { ok: true, token, sent, link: `${siteBase()}/?sign_insp=${token}` });
};

async function resend(body) {
  const token = (body.token || "").trim();
  if (!token) return json(400, { ok: false, error: "token required" });
  const row = await loadByToken(token);
  if (!row) return json(404, { ok: false, error: "Not found" });
  if (row.status === "signed") return json(409, { ok: false, error: "Already signed" });
  const sent = await sendLink(row);
  await patchByToken(token, {
    status: "sent",
    resend_count: (row.resend_count || 0) + 1,
    sent_at: new Date().toISOString(),
    sent_channels: sent.join("+") || null,
    expires_at: new Date(Date.now() + EXPIRY_MS).toISOString(),
  });
  if (!sent.length) return json(200, { ok: true, token, sent, warning: "Couldn't resend (no valid phone/email or send failed)." });
  return json(200, { ok: true, token, sent, link: `${siteBase()}/?sign_insp=${token}` });
}

async function sendLink(row) {
  const link = `${siteBase()}/?sign_insp=${row.token}`;
  const name = row.client_name || "there";
  const sent = [];
  if (String(row.mobile || "").replace(/\D/g, "").length >= 10) {
    if (await sendSms(row.mobile, name, `U.S. Shingle & Metal: please review & sign your Free Roof Inspection agreement here: ${link}  (link expires in 72 hours — we'll text a quick code to confirm it's you)`)) sent.push("sms");
  }
  if (row.email) {
    const ok = await sendEmail({
      to: [row.email],
      subject: "Sign your Free Roof Inspection Agreement — U.S. Shingle & Metal",
      html: `<div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto">
        <h2 style="color:#0f172a">Your Inspection Agreement is ready to sign</h2>
        <p>Hi ${escapeHtml(name)},</p>
        <p>Please review and sign your Free Roof Inspection Agreement. Tap the button below on your phone — we'll text you a quick 6-digit code to confirm it's you.</p>
        <p style="margin:22px 0"><a href="${link}" style="background:#199c2e;color:#fff;padding:13px 24px;border-radius:8px;text-decoration:none;font-weight:700">Review &amp; Sign</a></p>
        <p style="font-size:13px;color:#6b7280">Or open this link: <a href="${link}">${link}</a></p>
        <p style="font-size:12px;color:#9ca3af">This link expires in 72 hours. If you didn't request this, you can ignore it.</p>
      </div>`,
    });
    if (ok) sent.push("email");
  }
  return sent;
}
