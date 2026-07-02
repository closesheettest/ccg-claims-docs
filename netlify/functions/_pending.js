// netlify/functions/_pending.js
//
// Shared helpers for the Free Roof Inspection remote e-signature flow
// (pending_signings). `_`-prefixed files are helper modules, not endpoints.
// Everything talks to Supabase with the anon key, same pattern as
// submit-correction.js — reads/writes are mediated here, RLS stays closed.

const crypto = require("crypto");

const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const sb = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" };

function siteBase() {
  return (process.env.URL || process.env.PUBLIC_SITE_URL || "https://free-roof-inspections.netlify.app").replace(/\/$/, "");
}

async function loadByToken(token, select = "*") {
  const url = `${SB_URL}/rest/v1/pending_signings?token=eq.${encodeURIComponent(token)}&select=${select}&limit=1`;
  const r = await fetch(url, { headers: sb });
  if (!r.ok) return null;
  const rows = await r.json().catch(() => []);
  return rows[0] || null;
}

async function patchByToken(token, patch) {
  const r = await fetch(`${SB_URL}/rest/v1/pending_signings?token=eq.${encodeURIComponent(token)}`, {
    method: "PATCH",
    headers: { ...sb, Prefer: "return=minimal" },
    body: JSON.stringify(patch),
  });
  return r.ok;
}

function maskPhone(raw) {
  const d = String(raw || "").replace(/\D/g, "").slice(-10);
  if (d.length < 4) return "";
  return `(xxx) xxx-${d.slice(-4)}`;
}

// The stored OTP is only ever a hash of token+code — never the plaintext code.
function otpHash(token, code) {
  return crypto.createHash("sha256").update(`${token}:${code}`).digest("hex");
}

function clientIp(event) {
  const h = event.headers || {};
  const raw = h["x-nf-client-connection-ip"] || h["client-ip"] || h["x-forwarded-for"] || h["x-real-ip"] || "";
  return String(raw).split(",")[0].trim();
}

function json(status, body) {
  return { statusCode: status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }, body: JSON.stringify(body) };
}

async function sendSms(to, name, message) {
  try {
    const r = await fetch(`${siteBase()}/.netlify/functions/ghl-sms`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to, name, message }),
    });
    return r.ok;
  } catch { return false; }
}

async function sendEmail(payload) {
  try {
    const r = await fetch(`${siteBase()}/.netlify/functions/send-email`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return r.ok;
  } catch { return false; }
}

function escapeHtml(s) {
  return String(s || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

module.exports = { SB_URL, sb, siteBase, loadByToken, patchByToken, maskPhone, otpHash, clientIp, json, sendSms, sendEmail, escapeHtml };
