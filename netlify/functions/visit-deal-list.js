// netlify/functions/visit-deal-list.js
//
// The rep's own deals for a given outcome, nearest-first — powers the
// "pick a homeowner" step of the visit hub (Damage / No-Damage / Retail).
//
// POST { token, result, rep_jobnimbus_id?, rep_name?, lat?, lng? }
//   result = 'damage' | 'no_damage' | 'retail'
//   → { ok, deals: [{ inspection_id, client_name, address, city, state, zip,
//        mobile, email, jn_job_id, latitude, longitude, distance_mi, result,
//        result_at, pa_id }] }   (nearest-first; unknown distance last)
//
// Env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY.

import { retailStage } from "./_retail.js";
import { damageState, damageNeedsGoback } from "./_btpa.js";

const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const sb = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" };
const RESULTS = new Set(["damage", "no_damage", "retail"]);

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return cors(200, "");
  if (event.httpMethod !== "POST") return cors(405, JSON.stringify({ ok: false, error: "POST only" }));
  if (!SB_URL || !SB_KEY) return cors(500, JSON.stringify({ ok: false, error: "env missing" }));

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { return cors(400, JSON.stringify({ ok: false, error: "bad JSON" })); }
  if (!(await okToken(body.token))) return cors(401, JSON.stringify({ ok: false, error: "Invalid link" }));

  const result = String(body.result || "").trim();
  if (!RESULTS.has(result)) return cors(400, JSON.stringify({ ok: false, error: "bad result" }));
  const repId = String(body.rep_jobnimbus_id || "").trim();
  const repName = String(body.rep_name || "").trim();
  const lat = body.lat != null ? +body.lat : null;
  const lng = body.lng != null ? +body.lng : null;

  // Match the CURRENT assigned rep only (by JN id, then name). A deal reassigned
  // to another rep shows on THEIR go-back list, not the original signer's — so the
  // signer (e.g. William, who signs a lot in training) doesn't keep seeing deals
  // that were handed off. Unassigned deals still surface for whoever holds them now.
  const all = body.all === true; // office/admin GLOBAL view: every rep's go-backs (no rep filter)
  const conds = [];
  if (repId) conds.push(`sales_rep_id.eq.${q(repId)}`);
  if (repName) conds.push(`sales_rep_name.eq.${q(repName)}`);
  if (!all && !conds.length) return cors(400, JSON.stringify({ ok: false, error: "rep required" }));

  try {
    // review_availability is a newer column; if it hasn't been added yet the
    // SELECT 400s and we'd get zero deals. Try with it, fall back without it.
    const SEL_BASE = "id,client_name,address,city,state,zip,mobile,email,jn_job_id,latitude,longitude,result,result_at,pa_id,pa_signed_at,pa_opened_at,pa_stage,pa_fields,docs_signed,jn_status,pa_notes_log";
    const repClause = all ? "" : `&or=(${conds.join(",")})`;
    const tail = `&result=eq.${result}&cancelled_at=is.null${repClause}&order=result_at.desc&limit=${all ? 2000 : 500}`;
    // manager_assigned_to_rep_at is a newer column (added by manager_assign_rep_marker.sql);
    // keep it in the optional select so a pre-migration DB just falls back without it.
    let rows = await sbGet(`inspections?select=${SEL_BASE},review_availability,referral_outcome,retail_outcome,result_task_at,manager_assigned_to_rep_at${tail}`);
    if (!rows.length) rows = await sbGet(`inspections?select=${SEL_BASE}${tail}`);

    // Damage list: the rep goes back to (re)schedule the Public-Adjuster appointment.
    // Appointment-driven via the shared classifier (_btpa.js): show only deals that
    // still need one — need_appt (no PA appt ever) or missed (appt came and went, no
    // signing → reschedule). Signed / dead (Not Interested or office-closed DQ) /
    // upcoming all drop off. The OLD auto-assign flags (pa_opened_at, pa_stage
    // "active") are ignored — a PA merely "opening" a deal never meant an appointment.
    if (result === "damage") {
      const ids = rows.map((r) => r.id);
      const latestAppt = {};
      if (ids.length) {
        const inList = ids.map((id) => `"${id}"`).join(",");
        const appts = await sbGet(`pa_appointments?inspection_id=in.(${encodeURIComponent(inList)})&status=neq.cancelled&select=inspection_id,start_at,status`);
        for (const a of appts) {
          if (!a.inspection_id) continue;
          const cur = latestAppt[a.inspection_id];
          if (!cur || String(a.start_at || "") > String(cur.start_at || "")) latestAppt[a.inspection_id] = a;
        }
      }
      const nowMs = Date.now();
      rows = rows.filter((r) => damageNeedsGoback(damageState(r, latestAppt[r.id] || null, nowMs)));
    }
    // No-Damage list: once handled — certificate sent or referral declined
    // (inspections.referral_outcome set) — it drops off the rep's list.
    if (result === "no_damage") {
      rows = rows.filter((r) => !r.referral_outcome);
    }
    // Retail list: only a deal the rep STILL needs to go back and work — retailStage
    // "not_worked" (the "Sit Sold Insp" pool, no outcome recorded). Everything else is
    // handled (sold / no-sale / declined), scheduled, in another workflow (no-sit,
    // sit-pending), or DEAD (LOST / DQ) — none of which belong on a go-back list. This
    // is the SAME classifier the master report uses, so the two can't disagree.
    if (result === "retail") {
      rows = rows.filter((r) => retailStage(r.jn_status, r.retail_outcome) === "not_worked");
    }
    // Retail list: a deal leaves the rep's list once it's HANDLED — marked Not
    // Interested ("BTR - NI") or already scheduled (a retail_appointments row).
    if (result === "retail") {
      const ids = rows.map((r) => r.id);
      const scheduled = new Set();
      if (ids.length) {
        const inList = ids.map((id) => `"${id}"`).join(",");
        const appts = await sbGet(`retail_appointments?inspection_id=in.(${encodeURIComponent(inList)})&select=inspection_id`);
        for (const a of appts) if (a.inspection_id) scheduled.add(a.inspection_id);
      }
      rows = rows.filter((r) => String(r.jn_status || "").trim().toLowerCase() !== "btr - ni" && !scheduled.has(r.id));
    }
    const deals = rows.map((r) => {
      const dist = (lat != null && lng != null && r.latitude != null && r.longitude != null)
        ? Math.round(haversineMi(lat, lng, +r.latitude, +r.longitude) * 10) / 10 : null;
      return {
        inspection_id: r.id, client_name: r.client_name, address: r.address, city: r.city, state: r.state, zip: r.zip,
        mobile: r.mobile, email: r.email, jn_job_id: r.jn_job_id, latitude: r.latitude, longitude: r.longitude,
        distance_mi: dist, result: r.result, result_at: r.result_at, pa_id: r.pa_id, review_availability: r.review_availability, result_task_at: r.result_task_at,
        pa_notes_log: Array.isArray(r.pa_notes_log) ? r.pa_notes_log : null,
      };
    });
    deals.sort((a, b) => ((a.distance_mi ?? 1e9) - (b.distance_mi ?? 1e9)) || (a.client_name || "").localeCompare(b.client_name || ""));
    return cors(200, JSON.stringify({ ok: true, deals }));
  } catch (e) {
    return cors(500, JSON.stringify({ ok: false, error: e.message || "error" }));
  }
};

function haversineMi(lat1, lon1, lat2, lon2) {
  const R = 3958.8, toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
const q = (s) => encodeURIComponent(`"${String(s).replace(/"/g, '\\"')}"`);
async function okToken(token) {
  token = String(token || "").trim();
  if (!token) return false;
  const [d, v] = await Promise.all([getSetting("dialer_token"), getSetting("visit_token")]);
  return token === d || token === v;
}
async function getSetting(key) {
  const rows = await sbGet(`app_settings?key=eq.${encodeURIComponent(key)}&select=value&limit=1`);
  return rows[0]?.value || null;
}
async function sbGet(path) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: sb });
  if (!r.ok) return [];
  return r.json().catch(() => []);
}
function cors(status, body) {
  return { statusCode: status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" }, body };
}
