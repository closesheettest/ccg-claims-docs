// netlify/functions/create-result-task.js
//
// When an inspection result is classified (damage / no_damage / retail), drop a
// "go back" TASK on the JobNimbus job, of the matching task type, dated at the
// homeowner's preferred go-back time captured at intake (review_availability,
// e.g. "Wed · 5 PM"). The rep/PA already knows when the homeowner wants them
// back — this puts it straight on the JN job so it shows on their JN calendar.
//
//   result "damage"     → task "Inspection Result Insurance PA"  (record_type 25)
//   result "retail"     → task "Inspection Result Back to Retail" (record_type 24)
//   result "no_damage"  → task "Inspection Result No Damage"      (record_type 23)
//
// review_availability formats seen: "Wed · 5 PM", "Thu, Fri, Sat · 2 PM",
// "Any day · 2 PM". We schedule the SOONEST upcoming match (ET) at that hour.
//
// Internal call (no token), like send-to-pa-ops-hub / process-retail-result.
// POST { inspectionId } → { ok, created?, task_id?, when?, skipped? }
//
// Optional idempotency: if the inspections table has a `result_task_jnid` text
// column, we record the task id and skip re-creating. Works without it too.
//
// Env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, JOBNIMBUS_API_KEY.

const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const sb = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" };
const JN_BASE = "https://app.jobnimbus.com/api1";
const JN_KEY = process.env.JOBNIMBUS_API_KEY;
const jnH = { Authorization: `bearer ${JN_KEY}`, "Content-Type": "application/json" };

const RECORD_TYPE = { damage: 25, retail: 24, no_damage: 23 };
const TYPE_NAME = {
  damage: "Inspection Result Insurance PA",
  retail: "Inspection Result Back to Retail",
  no_damage: "Inspection Result No Damage",
};

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return cors(200, "");
  if (event.httpMethod !== "POST") return cors(405, JSON.stringify({ ok: false, error: "POST only" }));
  if (!SB_URL || !SB_KEY) return cors(500, JSON.stringify({ ok: false, error: "env missing" }));

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { return cors(400, JSON.stringify({ ok: false, error: "bad JSON" })); }
  const id = String(body.inspectionId || body.inspection_id || "").trim();
  if (!id) return cors(400, JSON.stringify({ ok: false, error: "inspectionId required" }));

  try {
    const insp = (await sbGet(`inspections?id=eq.${encodeURIComponent(id)}&select=result,review_availability,jn_job_id,client_name,sales_rep_id,original_sales_rep_id&limit=1`))[0];
    if (!insp) return cors(404, JSON.stringify({ ok: false, error: "inspection not found" }));

    const result = String(insp.result || "").trim();
    const rt = RECORD_TYPE[result];
    if (!rt) return cors(200, JSON.stringify({ ok: true, skipped: `result "${result || "none"}" has no result-task type` }));
    if (!insp.jn_job_id) return cors(200, JSON.stringify({ ok: true, skipped: "no JobNimbus job yet" }));
    if (!JN_KEY) return cors(200, JSON.stringify({ ok: true, skipped: "no JN key" }));

    // Don't put the rep in two places at once: collect the day+hour slots they
    // already have go-back appointments on, then pick the soonest FREE allowed day.
    const busy = await repBusySlots(insp.sales_rep_id || insp.original_sales_rep_id, id);
    const when = nextGoBackMs(insp.review_availability, busy);
    if (!when) return cors(200, JSON.stringify({ ok: true, skipped: `no usable go-back time in "${insp.review_availability || ""}"` }));

    // Idempotency (best-effort): skip if we already recorded a result task.
    const prior = await sbGetSafe(`inspections?id=eq.${encodeURIComponent(id)}&select=result_task_jnid&limit=1`);
    if (prior && prior[0] && prior[0].result_task_jnid) {
      return cors(200, JSON.stringify({ ok: true, skipped: "already created", task_id: prior[0].result_task_jnid }));
    }

    const startSec = Math.floor(when / 1000);
    const taskBody = {
      record_type: rt,
      record_type_name: TYPE_NAME[result],
      type: "task",
      title: `${TYPE_NAME[result]} — ${insp.client_name || "homeowner"}`,
      date_start: startSec,
      date_end: startSec + 3600,
      related: [{ id: insp.jn_job_id, type: "job" }],
    };
    if (insp.sales_rep_id) taskBody.owners = [{ id: insp.sales_rep_id }];

    const r = await fetch(`${JN_BASE}/tasks`, { method: "POST", headers: jnH, body: JSON.stringify(taskBody) });
    const txt = await r.text();
    if (!r.ok) return cors(502, JSON.stringify({ ok: false, error: `JN task ${r.status}: ${txt.slice(0, 200)}` }));
    let task = {}; try { task = JSON.parse(txt); } catch { /* */ }
    const taskId = task.jnid || task.id || null;

    // Record it for idempotency (tolerant — column may not exist yet).
    if (taskId) {
      fetch(`${SB_URL}/rest/v1/inspections?id=eq.${encodeURIComponent(id)}`, {
        method: "PATCH", headers: { ...sb, Prefer: "return=minimal" }, body: JSON.stringify({ result_task_jnid: taskId }),
      }).catch(() => {});
    }

    return cors(200, JSON.stringify({ ok: true, created: true, task_id: taskId, type: TYPE_NAME[result], when: new Date(when).toISOString() }));
  } catch (e) {
    return cors(500, JSON.stringify({ ok: false, error: e.message || "error" }));
  }
};

