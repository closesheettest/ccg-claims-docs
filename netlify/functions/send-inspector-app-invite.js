// netlify/functions/send-inspector-app-invite.js
//
// Sends the inspector their "app link" — a one-tap URL that opens the
// app straight into the Inspector mobile view (?mode=inspector) plus
// instructions to Add to Home Screen so they can launch it like a
// native app from their phone.
//
// Fires automatically when the manager flips an inspector from
// active=false to active=true in the admin panel (and is also exposed
// as a "Resend app link" button in case the inspector loses it).
//
// Channel auto-pick (same pattern as send-inspector-update-link):
//   • SMS via ghl-sms if phone on file
//   • Otherwise email via send-email
//
// POST body: { inspectorId, channel?: "auto" | "sms" | "email" }
// Response:  { ok, channel_used, link }
//
// Required env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY,
//               URL or PUBLIC_SITE_URL (for the link host),
//               RESEND_API_KEY (email path), GHL creds (SMS path).

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
  const channel = body.channel || "auto";
  if (!inspectorId) return json(400, { ok: false, error: "inspectorId required" });
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
    `${SB_URL}/rest/v1/inspectors?id=eq.${inspectorId}&select=id,name,email,phone&limit=1`,
    { headers: sbHeaders },
  );
  if (!lookup.ok) {
    return json(500, { ok: false, error: `Could not fetch inspector: ${await lookup.text()}` });
  }
  const rows = await lookup.json();
  const insp = rows?.[0];
  if (!insp) return json(404, { ok: false, error: "Inspector not found" });

  const base = (process.env.URL || process.env.PUBLIC_SITE_URL || "").replace(/\/$/, "");
  if (!base) return json(500, { ok: false, error: "No site URL configured" });
  const link = `${base}/?mode=inspector`;

  let chosen = channel;
  if (chosen === "auto") chosen = insp.phone ? "sms" : "email";
  if (chosen === "sms" && !insp.phone) {
    return json(400, { ok: false, error: "Inspector has no phone on file" });
  }
  if (chosen === "email" && !insp.email) {
    return json(400, { ok: false, error: "Inspector has no email on file" });
  }

  // SMS path.
  if (chosen === "sms") {
    const messageBody =
      `Hi ${insp.name}, you're activated as a U.S. Shingle & Metal inspector! ` +
      `Open the app here: ${link}\n\n` +
      `Save it to your home screen so it acts like a real app:\n` +
      `• iPhone (Safari): tap the Share button, then "Add to Home Screen"\n` +
      `• Android (Chrome): tap the ⋮ menu, then "Add to Home screen"`;
    const smsRes = await fetch(`${base}/.netlify/functions/ghl-sms`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to: insp.phone, name: insp.name, message: messageBody }),
    });
    const smsBody = await smsRes.json().catch(() => ({}));
    if (!smsRes.ok) {
      return json(500, { ok: false, channel_used: "sms", error: smsBody.error || `SMS failed (${smsRes.status})` });
    }
    return json(200, { ok: true, channel_used: "sms", phone: insp.phone, link });
  }

  // Email path.
  const subject = "You're activated — here's the Inspector app";
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#0f172a;">
      <h2 style="margin-top:0;color:#0e7490;">You're activated, ${escapeHtml(insp.name)}!</h2>
      <p>You're now an active U.S. Shingle &amp; Metal inspector. Tap the
         button below on your phone to open the Inspector app:</p>
      <p style="margin:24px 0;">
        <a href="${link}"
           style="display:inline-block;padding:14px 24px;background:#0e7490;color:#fff;
                  text-decoration:none;border-radius:10px;font-weight:700;
                  letter-spacing:0.04em;">
          Open Inspector app →
        </a>
      </p>
      <p style="font-size:13px;color:#64748b;">
        Or copy this link into your phone's browser:<br>
        <a href="${link}" style="color:#0e7490;">${link}</a>
      </p>
      <h3 style="color:#0f172a;margin-top:28px;">Save it like a real app</h3>
      <p style="margin:0 0 8px 0;"><strong>iPhone (Safari):</strong> tap the Share button, then
         <em>Add to Home Screen</em>.</p>
      <p style="margin:0 0 8px 0;"><strong>Android (Chrome):</strong> tap the ⋮ menu, then
         <em>Add to Home screen</em>.</p>
      <p style="font-size:12px;color:#94a3b8;margin-top:32px;">
        Questions? Reply to this email or text your manager.
      </p>
    </div>
  `;
  const sendRes = await fetch(`${base}/.netlify/functions/send-email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ to: insp.email, subject, html }),
  });
  const sendBody = await sendRes.json().catch(() => ({}));
  if (!sendRes.ok || !sendBody.success) {
    return json(500, {
      ok: false,
      channel_used: "email",
      error: sendBody.error || `send-email returned ${sendRes.status}`,
    });
  }
  return json(200, { ok: true, channel_used: "email", email: insp.email, link });
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
