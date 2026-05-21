// netlify/functions/send-inspector-setup-email.js
//
// Sends a "welcome — please confirm your home address" email to an
// inspector synced from JN. The email body contains a tokenized link
// of the form:
//   https://<site>/?inspector_setup=<registration_token>
// which the main app routes to the InspectorSetupPage where they
// pick their address from Google Places. Submitting that page saves
// lat/lng + sets info_updated_at on the inspectors row.
//
// POST body: { inspectorId }
// Response: { ok, email, link } on success
//        or { ok: false, error: '...' }
//
// Required env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY,
//               RESEND_API_KEY (for the underlying send-email function),
//               URL or PUBLIC_SITE_URL (for the link).

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return json(405, { ok: false, error: "Method not allowed" });
  }
  const missing = [];
  for (const k of ["VITE_SUPABASE_URL", "VITE_SUPABASE_ANON_KEY"]) {
    if (!process.env[k]) missing.push(k);
  }
  if (missing.length) return json(500, { ok: false, error: `Missing env: ${missing.join(", ")}` });

  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch {
    return json(400, { ok: false, error: "Invalid JSON body" });
  }
  const inspectorId = (body.inspectorId || "").trim();
  if (!inspectorId) return json(400, { ok: false, error: "inspectorId required" });

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
  const sbHeaders = {
    apikey: SB_KEY,
    Authorization: `Bearer ${SB_KEY}`,
    "Content-Type": "application/json",
  };

  // 1. Look up the inspector.
  const lookup = await fetch(
    `${SB_URL}/rest/v1/inspectors?id=eq.${inspectorId}&select=id,name,email,registration_token,info_updated_at&limit=1`,
    { headers: sbHeaders },
  );
  if (!lookup.ok) {
    return json(500, { ok: false, error: `Could not fetch inspector: ${await lookup.text()}` });
  }
  const rows = await lookup.json();
  const insp = rows?.[0];
  if (!insp) return json(404, { ok: false, error: "Inspector not found" });
  if (!insp.email) {
    return json(400, { ok: false, error: "Inspector has no email on file (JN didn't return one). Add it manually first." });
  }

  // 2. Build the magic link.
  const base = (process.env.URL || process.env.PUBLIC_SITE_URL || "").replace(/\/$/, "");
  if (!base) return json(500, { ok: false, error: "No site URL configured" });
  const link = `${base}/?inspector_setup=${insp.registration_token}`;

  // 3. Compose the email.
  const subject = "Welcome to the Inspector team — confirm your home address";
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#0f172a;">
      <h2 style="margin-top:0;color:#0e7490;">Welcome, ${escapeHtml(insp.name)} 👷</h2>
      <p>You've been added to the U.S. Shingle &amp; Metal inspector team.</p>
      <p>Before you can start receiving inspection jobs in the app, we need
         to know your <strong>home base address</strong>. We use it to route
         jobs to the closest inspector automatically (within whatever max
         mileage your manager has set).</p>
      <p style="margin:24px 0;">
        <a href="${link}"
           style="display:inline-block;padding:12px 22px;background:#0e7490;color:#fff;
                  text-decoration:none;border-radius:10px;font-weight:700;
                  letter-spacing:0.04em;">
          Confirm my home address →
        </a>
      </p>
      <p style="font-size:13px;color:#64748b;">
        Or copy this link into your browser:<br>
        <a href="${link}" style="color:#0e7490;">${link}</a>
      </p>
      <p style="font-size:12px;color:#94a3b8;margin-top:32px;">
        This link is unique to you. No need to log in.
      </p>
    </div>
  `;

  // 4. Send via the existing send-email function.
  const emailBase = process.env.URL || process.env.PUBLIC_SITE_URL || base;
  const sendRes = await fetch(`${emailBase}/.netlify/functions/send-email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ to: insp.email, subject, html }),
  });
  const sendBody = await sendRes.json().catch(() => ({}));
  if (!sendRes.ok || !sendBody.success) {
    return json(500, {
      ok: false,
      error: sendBody.error || `send-email returned ${sendRes.status}`,
    });
  }
  return json(200, {
    ok: true,
    email: insp.email,
    name: insp.name,
    link,
    already_set_up: !!insp.info_updated_at,
  });
};

function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function json(status, body) {
  return {
    statusCode: status,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}
