// TEMP one-off (guarded by ?go=1) — make Bridgette Job 11925's 7:00 appointment an
// "Initial Appointment" so the retail reminder automations fire. Completes the open
// generic Appointment task and creates an Initial Appointment at the SAME time,
// owned by Samuel Bissu. Returns the resulting open appointment tasks. DELETE after.
const JN_BASE = "https://app.jobnimbus.com/api1";
const JN_KEY = process.env.JOBNIMBUS_API_KEY;
const JOB_ID = "mpikx2sa2qgv97uy85u5j7z";
const SAMUEL = "miyr73x2uuj9ts6hcpxs68p";

exports.handler = async (event) => {
  if (!(event && event.queryStringParameters && event.queryStringParameters.go)) {
    return json(200, { ok: false, note: "add ?go=1 to run" });
  }
  const H = { Authorization: `bearer ${JN_KEY}`, "Content-Type": "application/json" };
  const out = { completed: [], created: null, after: [] };
  try {
    const tf = encodeURIComponent(JSON.stringify({ must: [{ term: { "related.id": JOB_ID } }] }));
    const list = async () => {
      const r = await fetch(`${JN_BASE}/tasks?size=50&filter=${tf}`, { headers: H });
      const d = r.ok ? await r.json().catch(() => ({})) : {};
      return d.results || d.tasks || d.data || [];
    };
    const tasks = await list();
    const openAppts = tasks.filter((t) => !t.is_completed && /appointment/i.test(t.record_type_name || ""));
    let apptSec = 0;
    for (const t of openAppts) {
      if (!apptSec && t.date_start) apptSec = Number(t.date_start);
      const id = t.jnid || t.id;
      const r = await fetch(`${JN_BASE}/tasks/${id}`, { method: "PUT", headers: H, body: JSON.stringify({ is_completed: true }) });
      out.completed.push({ id, was: t.record_type_name, ok: r.ok });
    }
    if (!apptSec) { out.error = "no open appointment task time found — aborted before create"; return json(200, out); }
    const cr = await fetch(`${JN_BASE}/tasks`, {
      method: "POST", headers: H,
      body: JSON.stringify({
        record_type: 4, record_type_name: "Initial Appointment", type: "task",
        title: "Initial Appointment — Bridgette Johnson", date_start: apptSec, date_end: 0,
        related: [{ id: JOB_ID, type: "job" }], owners: [{ id: SAMUEL }],
      }),
    });
    const cj = await cr.json().catch(() => ({}));
    out.created = { ok: cr.ok, id: cj.jnid || cj.id, date_start: apptSec };
    const after = await list();
    out.after = after.filter((t) => !t.is_completed && /appointment/i.test(t.record_type_name || ""))
      .map((t) => ({ type: t.record_type_name, date_start: t.date_start, owners: (t.owners || []).map((o) => o.id) }));
  } catch (e) { out.error = String((e && e.message) || e); }
  return json(200, out);
};
function json(s, b) { return { statusCode: s, headers: { "Content-Type": "application/json" }, body: JSON.stringify(b, null, 1) }; }
