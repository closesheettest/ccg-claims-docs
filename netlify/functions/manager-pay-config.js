// netlify/functions/manager-pay-config.js
//
// Read/write the Managers Pay rate config (app_settings key "manager_pay_config")
// so the admin can change override rates + the monthly bonus and the report
// recalculates — no redeploy.
//
//   GET  → { ok, config }                       (current rates, merged w/ defaults)
//   POST { pin, config } → { ok, config }        (admin PIN-gated; sanitized save)
//
// PIN = app_settings "manager_pay_pin" → env MANAGER_PAY_PIN → "1234" (the same
// default admin PIN the rest of the hub uses). Env: VITE_SUPABASE_URL,
// VITE_SUPABASE_ANON_KEY.

const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const sb = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" };
const KEY = "manager_pay_config";
const PIN_KEY = "manager_pay_pin";
const DEFAULT_CONFIG = { base_rate: 0.02, own_sale_rate: 0.01, irbad_rate: 0.20, irbad_bonus: 0.10, monthly_bonus: 0 };
const RATE_KEYS = ["base_rate", "own_sale_rate", "irbad_rate", "irbad_bonus"];

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return cors(200, "");
  if (!SB_URL || !SB_KEY) return cors(500, JSON.stringify({ ok: false, error: "env missing" }));

  if (event.httpMethod === "GET") {
    return cors(200, JSON.stringify({ ok: true, config: await loadConfig() }));
  }
  if (event.httpMethod !== "POST") return cors(405, JSON.stringify({ ok: false, error: "GET or POST" }));

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { return cors(400, JSON.stringify({ ok: false, error: "bad JSON" })); }

  const wantPin = String((await getSetting(PIN_KEY)) || process.env.MANAGER_PAY_PIN || "1234");
  if (String(body.pin || "") !== wantPin) return cors(401, JSON.stringify({ ok: false, error: "Incorrect PIN" }));

  const cfg = sanitize(body.config || {});
  const up = await fetch(`${SB_URL}/rest/v1/app_settings?on_conflict=key`, {
    method: "POST",
    headers: { ...sb, Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ key: KEY, value: JSON.stringify(cfg), updated_at: new Date().toISOString() }),
  });
  if (!up.ok) return cors(500, JSON.stringify({ ok: false, error: `save failed (${up.status})` }));
  return cors(200, JSON.stringify({ ok: true, config: cfg }));
};

// Rates are fractions (0.02 = 2%), clamped 0–1. monthly_bonus is dollars ≥ 0.
function sanitize(input) {
  const out = { ...DEFAULT_CONFIG };
  for (const k of RATE_KEYS) { const n = Number(input[k]); if (Number.isFinite(n)) out[k] = Math.min(1, Math.max(0, n)); }
  const mb = Number(input.monthly_bonus); if (Number.isFinite(mb)) out.monthly_bonus = Math.max(0, mb);
  return out;
}
async function loadConfig() {
  const v = await getSetting(KEY);
  if (v) { try { return { ...DEFAULT_CONFIG, ...(typeof v === "string" ? JSON.parse(v) : v) }; } catch { /* fall through */ } }
  return { ...DEFAULT_CONFIG };
}
async function getSetting(key) {
  try {
    const r = await fetch(`${SB_URL}/rest/v1/app_settings?key=eq.${encodeURIComponent(key)}&select=value&limit=1`, { headers: sb });
    if (r.ok) { const rows = await r.json(); return rows?.[0]?.value ?? null; }
  } catch { /* ignore */ }
  return null;
}
function cors(status, body) {
  return { statusCode: status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" }, body };
}