// "Wed · 5 PM" / "Thu, Fri, Sat · 2 PM" / "Any day · 2 PM" → ms of the soonest
// upcoming match (ET) at that hour, at least an hour out, that the rep ISN'T
// already booked on (busy = Set of "Y-M-D@hour"). Multi-day availabilities spread
// across days instead of stacking. If every free day is taken (rare), we fall
// back to the soonest match so the deal still gets a go-back. null if unparseable.
function nextGoBackMs(reviewAvail, busy = new Set()) {
  const s = String(reviewAvail || "");
  if (!s.includes(" · ")) return null;
  const [daysPart, timePart] = s.split(" · ").map((x) => x.trim());
  const tm = timePart.match(/(\d{1,2})\s*(AM|PM)/i);
  if (!tm) return null;
  let hour = parseInt(tm[1], 10) % 12;
  if (/pm/i.test(tm[2])) hour += 12;

  const WMAP = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
  let days;
  if (/any\s*day/i.test(daysPart)) days = [0, 1, 2, 3, 4, 5, 6];
  else {
    days = daysPart.split(",").map((d) => WMAP[d.trim().slice(0, 3).toLowerCase()]).filter((x) => x != null);
    if (!days.length) days = [0, 1, 2, 3, 4, 5, 6];
  }
  const now = Date.now();
  const pick = (avoid) => {
    for (let d = 0; d < 28; d++) {
      const { y, mo, day, weekday } = etParts(now + d * 864e5);
      if (!days.includes(weekday)) continue;
      if (avoid && busy.has(`${y}-${mo}-${day}@${hour}`)) continue;
      const ms = Date.parse(etToISO(y, mo, day, hour));
      if (ms > now + 60 * 60 * 1000) return ms;
    }
    return null;
  };
  return pick(true) || pick(false);
}
// The day+hour slots a rep already has go-back appointments on (future only),
// read from JobNimbus so we never double-book them. Few per rep → a few GETs.
async function repBusySlots(repId, excludeId) {
  const busy = new Set();
  if (!repId) return busy;
  const enc = encodeURIComponent;
  const rows = await sbGet(`inspections?or=(sales_rep_id.eq.${enc(repId)},original_sales_rep_id.eq.${enc(repId)})&result_task_jnid=not.is.null&cancelled_at=is.null&id=neq.${enc(excludeId)}&select=result_task_jnid`);
  const nowSec = Date.now() / 1000;
  for (const r of rows) {
    if (!r.result_task_jnid) continue;
    try {
      const resp = await fetch(`${JN_BASE}/tasks/${r.result_task_jnid}`, { headers: jnH });
      if (!resp.ok) continue;
      const t = await resp.json();
      const ds = Number(t.date_start);
      if (ds && ds > nowSec) busy.add(etSlotKey(ds * 1000));
    } catch { /* ignore */ }
  }
  return busy;
}
// "Y-M-D@hour" (ET) for an existing appointment's ms — must match the key built
// from etParts + target hour in nextGoBackMs.
function etSlotKey(ms) {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", hour12: false });
  const p = {}; for (const x of f.formatToParts(new Date(ms))) p[x.type] = x.value;
  return `${p.year}-${p.month}-${p.day}@${parseInt(p.hour, 10)}`;
}
function etParts(ms) {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "numeric", day: "numeric", weekday: "short" });
  const p = {}; for (const x of f.formatToParts(new Date(ms))) p[x.type] = x.value;
  const wmap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { y: +p.year, mo: +p.month, day: +p.day, weekday: wmap[p.weekday] };
}
function etToISO(y, mo, day, hour) {
  const guess = Date.UTC(y, mo - 1, day, hour, 0);
  const asEt = new Date(new Date(guess).toLocaleString("en-US", { timeZone: "America/New_York" }));
  return new Date(guess + (guess - asEt.getTime())).toISOString();
}
async function sbGet(path) { const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: sb }); if (!r.ok) return []; return r.json().catch(() => []); }
async function sbGetSafe(path) { try { const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: sb }); if (!r.ok) return null; return await r.json().catch(() => null); } catch { return null; } }
function cors(status, body) { return { statusCode: status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" }, body }; }
