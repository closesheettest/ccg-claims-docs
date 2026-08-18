// netlify/functions/goback-appt-repair.js
//
// Puts the MISSING come-back appointments onto reps' JobNimbus calendars.
//
// goback-book was posting an appointment without `type: "task"` or a `date_end`
// and never checking the response, so JN accepted nothing and the homeowners who
// self-scheduled never appeared on anyone's calendar. That's the exact harm Neal
// named: a manager can't see the rep is busy, hands them a company appointment,
// and the rep is double-booked (2026-08-18).
//
// For every inspection with review_appt_at set, this looks for an existing
// "Come-Back Review" task on that job and creates one only if there isn't one —
// so it can be re-run without stacking duplicates on a calendar.
//
//   POST { admin, days? }            → dry run: what's missing
//   POST { admin, days?, confirm:"FIX" } → creates them
//
// Env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, JOBNIMBUS_API_KEY

const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const JN_BASE = "https://app.jobnimbus.com/api1";
const JN_KEY = process.env.JOBNIMBUS_API_KEY;
const sbH = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" };
const jnH = { Authorization: `bearer ${JN_KEY}`, "Content-Type": "application/json" };
const APPT_MIN = 60;

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return cors(200, {});
  if (event.httpMethod !== "POST") return cors(405, { ok: false, error: "POST only" });
  if (!SB_URL || !SB_KEY || !JN_KEY) return cors(500, { ok: false, error: "env missing" });
  let body; try { body = JSON.parse(event.body || "{}"); } catch { return cors(400, { ok: false, error: "bad JSON" }); }

  const want = await getSetting("harvest_admin_token");
  if (!want || String(body.admin || "").trim() !== String(want)) return cors(401, { ok: false, error: "admin token required" });

  const days = Math.min(Math.max(parseInt(body.days, 10) || 60, 1), 365);
  const live = String(body.confirm || "") === "FIX";
  const since = new Date(Date.now() - days * 86400000).toISOString();

  const rows = await sbGet(
    `inspections?review_appt_at=not.is.null&review_appt_at=gte.${encodeURIComponent(since)}` +
    `&jn_job_id=not.is.null&cancelled_at=is.null` +
    `&select=id,client_name,address,city,sales_rep_id,sales_rep_name,jn_job_id,review_appt_at&order=review_appt_at.asc`,
  );

  const out = [];
  for (const r of rows) {
    const startMs = Date.parse(r.review_appt_at);
    if (!startMs) continue;
    const existing = await findApptTask(r.jn_job_id);
    const rec = {
      client: r.client_name, rep: r.sales_rep_name,
      when: new Date(startMs).toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }),
      jn_url: `https://app.jobnimbus.com/job/${r.jn_job_id}`,
      already_on_calendar: !!existing,
      // WHY it may not show on a calendar even though the task exists: JN needs a
      // date_end (and type "task") to give it a slot. A task with only a
      // date_start sits in the job's task list and never appears on the calendar
      // a manager checks before assigning work.
      task: existing ? {
        id: existing.jnid || existing.id || null,
        type: existing.type || null,
        record_type_name: existing.record_type_name || null,
        date_start: existing.date_start || null,
        date_end: existing.date_end || null,
        owners: (existing.owners || []).length,
        shows_on_calendar: !!(existing.date_start && existing.date_end),
      } : null,
      no_rep_on_record: !r.sales_rep_id,   // it'd land on the job but nobody's calendar
    };
    if (!existing && live) {
      const res = await createApptTask(r, startMs);
      rec.created = res.ok;
      if (!res.ok) rec.error = res.error;
    }
    out.push(rec);
  }

  return cors(200, {
    ok: true, dry_run: !live, window_days: days,
    booked: out.length,
    missing: out.filter((x) => !x.already_on_calendar).length,
    created: out.filter((x) => x.created).length,
    rows: out,
  });
};

// Match by the job's own tasks rather than a date filter — JN's task search
// ignores some nested filters, and the job id is the reliable link.
async function findApptTask(jobId) {
  try {
    const f = encodeURIComponent(JSON.stringify({ must: [{ term: { "related.id": jobId } }] }));
    const r = await fetch(`${JN_BASE}/tasks?size=100&filter=${f}`, { headers: jnH });
    if (!r.ok) return null;
    const d = await r.json().catch(() => ({}));
    const list = d.results || d.tasks || d.data || [];
    return list.find((t) => String(t.title || "").startsWith("Come-Back Review")) || null;
  } catch { return null; }
}
async function createApptTask(insp, startMs) {
  const endMs = startMs + APPT_MIN * 60000;
  const body = {
    record_type: 17, record_type_name: "Appointment", type: "task",
    title: `Come-Back Review — ${insp.client_name || "homeowner"}`,
    date_start: Math.floor(startMs / 1000), date_end: Math.floor(endMs / 1000),
    related: [{ id: insp.jn_job_id, type: "job" }],
    ...(insp.sales_rep_id ? { owners: [{ id: insp.sales_rep_id }] } : {}),
  };
  const r = await fetch(`${JN_BASE}/tasks`, { method: "POST", headers: jnH, body: JSON.stringify(body) });
  const txt = await r.text();
  if (!r.ok) return { ok: false, error: `JN ${r.status}: ${txt.slice(0, 160)}` };
  return { ok: true };
}
async function sbGet(path) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: sbH });
  if (!r.ok) return [];
  return r.json().catch(() => []);
}
async function getSetting(key) {
  const rows = await sbGet(`app_settings?key=eq.${encodeURIComponent(key)}&select=value&limit=1`);
  return rows[0] ? rows[0].value : null;
}
function cors(status, obj) {
  return { statusCode: status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" }, body: JSON.stringify(obj) };
}
