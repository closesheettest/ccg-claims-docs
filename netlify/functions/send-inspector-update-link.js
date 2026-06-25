// netlify/functions/send-inspector-update-link.js
//
// Unified "send the setup/update link" function for inspectors:
//
//   • channel "auto" (default) → sends BOTH SMS (ghl-sms) AND email
//     (send-inspector-setup-email) when both are on file, and succeeds if
//     EITHER lands. So an inspector whose texts bounce still gets the link.
//   • channel "sms" / "email" → force that single channel.
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

  // Decide channels. "auto" (the default used at setup) now sends BOTH SMS and
  // email so an inspector whose texts bounce (landline / GHL opt-out, the Sean
  // Hernandez case) still gets the link by email. "sms"/"email" force one.
  if (channel === "sms" && !insp.phone) {
    return json(400, { ok: false, error: "Inspector has no phone on file (set channel=email or add phone)" });
  }
  if (channel === "email" && !insp.email) {
    return json(400, { ok: false, error: "Inspector has no email on file" });
  }
  const wantSms = (channel === "sms" || channel === "auto") && !!insp.phone;
  const wantEmail = (channel === "email" || channel === "auto") && !!insp.email;
  if (!wantSms && !wantEmail) {
    return json(400, { ok: false, error: "Inspector has no phone or email on file" });
  }

  const sent = [];
  const errors = [];

  // SMS path.
  if (wantSms) {
    const messageBody = isUpdate
      ? `Hi ${insp.name}, you can update your inspector home address here: ${link}`
      : `Hi ${insp.name}, you've been added as a U.S. Shingle & Metal inspector. Confirm your home address here so we can route jobs to you: ${link}`;
    try {
      const smsRes = await fetch(`${base}/.netlify/functions/ghl-sms`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to: insp.phone, name: insp.name, message: messageBody }),
      });
      const smsBody = await smsRes.json().catch(() => ({}));
      if (smsRes.ok) sent.push("sms");
      else errors.push(`SMS: ${smsBody.error || smsRes.status}`);
    } catch (e) { errors.push(`SMS: ${e.message}`); }
  }

  // Email path — delegate to the existing setup-email function which already
  // composes the HTML body + send-email call.
  if (wantEmail) {
    try {
      const emailRes = await fetch(`${base}/.netlify/functions/send-inspector-setup-email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ inspectorId }),
      });
      const emailBody = await emailRes.json().catch(() => ({}));
      if (emailBody.ok) sent.push("email");
      else errors.push(`Email: ${emailBody.error || emailRes.status}`);
    } catch (e) { errors.push(`Email: ${e.message}`); }
  }

  // Succeed if EITHER channel landed.
  if (!sent.length) {
    return json(500, { ok: false, error: errors.join(" | ") || "Could not send on any channel", attempted: { sms: wantSms, email: wantEmail } });
  }
  return json(200, { ok: true, channel_used: sent.join("+"), sent, errors: errors.length ? errors : undefined, phone: wantSms ? insp.phone : null, email: wantEmail ? insp.email : null, link });
};

function json(status, body) {
  return {
    statusCode: status,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}
