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
import { SB_URL, sb, siteBase, loadByToken, patchByToken, otpHash, json, sendSms, sendEmail, escapeHtml, autosendEnabled } from "./_pending.js";

const EXPIRY_MS = 72 * 60 * 60 * 1000;

export const handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { ok: false, error: "Method not allowed" });
  for (const k of ["VITE_SUPABASE_URL", "VITE_SUPABASE_ANON_KEY"]) {
    if (!process.env[k]) return json(500, { ok: false, error: `Missing env: ${k}` });
  }
  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch { return json(400, { ok: false, error: "Invalid JSON body" }); }

  if ((body.action || "create") === "resend") return await resend(body);
  if ((body.action || "create") === "void") return await voidReq(body);

  const d = body.data || body;
  const client_name = (d.client_name || d.clientName || "").trim();
  const mobileDigits = String(d.mobile || "").replace(/\D/g, "");
  const email = (d.email || "").trim();
  if (!client_name) return json(400, { ok: false, error: "client_name required" });
  if (mobileDigits.length < 10 && !email) return json(400, { ok: false, error: "a mobile (10+ digits) or email is required to send the link" });

  // Per-signup code-delivery choice (from which button the rep tapped):
  //   'rep_code' = "Sign now" → code shown on the rep's screen (no auto-send).
  //   'sms'      = "Send for signing" → link + code texted/emailed to homeowner.
  // If the caller doesn't specify, fall back to the global autosend flag.
  const explicitMode = d.mode === "sms" ? "sms" : d.mode === "rep_code" ? "rep_code" : null;
  const autosend = explicitMode ? explicitMode === "sms" : await autosendEnabled();
  const deliveryMode = explicitMode || (autosend ? "sms" : "rep_code");

  const token = crypto.randomBytes(16).toString("hex");
  const nowIso = new Date().toISOString();
  // Rep-screen PAIRING CODE: after the homeowner opens the link, the rep's phone
  // reveals this 6-digit code; she types it into HER phone to verify. Nothing is
  // delivered to the homeowner (kills the SMS/email delivery problem). Stored as
  // a hash in otp_hash so verify-signing-otp compares against it unchanged; valid
  // for the full link lifetime. In SMS-fallback mode, send-signing-otp overwrites
  // this hash with a freshly texted code.
  const pairingCode = String(crypto.randomInt(0, 1000000)).padStart(6, "0");
  const row = {
    token, status: "sent",
    otp_hash: otpHash(token, pairingCode),
    otp_expires_at: new Date(Date.now() + EXPIRY_MS).toISOString(),
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
    delivery_mode: deliveryMode,
    sandbox: !!d.sandbox,   // training/practice run → never becomes a real deal

    prepared_by_rep_name: (d.sales_rep_name || "").trim() || null,
    prepared_at: nowIso,
    expires_at: new Date(Date.now() + EXPIRY_MS).toISOString(),
    created_at: nowIso,
  };
  // Harvesting-Map handoff: the pin this signing came from (if any), so finalize
  // can flip it Inspection Sold once the homeowner signs. Only set when present,
  // and tolerate the column not existing yet (retry without it) so a normal
  // signing is never blocked before sql/pending_signings_harvest_pin.sql is run.
  const harvestPin = (d.harvest_pin || "").trim() || null;
  if (harvestPin) row.harvest_pin = harvestPin;

  const doInsert = (r) => fetch(`${SB_URL}/rest/v1/pending_signings`, {
    method: "POST", headers: { ...sb, Prefer: "return=representation" }, body: JSON.stringify(r),
  });
  let ins = await doInsert(row);
  if (!ins.ok) {
    const t = await ins.text();
    if (harvestPin && /harvest_pin/.test(t)) {
      const { harvest_pin, ...rest } = row; // column missing → drop it and retry
      ins = await doInsert(rest);
      if (!ins.ok) return json(500, { ok: false, error: `Insert failed: ${(await ins.text()).slice(0, 200)}` });
    } else {
      return json(500, { ok: false, error: `Insert failed: ${t.slice(0, 200)}` });
    }
  }
  const created = (await ins.json().catch(() => []))[0] || row;

  // "Send for signing" (sms) → auto-text/email the link now. "Sign now"
  // (rep_code) → do NOT auto-send; the rep shares it in person (QR / copy link)
  // and reads the pairing code off their screen. Mode was chosen per-signup
  // above (falling back to the remote_signing_autosend flag when unspecified).
  const sent = deliveryMode === "sms" ? await sendLink(created) : [];
  await patchByToken(token, { sent_channels: sent.join("+") || null, sent_at: sent.length ? new Date().toISOString() : null });

  return json(200, {
    ok: true, token, sent,
    link: `${siteBase()}/?sign_insp=${token}`,
    pairing_code: pairingCode,
    mode: deliveryMode,
  });
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

// Void an OPEN signing request so its link can no longer be signed (and can't
// later create a duplicate deal). Soft — sets status "canceled" + expires it,
// never hard-deletes. Refuses if it's already signed.
async function voidReq(body) {
  const token = (body.token || "").trim();
  if (!token) return json(400, { ok: false, error: "token required" });
  const row = await loadByToken(token);
  if (!row) return json(404, { ok: false, error: "Not found" });
  if (row.status === "signed") return json(409, { ok: false, error: "Already signed — can't void." });
  await patchByToken(token, { status: "canceled", expires_at: new Date().toISOString() });
  return json(200, { ok: true, token, status: "canceled" });
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
