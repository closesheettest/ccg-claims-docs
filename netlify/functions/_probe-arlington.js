// TEMP read-only probe — inspect the 668 Arlington jobs + the pin's contact so we
// can see why the reverse sync didn't flip the pin. DELETE after diagnosis.
const JN_BASE = "https://app.jobnimbus.com/api1";
const JN_KEY = process.env.JOBNIMBUS_API_KEY;

exports.handler = async () => {
  const H = { Authorization: `bearer ${JN_KEY}`, "Content-Type": "application/json" };
  const out = { jobs_by_address: [], pin_contact: null, contact_jobs: [] };
  try {
    // 1. Jobs whose address_line1 matches "668 Arlington"
    const filter = encodeURIComponent(JSON.stringify({ must: [{ match_phrase: { address_line1: "668 Arlington Drive" } }] }));
    const r = await fetch(`${JN_BASE}/jobs?size=25&filter=${filter}`, { headers: H });
    const d = await r.json().catch(() => ({}));
    for (const j of (d.results || d.jobs || [])) {
      out.jobs_by_address.push({
        jnid: j.jnid, name: j.name || j.display_name, status_name: j.status_name,
        address_line1: j.address_line1, city: j.city, zip: j.zip,
        date_created: j.date_created, date_updated: j.date_updated,
        primary: j.primary && { id: j.primary.id, name: j.primary.name },
        related: (j.related || []).map((x) => ({ id: x.id, type: x.type, name: x.name })),
        geo: j.geo || null,
      });
    }
    // 2. The pin's contact a4b3edef… — its name/# and its jobs
    const cr = await fetch(`${JN_BASE}/contacts/a4b3edefc13349ea85358d64618358c8`, { headers: H });
    const c = await cr.json().catch(() => ({}));
    out.pin_contact = { jnid: c.jnid, display_name: c.display_name, number: c.number, address_line1: c.address_line1, status_name: c.status_name };
    // 3. Jobs where primary/related == that contact
    const jf = encodeURIComponent(JSON.stringify({ must: [{ match: { "related.id": "a4b3edefc13349ea85358d64618358c8" } }] }));
    const jr = await fetch(`${JN_BASE}/jobs?size=25&filter=${jf}`, { headers: H });
    const jd = await jr.json().catch(() => ({}));
    for (const j of (jd.results || jd.jobs || [])) {
      out.contact_jobs.push({ jnid: j.jnid, name: j.name, status_name: j.status_name, address_line1: j.address_line1, date_created: j.date_created });
    }
  } catch (e) {
    out.error = String(e && e.message || e);
  }
  return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify(out, null, 1) };
};
