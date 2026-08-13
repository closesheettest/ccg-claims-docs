// netlify/functions/manager-dashboard.js
//
// Backend for the "My Tools" launcher (?mode=mytools). Each person has their OWN
// passcode (not a shared PIN): the first time they pick their name they SET a passcode
// (the UI asks them to confirm it), and after that it validates against theirs. Each
// person keeps their own curated set of tool tiles.
//
//   GET  ?manager=<name>              → { ok, tools:[keys], pin_set }   (pin_set = does THIS person have a passcode yet)
//   POST { action:"auth", manager, pin }              → { ok }   (first time: sets it; after: validates)
//   POST { action:"save", manager, pin, tools:[keys] } → { ok }  (passcode-checked)
//
// Storage (no migration): each person's passcode in app_settings key  mgrpin_<slug>;
// their tool picks in  mgrdash_<slug>.
//
// Env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY.

const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const H = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" };
const bareSlug = (name) => String(name || "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
const pinKey = (name) => "mgrpin_" + bareSlug(name);
const toolsKey = (name) => "mgrdash_" + bareSlug(name);

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return cors(200, "");
  if (!SB_URL || !SB_KEY) return cors(500, JSON.stringify({ ok: false, error: "env missing" }));
  try {
    if (event.httpMethod === "GET") {
      const manager = (event.queryStringParameters || {}).manager || "";
      if (!manager) return cors(200, JSON.stringify({ ok: true }));
      const pinSet = await getSetting(pinKey(manager));
      const raw = await getSetting(toolsKey(manager));
      let tools = [];
      try { tools = raw ? JSON.parse(raw) : []; } catch { tools = []; }
      return cors(200, JSON.stringify({ ok: true, tools: Array.isArray(tools) ? tools : [], pin_set: !!pinSet }));
    }

    if (event.httpMethod === "POST") {
      const body = JSON.parse(event.body || "{}");
      const action = body.action || "auth";
      const manager = String(body.manager || "").trim();
      const pin = String(body.pin || "").trim();
      if (!manager) return cors(400, JSON.stringify({ ok: false, error: "Pick your name first." }));

      const stored = await getSetting(pinKey(manager));
      // First time for THIS person: whatever they enter becomes their own passcode.
      if (!stored) {
        if (!/^\d{4,8}$/.test(pin)) return cors(400, JSON.stringify({ ok: false, error: "Set a 4–8 digit passcode." }));
        await setSetting(pinKey(manager), pin);
      } else if (pin !== stored) {
        return cors(401, JSON.stringify({ ok: false, error: "Incorrect passcode." }));
      }

      if (action === "auth") return cors(200, JSON.stringify({ ok: true }));
      if (action === "save") {
        const tools = Array.isArray(body.tools) ? body.tools.filter((t) => typeof t === "string").slice(0, 300) : [];
        await setSetting(toolsKey(manager), JSON.stringify(tools));
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
