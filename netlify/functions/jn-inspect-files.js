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

  const out = { jnid, queries: {} };

  // Try several variants of the files query so we can see what works
  const variants = [
    { name: "type=2 (image)", url: `${JN_BASE}/files?related=${jnid}&type=2&size=50` },
    { name: "type=1 (document)", url: `${JN_BASE}/files?related=${jnid}&type=1&size=50` },
    { name: "no type filter", url: `${JN_BASE}/files?related=${jnid}&size=50` },
    { name: "no params", url: `${JN_BASE}/files?related=${jnid}` },
  ];

  for (const v of variants) {
    try {
      const r = await fetch(v.url, { headers: jnHeaders });
      const text = await r.text();
      let parsed;
      try { parsed = JSON.parse(text); }
      catch { parsed = { raw: text.slice(0, 500) }; }

      const files = parsed.data || parsed.files || parsed.results || [];
      out.queries[v.name] = {
        url: v.url,
        status: r.status,
        topLevelKeys: Object.keys(parsed),
        fileCount: Array.isArray(files) ? files.length : "not-array",
        firstThreeFiles: Array.isArray(files) ? files.slice(0, 3).map(f => ({
          jnid: f.jnid || f.id,
          filename: f.filename || f.name,
          content_type: f.content_type,
          type: f.type,
          // Show every URL-ish field so we can see what's available
          urlFields: Object.keys(f).filter(k =>
            k.toLowerCase().includes("url") || k === "src" || k === "link"
          ).reduce((acc, k) => { acc[k] = f[k]; return acc; }, {}),
          allKeys: Object.keys(f),
        })) : null,
      };
    } catch (e) {
      out.queries[v.name] = { error: e.message };
    }
  }

  return {
    statusCode: 200,
    body: JSON.stringify(out, null, 2),
  };
};