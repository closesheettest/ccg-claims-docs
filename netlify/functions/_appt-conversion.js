// netlify/functions/_appt-conversion.js
//
// SHARED logic for the Appointments → Sales report (zone-appt-conversion +
// all-appt-conversion). Edit the rules HERE so the per-zone and company-wide
// views never drift apart.
//
// Two cohorts, anchored on DIFFERENT dates (so the numbers match what managers
// already trust):
//   • APPOINTMENTS = jobs with a real APPOINTMENT TASK (Initial / Reset /
//     Appointment) whose date is in the period. A free-inspection SIGNING has no
//     appointment task, so it never counts. Type buckets:
//        harv = "Sales Rep Harvested" = Yes · iq = source "Instant Quote" ·
//        btr = source "Inspection" (came from an inspection, now retail).
//   • SALES = deals whose SOLD DATE (cf_date_5) is in the period and are in a
//     sold status — the same number the sales leaderboard shows (a deal sold
//     this week counts even if its appointment was earlier or it had none).
//   Sales % = sales ÷ appointments (a weekly ratio). RB / Insulation = how many
//   of those SALES included each.

const JN_BASE = "https://app.jobnimbus.com/api1";

const APPT_TASK_TYPES = new Set(["Initial Appointment", "Reset Appointment", "Appointment"]);

// "Sold" pipeline statuses (normalized) + their exact JN status_name spellings.
const SOLD_STATUSES = new Set([
  "sit sold", "signed contract", "production review", "job prep",
  "in funding", "waiting on pace", "upcoming installs", "install set",
  "roof started", "new roof", "paid closed", "upcoming commissions",
]);
const SOLD_STATUS_NAMES = [
  "Sit - Sold", "Signed Contract", "Production Review", "Job Prep",
  "In Funding", "Waiting on PACE", "Upcoming Installs", "Install Set",
  "Roof Started", "New Roof", "Paid & Closed", "Upcoming Commissions",
];

function isYes(v) { return v === true || v === "true" || v === "Yes" || v === "yes" || v === 1; }
function fieldMap(job) {
  const m = {};
  for (const [k, v] of Object.entries(job)) {
    m[k.trim()] = v;
    const bare = k.trim().replace(/^\*|\*$/g, "").trim();
    if (!(bare in m)) m[bare] = v;
  }
  return m;
}
function soldDateSec(job) {
  const v = job["Sold Date"] != null ? job["Sold Date"] : job.cf_date_5;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// APPOINTMENTS: jobs with an appointment task whose date_start is in the window.
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
  return fetchJobsByIds(headers, [...jobIds]);
}

async function fetchJobsByIds(headers, ids) {
  const byId = new Map();
  for (let i = 0; i < ids.length; i += 100) {
    const jobFilter = encodeURIComponent(JSON.stringify({ must: [{ terms: { jnid: ids.slice(i, i + 100) } }] }));
    const r = await fetch(`${JN_BASE}/jobs?size=100&filter=${jobFilter}`, { headers });
    if (!r.ok) continue;
    const d = await r.json().catch(() => ({}));
    for (const j of (d.results || d.jobs || d.data || [])) byId.set(j.jnid || j.id, j);
  }
  return [...byId.values()];
}

// SALES: jobs in a sold status whose Sold Date is in the window (same rule as
// zone-sales-leaderboard). Pulled by sold status_name to dodge the scan cap.
async function fetchSoldJobs(jnKey, startSec, endSec) {
  const headers = { Authorization: `bearer ${jnKey}`, "Content-Type": "application/json" };
  const since = startSec - 2 * 24 * 60 * 60;
  const byId = new Map();
  for (const name of SOLD_STATUS_NAMES) {
    const filter = encodeURIComponent(JSON.stringify({ must: [{ match_phrase: { status_name: name } }] }));
    for (let page = 0; page < 20; page++) {
      const r = await fetch(`${JN_BASE}/jobs?size=100&from=${page * 100}&sort=-date_updated&date_updated_after=${since}&filter=${filter}`, { headers });
      if (!r.ok) break;
      const d = await r.json().catch(() => ({}));
      const rows = d.results || d.jobs || [];
      for (const j of rows) byId.set(j.jnid || j.id, j);
      if (rows.length < 100) break;
    }
  }
  return [...byId.values()].filter((j) => {
    const sd = soldDateSec(j);
    if (sd == null || sd < startSec || sd > endSec) return false;
    const status = String(j.status_name || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    return SOLD_STATUSES.has(status);
  });
}

function newRep(rep) { return { rep, appts: 0, harv: 0, iq: 0, btr: 0, sales: 0, rb: 0, ins: 0 }; }

// An appointment that happened in the period (+ its type buckets).
function tallyAppt(rec, job) {
  rec.appts++;
  const F = fieldMap(job);
  const src = String(job.source_name || "");
  if (isYes(F["Sales Rep Harvested"])) rec.harv++;
  if (src === "Instant Quote") rec.iq++;
  if (src === "Inspection") rec.btr++;
}

// A sale that closed in the period (+ Radiant Barrier / Insulation attach).
function tallySold(rec, job) {
  rec.sales++;
  const F = fieldMap(job);
  if (isYes(F["Radiant Barrier"])) rec.rb++;
  if (isYes(F["Insulation"])) rec.ins++;
}

function pct(n, d) { return d > 0 ? Math.round((n / d) * 100) : 0; }
function shapeRep(r) {
  return {
    rep: r.rep, appts: r.appts, harv: r.harv, iq: r.iq, btr: r.btr,
    sales: r.sales, pct: pct(r.sales, r.appts),
    rb: r.rb, rb_pct: pct(r.rb, r.sales), ins: r.ins, ins_pct: pct(r.ins, r.sales),
  };
}
function sumTotals(reps) {
  const t = reps.reduce((s, r) => ({
    appts: s.appts + r.appts, harv: s.harv + r.harv, iq: s.iq + r.iq, btr: s.btr + r.btr,
    sales: s.sales + r.sales, rb: s.rb + r.rb, ins: s.ins + r.ins,
  }), { appts: 0, harv: 0, iq: 0, btr: 0, sales: 0, rb: 0, ins: 0 });
  return { ...t, pct: pct(t.sales, t.appts), rb_pct: pct(t.rb, t.sales), ins_pct: pct(t.ins, t.sales) };
}

export { fetchApptJobs, fetchSoldJobs, newRep, tallyAppt, tallySold, shapeRep, sumTotals, pct };
