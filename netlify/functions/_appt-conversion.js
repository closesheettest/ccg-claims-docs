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
function normStatus(s) { return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(); }

// A deal that already SOLD, then later had an appointment task put in, should NOT
// count that later appointment (it's a post-sale reschedule/follow-up, e.g. an
// already-sold deal getting a 6/19 task when it sold 6/1) — UNLESS the job is
// genuinely re-appointed (status "Appointment Scheduled" / "Reset Appointment").
const ACTIVE_APPT_STATUSES = new Set(["appointment scheduled", "reset appointment"]);
function isStaleAppt(job, apptDateSec) {
  const sold = soldDateSec(job);
  if (sold == null) return false;                       // never sold → a real appointment
  const ad = Number(apptDateSec);
  if (!Number.isFinite(ad) || sold >= ad) return false; // appt at/before the sale → it's the original sit
  return !ACTIVE_APPT_STATUSES.has(normStatus(job.status_name)); // sold-then-later-appt → stale unless re-appointed
}
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

// APPOINTMENTS: jobs with an appointment task whose date is in the window. We
// keep the EARLIEST in-window appt date per job so isStaleAppt() can drop a
// post-sale reschedule (appt put in after the deal already sold).
async function fetchApptJobs(jnKey, startSec, endSec) {
  const headers = { Authorization: `bearer ${jnKey}`, "Content-Type": "application/json" };
  const apptDateById = new Map(); // jobId -> earliest in-window appt task date (sec)
  const taskFilter = encodeURIComponent(JSON.stringify({ must: [{ range: { date_start: { gte: startSec, lte: endSec } } }] }));
  for (let page = 0; page < 40; page++) {
    const r = await fetch(`${JN_BASE}/tasks?size=100&from=${page * 100}&filter=${taskFilter}`, { headers });
    if (!r.ok) break;
    const d = await r.json().catch(() => ({}));
    const rows = d.results || d.tasks || d.data || [];
    for (const t of rows) {
      if (!APPT_TASK_TYPES.has(t.record_type_name)) continue;
      const td = Number(t.date_start) || 0;
      for (const rel of (t.related || [])) {
        if (rel.type !== "job" || !rel.id) continue;
        const prev = apptDateById.get(rel.id);
        if (prev == null || td < prev) apptDateById.set(rel.id, td);
      }
    }
    if (rows.length < 100) break;
  }
  const jobs = await fetchJobsByIds(headers, [...apptDateById.keys()]);
  return jobs.filter((j) => {
    const ad = apptDateById.get(j.jnid || j.id);
    j.__apptDate = ad;
    return !isStaleAppt(j, ad);   // drop post-sale reschedules (unless re-appointed)
  });
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

// Mutually-exclusive appointment category (so harv + comp + btr = total):
//   btr  = source "Inspection"        → came from a free inspection, now retail
//   harv = "Sales Rep Harvested" = Yes → harvested / canvassed appointment
//   comp = everything else            → company-provided lead (IQ, AI Bot, FB…)
function categoryOf(job) {
  if (String(job.source_name || "") === "Inspection") return "btr";
  if (isYes(fieldMap(job)["Sales Rep Harvested"])) return "harv";
  return "comp";
}
// Dollar value of a sold deal (approved estimate / invoice / budget revenue).
function saleAmount(job) {
  return Math.max(Number(job.approved_estimate_total) || 0, Number(job.approved_invoice_total) || 0, Number(job.last_budget_revenue) || 0);
}

// unix seconds → "M/D/YYYY" (ET), or "" when unset.
function fmtDate(sec) {
  const n = Number(sec);
  if (!Number.isFinite(n) || n <= 0) return "";
  try { return new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "numeric", day: "numeric", year: "numeric" }).format(new Date(n * 1000)); }
  catch { return ""; }
}

// Customer / address / status (+ sold & start dates) for the drill-down rows.
function dealInfo(job) {
  return {
    customer: (job.primary && job.primary.name) || job.name || "—",
    address: [job.address_line1, job.city].filter(Boolean).join(", "),
    status: job.status_name || "",
    sold: fmtDate(job.cf_date_5 != null ? job.cf_date_5 : job["Sold Date"]),
    start: fmtDate(job.date_start),
  };
}

