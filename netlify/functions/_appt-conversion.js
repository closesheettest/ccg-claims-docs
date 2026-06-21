// netlify/functions/_appt-conversion.js
//
// SHARED logic for the Appointments → Sales report (zone-appt-conversion +
// all-appt-conversion). Edit the rules HERE so the per-zone and company-wide
// views never drift apart.
//
// An "appointment" = a JN job that has an APPOINTMENT TASK (Initial Appointment
// / Reset Appointment / Appointment) whose date_start falls in the period. This
// is the real signal a rep actually ran an appointment — a free-inspection
// SIGNING has no appointment task, so it never counts (fixes the inspection
// trainer showing up); a back-to-retail lead DOES count the moment a real
// appointment task is booked on it, whatever its record type.

const JN_BASE = "https://app.jobnimbus.com/api1";

// JN task record_type_name values that represent a real appointment.
const APPT_TASK_TYPES = new Set(["Initial Appointment", "Reset Appointment", "Appointment"]);

// "Sold" pipeline statuses (normalized), same set the sales leaderboard counts.
const SOLD_STATUSES = new Set([
  "sit sold", "signed contract", "production review", "job prep",
  "in funding", "waiting on pace", "upcoming installs", "install set",
  "roof started", "new roof", "paid closed", "upcoming commissions",
]);

// JN boolean toggles: ON shows as true / "true" / "Yes" / 1.
function isYes(v) { return v === true || v === "true" || v === "Yes" || v === "yes" || v === 1; }

// JN echoes friendly labels as keys, sometimes with trailing spaces / *…*.
function fieldMap(job) {
  const m = {};
  for (const [k, v] of Object.entries(job)) {
    m[k.trim()] = v;
    const bare = k.trim().replace(/^\*|\*$/g, "").trim();
    if (!(bare in m)) m[bare] = v;
  }
  return m;
}

// Jobs that had an APPOINTMENT TASK in [startSec, endSec]. Two steps:
//   1. pull appointment-type tasks whose date_start is in the window → the
//      unique set of related job ids (one job = one appointment, even if it has
//      both an Initial and a Reset appointment).
//   2. batch-fetch those jobs (terms:jnid) for status / rep / RB / Insulation.
async function fetchApptJobs(jnKey, startSec, endSec) {
  const headers = { Authorization: `bearer ${jnKey}`, "Content-Type": "application/json" };
  const jobIds = new Set();
  const taskFilter = encodeURIComponent(JSON.stringify({ must: [{ range: { date_start: { gte: startSec, lte: endSec } } }] }));
  for (let page = 0; page < 40; page++) {
    const r = await fetch(`${JN_BASE}/tasks?size=100&from=${page * 100}&filter=${taskFilter}`, { headers });
    if (!r.ok) break;
    const d = await r.json().catch(() => ({}));
    const rows = d.results || d.tasks || d.data || [];
    for (const t of rows) {
      if (!APPT_TASK_TYPES.has(t.record_type_name)) continue;
      for (const rel of (t.related || [])) if (rel.type === "job" && rel.id) jobIds.add(rel.id);
    }
    if (rows.length < 100) break;
  }

  const ids = [...jobIds];
  const byId = new Map();
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const jobFilter = encodeURIComponent(JSON.stringify({ must: [{ terms: { jnid: chunk } }] }));
    const r = await fetch(`${JN_BASE}/jobs?size=100&filter=${jobFilter}`, { headers });
    if (!r.ok) continue;
    const d = await r.json().catch(() => ({}));
    for (const j of (d.results || d.jobs || d.data || [])) byId.set(j.jnid || j.id, j);
  }
  return [...byId.values()];
}

// Tally one appointment job into a per-rep accumulator { appts, sales, rb, ins }.
function tallyJob(rec, job) {
  rec.appts++;
  const status = String(job.status_name || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  if (SOLD_STATUSES.has(status)) {
    rec.sales++;
    const F = fieldMap(job);
    if (isYes(F["Radiant Barrier"])) rec.rb++;
    if (isYes(F["Insulation"])) rec.ins++;
  }
}

function pct(n, d) { return d > 0 ? Math.round((n / d) * 100) : 0; }
function shapeRep(r) {
  return { rep: r.rep, appts: r.appts, sales: r.sales, pct: pct(r.sales, r.appts), rb: r.rb, rb_pct: pct(r.rb, r.sales), ins: r.ins, ins_pct: pct(r.ins, r.sales) };
}
function sumTotals(reps) {
  const t = reps.reduce((s, r) => ({ appts: s.appts + r.appts, sales: s.sales + r.sales, rb: s.rb + r.rb, ins: s.ins + r.ins }), { appts: 0, sales: 0, rb: 0, ins: 0 });
  return { ...t, pct: pct(t.sales, t.appts), rb_pct: pct(t.rb, t.sales), ins_pct: pct(t.ins, t.sales) };
}

export { fetchApptJobs, tallyJob, shapeRep, sumTotals, pct };
