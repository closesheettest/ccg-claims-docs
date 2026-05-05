// netlify/functions/jn-inspect-files.js
//
// THROWAWAY DIAGNOSTIC — delete after we figure out why photo fetch fails.
// Hits JN's /files?related=<jnid> endpoint and dumps the raw response so we
// can see (1) whether JN returns files at all, (2) what shape they have,
// (3) what content_types they actually have.
//
// USAGE:
//   /.netlify/functions/jn-inspect-files?jnid=b9f4ea57fe7d4ef0a04333eacab04a5f

const JN_BASE = "https://app.jobnimbus.com/api1";
const JN_KEY = process.env.JOBNIMBUS_API_KEY;
const jnHeaders = {
  Authorization: `bearer ${JN_KEY}`,
  "Content-Type": "application/json",
};

exports.handler = async (event) => {
  const jnid = event.queryStringParameters?.jnid;
  if (!jnid) {
    return { statusCode: 400, body: JSON.stringify({ error: "Pass ?jnid=jobid" }) };
  }

  const out = { jnid };

  // 1) List files for the job — same as before
  try {
    const r = await fetch(`${JN_BASE}/files?related=${jnid}&type=2&size=50`, { headers: jnHeaders });
    const data = await r.json();
    const files = data.files || data.data || data.results || [];
    out.listEndpoint = {
      status: r.status,
      fileCount: files.length,
      firstFile: files[0] || null,
    };

    // 2) If there's at least one file, hit GET /files/{jnid} on it to see
    //    the full detail shape (with download URL fields)
    if (files[0]?.jnid) {
      try {
        const fileJnid = files[0].jnid;
        const dr = await fetch(`${JN_BASE}/files/${fileJnid}`, { headers: jnHeaders });
        const dtext = await dr.text();
        let dparsed;
        try { dparsed = JSON.parse(dtext); }
        catch { dparsed = { raw: dtext.slice(0, 500) }; }
        out.detailEndpoint = {
          url: `${JN_BASE}/files/${fileJnid}`,
          status: dr.status,
          allKeys: dparsed && typeof dparsed === "object" ? Object.keys(dparsed) : null,
          urlFields: dparsed && typeof dparsed === "object"
            ? Object.keys(dparsed).filter(k =>
                k.toLowerCase().includes("url") || k === "src" || k === "link" || k === "data"
              ).reduce((acc, k) => { acc[k] = dparsed[k]; return acc; }, {})
            : null,
          fullResponse: dparsed,
        };
      } catch (e) {
        out.detailEndpoint = { error: e.message };
      }
    }
  } catch (e) {
    out.listEndpoint = { error: e.message };
  }

  return {
    statusCode: 200,
    body: JSON.stringify(out, null, 2),
  };
};