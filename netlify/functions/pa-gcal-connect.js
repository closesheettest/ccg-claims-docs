// netlify/functions/pa-gcal-connect.js
//
// Google Calendar 2-way sync — STAGE 1 (OAuth start). A Public Adjuster taps
// "Connect Google Calendar" in their portal → this redirects them to Google's
// consent screen. On approval Google redirects back to pa-gcal-callback, which
// stores a refresh token on the PA. Later stages use it for free/busy
// availability + writing the appointment as a calendar event.
//
//   GET /.netlify/functions/pa-gcal-connect?pa_id=<id>   → 302 to Google consent
//
// Env: GOOGLE_CLIENT_ID, URL (site host). Inert (500) until GOOGLE_CLIENT_ID set.

const GOOGLE_AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const SCOPES = [
  "openid", "email",
  "https://www.googleapis.com/auth/calendar.events",   // create/update the appt event
  "https://www.googleapis.com/auth/calendar.readonly", // read free/busy for availability
].join(" ");

exports.handler = async (event) => {
  const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
  const base = (process.env.URL || process.env.PUBLIC_SITE_URL || "").replace(/\/$/, "");
  if (!CLIENT_ID) return { statusCode: 500, body: "Google Calendar not configured yet (GOOGLE_CLIENT_ID missing)." };
  const paId = String((event.queryStringParameters || {}).pa_id || "").trim();
  if (!paId) return { statusCode: 400, body: "pa_id required" };

  const redirectUri = `${base}/.netlify/functions/pa-gcal-callback`;
  const url = `${GOOGLE_AUTH}?` + new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: SCOPES,
    access_type: "offline",   // get a refresh token
    prompt: "consent",        // force refresh_token even on re-connect
    include_granted_scopes: "true",
    state: paId,
  }).toString();

  return { statusCode: 302, headers: { Location: url, "Cache-Control": "no-store" }, body: "" };
};
