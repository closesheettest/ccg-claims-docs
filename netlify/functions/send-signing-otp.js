// netlify/functions/send-signing-otp.js
//
// Sends a fresh 6-digit one-time code to the homeowner so we can prove they
// control the contact info the signing link was sent to. The code goes to
// BOTH channels the link used — SMS *and* email — because a text can silently
// fail (bad number / carrier drop) even when the email link arrives fine, which
// would otherwise strand the homeowner at the code screen with no way through.
// Only a HASH of the code is stored; it expires in 10 minutes.
//
// POST { token } → { ok, sent_to, channels } | { ok:false, error, no_contact? }
//
// Env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY (+ ghl-sms / send-email funcs)

import crypto from "crypto";
import { loadByToken, patchByToken, otpHash, maskPhone, json, sendSms, sendEmail, escapeHtml } from "./_pending.js";

const OTP_TTL_MS = 10 * 60 * 1000;
const MAX_RESENDS = 6;

export const handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { ok: false, error: "Method not allowed" });
  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch { return json(400, { ok: false, error: "Invalid JSON body" }); }
  const token = (body.token || "").trim();
  if (!token) return json(400, { ok: false, error: "token required" });

  const row = await loadByToken(token);
  if (!row) return json(404, { ok: false, error: "invalid link" });
  if (row.status === "signed") return json(409, { ok: false, error: "already signed" });
  if (new Date(row.expires_at).getTime() < Date.now()) return json(410, { ok: false, error: "link expired" });

  const hasPhone = String(row.mobile || "").replace(/\D/g, "").length >= 10;
  const hasEmail = /.+@.+\..+/.test(String(row.email || "").trim());
  if (!hasPhone && !hasEmail) {
    return json(400, { ok: false, error: "no phone or email on file", no_contact: true });
  }
  if ((row.otp_resend_count || 0) >= MAX_RESENDS) {
    return json(429, { ok: false, error: "too many codes requested — please contact your rep" });
  }

  const code = String(crypto.randomInt(0, 1000000)).padStart(6, "0");
  const stored = await patchByToken(token, {
    otp_hash: otpHash(token, code),
    otp_expires_at: new Date(Date.now() + OTP_TTL_MS).toISOString(),
    otp_attempts: 0,
    otp_last_sent_at: new Date().toISOString(),
    otp_resend_count: (row.otp_resend_count || 0) + 1,
  });
  if (!stored) return json(500, { ok: false, error: "could not store the code" });

  // Fire both channels in parallel; succeed if EITHER lands.
  const [smsOk, emailOk] = await Promise.all([
    hasPhone ? sendSms(row.mobile, row.client_name || "there", `Your U.S. Shingle signing code is ${code}. It expires in 10 minutes. Don't share it with anyone.`) : Promise.resolve(false),
    hasEmail ? sendEmail({
      to: [String(row.email).trim()],
      subject: `Your U.S. Shingle signing code: ${code}`,
      html: `<div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto">
        <p>Hi ${escapeHtml(row.client_name || "there")},</p>
        <p>Here is your one-time code to sign your Free Roof Inspection Agreement:</p>
        <p style="font-size:32px;font-weight:800;letter-spacing:6px;color:#0f172a;margin:18px 0">${code}</p>
        <p style="font-size:13px;color:#6b7280">It expires in 10 minutes. Don't share it with anyone.</p>
      </div>`,
    }) : Promise.resolve(false),
  ]);

  const channels = [];
  if (smsOk) channels.push("sms");
  if (emailOk) channels.push("email");
  if (!channels.length) return json(502, { ok: false, error: "could not send the code — check your phone number/email or contact your rep" });

  // Human-readable "where we sent it" for the page.
  const parts = [];
  if (smsOk) parts.push(`your phone ${maskPhone(row.mobile)}`);
  if (emailOk) parts.push(maskEmail(row.email));
  return json(200, { ok: true, sent_to: parts.join(" and "), channels });
};

function maskEmail(raw) {
  const s = String(raw || "").trim();
  const at = s.indexOf("@");
  if (at < 1) return s;
  const name = s.slice(0, at), dom = s.slice(at);
  const shown = name.length <= 2 ? name[0] : name.slice(0, 2);
  return `${shown}${"*".repeat(Math.max(1, name.length - shown.length))}${dom}`;
}
