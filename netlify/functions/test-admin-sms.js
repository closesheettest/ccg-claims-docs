// netlify/functions/test-admin-sms.js
//
// One-shot test of the admin SMS alert path. Sends a single "this is
// a test" message to ADMIN_ALERT_PHONE (or to a number passed in via
// query string) using the same ghl-sms function the cron alert uses.
//
// USAGE:
//   GET /.netlify/functions/test-admin-sms
//     → sends to whatever ADMIN_ALERT_PHONE is set to in Netlify env
//
//   GET /.netlify/functions/test-admin-sms?to=5551234567
//     → sends to that explicit number (useful for testing format
//       before committing it to env)
//
// Required env: ADMIN_ALERT_PHONE (or use ?to=), URL or PUBLIC_SITE_URL

exports.handler = async (event) => {
  const qs = event.queryStringParameters || {};
  const to = (qs.to || process.env.ADMIN_ALERT_PHONE || "").trim();
  if (!to) {
    return json(400, {
      ok: false,
      error:
        "No phone number — set ADMIN_ALERT_PHONE in Netlify env, OR pass ?to=<number>. " +
        "Format accepted by GHL: (555) 123-4567, 5551234567, or +15551234567.",
    });
  }

  const base = (process.env.URL || process.env.PUBLIC_SITE_URL || "").replace(/\/$/, "");
  if (!base) {
    return json(500, { ok: false, error: "No base URL configured for internal call" });
  }

  const message =
    "✅ Test from JN push cron alert system. " +
    "If you got this, your phone format is correct and " +
    "the cron will be able to text you when push failures happen. " +
    "Time: " + new Date().toLocaleString();

  try {
    const r = await fetch(`${base}/.netlify/functions/ghl-sms`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to, name: "Admin", message }),
    });
    const body = await r.json().catch(() => ({}));
    return json(r.ok ? 200 : 500, {
      ok: r.ok,
      sent_to: to,
      ghl_sms_status: r.status,
      ghl_sms_response: body,
      message_sent: r.ok ? message : null,
      help: r.ok
        ? "Check your phone within ~30 seconds. If it arrives, set ADMIN_ALERT_PHONE in Netlify env to the same number."
        : "Send failed — try a different format. GHL most reliably accepts (XXX) XXX-XXXX or +1XXXXXXXXXX.",
    });
  } catch (e) {
    return json(500, { ok: false, error: e.message });
  }
};

function json(status, body) {
  return {
    statusCode: status,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}
