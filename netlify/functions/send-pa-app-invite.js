// netlify/functions/send-pa-app-invite.js
//
// Sends a Public Adjuster their private portal link — a one-tap URL
// that opens the app straight into the PA mobile view (?mode=pa), plus
// Add-to-Home-Screen instructions. Mirrors send-inspector-app-invite.js.
//
// Fires automatically when the manager flips a PA from active=false to
// active=true in the admin panel (also exposed as a "Resend link"
// button). Channel auto-pick: SMS if phone on file, else email.
//
// POST body: { paId, channel?: "auto" | "sms" | "email" }.
// Response:  { ok, channel_used, link }.
//
// Required env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY,
//               URL or PUBLIC_SITE_URL, RESEND_API_KEY (email), GHL creds (SMS).

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
  const paId = (body.paId || "").trim();
  const channel = body.channel || "auto";
  if (!paId) return json(400, { ok: false, error: "paId required" });
  if (!["auto", "sms", "email"].includes(channel)) {
    return json(400, { ok: false, error: "channel must be auto | sms | email" });
  }

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
  const sbHeaders = {
    apikey: SB_KEY,
    Authorization: `Bearer ${SB_KEY}`,
    "Content-Type": "application/json",
  };

  const lookup = await fetch(
    `${SB_URL}/rest/v1/pas?id=eq.${paId}&select=id,name,email,phone&limit=1`,
    { headers: sbHeaders },
  );
  if (!lookup.ok) {
    return json(500, { ok: false, error: `Could not fetch PA: ${await lookup.text()}` });
  }
  const rows = await lookup.json();
  const pa = rows?.[0];
  if (!pa) return json(404, { ok: false, error: "PA not found" });

  const base = (process.env.URL || process.env.PUBLIC_SITE_URL || "").replace(/\/$/, "");
  if (!base) return json(500, { ok: false, error: "No site URL configured" });
  const link = `${base}/?mode=pa`;

  let chosen = channel;
  if (chosen === "auto") chosen = pa.phone ? "sms" : "email";
  if (chosen === "sms" && !pa.phone) {
    return json(400, { ok: false, error: "PA has no phone on file" });
  }
  if (chosen === "email" && !pa.email) {
    return json(400, { ok: false, error: "PA has no email on file" });
  }

  // Stamp app_link_sent_at (best-effort; don't fail the send if it errors).
  const stamp = () => fetch(`${SB_URL}/rest/v1/pas?id=eq.${paId}`, {
    method: "PATCH",
    headers: sbHeaders,
    body: JSON.stringify({ app_link_sent_at: new Date().toISOString() }),
  }).catch(() => {});

  // SMS path.
  if (chosen === "sms") {
    const messageBody =
      `Hi ${pa.name}, you're set up as a U.S. Shingle & Metal partner adjuster.\n\n` +
      `📱 Open your portal: ${link}\n\n` +
      `Inside you'll see the damage deals available to claim. Claim the ones ` +
      `you want, then fill in each milestone (PA filed, INS approved, etc.) as ` +
      `it happens — it updates JobNimbus automatically.\n\n` +
      `Save it to your home screen:\n` +
      `• iPhone (Safari): Share → "Add to Home Screen"\n` +
      `• Android (Chrome): ⋮ menu → "Add to Home screen"`;
    const smsRes = await fetch(`${base}/.netlify/functions/ghl-sms`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to: pa.phone, name: pa.name, message: messageBody }),
    });
    const smsBody = await smsRes.json().catch(() => ({}));
    if (!smsRes.ok) {
      return json(500, { ok: false, channel_used: "sms", error: smsBody.error || `SMS failed (${smsRes.status})` });
    }
    await stamp();
    return json(200, { ok: true, channel_used: "sms", phone: pa.phone, link });
  }

  // Email path.
  const subject = "Your U.S. Shingle & Metal adjuster portal";
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#0f172a;">
      <h2 style="margin-top:0;color:#0e7490;">Welcome, ${escapeHtml(pa.name)}!</h2>
      <p>You're set up as a partner public adjuster for U.S. Shingle &amp; Metal.
         Tap the button below on your phone to open your portal:</p>
      <p style="margin:24px 0;">
        <a href="${link}"
           style="display:inline-block;padding:14px 24px;background:#0e7490;color:#fff;
                  text-decoration:none;border-radius:10px;font-weight:700;
                  letter-spacing:0.04em;">
          Open Adjuster portal →
        </a>
      </p>
      <p style="font-size:13px;color:#64748b;">
        Or copy this link into your phone's browser:<br>
        <a href="${link}" style="color:#0e7490;">${link}</a>
      </p>
      <h3 style="color:#0f172a;margin-top:28px;">How it works</h3>
      <p>Inside you'll see the <strong>damage deals available to claim</strong>.
         Claim the ones you want to work, then fill in each milestone
         (PA filed, INS approved, ISS uploaded, advances, etc.) as it
         happens — every entry pushes straight into JobNimbus automatically,
         so there's no double entry.</p>
      <h3 style="color:#0f172a;margin-top:28px;">Save it like a real app</h3>
      <p style="margin:0 0 8px 0;"><strong>iPhone (Safari):</strong> tap Share, then
         <em>Add to Home Screen</em>.</p>
      <p style="margin:0 0 8px 0;"><strong>Android (Chrome):</strong> tap the ⋮ menu, then
         <em>Add to Home screen</em>.</p>
      <p style="font-size:12px;color:#94a3b8;margin-top:32px;">
        Questions? Reply to this email or text your U.S. Shingle contact.
      </p>
    </div>
  `;
  const sendRes = await fetch(`${base}/.netlify/functions/send-email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ to: pa.email, subject, html }),
  });
  const sendBody = await sendRes.json().catch(() => ({}));
  if (!sendRes.ok || !sendBody.success) {
    return json(500, {
      ok: false,
      channel_used: "email",
      error: sendBody.error || `send-email returned ${sendRes.status}`,
    });
  }
  await stamp();
  return json(200, { ok: true, channel_used: "email", email: pa.email, link });
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