function newRep(rep) {
  return { rep, level: "", appts: 0, harvAp: 0, compAp: 0, btrAp: 0, sales: 0, harvSl: 0, compSl: 0, btrSl: 0, harvAmt: 0, compAmt: 0, btrAmt: 0, amt: 0, rb: 0, ins: 0, details: [] };
}

// TMS rep_level → short badge. "" when unknown (rep_level not set).
function levelLabel(repLevel) {
  const v = String(repLevel || "").toLowerCase();
  if (v === "senior") return "SR";
  if (v === "junior") return "JR";
  return "";
}

// An appointment that happened in the period (bucketed by category).
function tallyAppt(rec, job) {
  const cat = categoryOf(job);
  rec.appts++;
  rec[cat + "Ap"]++;
  rec.details.push({ kind: "appt", cat, ...dealInfo(job) });   // drill-down detail
}

// A sale that closed in the period — bucketed by category, with its $ amount
// (for avg $/sale) and Radiant Barrier / Insulation attach.
function tallySold(rec, job) {
  rec.sales++;
  const cat = categoryOf(job);
  const amt = saleAmount(job);
  rec[cat + "Sl"]++;          // count (used for the per-bucket conversion %)
  rec[cat + "Amt"] += amt;    // $ value of this bucket's sales
  rec.amt += amt;
  const F = fieldMap(job);
  if (isYes(F["Radiant Barrier"])) rec.rb++;
  if (isYes(F["Insulation"])) rec.ins++;
  rec.details.push({ kind: "sale", cat, amt: Math.round(amt), ...dealInfo(job) });   // drill-down detail
}

function pct(n, d) { return d > 0 ? Math.round((n / d) * 100) : 0; }
function shapeRep(r) {
  return {
    rep: r.rep, level: r.level || "",
    harvAp: r.harvAp, compAp: r.compAp, btrAp: r.btrAp, appts: r.appts,
    harvSl: r.harvSl, compSl: r.compSl, btrSl: r.btrSl, sales: r.sales,
    harvAmt: Math.round(r.harvAmt), compAmt: Math.round(r.compAmt), btrAmt: Math.round(r.btrAmt),
    harvPct: pct(r.harvSl, r.harvAp), compPct: pct(r.compSl, r.compAp), btrPct: pct(r.btrSl, r.btrAp), pct: pct(r.sales, r.appts),
    amt: Math.round(r.amt),
    avg: r.sales > 0 ? Math.round(r.amt / r.sales) : 0,
    rb: r.rb, rb_pct: pct(r.rb, r.sales), ins: r.ins, ins_pct: pct(r.ins, r.sales),
    details: r.details || [],
  };
}
function sumTotals(reps) {
  const t = reps.reduce((s, r) => ({
    appts: s.appts + r.appts, harvAp: s.harvAp + r.harvAp, compAp: s.compAp + r.compAp, btrAp: s.btrAp + r.btrAp,
    sales: s.sales + r.sales, harvSl: s.harvSl + r.harvSl, compSl: s.compSl + r.compSl, btrSl: s.btrSl + r.btrSl,
    harvAmt: s.harvAmt + r.harvAmt, compAmt: s.compAmt + r.compAmt, btrAmt: s.btrAmt + r.btrAmt,
    amt: s.amt + r.amt, rb: s.rb + r.rb, ins: s.ins + r.ins,
  }), { appts: 0, harvAp: 0, compAp: 0, btrAp: 0, sales: 0, harvSl: 0, compSl: 0, btrSl: 0, harvAmt: 0, compAmt: 0, btrAmt: 0, amt: 0, rb: 0, ins: 0 });
  return {
    ...t,
    harvAmt: Math.round(t.harvAmt), compAmt: Math.round(t.compAmt), btrAmt: Math.round(t.btrAmt),
    harvPct: pct(t.harvSl, t.harvAp), compPct: pct(t.compSl, t.compAp), btrPct: pct(t.btrSl, t.btrAp), pct: pct(t.sales, t.appts),
    amt: Math.round(t.amt),
    avg: t.sales > 0 ? Math.round(t.amt / t.sales) : 0,
    rb_pct: pct(t.rb, t.sales), ins_pct: pct(t.ins, t.sales),
  };
}

export { fetchApptJobs, fetchSoldJobs, newRep, tallyAppt, tallySold, shapeRep, sumTotals, pct, levelLabel };
