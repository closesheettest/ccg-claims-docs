// netlify/functions/backfill-inspection-mobile.js
//
// Backfill inspections.mobile from JobNimbus for records that have no
// phone stored (older / imported deals). The homeowner's number lives on
// the JN CONTACT (mobile_phone / home_phone / work_phone) even when our
// inspections.mobile is null — this copies it in so the PA portal and
// company portal show a click-to-dial number.
//
// Reads only (job → primary contact); never writes to JN.
//
// POST { paId?, limit? }
//   paId   — optional: only this PA's deals (else all missing-mobile deals)
//   limit  — optional batch cap (default 100)
// → { ok, scanned, updated, still_missing, results:[{id,name,phone}] }
//
// Env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, JOBNIMBUS_API_KEY.

const JN_BASE = "https://app.jobnimbus.com/api1";

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { ok: false, error: "Method not allowed" });
  for (const k of ["VITE_SUPABASE_URL", "VITE_SUPABASE_ANON_KEY", "JOBNIMBUS_API_KEY"]) {
    if (!process.env[k]) return json(500, { ok: false, error: `Missing env: ${k}` });
  }
  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch { return json(400, { ok: false, error: "Bad JSON" }); }

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
  const JN_KEY = process.env.JOBNIMBUS_API_KEY;
  const sb = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" };
  const jn = { Authorization: `bearer ${JN_KEY}`, "Content-Type": "application/json" };

  const paId = (body.paId || "").trim();
  const limit = Math.min(Math.max(parseInt(body.limit, 10) || 100, 1), 500);

  let url = `${SB_URL}/rest/v1/inspections?mobile=is.null&jn_job_id=not.is.null&cancelled_at=is.null&select=id,client_name,jn_job_id&limit=${limit}`;
  if (paId) url += `&pa_id=eq.${encodeURIComponent(paId)}`;
  const rows = await get(url, sb);

  let updated = 0; const results = [];
  for (const r of rows) {
    try {
      // 1. Job → primary contact id.
      const job = await getJson(`${JN_BASE}/jobs/${encodeURIComponent(r.jn_job_id)}`, jn);
      const contactId = job?.primary?.id || (Array.isArray(job?.related) ? (job.related.find((x) => x.type === "contact")?.id) : null);
      if (!contactId) { results.push({ id: r.id, name: r.client_name, phone: null, note: "no contact" }); continue; }
      // 2. Contact → phone.
      const c = await getJson(`${JN_BASE}/contacts/${encodeURIComponent(contactId)}`, jn);
      const phone = normalizePhone(c?.mobile_phone) || normalizePhone(c?.home_phone) || normalizePhone(c?.work_phone);
      if (!phone) { results.push({ id: r.id, name: r.client_name, phone: null, note: "no phone in JN" }); continue; }
      // 3. Write it back.
      const upd = await fetch(`${SB_URL}/rest/v1/inspections?id=eq.${encodeURIComponent(r.id)}`, {
        method: "PATCH", headers: { ...sb, Prefer: "return=minimal" }, body: JSON.stringify({ mobile: phone }),
      });
      if (upd.ok) { updated++; results.push({ id: r.id, name: r.client_name, phone }); }
      else results.push({ id: r.id, name: r.client_name, phone, note: `write failed ${upd.status}` });
    } catch (e) {
      results.push({ id: r.id, name: r.client_name, phone: null, note: e.message?.slice(0, 80) });
    }
  }

  return json(200, { ok: true, scanned: rows.length, updated, still_missing: rows.length - updated, results });
};

function normalizePhone(raw) {
  if (!raw) return null;
  const d = String(raw).replace(/\D/g, "");
  if (d.length === 10) return d;
  if (d.length === 11 && d.startsWith("1")) return d.slice(1);
  return d.length >= 7 ? d : null;
}
async function get(url, headers) { try { const r = await fetch(url, { headers }); return r.ok ? (await r.json()) || [] : []; } catch { return []; } }
async function getJson(url, headers) { const r = await fetch(url, { headers }); if (!r.ok) throw new Error(`${url.split("/").pop()} ${r.status}`); return await r.json().catch(() => ({})); }
function json(status, obj) { return { statusCode: status, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) }; }
