// netlify/functions/cron-link-pending-pas.js
//
// Every 5 minutes: link company-added PAs that are WAITING for JobNimbus to
// their freshly-created JN user, by EMAIL, and backfill jn_user_id.
//
// Flow: a PA company admin adds an adjuster in their portal → we text whoever
// manages JN to add that person (exactly as spelled) → this cron watches for
// the new JN user and, the moment their email shows up, stamps jn_user_id on
// the pending PA. That flips the PA to "Ready to activate" in the company
// portal. Once linked, the PA is no longer pending, so it stops being checked
// — and when nothing's pending this cron is a no-op.
//
// "Pending" = pas row with: jn_user_id IS NULL, pa_company_id IS NOT NULL
// (company-added), active = false, email present.
//
// Required env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, JOBNIMBUS_API_KEY.

exports.handler = async () => {
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
  const JN_KEY = process.env.JOBNIMBUS_API_KEY;
  for (const k of ["VITE_SUPABASE_URL", "VITE_SUPABASE_ANON_KEY", "JOBNIMBUS_API_KEY"]) {
    if (!process.env[k]) return json(500, { ok: false, error: `Missing env: ${k}` });
  }
  const sb = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" };
  const base = (process.env.URL || process.env.DEPLOY_URL || process.env.PUBLIC_SITE_URL || "https://free-roof-inspections.netlify.app").replace(/\/$/, "");

  // 1. Pending company-added PAs awaiting JobNimbus.
  const pending = await get(
    `${SB_URL}/rest/v1/pas?jn_user_id=is.null&pa_company_id=not.is.null&active=eq.false&email=not.is.null&select=id,name,email,pa_company_id`,
    sb,
  );
  if (!pending.length) return json(200, { ok: true, pending: 0, linked: 0 });

  // 2. JN users, indexed by lowercased email (active only).
  const jnRes = await fetch("https://app.jobnimbus.com/api1/account/users", {
    headers: { Authorization: `bearer ${JN_KEY}`, "Content-Type": "application/json" },
  });
  if (!jnRes.ok) return json(500, { ok: false, error: `JN /users ${jnRes.status}` });
  const users = ((await jnRes.json().catch(() => ({}))).users || []).filter((u) => u.is_active !== false);
  const byEmail = new Map();
  for (const u of users) if (u.email) byEmail.set(String(u.email).trim().toLowerCase(), u);

  // 3. Match + backfill jn_user_id (skip if that JN user is already linked to
  //    another PA row, to avoid duplicate jn_user_id).
  let linked = 0;
  const results = [];
  const linkedRows = []; // { id, name, pa_company_id } → notify the company admin
  for (const p of pending) {
    const u = byEmail.get(String(p.email).trim().toLowerCase());
    if (!u || !u.id) continue;
    const already = await get(`${SB_URL}/rest/v1/pas?jn_user_id=eq.${encodeURIComponent(u.id)}&select=id&limit=1`, sb);
    if (already.length) { results.push({ name: p.name, skipped: "jn_user already linked to another PA" }); continue; }
    const upd = await fetch(`${SB_URL}/rest/v1/pas?id=eq.${encodeURIComponent(p.id)}`, {
      method: "PATCH", headers: { ...sb, Prefer: "return=minimal" }, body: JSON.stringify({ jn_user_id: u.id }),
    });
    if (upd.ok) { linked++; results.push({ name: p.name, linked: true }); linkedRows.push(p); }
  }

  // 4. Tell each company admin their adjuster(s) are approved & ready to
  //    activate (SMS + email, whichever's on file). Best-effort.
  let notified = 0;
  if (linkedRows.length) {
    const cids = [...new Set(linkedRows.map((r) => r.pa_company_id))];
    const companies = await get(`${SB_URL}/rest/v1/pa_companies?id=in.(${cids.map((c) => `"${c}"`).join(",")})&select=id,name,admin_name,admin_phone,email,token`, sb);
    const byId = new Map(companies.map((c) => [c.id, c]));
    for (const r of linkedRows) {
      const c = byId.get(r.pa_company_id);
      if (!c) continue;
      const link = `${base}/?pa_company=${c.token}`;
      const sms = `✅ ${r.name} has been approved and is ready to activate in your U.S. Shingle portal: ${link}`;
      const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.55;color:#1e293b">Hi ${c.admin_name || "there"},<br><br><b>${r.name}</b> has been approved and is now <b>ready to activate</b>.<br><br>Open your portal and tap <b>Activate</b> to set them live:<br><a href="${link}">${link}</a></div>`;
      if (c.admin_phone) { await fetch(`${base}/.netlify/functions/ghl-sms`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ to: c.admin_phone, name: c.admin_name || "Admin", message: sms }) }).catch(() => {}); notified++; }
      if (c.email) { await fetch(`${base}/.netlify/functions/send-email`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ to: c.email, subject: `${r.name} is approved — ready to activate`, html }) }).catch(() => {}); }
    }
  }

  return json(200, { ok: true, pending: pending.length, linked, notified, results });
};

async function get(url, headers) {
  try { const r = await fetch(url, { headers }); return r.ok ? (await r.json()) || [] : []; } catch { return []; }
}
function json(statusCode, body) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

// Every 5 minutes.
exports.config = { schedule: "*/5 * * * *" };
