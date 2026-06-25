// netlify/functions/_appt-conversion.js
//
// SHARED logic for the Appointments → Sales report (zone-appt-conversion +
// all-appt-conversion). Edit the rules HERE so the per-zone and company-wide
// views never drift apart.
//
// APPOINTMENTS (the denominator) = SOLD deals + UNSOLD appointments:
//   • A SOLD deal (sold status, SOLD DATE / cf_date_5 in the period) counts as
//     ONE appointment AND one sale, in its Sold-Date week. We do NOT use its own
//     appointment task for timing — in JN, sold deals carry post-sale tasks
//     ("collect payment", reschedules) dated AFTER the sale, which would mis-date
//     or inflate things. A sale implies an appointment happened, so sold = 1+1.
//   • An UNSOLD job with a real APPOINTMENT TASK (Initial / Reset / Appointment)
//     counts as one appointment, in the week of its LATEST appt task (the actual
//     sit) — never an earlier no-show/original, so an original + reschedule of
//     the SAME opportunity counts once, not in two periods. A free-inspection
//     SIGNING has no appointment task, so it never counts.
//   • A "no-sit reschedule" deal (status "No Sit- Need to Reschedule" / "No Sit
//     - Rescheduled") NEVER PRESENTED, so it does not count against closing %.
//     It counts later, in the week it actually re-sits (status moves off these).
//   • A LOST/cancelled deal (status starts "Lost") is dead — it does not count
//     as an appointment (and so is never flagged). If it sold then cancelled,
//     the sale was already credited on its sold week; a loss isn't a new appt.
//   • isStaleAppt() also drops a task on a deal that already sold in a PRIOR
//     period (e.g. an Install-Complete job getting a new task) unless it's
//     genuinely re-appointed (status "Appointment Scheduled" / "Reset Appointment").
//   Type buckets (mutually exclusive): btr = source "Inspection" · harv =
//   "Sales Rep Harvested" = Yes · comp = everything else.
//   Sales % = sales ÷ appointments (always ≤ 100% now — every sale is also an
//   appointment). RB / Insulation = how many of those SALES included each.

const JN_BASE = "https://app.jobnimbus.com/api1";

const APPT_TASK_TYPES = new Set(["Initial Appointment", "Reset Appointment", "Appointment"]);

// "Sold" pipeline statuses (normalized) + their exact JN status_name spellings.
const SOLD_STATUSES = new Set([
  "sit sold", "signed contract", "production review", "job prep",
  "in funding", "waiting on pace", "upcoming installs", "install set",
  "roof started", "new roof", "paid closed", "upcoming commissions",
  "holds", "extras",   // special sold statuses — deal on Hold / add-on Extras
]);
const SOLD_STATUS_NAMES = [
  "Sit - Sold", "Signed Contract", "Production Review", "Job Prep",
  "In Funding", "Waiting on PACE", "Upcoming Installs", "Install Set",
  "Roof Started", "New Roof", "Paid & Closed", "Upcoming Commissions",
  "Holds", "Extras",
];

function isYes(v) { return v === true || v === "true" || v === "Yes" || v === "yes" || v === 1; }
function normStatus(s) { return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(); }

// A deal that already SOLD, then later had an appointment task put in, should NOT
// count that later appointment (it's a post-sale reschedule/follow-up, e.g. an
// already-sold deal getting a 6/19 task when it sold 6/1) — UNLESS the job is
// genuinely re-appointed (status "Appointment Scheduled" / "Reset Appointment").
const ACTIVE_APPT_STATUSES = new Set(["appointment scheduled", "reset appointment"]);
function isStaleAppt(job, apptDateSec) {
  // A "post-sale leftover" appt only applies to a deal that's CURRENTLY in a sold
  // status. A back-to-retail re-sit carries an OLD inspection Sold Date (cf_date_5
  // = the original free-inspection sit) but is NOT sold now (e.g. "Sit - No Sale"),
  // so its new appointment is REAL — the old date must not make it look stale.
  // (This was silently dropping every re-worked inspection deal whose new appt fell
  // after its original inspection sit — the reason back-to-retail BTR counts were 0.)
  if (!SOLD_STATUSES.has(normStatus(job.status_name))) return false;
  const sold = soldDateSec(job);
  if (sold == null) return false;                       // never sold → a real appointment
  const ad = Number(apptDateSec);
  if (!Number.isFinite(ad) || sold >= ad) return false; // appt at/before the sale → it's the original sit
  return !ACTIVE_APPT_STATUSES.has(normStatus(job.status_name)); // sold-then-later-appt → stale unless re-appointed
}

