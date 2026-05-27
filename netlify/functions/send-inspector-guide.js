// netlify/functions/send-inspector-guide.js
//
// Admin-triggered: text (or email) an active inspector a link to the
// /inspector-guide/ field-reference page. The same guide URL is also
// auto-appended to the activation SMS by send-inspector-app-invite —
// this function is the "I want to re-send it on demand" path.
//
// Use cases:
//   • Refresher mid-week (e.g. an inspector keeps forgetting to photo
//     the house number, you re-text the guide).
//   • New manager joining who didn't get the original activation SMS.
//   • Inspector lost the link / deleted the text.
//
// Channel auto-pick: SMS if phone on file, else email. Same pattern as
// send-inspector-app-invite. Refuses to send to inactive inspectors —
// they're meant to be off the team.
//
// POST body: { inspectorId, channel?: "auto" | "sms" | "email" }
// Response:  { ok, channel_used, link }
//
// Required env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY,
//               URL or PUBLIC_SITE_URL, plus GHL creds (SMS path) or
//               RESEND_API_KEY (email path).

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

  // Pull the inspector. We require active=true because the guide is a
  // working-inspector resource; if they've been deactivated we don't
  // want to re-engage them.
  const lookup = await fetch(
    `${SB_URL}/rest/v1/inspectors?id=eq.${inspectorId}&select=id,name,email,phone,active&limit=1`,
    { headers: sbHeaders },
  );
  if (!lookup.ok) {
    return json(500, { ok: false, error: `Could not fetch inspector: ${await lookup.text()}` });
  }
  const rows = await lookup.json();
  const insp = rows?.[0];
  if (!insp) return json(404, { ok: false, error: "Inspector not found" });
  if (!insp.active) {
    return json(409, { ok: false, error: "Inspector is inactive — activate them first to send the field guide." });
  }

  const base = (process.env.URL || process.env.PUBLIC_SITE_URL || "").replace(/\/$/, "");
  if (!base) return json(500, { ok: false, error: "No site URL configured" });
  const guideLink = `${base}/inspector-guide/`;

  let chosen = channel;
  if (chosen === "auto") chosen = insp.phone ? "sms" : "email";
  if (chosen === "sms" && !insp.phone) {
    return json(400, { ok: false, error: "Inspector has no phone on file" });
  }
  if (chosen === "email" && !insp.email) {
    return json(400, { ok: false, error: "Inspector has no email on file" });
  }

  // SMS path — keep short. The guide itself is the long-form content.
  if (chosen === "sms") {
    const messageBody =
      `Hi ${insp.name}, here's the U.S. Shingle field guide for inspecting roofs — ` +
      `quick reference for the app flow, photo tips, and what each result type means. ` +
      `Pull it up on your phone while you're on a roof: ${guideLink}`;
    const smsRes = await fetch(`${base}/.netlify/functions/ghl-sms`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to: insp.phone, name: insp.name, message: messageBody }),
    });
    const smsBody = await smsRes.json().catch(() => ({}));
    if (!smsRes.ok) {
      return json(500, {
        ok: false, channel_used: "sms",
        error: smsBody.error || `SMS failed (${smsRes.status})`,
      });
    }
    return json(200, { ok: true, channel_used: "sms", phone: insp.phone, link: guideLink });
  }

  // Email path.
  const subject = "Inspector Field Guide — quick reference for the app";
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#0f172a;">
      <h2 style="margin-top:0;color:#0e7490;">Field Guide — Inspecting a Roof</h2>
      <p>Hi ${escapeHtml(insp.name)}, here's the quick reference for the inspector app:</p>
      <p style="margin:24px 0;">
        <a href="${guideLink}"
           style="display:inline-block;padding:14px 24px;background:#b8324f;color:#fff;
                  text-decoration:none;border-radius:10px;font-weight:700;">
          Open Field Guide →
        </a>
      </p>
      <p style="font-size:13px;color:#64748b;">
        Covers: opening the app, claiming a job, the 6-step photo wizard
        (house number → front → stories → roof overview → slopes), the
        3 result types (Damage / Retail / No Damage), photo &amp; safety
        tips, and what to do when something goes wrong.
      </p>
      <p style="font-size:13px;color:#64748b;">
        Or copy the link into your phone's browser:<br>
        <a href="${guideLink}" style="color:#b8324f;">${guideLink}</a>
      </p>
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
      ok: false, channel_used: "email",
      error: sendBody.error || `send-email returned ${sendRes.status}`,
    });
  }
  return json(200, { ok: true, channel_used: "email", email: insp.email, link: guideLink });
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
