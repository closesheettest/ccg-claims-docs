// netlify/functions/send-signing-otp.js
//
// Texts a fresh 6-digit one-time code to the homeowner's phone (the same number
// the signing link was sent to) so we can prove phone control before they sign.
// Only a HASH of the code is stored; it expires in 10 minutes.
//
// POST { token } → { ok, sent_to } | { ok:false, error, no_phone? }
//
// Env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY (+ ghl-sms func)

import crypto from "crypto";
import { loadByToken, patchByToken, otpHash, maskPhone, json, sendSms } from "./_pending.js";

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

  if (String(row.mobile || "").replace(/\D/g, "").length < 10) {
    return json(400, { ok: false, error: "no phone on file", no_phone: true });
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

  const ok = await sendSms(row.mobile, row.client_name || "there", `Your U.S. Shingle signing code is ${code}. It expires in 10 minutes. Don't share it with anyone.`);
  if (!ok) return json(502, { ok: false, error: "could not send the code by text" });

  return json(200, { ok: true, sent_to: maskPhone(row.mobile) });
};
