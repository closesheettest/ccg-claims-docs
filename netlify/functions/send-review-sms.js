// Send a homeowner a "leave us a Google review" text. Powers the ⭐ review button
// on the map — the rep types the homeowner's cell, we text them the review link.
// The map ALSO logs a `review_request` activity so it counts for the contest; this
// function only handles the send.
//
//   POST { phone, name? }  → { ok, to } | { ok:false, error }
//
// The link comes from app_settings.google_review_url (set once, used everywhere).
// A rep can't send it to their own number is enforced on the map side (they pass a
// homeowner number); here we just guard for a valid 10-digit US number.
//
// Env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, URL (for the ghl-sms hop)

const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const sb = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` };

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return cors(200, "");
  if (event.httpMethod !== "POST") return cors(405, JSON.stringify({ ok: false, error: "POST only" }));
  if (!SB_URL || !SB_KEY) return cors(500, JSON.stringify({ ok: false, error: "env missing" }));

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { return cors(400, JSON.stringify({ ok: false, error: "bad JSON" })); }
  const digits = String(body.phone || "").replace(/\D/g, "");
  if (digits.length < 10) return cors(400, JSON.stringify({ ok: false, error: "A valid cell number is required." }));
  const name = String(body.name || "").trim();

  const reviewUrl = (await getSetting("google_review_url")) || "";
  if (!reviewUrl || /REPLACE_ME|YOUR_REAL/i.test(reviewUrl)) {
    return cors(409, JSON.stringify({ ok: false, error: "The Google review link isn't set up yet — ask the office." }));
  }

  const hi = name ? `Hi ${name}, ` : "Hi, ";
  const message = `${hi}thanks for having U.S. Shingle & Metal out! If we earned it, a quick Google review would mean a lot: ${reviewUrl}`;

  const base = (process.env.URL || process.env.PUBLIC_SITE_URL || "https://free-roof-inspections.netlify.app").replace(/\/$/, "");
  try {
    const r = await fetch(`${base}/.netlify/functions/ghl-sms`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to: digits, name: name || "Homeowner", message }),
    });
    const o = await r.json().catch(() => ({}));
    if (!r.ok || o.success === false) return cors(502, JSON.stringify({ ok: false, error: o.error || "Text failed to send." }));
    // GHL returns success:true but SKIPS the send when the number is opted out of texts
    // (they replied STOP → DND). Don't report that as "Sent" — the homeowner never gets it.
    if (o.skipped || o.reason === "opted_out") {
      return cors(409, JSON.stringify({ ok: false, opted_out: true, error: "This number opted out of our texts (replied STOP), so the review link can't be delivered. They'd have to text START to turn texts back on — or share the review link another way." }));
    }
    return cors(200, JSON.stringify({ ok: true, to: digits }));
  } catch (e) {
    return cors(500, JSON.stringify({ ok: false, error: e.message || "send error" }));
  }
};

async function getSetting(key) {
  try {
    const r = await fetch(`${SB_URL}/rest/v1/app_settings?key=eq.${encodeURIComponent(key)}&select=value&limit=1`, { headers: sb });
    if (!r.ok) return null;
    const rows = await r.json().catch(() => []);
    return rows[0]?.value ?? null;
  } catch { return null; }
}
function cors(status, body) {
  return { statusCode: status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" }, body };
}
