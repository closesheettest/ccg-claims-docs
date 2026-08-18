// netlify/functions/audit-inspection-certs.js
//
// Does every completed inspection actually have its CERTIFICATE and PHOTOS in
// JobNimbus? Asked of JN itself, not of our own flags — jn_cert_uploaded_at can
// be stale or never written, so it can't be trusted to answer this (Neal,
// 2026-08-18, after the inspector report was found to be undercounting work).
//
// For each inspection completed in the window it reads the JN job's files:
//   • photos    → /files?related=<jnid>&type=2, counting image content types
//   • the cert  → /files?related=<jnid>&type=1, an "Inspection-Report-*.pdf"
// Same endpoints and filename rule the bulk report generator uses, so "has a
// report" means exactly what it means everywhere else.
//
// ONLY REAL INSPECTIONS. Rows with a blank inspector are pay-credit records the
// map writes when a rep books a retail appointment — nobody inspected a roof, so
// a missing cert on those is correct, not a finding.
//
//   GET ?days=14&limit=40&offset=0
//   → { ok, window_days, scanned, next_offset, rows:[…], by_inspector:[…] }
//
// Paged on purpose: two JN calls per roof, and a whole fortnight would run past
// the function timeout. Walk it with next_offset.
//
// Env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, JOBNIMBUS_API_KEY

const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const JN_BASE = "https://app.jobnimbus.com/api1";
const JN_KEY = process.env.JOBNIMBUS_API_KEY;
const sbH = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` };
const jnH = { Authorization: `bearer ${JN_KEY}`, "Content-Type": "application/json" };

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return cors(200, {});
  if (!SB_URL || !SB_KEY || !JN_KEY) return cors(500, { ok: false, error: "env missing" });
  const q = event.queryStringParameters || {};
  const days = Math.min(Math.max(parseInt(q.days, 10) || 14, 1), 120);
  const limit = Math.min(Math.max(parseInt(q.limit, 10) || 40, 1), 100);
  const offset = Math.max(parseInt(q.offset, 10) || 0, 0);
  const since = new Date(Date.now() - days * 86400000).toISOString();

  try {
    const r = await fetch(
      `${SB_URL}/rest/v1/inspections?result_at=gte.${encodeURIComponent(since)}` +
      `&inspector_name=not.is.null&cancelled_at=is.null&jn_job_id=not.is.null` +
      `&select=id,client_name,address,inspector_name,result,result_at,jn_job_id,jn_cert_uploaded_at` +
      `&order=result_at.desc&limit=${limit}&offset=${offset}`,
      { headers: sbH },
    );
    if (!r.ok) return cors(502, { ok: false, error: `Supabase ${r.status}` });
    const all = await r.json();
    // Blank-but-not-null inspector names slip past the SQL filter.
    const rows = all.filter((x) => String(x.inspector_name || "").trim());

    const scanned = [];
    for (let i = 0; i < rows.length; i += 6) {
      const batch = rows.slice(i, i + 6);
      const out = await Promise.all(batch.map(async (x) => {
        const [photos, cert] = await Promise.all([countPhotos(x.jn_job_id), certName(x.jn_job_id)]);
        return {
          client: x.client_name, address: x.address, inspector: x.inspector_name,
          result: x.result, on: (x.result_at || "").slice(0, 10),
          jn_url: `https://app.jobnimbus.com/job/${x.jn_job_id}`,
          photos, cert: !!cert, cert_file: cert || null,
          // What OUR record claims, so a disagreement is visible rather than assumed.
          flagged_uploaded: !!x.jn_cert_uploaded_at,
        };
      }));
      scanned.push(...out);
    }

    const by = {};
    for (const s of scanned) {
      const b = by[s.inspector] || (by[s.inspector] = { inspector: s.inspector, roofs: 0, no_cert: 0, no_photos: 0, flag_wrong: 0 });
      b.roofs++;
      if (!s.cert) b.no_cert++;
      if (!s.photos) b.no_photos++;
      if (s.flagged_uploaded && !s.cert) b.flag_wrong++;   // we said uploaded, JN disagrees
    }

    return cors(200, {
      ok: true, window_days: days, offset, scanned: scanned.length,
      next_offset: all.length === limit ? offset + limit : null,
      by_inspector: Object.values(by).sort((a, b) => b.roofs - a.roofs),
      rows: scanned,
    });
  } catch (e) {
    return cors(500, { ok: false, error: e.message || "error" });
  }
};

async function countPhotos(jnid) {
  try {
    const r = await fetch(`${JN_BASE}/files?related=${jnid}&type=2&size=50`, { headers: jnH });
    if (!r.ok) return 0;
    const d = await r.json();
    const files = d.files || d.data || d.results || [];
    return files.filter((f) => String(f.content_type || "").startsWith("image/")).length;
  } catch { return 0; }
}
// The certificate is the Inspection-Report PDF on the Documents tab — same
// filename rule the generator writes and the bulk lister checks.
async function certName(jnid) {
  try {
    const r = await fetch(`${JN_BASE}/files?related=${jnid}&type=1&size=50`, { headers: jnH });
    if (!r.ok) return null;
    const d = await r.json();
    const files = d.files || d.data || d.results || [];
    const hit = files.find((f) => String(f.filename || "").startsWith("Inspection-Report-"));
    return hit ? hit.filename : null;
  } catch { return null; }
}
function cors(status, obj) {
  return { statusCode: status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" }, body: JSON.stringify(obj) };
}
