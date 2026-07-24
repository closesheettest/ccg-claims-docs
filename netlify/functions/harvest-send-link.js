// netlify/functions/harvest-send-link.js
//
// Office sends a rep their personal Harvesting-Map link — by SMS *and* email, on
// purpose: a text alone silently misses anyone on DND / opted out, and an email
// alone gets buried. Stamps sales_reps.harvest_link_sent_at so the links page can
// show who's already had theirs.
//
//   POST { admin, rep_id } → { ok, sent_sms, sent_email, sent_at, name }
//
// Env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, URL

const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { ok: false, error: "POST only" });
  if (!SB_URL || !SB_KEY) return json(500, { ok: false, error: "env missing" });
  let body; try { body = JSON.parse(event.body || "{}"); } catch { return json(400, { ok: false, error: "bad JSON" }); }

  const sb = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" };
  const sbGet = (p) => fetch(`${SB_URL}/rest/v1/${p}`, { headers: sb }).then((r) => (r.ok ? r.json() : [])).catch(() => []);

  // Office-only (same admin token the links page is opened with).
  const admin = String(body.admin || "").trim();
  const want = (await sbGet(`app_settings?key=eq.harvest_admin_token&select=value&limit=1`))[0]?.value;
  if (!admin || !want || admin !== want) return json(401, { ok: false, error: "admin only" });

  const repId = String(body.rep_id || "").trim();
  if (!repId) return json(400, { ok: false, error: "rep_id required" });
  const rep = (await sbGet(`sales_reps?id=eq.${encodeURIComponent(repId)}&select=id,name,phone,email,harvest_token&limit=1`))[0];
  if (!rep) return json(404, { ok: false, error: "rep not found" });
  if (!rep.harvest_token) return json(400, { ok: false, error: "this rep has no map link yet" });

  const base = (process.env.URL || process.env.PUBLIC_SITE_URL || "https://free-roof-inspections.netlify.app").replace(/\/$/, "");
  const link = `${base}/?mode=harvest&rt=${rep.harvest_token}`;
  const first = String(rep.name || "there").split(/\s+/)[0];

  let sent_sms = false, sent_email = false;
  if (rep.phone) {
    try {
      const r = await fetch(`${base}/.netlify/functions/ghl-sms`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to: rep.phone, name: rep.name || "Rep", message: `Hi ${first}, here's your U.S. Shingle DoorDispatcher — open it to see your doors and start your day: ${link}\n\nWhen it opens, tap the "Install" button at the bottom to add it to your phone — then it's one tap every morning. (iPhone: tap "Install" and it shows you the quick steps.)` }),
      });
      sent_sms = r.ok;
    } catch { /* email may still land */ }
  }
  if (rep.email) {
    try {
      const html = `<p>Hi ${esc(first)},</p>
<p>Here's your personal <b>DoorDispatcher</b> link. Open it on your phone to see your doors, start your day, and log every knock.</p>
<p><a href="${esc(link)}" style="display:inline-block;background:#16a34a;color:#fff;font-weight:bold;padding:12px 20px;border-radius:8px;text-decoration:none">Open my DoorDispatcher</a></p>
<p style="color:#666;font-size:13px">This link is yours — don't share it.</p>
<div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:14px 16px;margin:14px 0">
  <div style="font-weight:bold;font-size:14px;margin-bottom:8px">📲 Add it to your phone — one tap every morning</div>
  <div style="font-size:13.5px;color:#334155;margin-bottom:6px">When you open the link, look for the <b>“Install”</b> button at the bottom and tap it.</div>
  <div style="font-size:13.5px;color:#334155;margin-bottom:4px"><b>Android / computer:</b> tap <b>Install</b> — done, the icon lands on your screen.</div>
  <div style="font-size:13.5px;color:#334155"><b>iPhone:</b> tap <b>“Install,”</b> then follow the quick <b>Share → “Add to Home Screen”</b> steps it shows you.</div>
</div>
<p style="color:#666;font-size:12px;word-break:break-all">${esc(link)}</p>`;
      const r = await fetch(`${base}/.netlify/functions/send-email`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to: rep.email, subject: "Your DoorDispatcher link", html }),
      });
      sent_email = r.ok;
    } catch { /* sms may have landed */ }
  }

  if (!sent_sms && !sent_email) {
    return json(200, { ok: false, error: rep.phone || rep.email ? "Couldn't send — check the rep's phone/email." : "This rep has no phone or email on file.", sent_sms, sent_email });
  }

  // Stamp it (own patch; a pre-migration missing column can't fail the send).
  const sent_at = new Date().toISOString();
  await fetch(`${SB_URL}/rest/v1/sales_reps?id=eq.${encodeURIComponent(repId)}`, {
    method: "PATCH", headers: { ...sb, Prefer: "return=minimal" }, body: JSON.stringify({ harvest_link_sent_at: sent_at }),
  }).catch(() => {});

  return json(200, { ok: true, sent_sms, sent_email, sent_at, name: rep.name || "Rep" });
};

const esc = (s) => String(s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
function json(statusCode, obj) {
  return { statusCode, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }, body: JSON.stringify(obj) };
}
