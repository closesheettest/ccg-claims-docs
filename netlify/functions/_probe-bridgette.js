// TEMP read-only probe — verify Job 11925 (Bridgette Johnson) retail conversion.
// DELETE after diagnosis.
const JN_BASE = "https://app.jobnimbus.com/api1";
const JN_KEY = process.env.JOBNIMBUS_API_KEY;
const JOB_ID = "mpikx2sa2qgv97uy85u5j7z";

exports.handler = async () => {
  const H = { Authorization: `bearer ${JN_KEY}`, "Content-Type": "application/json" };
  const out = {};
  try {
    const jr = await fetch(`${JN_BASE}/jobs/${JOB_ID}`, { headers: H });
    const j = jr.ok ? await jr.json().catch(() => ({})) : {};
    out.job = {
      name: j.name || j.display_name,
      status_name: j.status_name,
      record_type_name: j.record_type_name,
      location: j.location,
      owners: (j.owners || []).map((o) => o.id),
      sales_rep: j.sales_rep,
      date_start: j.date_start,
      date_end: j.date_end,
      primary: j.primary && { id: j.primary.id, name: j.primary.name },
    };
    const tf = encodeURIComponent(JSON.stringify({ must: [{ term: { "related.id": JOB_ID } }] }));
    const tr = await fetch(`${JN_BASE}/tasks?size=50&filter=${tf}`, { headers: H });
    const td = tr.ok ? await tr.json().catch(() => ({})) : {};
    out.tasks = (td.results || td.tasks || td.data || []).map((t) => ({
      title: t.title, record_type_name: t.record_type_name,
      date_start: t.date_start, is_completed: t.is_completed,
      owners: (t.owners || []).map((o) => o.id),
    }));
  } catch (e) { out.error = String((e && e.message) || e); }
  return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify(out, null, 1) };
};
