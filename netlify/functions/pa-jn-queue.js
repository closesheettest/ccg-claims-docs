// netlify/functions/pa-jn-queue.js
//
// Backs the "Add to JobNimbus" queue page (/?jn_queue=<token>). U.S. Shingle
// opens it from the alert, copy-pastes each pending PA's name / email / phone
// into JobNimbus (so nothing is mistyped — copy/paste keeps the email an
// EXACT match for auto-linking), then clicks "Completed." That fires the
// link: we pull JN users, match this PA by email, stamp jn_user_id, and
// notify their company admin they're ready to activate.
//
// POST { token, action: "load" }
//   → { ok, pending: [{ id, name, email, phone, company_name }] }
// POST { token, action: "complete", paId }
//   → { ok, linked: true }  OR  { ok, linked: false, error }  (not in JN yet)
//
// Required env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, JOBNIMBUS_API_KEY.

// Shared secret for the queue link. Unguessable; baked into the link the
// alert sends. Rotate by changing here + redeploying.
const QUEUE_TOKEN = "jnq_7Kx2pV9mQ4sR1bN8wL3";
const TMS_SB_URL = "https://yfmzktvmlfeqcubnvhxr.supabase.co";
const TMS_SB_KEY = "sb_publishable_Nfr-w2esI_2JoBwBXOWpIg_rWJWkBrN";

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return cors(200, "");
  if (event.httpMethod !== "POST") return cors(405, { ok: false, error: "Method not allowed" });
  for (const k of ["VITE_SUPABASE_URL", "VITE_SUPABASE_ANON_KEY", "JOBNIMBUS_API_KEY"]) {
    if (!process.env[k]) return cors(500, { ok: false, error: `Missing env: ${k}` });
  }
  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch { return cors(400, { ok: false, error: "Bad JSON" }); }
  if ((body.token || "") !== QUEUE_TOKEN) return cors(403, { ok: false, error: "Invalid link" });

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
  const JN_KEY = process.env.JOBNIMBUS_API_KEY;
  const sb = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" };
  const base = (process.env.URL || process.env.DEPLOY_URL || process.env.PUBLIC_SITE_URL || "https://free-roof-inspections.netlify.app").replace(/\/$/, "");
  const action = (body.action || "load").trim();

  // Pending = company-added PAs still waiting for JobNimbus.
  const loadPending = async () => {
    const rows = await get(`${SB_URL}/rest/v1/pas?jn_user_id=is.null&pa_company_id=not.is.null&active=eq.false&email=not.is.null&select=id,name,email,phone,pa_company_id&order=created_at.asc`, sb);
    const cids = [...new Set(rows.map((r) => r.pa_company_id))];
    let nameById = {};
    if (cids.length) {
      const cos = await get(`${SB_URL}/rest/v1/pa_companies?id=in.(${cids.map((c) => `"${c}"`).join(",")})&select=id,name`, sb);
      nameById = Object.fromEntries(cos.map((c) => [c.id, c.name]));
    }
    return rows.map((r) => ({ id: r.id, name: r.name, email: r.email, phone: r.phone || "", company_name: nameById[r.pa_company_id] || "—", pa_company_id: r.pa_company_id }));
  };

  if (action === "load") {
    return cors(200, { ok: true, pending: (await loadPending()).map(({ pa_company_id, ...p }) => p) });
  }

  if (action === "complete") {
    const paId = (body.paId || "").trim();
    const pending = await loadPending();
    const pa = pending.find((p) => p.id === paId);
    if (!pa) return cors(404, { ok: false, error: "That PA isn't in the queue (maybe already linked)." });
    // Match by email in the JN user list.
    const jnRes = await fetch("https://app.jobnimbus.com/api1/account/users", { headers: { Authorization: `bearer ${JN_KEY}`, "Content-Type": "application/json" } });
    if (!jnRes.ok) return cors(502, { ok: false, error: `JobNimbus error ${jnRes.status}` });
    const users = ((await jnRes.json().catch(() => ({}))).users || []).filter((u) => u.is_active !== false);
    const u = users.find((x) => x.email && String(x.email).trim().toLowerCase() === String(pa.email).trim().toLowerCase());
    if (!u || !u.id) {
      return cors(200, { ok: true, linked: false, error: "Not in JobNimbus yet — add them there first (exact email), then click Completed." });
    }
    const already = await get(`${SB_URL}/rest/v1/pas?jn_user_id=eq.${encodeURIComponent(u.id)}&select=id&limit=1`, sb);
    if (already.length) return cors(409, { ok: false, error: "That JobNimbus user is already linked to another PA." });
    const upd = await fetch(`${SB_URL}/rest/v1/pas?id=eq.${encodeURIComponent(paId)}`, {
      method: "PATCH", headers: { ...sb, Prefer: "return=minimal" }, body: JSON.stringify({ jn_user_id: u.id }),
    });
    if (!upd.ok) return cors(500, { ok: false, error: `Link failed: ${(await upd.text()).slice(0, 160)}` });
    // Notify the company admin they're ready to activate (best-effort).
    try {
      const co = (await get(`${SB_URL}/rest/v1/pa_companies?id=eq.${pa.pa_company_id}&select=name,admin_name,admin_phone,email,token`, sb))[0];
      if (co) {
        const link = `${base}/?pa_company=${co.token}`;
        const sms = `✅ ${pa.name} has been approved and is ready to activate in your U.S. Shingle portal: ${link}`;
        const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.55;color:#1e293b">Hi ${co.admin_name || "there"},<br><br><b>${pa.name}</b> is <b>ready to activate</b>.<br><br>Open your portal and tap <b>Activate</b>:<br><a href="${link}">${link}</a></div>`;
        if (co.admin_phone) await fetch(`${base}/.netlify/functions/ghl-sms`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ to: co.admin_phone, name: co.admin_name || "Admin", message: sms }) }).catch(() => {});
        if (co.email) await fetch(`${base}/.netlify/functions/send-email`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ to: co.email, subject: `${pa.name} is approved — ready to activate`, html }) }).catch(() => {});
      }
    } catch { /* notify best-effort */ }
    return cors(200, { ok: true, linked: true });
  }

  return cors(400, { ok: false, error: "Unknown action" });
};

async function get(url, headers) {
  try { const r = await fetch(url, { headers }); return r.ok ? (await r.json()) || [] : []; } catch { return []; }
}
function cors(status, obj) {
  return {
    statusCode: status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" },
    body: typeof obj === "string" ? obj : JSON.stringify(obj),
  };
}