// "No-sit reschedule" statuses: the rep NEVER PRESENTED (no-showed / homeowner
// pushed it), so these do NOT count as appointments against closing %. They
// count later, in the week the deal actually re-sits (status moves off these).
// Exact JN status_name spellings mirror all-no-sits.js.
const NO_SIT_RESCHEDULE_STATUSES = new Set(["no sit need to reschedule", "no sit rescheduled"]);
function isNoSitReschedule(job) { return NO_SIT_RESCHEDULE_STATUSES.has(normStatus(job.status_name)); }
// A LOST deal is dead — it does NOT count as an appointment (and so never gets
// flagged either, since the flag only runs on counted rows). If it had sold then
// cancelled, the sale was already credited in its sold week; a later loss isn't a
// new appointment, so we simply stop counting it.
function isLost(job) { return normStatus(job.status_name).startsWith("lost"); }
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

// Appointment-task metadata: per job, the EARLIEST in-window appt date, the
// LATEST appt date up to now (so we can count a reschedule in its actual-sit
// week, never an earlier no-show), whether an in-window task was a Reset, and
// the SET of who created the appt tasks (for "harvested" — a rep who created
// the appointment task self-generated it).
async function fetchApptTaskMeta(jnKey, startSec, endSec) {
  const headers = { Authorization: `bearer ${jnKey}`, "Content-Type": "application/json" };
  const meta = new Map(); // jobId -> { date, latest, creators:Set, resetInWindow, inWindow }
  // Scan from the window start through NOW — not just endSec — so a LATER reset
  // of an in-window appointment is visible. A reset deal counts only in the week
  // of its LATEST appt task (the real sit), so one opportunity never counts twice.
  const nowSec = Math.floor(Date.now() / 1000);
  const scanEnd = Math.max(endSec, nowSec);
  const taskFilter = encodeURIComponent(JSON.stringify({ must: [{ range: { date_start: { gte: startSec, lte: scanEnd } } }] }));
  for (let page = 0; page < 40; page++) {
    const r = await fetch(`${JN_BASE}/tasks?size=100&from=${page * 100}&filter=${taskFilter}`, { headers });
    if (!r.ok) break;
    const d = await r.json().catch(() => ({}));
    const rows = d.results || d.tasks || d.data || [];
    for (const t of rows) {
      if (!APPT_TASK_TYPES.has(t.record_type_name)) continue;
      const td = Number(t.date_start) || 0;
      const inWindow = td >= startSec && td <= endSec;
      const isReset = t.record_type_name === "Reset Appointment";
      const by = t.created_by ? String(t.created_by) : null;
      for (const rel of (t.related || [])) {
        if (rel.type !== "job" || !rel.id) continue;
        let m = meta.get(rel.id);
        if (!m) { m = { date: 0, latest: 0, creators: new Set(), resetInWindow: false, inWindow: false }; meta.set(rel.id, m); }
        if (td > m.latest) m.latest = td;
        if (by) m.creators.add(by);
        if (inWindow) {
          m.inWindow = true;
          if (td && (!m.date || td < m.date)) m.date = td;
          if (isReset) m.resetInWindow = true;
        }
      }
    }
    if (rows.length < 100) break;
  }
  return meta;
}

