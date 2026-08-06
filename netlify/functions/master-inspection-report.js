// netlify/functions/master-inspection-report.js
//
// The MASTER INSPECTION REPORT — one call, everything about the free-roof-inspection
// pipeline, computed straight from Supabase (inspections + pa_appointments + pas +
// pa_companies). No live JobNimbus needed: jn_status, retail_outcome and the PA
// milestone fields are already mirrored onto the inspections row.
//
//   GET /.netlify/functions/master-inspection-report
//   → { ok, generated_at, counts, needs_inspection[], needs_goback_status[],
//       retail{total,buckets,pct,deals[]}, damage{with_appt[],needs_appt[]},
//       pa_passed[], missed_pa[] }
//
// Env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY

const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const sbH = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" };
const TMS_REP_ZONES_URL = "https://trainingmanagementsys.netlify.app/.netlify/functions/rep-zones?include_inactive=1";

// Rep → zone map (same normalization as the leaderboards) so non-PA sections can
// group by team/zone then rep.
function normalizeName(s) {
  return String(s || "").toLowerCase()
    .replace(/["“”]([^"“”]*)["“”]/g, "").replace(/'([^']*)'/g, "").replace(/\(([^)]*)\)/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
}
async function fetchZoneByRep() {
  const map = {};
  try {
    const res = await fetch(TMS_REP_ZONES_URL);
    if (res.ok) { const j = await res.json(); for (const r of (j.reps || [])) if (r.name && r.zone) map[normalizeName(r.name)] = r.zone; }
  } catch { /* best-effort — reps with no zone bucket under "Unassigned" */ }
  return map;
}

// Range-paginate a PostgREST table (max-rows caps a single response at 1000).
async function sbGetAll(pathQuery, pageSize = 1000) {
  const out = [];
  for (let from = 0; ; from += pageSize) {
    const r = await fetch(`${SB_URL}/rest/v1/${pathQuery}`, {
      headers: { ...sbH, "Range-Unit": "items", Range: `${from}-${from + pageSize - 1}` },
    });
    if (!r.ok) break;
    const batch = await r.json().catch(() => []);
    if (!Array.isArray(batch) || !batch.length) break;
    out.push(...batch);
    if (batch.length < pageSize) break;
  }
  return out;
}

const isYes = (v) => v === true || v === "true" || v === "Yes" || v === "yes";
// Epoch-seconds (JN cf_date) or ISO → ISO date string, else null.
function toISO(v) {
  if (v == null || v === "") return null;
  if (typeof v === "number" || /^\d+$/.test(String(v))) { const n = Number(v); return n > 0 ? new Date((n < 1e12 ? n * 1000 : n)).toISOString() : null; }
  const d = new Date(v); return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
function paFields(row) { const f = row.pa_fields; if (!f) return {}; if (typeof f === "string") { try { return JSON.parse(f); } catch { return {}; } } return f; }

// The homeowner's real sign outcome — derived from the inspection, not the appt row
// (the appt.status often stays "scheduled" even after they sign or refuse).
function paOutcome(insp) {
  const f = paFields(insp);
  const signup = String(f.pa_signup || "").toLowerCase();
  // A PA who signs the homeowner DIRECTLY in JobNimbus (never touching our app)
  // leaves no pa_signed_at/pa_status — only a won JN status. Treat that as signed too,
  // so a signed claim can never leak into the "needs appointment" bucket.
  const jnSigned = /sitsold pa|signed contract|production review|job prep|funding|pace|upcoming install|install|new roof|paid|collection/i.test(String(insp.jn_status || ""));
  if (insp.pa_signed_at || insp.pa_status === "signed" || signup.startsWith("signed") || jnSigned) return "signed";
  if (insp.pa_status === "refused" || signup.includes("refus") || signup.includes("retail")) return "refused";
  return "pending"; // no outcome recorded yet
}

// The last few PA notes (newest first, deduped) — the human story behind the deal:
// why it refused, what happened at the appointment, whether it's waiting on docs, etc.
function recentNotes(insp) {
  let log = insp.pa_notes_log;
  if (typeof log === "string") { try { log = JSON.parse(log); } catch { log = []; } }
  if (!Array.isArray(log)) return [];
  const out = [], seen = new Set();
  for (const e of log.slice().reverse()) {
    const text = String((e && e.text) || "").trim();
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue; // drop the duplicate "stage" echoes the pipeline logs
    seen.add(key);
    out.push({ text: text.slice(0, 240), stage: (e && e.stage) || null, at: (e && e.at) || null });
    if (out.length >= 4) break;
  }
  return out;
}

// The REAL BTR pipeline stage from the live JobNimbus status (falls back to the
// coarse retail_outcome when status is blank). This is the true pipeline the office
// works — Sit-Pending, No-Sit, Credit Denial, etc. are all distinct now.
function retailNorm(s) { return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(); }
function retailStage(status, outcome) {
  const s = retailNorm(status);
  if (s) {
    if (s.includes("sit sold insp")) {
      // "Sit Sold Insp" is the STARTING pool status — the office often never moves the
      // JN status off it even after the rep records a retail outcome. So when a local
      // outcome IS recorded, trust that over the stale pool status (else a deal the rep
      // marked Not Interested / Sold reads as "not worked yet").
      if (outcome === "sold") return "sold";
      if (outcome === "credit_denial") return "credit_denial";
      if (outcome === "no_sale") return "no_sale";
      if (outcome === "ni") return "declined";
      if (outcome === "btr_appt") return "appt_scheduled";
      return "not_worked";                                              // signed inspection, retail go-back not started
    }
    if (/sit sold|signed contract|production review|job prep|funding|pace|upcoming install|install set|roof started|new roof|paid|commission|collection|sitsold pa/.test(s)) return "sold";
    if (s.includes("credit") && (s.includes("deni") || s.includes("declin"))) return "credit_denial";
    if (s.includes("no sale")) return "no_sale";
    if (s.includes("pending")) return "sit_pending";
    if (s.includes("appointment scheduled")) return "appt_scheduled";
    if (s.includes("no sit") || s.includes("no show")) return "no_sit";
    if (s.includes("btr ni") || s.includes("not interested") || s.includes("refused")) return "declined";
    if (s.includes("lost") || s === "dq" || s.includes("stale") || s.includes("dead") || s.includes("no response")) return "lost";
  }
  if (outcome === "sold") return "sold";
  if (outcome === "credit_denial") return "credit_denial";
  if (outcome === "no_sale") return "no_sale";
  if (outcome === "ni") return "declined";
  if (outcome === "btr_appt") return "appt_scheduled";
  return "not_worked";
}
const RETAIL_STAGES = ["not_worked", "declined", "no_sit", "appt_scheduled", "sit_pending", "no_sale", "credit_denial", "sold", "lost"];

const person = (insp) => insp.client_name || insp.homeowner_name || "—";
const rep = (insp) => insp.sales_rep_name || insp.original_sales_rep_name || null;

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return cors(200, "");
  if (!SB_URL || !SB_KEY) return cors(500, JSON.stringify({ ok: false, error: "Missing Supabase env" }));
  try {
    const nowMs = Date.now();
    const zoneByRep = await fetchZoneByRep();
    const [inspections, appts, pas, companies, retailAppts] = await Promise.all([
      sbGetAll("inspections?select=id,jn_job_id,address,city,county,latitude,longitude,client_name,mobile,email,sales_rep_name,original_sales_rep_name,signed_at,docs_signed,date,inspection_date,result_at,inspector_name,result,inspection_result,jn_status,retail_outcome,retail_outcome_at,result_task_jnid,result_task_at,cancelled_at,cancel_review_pending,lost_reason,pa_id,pa_company_id,pa_status,pa_signed_at,pa_stage,pa_opened_at,manager_assigned_to_rep_at,pa_fields,pa_notes_log,pa_status_notes,pa_decision_reason,correction_note,referral_outcome,goback_not_home_count,goback_last_attempt_at"),
      sbGetAll("pa_appointments?select=id,pa_id,pa_company_id,inspection_id,homeowner_name,homeowner_phone,address,start_at,end_at,status,booked_by,notes,created_at"),
      sbGetAll("pas?select=id,name,phone,email,pa_company_id"),
      sbGetAll("pa_companies?select=id,name"),
      sbGetAll("retail_appointments?select=inspection_id"),
    ]);
    // Retail deals already booked for a back-to-retail options appointment — off the
    // rep's go-back list (mirrors visit-deal-list's retail exclusion).
    const scheduledRetail = new Set(retailAppts.map((a) => a.inspection_id).filter(Boolean));

    const paName = {}; for (const p of pas) paName[p.id] = p.name;
    const paCompany = {}; for (const p of pas) paCompany[p.id] = p.pa_company_id; // adjuster → their company
    const coName = {}; for (const c of companies) coName[c.id] = c.name;
    const inspById = {}; for (const i of inspections) inspById[i.id] = i;

    // Active (non-cancelled) appointments grouped by inspection.
    const apptByInsp = {};
    for (const a of appts) { if (a.status === "cancelled") continue; (apptByInsp[a.inspection_id] = apptByInsp[a.inspection_id] || []).push(a); }
    const latestAppt = (inspId) => (apptByInsp[inspId] || []).slice().sort((x, y) => new Date(y.start_at) - new Date(x.start_at))[0] || null;

    // Live records only (drop cancelled/lost inspections from the pipeline views).
    const live = inspections.filter((i) => !i.cancelled_at && i.result !== "lost" && String(i.jn_status || "").toLowerCase() !== "lost");
    const zoneOf = (r) => (r && zoneByRep[normalizeName(r)]) || "Unassigned";
    const card = (i) => ({ id: i.id, jn_job_id: i.jn_job_id, address: i.address, city: i.city, county: i.county, name: person(i), rep: rep(i), zone: zoneOf(rep(i)), phone: i.mobile, email: i.email, status: i.jn_status || i.inspection_result || null, visits: i.goback_not_home_count || 0, last_visit: toISO(i.goback_last_attempt_at) });

    // 1) STILL NEED TO BE INSPECTED — signed, not cancelled, no inspection done yet.
    const needs_inspection = live
      .filter((i) => (i.signed_at || isYes(i.docs_signed)) && !i.inspection_date && !i.result && !i.cancel_review_pending)
      .map((i) => ({ ...card(i), signed_at: toISO(i.signed_at), inspector: i.inspector_name || null }))
      .sort((a, b) => (a.signed_at || "").localeCompare(b.signed_at || ""));

    // 2) INSPECTED, STILL NEED A GO-BACK STATUS — a result IS recorded but the go-back
    //    action isn't done: a DAMAGE roof with no PA appointment booked (and not yet
    //    signed/refused), or a RETAIL roof the rep hasn't gone back to work yet. This
    //    is the post-inspection to-do backlog.
    // Use the EXACT "already handled" rules the reps' go-back list uses (visit-deal-list),
    // so this backlog can't diverge from what reps actually see on the map. A deal is
    // dropped once it's genuinely resolved or in a PA's hands — NOT still "needs a go-back":
    //   • BTPA — a PA has ENGAGED (signed / opened it / waiting on docs / LOR-PAC on file
    //     / a won JN status like "Sitsold PA" or "New Roof"), unless a manager explicitly
    //     handed it back to the rep. Also drop rep-marked Not Interested (BTR-NI).
    //   • BTR  — a retail options appt is already booked, or it's marked Not Interested.
    //   • ND   — a referral go-back was already recorded.
    const SIGNED_JN = /sitsold pa|signed contract|production review|job prep|funding|pace|upcoming install|install|new roof|paid|collection/i;
    const isNI = (i) => String(i.jn_status || "").trim().toLowerCase() === "btr - ni";
    const damageStillOpen = (i) => {
      const paEngaged = i.pa_signed_at || i.pa_stage === "waiting_docs" || /\b(lor|pac)\b/i.test(i.docs_signed || "") || SIGNED_JN.test(String(i.jn_status || ""));
      const paOpenedHide = i.pa_opened_at && !i.manager_assigned_to_rep_at;
      return !(paEngaged || paOpenedHide) && !isNI(i);
    };
    const needs_goback_status = live
      .filter((i) => (i.result === "damage" && damageStillOpen(i))                                                // BTPA — PA hasn't engaged, not NI
        || (i.result === "retail" && retailStage(i.jn_status, i.retail_outcome) === "not_worked" && !isNI(i) && !scheduledRetail.has(i.id)) // BTR — still "Sit Sold Insp", not NI, no appt booked
        || (i.result === "no_damage" && !i.referral_outcome))                                                    // ND — no referral go-back yet
      .map((i) => ({ ...card(i), result: i.result, need: i.result === "damage" ? "Needs PA appointment" : i.result === "no_damage" ? "Needs referral go-back" : "Needs rep go-back (BTR)" }))
      .sort((a, b) => (a.result || "").localeCompare(b.result || ""));

    // 3) RETAIL breakdown + percentages. retail_outcome: ni / no_sale / sold / btr_appt / (null = pending)
    const retailDeals = live.filter((i) => i.result === "retail");
    const RB = { ni: "BTR – Not Interested", btr_appt: "BTR – Appointment", sold: "BTR Sold", credit_denial: "BTR – Credit Denial", no_sale: "BTR – No Sale", pending: "Not worked yet (rep hasn't gone back)" };
    const buckets = { ni: 0, btr_appt: 0, sold: 0, credit_denial: 0, no_sale: 0, pending: 0 };
    for (const i of retailDeals) { const k = i.retail_outcome && buckets[i.retail_outcome] != null ? i.retail_outcome : "pending"; buckets[k]++; }
    const rTotal = retailDeals.length || 1;
    const pct = {}; for (const k of Object.keys(buckets)) pct[k] = Math.round((buckets[k] / rTotal) * 1000) / 10;
    // The REAL pipeline from live JN status (LOST/DQ split out, Sit-Pending its own stage).
    const pipeline = {}; RETAIL_STAGES.forEach((k) => { pipeline[k] = 0; });
    for (const i of retailDeals) pipeline[retailStage(i.jn_status, i.retail_outcome)]++;
    const retail = {
      total: retailDeals.length, labels: RB, buckets, pct, pipeline,
      deals: retailDeals.map((i) => ({ ...card(i), outcome: i.retail_outcome || "pending", stage: retailStage(i.jn_status, i.retail_outcome), outcome_at: toISO(i.retail_outcome_at), jn_status: i.jn_status || null, notes: recentNotes(i) }))
        .sort((a, b) => (b.outcome_at || "").localeCompare(a.outcome_at || "")),
    };

    // 4) DAMAGE / BTPA — every damage deal, bucketed by where it is in the PA lifecycle:
    //    need_appt (no PA appt booked yet) · missed (appt time passed, still "scheduled"
    //    or cancelled, never signed = a no-show) · signed (PA paperwork signed) · unknown
    //    (has an appt but we can't tell — upcoming, refused, or ambiguous). Powers the
    //    BTPA breakdown buttons in the master report.
    const damageDeals = live.filter((i) => i.result === "damage");
    const btpaNowMs = Date.now();
    const btpaBucket = (deal, hasAppt) => {
      if (deal.signed) return "signed";
      // Note: pa_stage "dead" is NOT its own bucket — it means the PA did nothing with
      // the deal, so it still needs the rep to go back and set an appointment.
      if (!hasAppt) return "need_appt";
      const st = String(deal.appt_status || "").toLowerCase();
      const t = deal.start_at ? new Date(deal.start_at).getTime() : 0;
      const past = t && t < btpaNowMs;
      if (past && (st === "scheduled" || st === "cancelled")) return "missed"; // no-show / didn't happen
      if (t && !past) return "upcoming"; // appointment is scheduled for later
      return "unknown"; // refused, or ambiguous
    };
    const withApptArr = [], needApptArr = [], allDamage = [];
    for (const i of damageDeals) {
      const a = latestAppt(i.id);
      // Resolve the PA adjuster + company robustly: the deal's own fields first, then
      // the appointment's, then the adjuster's own company — so a company shows on the
      // card whenever we can determine one (the deal doesn't always stamp pa_company_id).
      const paId = i.pa_id || (a && a.pa_id) || null;
      const coId = i.pa_company_id || (a && a.pa_company_id) || (paId ? paCompany[paId] : null) || null;
      const pn = paId ? paName[paId] : null;
      const co = coId ? coName[coId] : null;
      // Only surface a PA stage when a PA is actually ASSIGNED — a stale "active" on
      // an unassigned deal is misleading (nobody's on it). Guard on pa_id/company.
      const assigned = !!(paId || coId);
      const base = { ...card(i), pa: pn, company: co, stage: assigned ? (i.pa_stage || null) : null, notes: recentNotes(i), signed: paOutcome(i) === "signed" };
      const deal = a ? { ...base, start_at: a.start_at, appt_status: a.status } : { ...base, assigned };
      deal.bucket = btpaBucket(deal, !!a);
      (a ? withApptArr : needApptArr).push(deal);
      allDamage.push(deal);
    }
    const btpaCounts = { need_appt: 0, upcoming: 0, missed: 0, signed: 0, unknown: 0 };
    for (const d of allDamage) btpaCounts[d.bucket] = (btpaCounts[d.bucket] || 0) + 1;
    const damage = {
      total: damageDeals.length,
      with_appt: withApptArr.sort((a, b) => (a.start_at || "").localeCompare(b.start_at || "")),
      needs_appt: needApptArr,
      all: allDamage,
      buckets: btpaCounts,
    };

    // 5) PA APPOINTMENTS THAT HAVE PASSED — status, outcome, which PA / company, when filed.
    const pa_passed = appts
      .filter((a) => {
        if (!(a.start_at && new Date(a.start_at).getTime() < nowMs)) return false;
        // Converted to retail at the door → it's a BTR deal now, not a PA appointment
        // to reschedule. Drop it from the PA report; it lives in the BTR bucket.
        const insp = a.inspection_id ? inspById[a.inspection_id] : null;
        if (insp && String(insp.result || "").toLowerCase() === "retail") return false;
        return true;
      })
      .map((a) => {
        const insp = a.inspection_id ? inspById[a.inspection_id] : null;
        const outcome = insp ? paOutcome(insp) : "pending";
        const f = insp ? paFields(insp) : {};
        return {
          appt_id: a.id, inspection_id: a.inspection_id,
          name: a.homeowner_name || (insp && person(insp)) || "—",
          phone: a.homeowner_phone || (insp && insp.mobile) || null,
          email: insp && insp.email || null,
          address: a.address || (insp && insp.address) || null,
          city: (insp && insp.city) || null,
          pa: a.pa_id ? paName[a.pa_id] : null,
          company: a.pa_company_id ? coName[a.pa_company_id] : (insp && insp.pa_company_id ? coName[insp.pa_company_id] : null),
          pa_id: a.pa_id || (insp && insp.pa_id) || null,
          start_at: a.start_at,
          appt_status: a.status,          // scheduled / done / cancelled
          outcome,                        // signed / refused / pending (derived from inspection)
          signed: outcome === "signed",   // did they sign PA paperwork? not-signed = reschedule candidate
          filed_at: toISO(f.pa_filed),    // when the claim was filed
          booked_at: toISO(a.created_at), // when the appointment was set
          rep: insp ? rep(insp) : null,
          // The STORY behind the verdict — so the office can see WHY it's refused /
          // what "no outcome" actually means (PA showed? homeowner no-showed?) instead
          // of a bare label. PA pipeline stage + the recent PA notes + the appt note.
          stage: insp ? (insp.pa_stage || null) : null,
          reason: insp ? (insp.pa_status_notes || insp.lost_reason || insp.pa_decision_reason || insp.correction_note || null) : null,
          notes: insp ? recentNotes(insp) : [],
          appt_note: a.notes || null,
        };
      })
      .sort((a, b) => (b.start_at || "").localeCompare(a.start_at || ""));

    // ── INSPECTOR ACTIVITY — per inspector, per day: roofs inspected + miles driven.
    //    Miles are ESTIMATED (shortest route through the day's roofs × a road factor) —
    //    the actual visit order/times aren't captured yet (coming with the inspector map).
    const milesBetween = (a, b) => {
      if (!a || !b || a.lat == null || b.lat == null) return 0;
      const R = 3958.8, toRad = (d) => (d * Math.PI) / 180;
      const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
      const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
      return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
    };
    const ROAD = 1.3, r1 = (x) => Math.round(x * 10) / 10;
    const orderRoofs = (pts) => { // nearest-neighbour from the first roof
      if (pts.length <= 2) return pts.slice();
      const rem = pts.slice(), out = [rem.shift()];
      while (rem.length) { let bi = 0, bd = Infinity; for (let i = 0; i < rem.length; i++) { const d = milesBetween(out[out.length - 1], rem[i]); if (d < bd) { bd = d; bi = i; } } out.push(rem.splice(bi, 1)[0]); }
      return out;
    };
    // Group by WHEN the roof was inspected (result_at) — NOT `date`, which is the
    // homeowner's signed/appointment date and files a 7/29 inspection under 7/24.
    // Fall back to `date` only for old rows that predate result_at being stamped.
    const inspectedRows = inspections.filter((i) => ["damage", "retail", "no_damage"].includes(i.result) && i.inspector_name && !i.cancelled_at && (i.result_at || i.date));
    const byInsp = {};
    for (const i of inspectedRows) { const d = String(i.result_at || i.date).slice(0, 10); (byInsp[i.inspector_name] = byInsp[i.inspector_name] || {}); (byInsp[i.inspector_name][d] = byInsp[i.inspector_name][d] || []).push(i); }
    const inspector_activity = [];
    for (const [name, days] of Object.entries(byInsp)) {
      const day_list = []; let totalRoofs = 0, totalMiles = 0;
      for (const [d, rows] of Object.entries(days)) {
        const strip = (r) => ({ address: r.address, city: r.city, result: r.result, name: person(r) });
        const geo = rows.filter((r) => r.latitude != null && r.longitude != null).map((r) => ({ lat: +r.latitude, lng: +r.longitude, ...strip(r) }));
        const noGeo = rows.filter((r) => r.latitude == null || r.longitude == null).map(strip);
        const ordered = orderRoofs(geo);
        const legs = []; let miles = 0;
        for (let k = 1; k < ordered.length; k++) { const m = milesBetween(ordered[k - 1], ordered[k]) * ROAD; miles += m; legs.push({ from: ordered[k - 1].address, to: ordered[k].address, miles: r1(m) }); }
        totalRoofs += rows.length; totalMiles += miles;
        // Every roof lists (with city); legs only span the geocoded ones. missing_geo
        // flags a day whose mileage is partial (some roofs not geocoded yet).
        day_list.push({ date: d, roofs: rows.length, miles: r1(miles), missing_geo: noGeo.length, stops: [...ordered.map(strip), ...noGeo], legs });
      }
      day_list.sort((a, b) => b.date.localeCompare(a.date));
      inspector_activity.push({ inspector: name, days: day_list.length, roofs: totalRoofs, miles: r1(totalMiles), day_list });
    }
    inspector_activity.sort((a, b) => b.roofs - a.roofs);

    // MISSED PA APPOINTMENTS — passed, not cancelled, no outcome yet. These need a
    // rebook / a fresh scheduling link (rep view + homeowner auto-nudge).
    const missed_pa = pa_passed.filter((a) => a.appt_status !== "cancelled" && a.appt_status !== "done" && a.outcome === "pending");

    return cors(200, JSON.stringify({
      ok: true,
      generated_at: new Date(nowMs).toISOString(),
      counts: {
        needs_inspection: needs_inspection.length,
        needs_goback_status: needs_goback_status.length,
        retail: retail.total,
        damage: damage.total,
        damage_with_appt: damage.with_appt.length,
        damage_needs_appt: damage.needs_appt.length,
        pa_passed: pa_passed.length,
        missed_pa: missed_pa.length,
        inspectors: inspector_activity.length,
      },
      needs_inspection, needs_goback_status, retail, damage, pa_passed, missed_pa, inspector_activity,
    }));
  } catch (e) {
    return cors(500, JSON.stringify({ ok: false, error: e.message || "Unknown error" }));
  }
};

function cors(status, body) {
  return { statusCode: status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" }, body };
}
