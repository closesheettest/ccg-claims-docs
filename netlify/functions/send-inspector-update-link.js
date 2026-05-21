// netlify/functions/send-inspector-update-link.js
//
// Unified "send the setup/update link" function for inspectors:
//
//   • If the inspector has a phone on file → SMS via the existing
//     /.netlify/functions/ghl-sms route.
//   • Otherwise → email via /.netlify/functions/send-inspector-setup-email.
//
// Same magic link in either case — points at ?inspector_setup=<token>
// which routes to the InspectorSetupPage where they confirm or update
// their home address. The page handles both "first-time setup" and
// "I moved, update it" copy on its own (it checks info_updated_at).
//
// POST body: { inspectorId, channel?: "auto" | "sms" | "email" }
//   "auto" (default) — SMS if phone set, else email.
//   "sms"            — force SMS (errors if no phone).
//   "email"          — force email (errors if no email).
//
// Response: { ok, channel_used, link }
//
// Required env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY,
//               RESEND_API_KEY (for email path), GHL_LOCATION_ID (for
//               SMS path), URL or PUBLIC_SITE_URL (for the link host).

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

  // Look up the inspector.
  const lookup = await fetch(
    `${SB_URL}/rest/v1/inspectors?id=eq.${inspectorId}&select=id,name,email,phone,registration_token,info_updated_at&limit=1`,
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
  const link = `${base}/?inspector_setup=${insp.registration_token}`;
  const isUpdate = !!insp.info_updated_at;

  // Decide channel.
  let chosen = channel;
  if (chosen === "auto") {
    chosen = insp.phone ? "sms" : "email";
  }
  if (chosen === "sms" && !insp.phone) {
    return json(400, { ok: false, error: "Inspector has no phone on file (set channel=email or add phone)" });
  }
  if (chosen === "email" && !insp.email) {
    return json(400, { ok: false, error: "Inspector has no email on file" });
  }

  // SMS path.
  if (chosen === "sms") {
    const messageBody = isUpdate
      ? `Hi ${insp.name}, you can update your inspector home address here: ${link}`
      : `Hi ${insp.name}, you've been added as a U.S. Shingle & Metal inspector. Confirm your home address here so we can route jobs to you: ${link}`;
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

  // Email path — delegate to the existing setup-email function which
  // already composes the HTML body + send-email call.
  const emailRes = await fetch(`${base}/.netlify/functions/send-inspector-setup-email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ inspectorId }),
  });
  const emailBody = await emailRes.json().catch(() => ({}));
  if (!emailBody.ok) {
    return json(500, { ok: false, channel_used: "email", error: emailBody.error || `Email failed (${emailRes.status})` });
  }
  return json(200, { ok: true, channel_used: "email", email: insp.email, link });
};

function json(status, body) {
  return {
    statusCode: status,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}
