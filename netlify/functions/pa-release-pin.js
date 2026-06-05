// netlify/functions/pa-release-pin.js
//
// Tiny key/value gate for the PA portal's "Release this deal back to the
// pool" button. A 4-digit PIN is stored server-side (Supabase
// app_settings table, key "pa_release_pin") so it's shared across every
// device — the PA portal (which verifies) and the manager Settings UI
// (which sets it) live in different browsers, so localStorage won't do.
//
// POST body actions:
//   { action: "verify", pin: "1234" }   -> { ok, valid }
//   { action: "set",    newPin: "5678" } -> { ok }   (manager)
//
// If the row doesn't exist yet, the PIN defaults to "1234" so the gate
// still works before anyone customizes it. The PIN itself is never
// returned to the client — verify only echoes a boolean.
//
// Required env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY.

const SETTING_KEY = "pa_release_pin";
const DEFAULT_PIN = "1234";

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return json(405, { ok: false, error: "Method not allowed" });
  }
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
  if (!SB_URL || !SB_KEY) {
    return json(500, { ok: false, error: "Missing Supabase env" });
  }
  const sbHeaders = {
    apikey: SB_KEY,
    Authorization: `Bearer ${SB_KEY}`,
    "Content-Type": "application/json",
  };

  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch {
    return json(400, { ok: false, error: "Invalid JSON body" });
  }
  const action = (body.action || "").trim();

  // Read the current stored PIN (falls back to DEFAULT_PIN if no row).
  async function readPin() {
    try {
      const r = await fetch(
        `${SB_URL}/rest/v1/app_settings?key=eq.${encodeURIComponent(SETTING_KEY)}&select=value&limit=1`,
        { headers: sbHeaders },
      );
      if (!r.ok) return DEFAULT_PIN;
      const rows = await r.json().catch(() => []);
      const v = rows?.[0]?.value;
      return (v && String(v).trim()) || DEFAULT_PIN;
    } catch {
      return DEFAULT_PIN;
    }
  }

  if (action === "verify") {
    const pin = (body.pin == null ? "" : String(body.pin)).trim();
    if (!pin) return json(400, { ok: false, error: "pin required" });
    const stored = await readPin();
    return json(200, { ok: true, valid: pin === stored });
  }

  if (action === "set") {
    const newPin = (body.newPin == null ? "" : String(body.newPin)).trim();
    if (!/^\d{4}$/.test(newPin)) {
      return json(400, { ok: false, error: "PIN must be exactly 4 digits" });
    }
    // Upsert via PostgREST (on_conflict=key, merge-duplicates).
    try {
      const r = await fetch(
        `${SB_URL}/rest/v1/app_settings?on_conflict=key`,
        {
          method: "POST",
          headers: { ...sbHeaders, Prefer: "resolution=merge-duplicates,return=minimal" },
          body: JSON.stringify({ key: SETTING_KEY, value: newPin, updated_at: new Date().toISOString() }),
        },
      );
      if (!r.ok) {
        return json(502, { ok: false, error: `Could not save PIN: ${(await r.text()).slice(0, 200)}` });
      }
    } catch (e) {
      return json(502, { ok: false, error: e.message || "Save failed" });
    }
    return json(200, { ok: true });
  }

  return json(400, { ok: false, error: `Unknown action "${action}"` });
};

function json(status, body) {
  return {
    statusCode: status,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}
