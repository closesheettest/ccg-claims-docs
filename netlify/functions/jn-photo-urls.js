// netlify/functions/jn-photo-urls.js
//
// Displayable URLs for a JobNimbus job's image files, so a page can SHOW the
// photos that live only in JN (not just count them). The confirm/hold review
// card uses this to render every photo — app-captured AND JN — since older
// deals have most of their roof photos in JN.
//
//   POST { jn_job_id }  → { ok, urls: ["https://…presigned…", …] }
//
// Each JN file id is resolved to its short-lived presigned URL by following the
// /files/<id> 302 (same endpoint pull-jn-photos-to-app downloads from). Image
// files only. Best-effort per file.
//
// Env: JOBNIMBUS_API_KEY

const JN_BASE = "https://app.jobnimbus.com/api1";
const JN_KEY = process.env.JOBNIMBUS_API_KEY;
const jnHeaders = { Authorization: `bearer ${JN_KEY}` };

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return cors(200, "");
  if (event.httpMethod !== "POST") return cors(405, { ok: false, error: "POST only" });
  let body; try { body = JSON.parse(event.body || "{}"); } catch { return cors(400, { ok: false, error: "bad JSON" }); }
  const jnid = String(body.jn_job_id || "").trim();
  if (!jnid || !JN_KEY) return cors(200, { ok: true, urls: [] });

  try {
    const r = await fetch(`${JN_BASE}/files?related=${encodeURIComponent(jnid)}&type=2&size=100`, { headers: jnHeaders });
    const d = r.ok ? await r.json().catch(() => ({})) : {};
    const files = (d.files || d.data || d.results || []).filter((f) => (f.content_type || "").startsWith("image/"));
    const urls = [];
    await Promise.all(files.map(async (f) => {
      const id = f.jnid || f.id;
      if (!id) return;
      try {
        // redirect:manual → JN answers 302 to the S3 presigned URL (public, short-lived).
        const fr = await fetch(`${JN_BASE}/files/${encodeURIComponent(id)}`, { headers: jnHeaders, redirect: "manual" });
        const loc = fr.headers.get("location");
        if (loc) urls.push({ url: loc, at: Number(f.date_created) || 0 });
      } catch { /* skip this file */ }
    }));
    urls.sort((a, b) => a.at - b.at);
    return cors(200, { ok: true, urls: urls.map((u) => u.url) });
  } catch (e) {
    return cors(500, { ok: false, error: e.message || "error" });
  }
};

function cors(status, body) {
  return { statusCode: status, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" }, body: typeof body === "string" ? body : JSON.stringify(body) };
}
