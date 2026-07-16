// Read-only JobNimbus lookup by address (or free text). Returns matching
// contacts + jobs with the fields that matter for tracing a deal, plus each
// job's attachment count (to spot a missing signed agreement).
//   GET ?q=830 Virginia
const JN_BASE = "https://app.jobnimbus.com/api1";
const JN_KEY = process.env.JOBNIMBUS_API_KEY;

exports.handler = async (event) => {
  const H = { Authorization: `bearer ${JN_KEY}`, "Content-Type": "application/json" };
  const q = ((event.queryStringParameters || {}).q || "").trim();
  if (!q) return json({ ok: false, error: "pass ?q=<address or text>" });
  const filter = encodeURIComponent(JSON.stringify({ must: [{ match: { address_line1: q } }] }));

  const contacts = (await get(`${JN_BASE}/contacts?size=25&filter=${filter}`, H)).results || [];
  const jobs = (await get(`${JN_BASE}/jobs?size=25&filter=${filter}`, H)).results || [];

  const slimC = contacts.map((c) => ({
    jnid: c.jnid, name: c.display_name, address: [c.address_line1, c.city, c.state_text, c.zip].filter(Boolean).join(", "),
    status: c.status_name, record_type: c.record_type_name, source: c.source_name,
    sales_rep: c.sales_rep_name, created_by: c.created_by_name,
    created: c.date_created ? new Date(c.date_created * 1000).toISOString().slice(0, 16) : null,
    attachments: c.attachment_count, tasks: c.task_count,
  }));
  const slimJ = [];
  for (const j of jobs) {
    slimJ.push({
      jnid: j.jnid, name: j.name, address: [j.address_line1, j.city, j.state_text, j.zip].filter(Boolean).join(", "),
      status: j.status_name, record_type: j.record_type_name, source: j.source_name,
      sales_rep: j.sales_rep_name, created_by: j.created_by_name,
      created: j.date_created ? new Date(j.date_created * 1000).toISOString().slice(0, 16) : null,
      sold: j.date_status_change ? new Date(j.date_status_change * 1000).toISOString().slice(0, 16) : null,
      attachments: j.attachment_count,
    });
  }
  return json({ ok: true, q, contacts: slimC, jobs: slimJ });
};
async function get(url, headers) { try { const r = await fetch(url, { headers }); return await r.json(); } catch (e) { return { error: String(e) }; } }
function json(o) { return { statusCode: 200, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }, body: JSON.stringify(o) }; }
