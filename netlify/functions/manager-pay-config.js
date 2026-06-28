// netlify/functions/manager-pay-config.js
//
// Read/write the Managers Pay rate config (app_settings key "manager_pay_config")
// so the admin can change override rates + the monthly bonus and the report
// recalculates — no redeploy. Rates are PER REGION: the top-level keys are the
// default for every region, and config.regions[zone] overrides any subset for
// one region (e.g. a monthly bonus on Zone 4 only).
//
//   GET  → { ok, config (defaults), regions:{ "Zone 1":{effective…}, … } }
//   POST { pin, config:{ base_rate.., regions:{ "Zone 1":{…}, … } } } → same shape
//
// PIN = app_settings "manager_pay_pin" → env MANAGER_PAY_PIN → "1234".
// Env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY.

const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const sb = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" };
const KEY = "manager_pay_config";
const PIN_KEY = "manager_pay_pin";
const DEFAULT_CONFIG = { base_rate: 0.02, own_sale_rate: 0.01, irbad_rate: 0.20, irbad_bonus: 0.10, monthly_bonus: 0, ins_min_ppsf: 1.5, rad_min_ppsf: 2.5 };
const RATE_KEYS = ["base_rate", "own_sale_rate", "irbad_rate", "irbad_bonus"];
const THRESH_KEYS = ["ins_min_ppsf", "rad_min_ppsf"]; // global $/sqft floors
const ZONES = ["Zone 1", "Zone 2", "Zone 3", "Zone 4"];

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return cors(200, "");
  if (!SB_URL || !SB_KEY) return cors(500, JSON.stringify({ ok: false, error: "env missing" }));

  if (event.httpMethod === "GET") return cors(200, JSON.stringify({ ok: true, ...shape(await loadConfig()) }));
  if (event.httpMethod !== "POST") return cors(405, JSON.stringify({ ok: false, error: "GET or POST" }));

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { return cors(400, JSON.stringify({ ok: false, error: "bad JSON" })); }

  const wantPin = String((await getSetting(PIN_KEY)) || process.env.MANAGER_PAY_PIN || "1234");
  if (String(body.pin || "") !== wantPin) return cors(401, JSON.stringify({ ok: false, error: "Incorrect PIN" }));

  const stored = sanitize(body.config || {});
  const up = await fetch(`${SB_URL}/rest/v1/app_settings?on_conflict=key`, {
    method: "POST",
    headers: { ...sb, Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ key: KEY, value: JSON.stringify(stored), updated_at: new Date().toISOString() }),
  });
  if (!up.ok) return cors(500, JSON.stringify({ ok: false, error: `save failed (${up.status})` }));
  return cors(200, JSON.stringify({ ok: true, ...shape(stored) }));
};

// Stored shape → { config: defaults (rates + global thresholds), regions:{ zone: effective rates } }.
function shape(stored) {
  const config = { ...DEFAULT_CONFIG, ...rates(stored), ...thresholds(stored) };
  const regions = {};
  for (const z of ZONES) regions[z] = { ...DEFAULT_CONFIG, ...rates(stored), ...rates((stored.regions || {})[z] || {}) };
  return { config, regions };
}
function rates(input) {
  const out = {};
  for (const k of RATE_KEYS) { const n = Number(input[k]); if (Number.isFinite(n)) out[k] = Math.min(1, Math.max(0, n)); }
  const mb = Number(input.monthly_bonus); if (Number.isFinite(mb)) out.monthly_bonus = Math.max(0, mb);
  return out;
}
function thresholds(input) {
  const out = {};
  for (const k of THRESH_KEYS) { const n = Number(input[k]); if (Number.isFinite(n)) out[k] = Math.max(0, n); }
  return out;
}
function sanitize(input) {
  const out = { ...DEFAULT_CONFIG, ...rates(input), ...thresholds(input), regions: {} };
  if (input.regions && typeof input.regions === "object") {
    for (const z of ZONES) { const r = rates(input.regions[z] || {}); if (Object.keys(r).length) out.regions[z] = r; }
  }
  return out;
}
async function loadConfig() {
  const v = await getSetting(KEY);
  if (v) { try { return typeof v === "string" ? JSON.parse(v) : v; } catch { /* fall through */ } }
  return {};
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
