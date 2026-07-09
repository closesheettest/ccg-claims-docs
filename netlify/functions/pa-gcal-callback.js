// netlify/functions/pa-gcal-callback.js
//
// Google Calendar 2-way sync — STAGE 1 (OAuth callback). Google redirects here
// after the PA approves. We exchange the code for a REFRESH token and store it
// (+ their Google email) on the pas row, then send them back to their portal.
//
//   GET /.netlify/functions/pa-gcal-callback?code=…&state=<pa_id>
//
// Env: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, VITE_SUPABASE_URL,
//      VITE_SUPABASE_ANON_KEY, URL.

const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const sb = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" };

exports.handler = async (event) => {
  const base = (process.env.URL || process.env.PUBLIC_SITE_URL || "").replace(/\/$/, "");
  const back = (status) => ({ statusCode: 302, headers: { Location: `${base}/?mode=pa&gcal=${status}`, "Cache-Control": "no-store" }, body: "" });
  const CLIENT_ID = process.env.GOOGLE_CLIENT_ID, CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
  if (!CLIENT_ID || !CLIENT_SECRET || !SB_URL || !SB_KEY) return back("error");

  const qp = event.queryStringParameters || {};
  const code = String(qp.code || "").trim();
  const paId = String(qp.state || "").trim();
  if (qp.error || !code || !paId) return back("error");

  try {
    const redirectUri = `${base}/.netlify/functions/pa-gcal-callback`;
    const tokRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ code, client_id: CLIENT_ID, client_secret: CLIENT_SECRET, redirect_uri: redirectUri, grant_type: "authorization_code" }).toString(),
    });
    const tok = await tokRes.json().catch(() => ({}));
    // refresh_token is only returned on the FIRST consent for this Google
    // account; prompt=consent forces it, but guard anyway.
    if (!tokRes.ok || !tok.refresh_token) return back("error");

    let email = null;
    try {
      const ui = await (await fetch("https://www.googleapis.com/oauth2/v2/userinfo", { headers: { Authorization: `Bearer ${tok.access_token}` } })).json();
      email = ui && ui.email ? ui.email : null;
    } catch { /* email is best-effort */ }

    const r = await fetch(`${SB_URL}/rest/v1/pas?id=eq.${encodeURIComponent(paId)}`, {
      method: "PATCH",
      headers: { ...sb, Prefer: "return=minimal" },
      body: JSON.stringify({ google_refresh_token: tok.refresh_token, google_email: email, google_connected_at: new Date().toISOString() }),
    });
    if (!r.ok) return back("error");
    return back("connected");
  } catch {
    return back("error");
  }
};
