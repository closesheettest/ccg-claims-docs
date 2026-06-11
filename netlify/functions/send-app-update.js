// netlify/functions/send-app-update.js
//
// Text PAs and/or inspectors a friendly "we added something new" message
// with a link to the /whats-new/ page (filtered to their role). Triggered
// from the admin dashboard when a change ships.
//
// POST { audience: "pa" | "inspector" | "both", note?, dry? }
//   note  — optional extra line appended to the text (admin's words).
//   dry   — true → return who WOULD get it + the message, send nothing.
// Response: { ok, sent, recipients:[{role,name,phone}], message_samples }
//
// Required env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY,
//               GHL_* (used by ghl-sms), URL (for the page + internal call).

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { ok: false, error: "Method not allowed" });
  for (const k of ["VITE_SUPABASE_URL", "VITE_SUPABASE_ANON_KEY"]) {
    if (!process.env[k]) return json(500, { ok: false, error: `Missing env: ${k}` });
  }

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { return json(400, { ok: false, error: "Invalid JSON" }); }
  const audience = (body.audience || "").trim().toLowerCase();
  if (!["pa", "inspector", "both"].includes(audience)) {
    return json(400, { ok: false, error: 'audience must be "pa", "inspector", or "both"' });
  }
  const note = (body.note || "").toString().trim();
  const dry = body.dry === true || body.dry === "1";

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
  const sb = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` };
  const base = (process.env.URL || process.env.DEPLOY_URL || process.env.PUBLIC_SITE_URL || "https://free-roof-inspections.netlify.app").replace(/\/$/, "");
  const PAGE = `${base}/whats-new/`;

  const recipients = [];

  if (audience === "pa" || audience === "both") {
    const rows = await get(`${SB_URL}/rest/v1/pas?active=eq.true&phone=not.is.null&select=name,phone`, sb);
    for (const r of rows) if (r.phone) recipients.push({ role: "pa", name: r.name || "there", phone: r.phone, link: `${PAGE}?for=pa` });
  }
  if (audience === "inspector" || audience === "both") {
    const rows = await get(`${SB_URL}/rest/v1/inspectors?active=eq.true&info_updated_at=not.is.null&phone=not.is.null&select=name,phone`, sb);
    for (const r of rows) if (r.phone) recipients.push({ role: "inspector", name: r.name || "there", phone: r.phone, link: `${PAGE}?for=inspector` });
  }

  // Dedupe by role+phone (a person who is both PA and inspector gets one of
  // each role's link, which is intended — each link shows their relevant tips).
  const seen = new Set();
  const targets = recipients.filter((r) => {
    const k = `${r.role}|${String(r.phone).replace(/\D/g, "")}`;
    if (seen.has(k)) return false; seen.add(k); return true;
  });

  const buildMsg = (r) => {
    const first = String(r.name || "there").trim().split(/\s+/)[0] || "there";
    return (
      `Hi ${first}! 👋 We just added something new to your U.S. Shingle app to make your job easier. ` +
      `Tap to see what's new + how to use it (super simple): ${r.link}` +
      (note ? `\n\n${note}` : "")
    );
  };

  if (dry) {
    return json(200, {
      ok: true, dry: true, would_send: targets.length,
      recipients: targets.map((r) => ({ role: r.role, name: r.name, phone: r.phone })),
      message_samples: targets.slice(0, 2).map(buildMsg),
    });
  }

  let sent = 0;
  for (const r of targets) {
    try {
      const res = await fetch(`${base}/.netlify/functions/ghl-sms`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to: r.phone, name: r.name, message: buildMsg(r) }),
      });
      if (res.ok) sent++;
    } catch (e) { console.warn("send-app-update sms failed:", e.message || e); }
  }

  return json(200, { ok: true, sent, total: targets.length, audience });
};

async function get(url, headers) {
  try {
    const r = await fetch(url, { headers });
    if (!r.ok) return [];
    return (await r.json()) || [];
  } catch { return []; }
}
function json(statusCode, body) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}
