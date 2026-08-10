// netlify/functions/goback-autoschedule-config.js
//
// Admin config for the "auto-schedule the go-back after an inspection" text
// sequence. One place to control: on/off, and an ordered list of messages —
// each with its OWN wait (days after the inspection), send time (ET), and body.
// The number of messages IS the number of texts that go out.
//
//   GET                → { ok, config }
//   POST { config }    → saves it, returns { ok, config }
//
// Stored in app_settings under goback_autoschedule_config. The cron sender + the
// homeowner booking page read this same config. Merge tokens usable in a body:
//   {name}  {rep}  {link}  {address}  {company}
//   {name} = homeowner first name, {rep} = assigned rep's first name.
//
// NOTE: the DEFAULT_CONFIG below is Neal's live, approved verbiage — kept here in
// source on purpose so a rebuild or a wiped app_settings row never loses it.
//
// Env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY.

const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const sb = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" };
const KEY = "goback_autoschedule_config";

const DEFAULT_CONFIG = {
  enabled: false,
  messages: [
    { delay_days: 0, send_time: "17:00", body: "Hello {name} this is {rep} with U S Shingle and Metal and we just finished your roof inspection. I have your detailed report with photos and want to deliver it and go over it with you so please just grab a time that works for you 👉 {link}" },
    { delay_days: 2, send_time: "10:00", body: "Hi {name}, still happy to come walk you through your roof findings whenever it's convenient. Pick a time here 👉 {link}" },
    { delay_days: 4, send_time: "14:00", body: "Just checking back — we can swing by to go over your roof at a time that works for you. Book here 👉 {link}" },
  ],
};

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return cors(200, "");
  if (!SB_URL || !SB_KEY) return cors(500, JSON.stringify({ ok: false, error: "env missing" }));

  try {
    if (event.httpMethod === "GET") {
      const cfg = await getConfig();
      return cors(200, JSON.stringify({ ok: true, config: cfg }));
    }
    if (event.httpMethod === "POST") {
      let body;
      try { body = JSON.parse(event.body || "{}"); } catch { return cors(400, JSON.stringify({ ok: false, error: "bad JSON" })); }
      const cfg = sanitize(body.config);
      if (!cfg) return cors(400, JSON.stringify({ ok: false, error: "config required" }));
      await setSetting(KEY, cfg);
      return cors(200, JSON.stringify({ ok: true, config: cfg }));
    }
    return cors(405, JSON.stringify({ ok: false, error: "method" }));
  } catch (e) {
    return cors(500, JSON.stringify({ ok: false, error: e.message || "error" }));
  }
};

// Keep only the fields we own, clamp to sane values, drop empty-body messages.
function sanitize(c) {
  if (!c || typeof c !== "object") return null;
  const msgs = Array.isArray(c.messages) ? c.messages : [];
  const messages = msgs
    .map((m) => ({
      delay_days: Math.max(0, Math.min(60, Math.round(Number(m && m.delay_days) || 0))),
      send_time: /^\d{1,2}:\d{2}$/.test(String(m && m.send_time)) ? String(m.send_time) : "10:00",
      body: String((m && m.body) || "").slice(0, 1200),
    }))
    .filter((m) => m.body.trim())
    .sort((a, b) => a.delay_days - b.delay_days)
    .slice(0, 12);
  return { enabled: !!c.enabled, messages };
}

async function getConfig() {
  try {
    const r = await fetch(`${SB_URL}/rest/v1/app_settings?key=eq.${encodeURIComponent(KEY)}&select=value&limit=1`, { headers: sb });
    if (!r.ok) return DEFAULT_CONFIG;
    const rows = await r.json();
    const raw = rows[0]?.value;
    if (raw == null) return DEFAULT_CONFIG;
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    const clean = sanitize(parsed);
    return clean && clean.messages.length ? clean : DEFAULT_CONFIG;
  } catch { return DEFAULT_CONFIG; }
}
async function setSetting(key, obj) {
  await fetch(`${SB_URL}/rest/v1/app_settings?on_conflict=key`, {
    method: "POST", headers: { ...sb, Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ key, value: JSON.stringify(obj), updated_at: new Date().toISOString() }),
  });
}
function cors(status, body) {
  return { statusCode: status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" }, body };
}
