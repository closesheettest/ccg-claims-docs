// netlify/functions/scan-missing-reports.js
//
// Read-only audit: how many inspection REPORTS that our app uploaded to
// JobNimbus have since gone MISSING (deleted). Signal of the "QuickBooks
// deleted the inspection report" issue (e.g. Kieth Lopez, 6/18).
//
// For every inspection we stamped `jn_cert_uploaded_at` (= we uploaded the
// report) that still has a JN job and isn't cancelled, we list the job's
// document files and check whether an `Inspection-Report-*` doc is still
// present. If it's gone, the report was deleted after we uploaded it.
//
//   GET /.netlify/functions/scan-missing-reports            → first 200
//   GET ...?limit=200&offset=0                              → paging
//
// Never writes anything. Env: JOBNIMBUS_API_KEY, VITE_SUPABASE_URL,
// VITE_SUPABASE_ANON_KEY.

const JN_BASE = "https://app.jobnimbus.com/api1";
const JN_KEY = process.env.JOBNIMBUS_API_KEY;
const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const sb = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` };
const jnH = { Authorization: `bearer ${JN_KEY}`, "Content-Type": "application/json" };
const CONCURRENCY = 10;

const isReport = (f) => {
  const fn = f.filename || "", desc = f.description || "";
  return fn.startsWith("Inspection-Report-") || desc.startsWith("Inspection Report (with photos)");
};

exports.handler = async (event) => {
  if (!JN_KEY || !SB_URL || !SB_KEY) return json(500, { ok: false, error: "Missing env" });
  const qp = (event && event.queryStringParameters) || {};
  const limit = Math.min(Math.max(parseInt(qp.limit, 10) || 200, 1), 300);
  const offset = Math.max(parseInt(qp.offset, 10) || 0, 0);

  try {
    const rows = await sbGet(
      `inspections?jn_cert_uploaded_at=not.is.null&jn_job_id=not.is.null&cancelled_at=is.null` +
      `&select=id,client_name,address,city,sales_rep_name,jn_job_id,jn_cert_uploaded_at,result` +
      `&order=jn_cert_uploaded_at.desc&limit=${limit}&offset=${offset}`
    );

    const missing = [];
    let present = 0, jnErrors = 0;

    for (let i = 0; i < rows.length; i += CONCURRENCY) {
      const batch = rows.slice(i, i + CONCURRENCY);
      await Promise.all(batch.map(async (r) => {
        const data = await jnGet(`files?related=${encodeURIComponent(r.jn_job_id)}&type=1&size=50`);
        if (data === null) { jnErrors++; return; }
        const files = data.files || data.results || [];
        if (files.some(isReport)) { present++; return; }
        missing.push({
          name: r.client_name || "—",
          rep: r.sales_rep_name || null,
          result: r.result || null,
          uploaded: r.jn_cert_uploaded_at ? r.jn_cert_uploaded_at.slice(0, 10) : null,
          address: [r.address, r.city].filter(Boolean).join(", "),
          jn_url: `https://app.jobnimbus.com/job/${r.jn_job_id}`,
          jnid: r.jn_job_id,
        });
      }));
    }

    missing.sort((a, b) => (b.uploaded || "").localeCompare(a.uploaded || ""));
    return json(200, {
      ok: true,
      scanned: rows.length,
      offset, limit,
      more: rows.length === limit ? `re-run with ?offset=${offset + limit}` : null,
      present_reports: present,
      missing_count: missing.length,
      jn_errors: jnErrors,
      missing,
    });
  } catch (e) {
    return json(500, { ok: false, error: e.message || "error" });
  }
};

async function jnGet(path) {
  for (let a = 0; a < 3; a++) {
    try {
      const r = await fetch(`${JN_BASE}/${path}`, { headers: jnH });
      if (r.ok) return await r.json().catch(() => null);
      if (r.status < 500) return null;
    } catch { /* retry */ }
    await sleep(300 * (a + 1));
  }
  return null;
}
async function sbGet(path) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: sb });
  if (!r.ok) return [];
  return r.json().catch(() => []);
}
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
function json(status, obj) {
  return {
    statusCode: status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" },
    body: JSON.stringify(obj),
  };
}
