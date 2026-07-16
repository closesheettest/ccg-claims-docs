// Read-only JobNimbus lookup. Tries several search strategies (job/contact name
// embeds the address; address_line1 may not be ES-searchable) and returns whatever
// hits, with the fields that matter for tracing a deal + attachment count.
//   GET ?q=830 Virginia
const JN_BASE = "https://app.jobnimbus.com/api1";
const JN_KEY = process.env.JOBNIMBUS_API_KEY;

exports.handler = async (event) => {
  const H = { Authorization: `bearer ${JN_KEY}`, "Content-Type": "application/json" };
  const q = ((event.queryStringParameters || {}).q || "").trim();
  if (!q) return json({ ok: false, error: "pass ?q=<text>" });

  const strategies = [
    ["jobs/name.match", "jobs", { must: [{ match: { name: q } }] }],
    ["jobs/addr.match", "jobs", { must: [{ match: { address_line1: q } }] }],
    ["contacts/name.match", "contacts", { must: [{ match: { display_name: q } }] }],
    ["contacts/addr.match", "contacts", { must: [{ match: { address_line1: q } }] }],
  ];
  const out = {};
  const seenJobs = {}, seenContacts = {};
  for (const [label, kind, filter] of strategies) {
    const f = encodeURIComponent(JSON.stringify(filter));
    const d = await get(`${JN_BASE}/${kind}?size=25&filter=${f}`, H);
    const rows = d.results || [];
    out[label] = rows.length;
    for (const r of rows) {
      const rec = {
        jnid: r.jnid, name: r.name || r.display_name,
        address: [r.address_line1, r.city, r.state_text, r.zip].filter(Boolean).join(", "),
        status: r.status_name, record_type: r.record_type_name, source: r.source_name,
        sales_rep: r.sales_rep_name, created_by: r.created_by_name,
        created: r.date_created ? new Date(r.date_created * 1000).toISOString().slice(0, 16) : null,
        attachments: r.attachment_count, tasks: r.task_count,
      };
      if (kind === "jobs") seenJobs[r.jnid] = rec; else seenContacts[r.jnid] = rec;
    }
  }
  return json({ ok: true, q, strategy_hits: out, jobs: Object.values(seenJobs), contacts: Object.values(seenContacts) });
};
async function get(url, headers) { try { const r = await fetch(url, { headers }); return await r.json(); } catch (e) { return { error: String(e) }; } }
function json(o) { return { statusCode: 200, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }, body: JSON.stringify(o) }; }
