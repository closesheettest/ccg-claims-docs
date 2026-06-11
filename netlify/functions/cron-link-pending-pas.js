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

  // 1. Pending company-added PAs awaiting JobNimbus.
  const pending = await get(
    `${SB_URL}/rest/v1/pas?jn_user_id=is.null&pa_company_id=not.is.null&active=eq.false&email=not.is.null&select=id,name,email`,
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
  for (const p of pending) {
    const u = byEmail.get(String(p.email).trim().toLowerCase());
    if (!u || !u.id) continue;
    const already = await get(`${SB_URL}/rest/v1/pas?jn_user_id=eq.${encodeURIComponent(u.id)}&select=id&limit=1`, sb);
    if (already.length) { results.push({ name: p.name, skipped: "jn_user already linked to another PA" }); continue; }
    const upd = await fetch(`${SB_URL}/rest/v1/pas?id=eq.${encodeURIComponent(p.id)}`, {
      method: "PATCH", headers: { ...sb, Prefer: "return=minimal" }, body: JSON.stringify({ jn_user_id: u.id }),
    });
    if (upd.ok) { linked++; results.push({ name: p.name, linked: true }); }
  }

  return json(200, { ok: true, pending: pending.length, linked, results });
};

async function get(url, headers) {
  try { const r = await fetch(url, { headers }); return r.ok ? (await r.json()) || [] : []; } catch { return []; }
}
function json(statusCode, body) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

// Every 5 minutes.
exports.config = { schedule: "*/5 * * * *" };
