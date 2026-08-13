// netlify/functions/manager-dashboard.js
//
// Backend for the "My Tools" launcher (?mode=mytools): a shared manager PIN gates
// entry, then each manager picks their name and keeps their OWN curated set of tool
// tiles — so they build a dashboard of just what they use instead of scrolling the
// whole catalog.
//
//   GET  ?manager=<name>          → { ok, tools:[keys], pin_set }
//   POST { action:"auth", pin }   → { ok } | 401   (validate the shared PIN)
//   POST { action:"save", pin, manager, tools:[keys] } → { ok }  (PIN-checked)
//
// Storage (no migration): the shared PIN lives in app_settings.manager_pin; each
// manager's picks under app_settings key  mgrdash_<slug>.
//
// Env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY.

const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const H = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" };
const slug = (name) => "mgrdash_" + String(name || "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return cors(200, "");
  if (!SB_URL || !SB_KEY) return cors(500, JSON.stringify({ ok: false, error: "env missing" }));
  try {
    if (event.httpMethod === "GET") {
      const manager = (event.queryStringParameters || {}).manager || "";
      const pinSet = await getSetting("manager_pin");
      if (!manager) return cors(200, JSON.stringify({ ok: true, pin_set: !!pinSet }));
      const raw = await getSetting(slug(manager));
      let tools = [];
      try { tools = raw ? JSON.parse(raw) : []; } catch { tools = []; }
      return cors(200, JSON.stringify({ ok: true, tools: Array.isArray(tools) ? tools : [], pin_set: !!pinSet }));
    }

    if (event.httpMethod === "POST") {
      const body = JSON.parse(event.body || "{}");
      const action = body.action || "auth";
      const stored = await getSetting("manager_pin");
      const pin = String(body.pin || "").trim();
      // First-ever use: no PIN on file → whatever is typed BECOMES the shared PIN.
      if (!stored) {
        if (!/^\d{4,8}$/.test(pin)) return cors(400, JSON.stringify({ ok: false, error: "Set a 4–8 digit PIN." }));
        await setSetting("manager_pin", pin);
      } else if (pin !== stored) {
        return cors(401, JSON.stringify({ ok: false, error: "Incorrect PIN." }));
      }
      if (action === "auth") return cors(200, JSON.stringify({ ok: true }));
      if (action === "save") {
        const manager = String(body.manager || "").trim();
        if (!manager) return cors(400, JSON.stringify({ ok: false, error: "manager required" }));
        const tools = Array.isArray(body.tools) ? body.tools.filter((t) => typeof t === "string").slice(0, 200) : [];
        await setSetting(slug(manager), JSON.stringify(tools));
        return cors(200, JSON.stringify({ ok: true, tools }));
      }
      return cors(400, JSON.stringify({ ok: false, error: "unknown action" }));
    }
    return cors(405, JSON.stringify({ ok: false, error: "method" }));
  } catch (e) {
    return cors(500, JSON.stringify({ ok: false, error: e.message || "error" }));
  }
};

async function getSetting(key) {
  const r = await fetch(`${SB_URL}/rest/v1/app_settings?key=eq.${encodeURIComponent(key)}&select=value&limit=1`, { headers: H });
  if (!r.ok) return null;
  const rows = await r.json().catch(() => []);
  return rows[0] ? rows[0].value : null;
}
async function setSetting(key, value) {
  await fetch(`${SB_URL}/rest/v1/app_settings?on_conflict=key`, {
    method: "POST",
    headers: { ...H, Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ key, value }),
  });
}
function cors(status, body) {
  return { statusCode: status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" }, body };
}
