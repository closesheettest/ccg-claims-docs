// TEMP one-off (guarded) — reconcile Bridgette Job 11925 appointment tasks so there's
// exactly ONE open "Initial Appointment" at 7:00 (for retail reminders), owned by
// Samuel Bissu. Idempotent: completes any open generic "Appointment" tasks (retried),
// leaves/creates a single Initial Appointment. ?read=1 lists tasks. DELETE after.
const JN_BASE = "https://app.jobnimbus.com/api1";
const JN_KEY = process.env.JOBNIMBUS_API_KEY;
const JOB_ID = "mpikx2sa2qgv97uy85u5j7z";
const SAMUEL = "miyr73x2uuj9ts6hcpxs68p";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

exports.handler = async (event) => {
  const q = (event && event.queryStringParameters) || {};
  if (!q.go && !q.read) return json(200, { note: "?read=1 to list, ?go=1 to reconcile" });
  const H = { Authorization: `bearer ${JN_KEY}`, "Content-Type": "application/json" };
  const listAll = async () => {
    const tf = encodeURIComponent(JSON.stringify({ must: [{ term: { "related.id": JOB_ID } }] }));
    const r = await fetch(`${JN_BASE}/tasks?size=50&filter=${tf}`, { headers: H });
    const d = r.ok ? await r.json().catch(() => ({})) : {};
    return (d.results || d.tasks || d.data || []).map((t) => ({
      id: t.jnid || t.id, type: t.record_type_name, date_start: t.date_start,
      is_completed: !!t.is_completed, owners: (t.owners || []).map((o) => o.id),
    }));
  };
  if (q.read) return json(200, { tasks: await listAll() });

  const out = { actions: [] };
  try {
    let tasks = await listAll();
    const isInitial = (t) => String(t.type || "").toLowerCase() === "initial appointment";
    const isAppt = (t) => /appointment/i.test(t.type || "");
    const openInitial = tasks.filter((t) => !t.is_completed && isInitial(t));
    const openGeneric = tasks.filter((t) => !t.is_completed && isAppt(t) && !isInitial(t));
    let apptSec = 0;
    for (const t of [...openInitial, ...openGeneric]) if (!apptSec && t.date_start) apptSec = Number(t.date_start);

    for (const t of openGeneric) {
      let ok = false, err = null;
      for (let i = 0; i < 3 && !ok; i++) {
        const r = await fetch(`${JN_BASE}/tasks/${t.id}`, { method: "PUT", headers: H, body: JSON.stringify({ is_completed: true }) });
        ok = r.ok; if (!ok) { err = (await r.text().catch(() => "")).slice(0, 160); await sleep(500 * (i + 1)); }
      }
      out.actions.push({ completed_generic: t.id, ok, err });
    }
    if (openInitial.length === 0) {
      if (!apptSec) apptSec = 1785970800; // 2026-08-04 19:00 ET fallback
      const cr = await fetch(`${JN_BASE}/tasks`, {
        method: "POST", headers: H,
        body: JSON.stringify({ record_type: 4, record_type_name: "Initial Appointment", type: "task", title: "Initial Appointment — Bridgette Johnson", date_start: apptSec, date_end: 0, related: [{ id: JOB_ID, type: "job" }], owners: [{ id: SAMUEL }] }),
      });
      out.actions.push({ created_initial: (await cr.json().catch(() => ({}))).jnid, ok: cr.ok });
    } else {
      out.actions.push({ note: `Initial Appointment already open (${openInitial.length}) — none created` });
    }
    await sleep(1800);
    out.after = (await listAll()).filter((t) => !t.is_completed && isAppt(t)).map((t) => ({ type: t.type, date_start: t.date_start, owners: t.owners }));
  } catch (e) { out.error = String((e && e.message) || e); }
  return json(200, out);
};
function json(s, b) { return { statusCode: s, headers: { "Content-Type": "application/json" }, body: JSON.stringify(b, null, 1) }; }
