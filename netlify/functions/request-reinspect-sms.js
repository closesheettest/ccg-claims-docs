// netlify/functions/request-reinspect-sms.js
//
// MANUAL admin action for a no-photo inspection (e.g. Bastos): reopen the job
// so it returns to the inspector's pool, and TEXT the inspector to go back and
// re-inspect, with a link to the inspector app. Manual on purpose — these are
// one-offs the office wants to know about, so nothing fires automatically.
//
// POST { inspectionId, dry? }
//   1. Reopen the job via reinspect-job (clears the bad result + any photos so
//      it reappears for the inspector; posts a JN note for the paper trail).
//   2. SMS the assigned inspector a "go re-inspect <customer>" link.
//
// Env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, URL.

const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const sb = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` };

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return cors(200, "");
  if (event.httpMethod !== "POST") return cors(405, JSON.stringify({ ok: false, error: "POST only" }));
  if (!SB_URL || !SB_KEY) return cors(500, JSON.stringify({ ok: false, error: "Supabase env missing" }));

  let body; try { body = JSON.parse(event.body || "{}"); } catch { return cors(400, JSON.stringify({ ok: false, error: "bad JSON" })); }
  const inspectionId = String(body.inspectionId || "").trim();
  const dry = !!body.dry;
  if (!inspectionId) return cors(400, JSON.stringify({ ok: false, error: "inspectionId required" }));
  const base = process.env.URL || process.env.DEPLOY_URL || process.env.PUBLIC_SITE_URL || "";

  // 1. Inspection + its inspector.
  const rows = await sbGet(`inspections?id=eq.${encodeURIComponent(inspectionId)}&select=id,client_name,address,inspector_id,jn_job_id&limit=1`);
  const insp = rows[0];
  if (!insp) return cors(404, JSON.stringify({ ok: false, error: "Inspection not found" }));
  let inspector = null;
  if (insp.inspector_id) {
    const irows = await sbGet(`inspectors?id=eq.${encodeURIComponent(insp.inspector_id)}&select=name,phone&limit=1`);
    inspector = irows[0] || null;
  }
  if (!inspector || !inspector.phone) {
    return cors(409, JSON.stringify({ ok: false, error: "No inspector with a phone on this job — assign/contact the inspector manually" }));
  }

  const customer = (insp.client_name || "the customer").trim();
  const address = insp.address || "";
  const link = `${base}/?mode=inspector`;
  const first = (inspector.name || "").trim().split(/\s+/)[0] || "";
  const message =
    `Hey${first ? " " + first : ""} — no photos came through for ${customer}${address ? ` (${address})` : ""}, ` +
    `so we need you to go back and re-inspect. Open the inspector app and you'll see them in your list: ${link}`;

  if (dry) return cors(200, JSON.stringify({ ok: true, dry: true, to: inspector.phone, inspector: inspector.name, would_send: message }));

  // 2. Reopen the job (clears result + photos so it returns to the pool).
  let reopened = false, reopenDetail = null;
  try {
    const r = await fetch(`${base}/.netlify/functions/reinspect-job`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ inspectionId }),
    });
    const d = await r.json().catch(() => ({}));
    reopened = r.ok && d.ok !== false;
    reopenDetail = d.error || (reopened ? "reopened" : `status ${r.status}`);
  } catch (e) { reopenDetail = e.message; }

  // 3. Text the inspector.
  let sent = false, smsErr = null;
  try {
    const r = await fetch(`${base}/.netlify/functions/ghl-sms`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ to: inspector.phone, name: inspector.name, message }),
    });
    sent = r.ok;
    if (!sent) smsErr = `ghl-sms ${r.status}`;
  } catch (e) { smsErr = e.message; }

  return cors(sent ? 200 : 502, JSON.stringify({ ok: sent, inspector: inspector.name, to: inspector.phone, reopened, reopenDetail, smsErr, message }));
};

async function sbGet(path) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: sb });
  if (!r.ok) return [];
  return r.json().catch(() => []);
}
function cors(status, body) {
  return { statusCode: status, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" }, body };
}
