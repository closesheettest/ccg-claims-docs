// netlify/functions/scrub-filed-pa-deals.js
//
// One-off cleanup: damage deals that the PRIOR PA already FILED a claim on
// should never be in the new PA pipeline. A filed claim shows up in
// JobNimbus as a "filed" date (cf_date_20). This finds those and removes
// them from the PA workflow (pa_stage='dead') so they drop off every PA /
// company list and won't be re-assigned.
//
// Two actions (split so the slow JN scan is read-only, the kill is fast):
//   POST { action:"scan", offset?, limit? }
//     → { ok, total, page:{offset,limit}, scanned, filed:[{id,name,filed,jn_status}] }
//   POST { action:"kill", ids:[...] }
//     → { ok, killed }
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
  const action = (body.action || "scan").trim();

  // Candidate set: damage deals still in the PA pipeline (not already dead).
  const CANDIDATE = `result=eq.damage&cancelled_at=is.null&jn_job_id=not.is.null&or=(pa_stage.is.null,pa_stage.neq.dead)`;

  if (action === "kill") {
    const ids = Array.isArray(body.ids) ? body.ids.filter(Boolean) : [];
    if (!ids.length) return json(400, { ok: false, error: "ids[] required" });
    let killed = 0;
    const nowIso = new Date().toISOString();
    for (const id of ids) {
      const r = await fetch(`${SB_URL}/rest/v1/inspections?id=eq.${encodeURIComponent(id)}`, {
        method: "PATCH", headers: { ...sb, Prefer: "return=minimal" },
        body: JSON.stringify({ pa_stage: "dead", pa_stage_at: nowIso }),
      });
      if (r.ok) killed++;
    }
    return json(200, { ok: true, killed });
  }

  // scan (default): read-only, paginated JN check.
  const offset = Math.max(parseInt(body.offset, 10) || 0, 0);
  const limit = Math.min(Math.max(parseInt(body.limit, 10) || 40, 1), 60);

  // total candidate count (for progress).
  let total = null;
  try {
    const head = await fetch(`${SB_URL}/rest/v1/inspections?${CANDIDATE}&select=id`, {
      headers: { ...sb, Prefer: "count=exact", Range: "0-0" },
    });
    const cr = head.headers.get("content-range") || "";
    const m = cr.match(/\/(\d+)$/); if (m) total = Number(m[1]);
  } catch { /* count best-effort */ }

  const rows = await get(
    `${SB_URL}/rest/v1/inspections?${CANDIDATE}&select=id,client_name,jn_job_id,pa_id,pa_company_id,jn_status&order=id.asc&offset=${offset}&limit=${limit}`,
    sb,
  );

  const filed = [];
  for (const r of rows) {
    try {
      const job = await getJson(`${JN_BASE}/jobs/${encodeURIComponent(r.jn_job_id)}`, jn);
      const filedSec = filedDate(job);
      if (filedSec) {
        filed.push({
          id: r.id, name: (r.client_name || "").trim(), jn_status: r.jn_status || null,
          filed: new Date(filedSec * 1000).toISOString().slice(0, 10),
          assigned: !!(r.pa_id || r.pa_company_id),
        });
      }
    } catch { /* skip a job we can't read */ }
  }

  return json(200, { ok: true, total, page: { offset, limit }, scanned: rows.length, filed });
};

// A claim is "filed" if JobNimbus has a filed date. cf_date_20 is the
// filed-date custom field (confirmed); also catch any friendly "...filed..."
// date key just in case the field id differs on some jobs.
function filedDate(job) {
  if (!job || typeof job !== "object") return null;
  const cf = Number(job.cf_date_20);
  if (cf > 0) return cf;
  for (const [k, v] of Object.entries(job)) {
    if (/filed/i.test(k)) { const n = Number(v); if (n > 1000000000) return n; }
  }
  return null;
}

async function get(url, headers) { try { const r = await fetch(url, { headers }); return r.ok ? (await r.json()) || [] : []; } catch { return []; } }
async function getJson(url, headers) { const r = await fetch(url, { headers }); if (!r.ok) throw new Error(`${r.status}`); return await r.json().catch(() => ({})); }
function json(status, obj) { return { statusCode: status, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) }; }
