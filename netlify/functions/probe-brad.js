// TEMPORARY read-only probe — dump one JN job + its appointment tasks so we can
// see exactly what state the Brad Ellenwood / 240 Killington Court deal is in
// (status, source, rep, owner, sold date, harvest flag, appt). Delete after use.
//   GET /.netlify/functions/probe-brad?id=<jn_job_id>
const JN_BASE = "https://app.jobnimbus.com/api1";
const JN_KEY = process.env.JOBNIMBUS_API_KEY;
const jnH = { Authorization: `bearer ${JN_KEY}`, "Content-Type": "application/json" };

exports.handler = async (event) => {
  if (!JN_KEY) return j(500, { ok: false, error: "no JN key" });
  const id = String((event.queryStringParameters || {}).id || "mrmiynqbuyx20ivrvylszky").trim();
  try {
    const job = await jn(`jobs/${encodeURIComponent(id)}`);
    if (!job) return j(200, { ok: false, error: "job not found", id });

    // Pull custom fields by label (harvest flag, sold date, etc.).
    const cf = {};
    for (const [k, v] of Object.entries(job)) {
      const label = k.trim().replace(/^\*|\*$/g, "").trim();
      if (/harvested|sold date|payment type|source|start date/i.test(label) && v !== null && v !== "" && v !== undefined) cf[label] = v;
    }

    // Appointment tasks on this job (record_type 4/12/17 = Initial/Reset/Appointment).
    let appts = [];
    try {
      const flt = encodeURIComponent(JSON.stringify({ must: [{ terms: { record_type: [4, 12, 17] } }] }));
      const r = await fetch(`${JN_BASE}/tasks?size=50&filter=${flt}`, { headers: jnH });
      const d = r.ok ? await r.json() : {};
      const rows = d.results || d.tasks || [];
      appts = rows.filter((t) => (t.related || []).some((rel) => rel.type === "job" && rel.id === id))
        .map((t) => ({ title: t.record_type_name, created: iso(t.date_created), start: iso(t.date_start), complete: t.is_completed, by: t.created_by_name }));
    } catch { /* skip */ }

    return j(200, {
      ok: true,
      id,
      name: job.name,
      status_name: job.status_name,
      source_name: job.source_name,
      sales_rep_name: job.sales_rep_name,
      owners: (job.owners || []).map((o) => o.name || o.id),
      location: job.location && job.location.id,
      date_created: iso(job.date_created),
      date_start: iso(job.date_start),
      date_status_change: iso(job.date_status_change),
      date_updated: iso(job.date_updated),
      custom_fields: cf,
      appointment_tasks: appts,
      primary: job.primary && { name: job.primary.name },
    });
  } catch (e) { return j(200, { ok: false, error: e.message || "err" }); }
};

async function jn(path) { const r = await fetch(`${JN_BASE}/${path}`, { headers: jnH }); return r.ok ? r.json().catch(() => null) : null; }
function iso(sec) { const n = Number(sec) || 0; return n ? new Date(n * 1000).toISOString() : null; }
function j(status, body) { return { statusCode: status, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }, body: JSON.stringify(body) }; }