// APPOINTMENTS: jobs counted in the week of their LATEST appt task (the actual
// sit). Drops: a post-sale reschedule (isStaleAppt), an opportunity whose latest
// appt is in a LATER week (it counts there, not here — no double-count), and a
// "no-sit reschedule" deal that never presented (it counts when it re-sits).
async function fetchApptJobs(jnKey, startSec, endSec, taskMeta) {
  const headers = { Authorization: `bearer ${jnKey}`, "Content-Type": "application/json" };
  const meta = taskMeta || await fetchApptTaskMeta(jnKey, startSec, endSec);
  const jobs = await fetchJobsByIds(headers, [...meta.keys()]);
  return jobs.filter((j) => {
    const m = meta.get(j.jnid || j.id);
    if (!m) return false;
    // Count the deal once, in the week of its LATEST appt task — never an
    // earlier no-show/original. If the latest task is outside this window, it
    // belongs to that (later) week's count, so skip it here.
    if (!(m.latest >= startSec && m.latest <= endSec)) return false;
    j.__apptDate = m.latest;
    j.__apptTaskCreators = [...m.creators];
    j.__isReset = m.resetInWindow;
    // Never PRESENTED → not an appointment. The no-show/reschedule doesn't count
    // against closing %; the deal counts later, in the week it actually re-sits.
    if (isNoSitReschedule(j)) return false;
    // LOST/cancelled deal → dead, don't count it (and so it's not flagged either).
    if (isLost(j)) return false;
    return !isStaleAppt(j, j.__apptDate);
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
//   btr  = back to retail: inspection RESULT = retail (taken back out to sell a
//          retail roof). Also a free-inspection source deal whose result is NOT
//          damage/no-damage (legacy/unknown). Overrides harv/comp. A Damage /
//          No-Damage deal is NOT auto-BTR — it stays Co/Harv (and gets the
//          "move to Retail location" flag if it sells).
//   harv = the SALES REP self-generated it: the rep created the JOB
//          (created_by === the rep) OR created the appointment TASK. If anyone
//          else created both (office/intake/etc.), it's not harvested.
//   comp = everything else      → company-provided lead (created by the office).
// job.__result is the inspections.result (damage|no_damage|retail), stamped on
// each job before tallying.
function categoryOf(job) {
  const result = String(job.__result || "");
  if (result === "retail" || (result !== "damage" && result !== "no_damage" && String(job.source_name || "") === "Inspection")) return "btr";
  const repId = job.__repId || job.sales_rep;
  if (repId) {
    const rid = String(repId);
    if (job.created_by && String(job.created_by) === rid) return "harv";          // rep created the job
    if (Array.isArray(job.__apptTaskCreators) && job.__apptTaskCreators.includes(rid)) return "harv"; // rep created the appt task
  }
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

// Customer / address / status (+ appt, sold & start dates) for the drill-down
// rows. apptDate = the date that PUT this on the report: the appointment task
// date for an unsold job, or the Sold Date for a sold deal (which we count as an
// appointment in its sold week). "start" is JN's own date_start field, shown for
// reference only — it does NOT drive the report.
function dealInfo(job) {
  const apptSec = Number(job.__apptDate) > 0 ? job.__apptDate : soldDateSec(job);
  const F = fieldMap(job);
  return {
    jnid: job.jnid || job.id,                          // for joining roof_pitch
    customer: (job.primary && job.primary.name) || job.name || "—",
    address: [job.address_line1, job.city].filter(Boolean).join(", "),
    status: job.status_name || "",
    source: job.source_name || "",         // JN lead source

    apptDate: fmtDate(apptSec),
    sold: fmtDate(soldDateSec(job)),
    start: fmtDate(job.date_start),
    rb: isYes(F["Radiant Barrier"]),         // Radiant Barrier on the deal?
    ins: isYes(F["Insulation"]),             // Insulation on the deal?
    fromAssigned: !!job.__repFromAssigned,   // rep came from Assigned field, not Sales Rep
    isReset: !!job.__isReset,                 // counted appt was a Reset Appointment (a re-sit/follow-up)
    result: job.__result || null,             // inspections.result (damage|no_damage|retail), for the retail-loc flag
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

// Roof pitch (from the roof_pitch cache, filled by cron-extract-pitch) →
// attach onto each sold deal's drill-down detail by jnid.
async function fetchPitchMap(jnids) {
  const SB_URL = process.env.VITE_SUPABASE_URL, SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
  const ids = [...new Set((jnids || []).filter(Boolean))];
  if (!SB_URL || !SB_KEY || !ids.length) return {};
  const headers = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` };
  const map = {};
  for (let i = 0; i < ids.length; i += 150) {
    const chunk = ids.slice(i, i + 150).map((x) => `"${x}"`).join(",");
    const url = `${SB_URL}/rest/v1/roof_pitch?select=jnid,pitch,status&jnid=in.(${encodeURIComponent(chunk)})`;
    try { const r = await fetch(url, { headers }); if (r.ok) for (const row of await r.json()) map[row.jnid] = { pitch: row.pitch, status: row.status }; }
    catch { /* report still works without pitch */ }
  }
  return map;
}
// Attach pitch + Roofr status to every detail row of every rep, keyed by jnid.
function attachPitch(reps, map) {
  for (const r of reps) for (const d of (r.details || [])) {
    const e = d.jnid && map[d.jnid];
    if (e) { if (e.pitch) d.pitch = e.pitch; d.roofrStatus = e.status; }
  }
}

// Inspection RESULT (damage | no_damage | retail) from our own inspections
// table, keyed by the JN job id. The reliable source of truth (vs guessing a JN
// custom-field label) — used to flag a sold Damage/No-Damage deal that's still
// sitting in the Insurance location (it should be moved to Retail in JN).
async function fetchResultMap(jnids) {
  const SB_URL = process.env.VITE_SUPABASE_URL, SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
  const ids = [...new Set((jnids || []).filter(Boolean))];
  if (!SB_URL || !SB_KEY || !ids.length) return {};
  const headers = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` };
  const map = {};
  for (let i = 0; i < ids.length; i += 150) {
    const chunk = ids.slice(i, i + 150).map((x) => `"${x}"`).join(",");
    const url = `${SB_URL}/rest/v1/inspections?select=jn_job_id,result&jn_job_id=in.(${encodeURIComponent(chunk)})`;
    try { const r = await fetch(url, { headers }); if (r.ok) for (const row of await r.json()) if (row.jn_job_id) map[row.jn_job_id] = row.result || null; }
    catch { /* report still works without the result */ }
  }
  return map;
}
// Attach the inspection result to every detail row, keyed by jnid (= JN job id).
function attachResult(reps, map) {
  for (const r of reps) for (const d of (r.details || [])) {
    if (d.jnid && map[d.jnid]) d.result = map[d.jnid];
  }
}

export { fetchApptTaskMeta, fetchApptJobs, fetchSoldJobs, newRep, tallyAppt, tallySold, shapeRep, sumTotals, pct, levelLabel, fetchPitchMap, attachPitch, fetchResultMap, attachResult };
