// netlify/functions/verify-signing-otp.js
//
// Checks the 6-digit code the homeowner typed against the stored hash. On
// success we record phone_verified_at + the masked number (goes into the audit
// trail) and unlock signing. Capped at 5 attempts per code; codes expire in 10m.
//
// POST { token, code } → { ok, phone_verified_number, phone_verified_at }
//                      | { ok:false, error, attempts_left?, need_code? }
//
// Env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY

const { loadByToken, patchByToken, otpHash, maskPhone, json } = require("./_pending.js");

const MAX_ATTEMPTS = 5;

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { ok: false, error: "Method not allowed" });
  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch { return json(400, { ok: false, error: "Invalid JSON body" }); }
  const token = (body.token || "").trim();
  const code = String(body.code || "").replace(/\D/g, "");
  if (!token || !code) return json(400, { ok: false, error: "token and code required" });

  const row = await loadByToken(token);
  if (!row) return json(404, { ok: false, error: "invalid link" });
  if (row.phone_verified_at) {
    return json(200, { ok: true, already: true, phone_verified_number: row.phone_verified_number, phone_verified_at: row.phone_verified_at });
  }
  if (!row.otp_hash || !row.otp_expires_at) return json(400, { ok: false, error: "request a code first", need_code: true });
  if (new Date(row.otp_expires_at).getTime() < Date.now()) return json(410, { ok: false, error: "code expired — request a new one", need_code: true });
  if ((row.otp_attempts || 0) >= MAX_ATTEMPTS) return json(429, { ok: false, error: "too many attempts — request a new code", need_code: true });

  if (otpHash(token, code) !== row.otp_hash) {
    const attempts = (row.otp_attempts || 0) + 1;
    await patchByToken(token, { otp_attempts: attempts });
    return json(200, { ok: false, error: "incorrect code", attempts_left: Math.max(0, MAX_ATTEMPTS - attempts) });
  }

  const nowIso = new Date().toISOString();
  const masked = maskPhone(row.mobile);
  await patchByToken(token, {
    phone_verified_at: nowIso,
    phone_verified_number: masked,
    status: row.status === "signed" ? row.status : "phone_verified",
    otp_hash: null,
  });
  return json(200, { ok: true, phone_verified_number: masked, phone_verified_at: nowIso });
};
