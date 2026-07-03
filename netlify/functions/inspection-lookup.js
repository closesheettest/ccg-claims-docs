// netlify/functions/inspection-lookup.js
//
// Manager/admin "Look up an inspection": search by address or homeowner name and
// get where each deal sits in the process — signed → inspected → result → PA /
// retail / no-damage → cancelled — with a plain timeline, the PA notes log (why
// it stalled), and the live JobNimbus status. Powers the InspectionLookup card
// on the CCG Admin Dashboard and the TMS Regional Managers dashboard.
//
// POST { q }  (address or name, 2+ chars)
//   → { ok, count, results:[{ inspection_id, client_name, address, city, rep,
//        stage, stage_detail, timeline:[{label,at}], notes:[{at,text,stage}],
//        result, inspector_name, jn_status, jn_status_stale, jn_job_id, jn_url,
//        pa_id, pa_stage, start_date, sold_date }] }
//
// Open-CORS (called cross-origin from TMS). Env: VITE_SUPABASE_URL,
// VITE_SUPABASE_ANON_KEY, JOBNIMBUS_API_KEY.

const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const sb = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" };
const JN_BASE = "https://app.jobnimbus.com/api1";
const JN_KEY = process.env.JOBNIMBUS_API_KEY;

const SEL = "id,client_name,address,city,state,zip,mobile,email,sales_rep_name,original_sales_rep_name," +
  "signed_at,cancelled_at,cancel_reason,result,result_at,inspector_name,jn_job_id,jn_status," +
  "jn_cert_uploaded_at,pa_id,pa_stage,pa_opened_at,pa_signed_at,docs_signed,pa_notes_log";

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return cors(200, "");
  if (event.httpMethod !== "POST") return cors(405, JSON.stringify({ ok: false, error: "POST only" }));
  if (!SB_URL || !SB_KEY) return cors(500, JSON.stringify({ ok: false, error: "env missing" }));

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { return cors(400, JSON.stringify({ ok: false, error: "bad JSON" })); }
  const q = String(body.q || "").trim();
  if (q.length < 2) return cors(400, JSON.stringify({ ok: false, error: "Type at least 2 characters (an address or homeowner name)." }));

  try {
    const like = `*${q.replace(/[*,()]/g, " ").trim()}*`;
    const enc = encodeURIComponent(like);
    const rows = await sbGet(`inspections?select=${SEL}&or=(address.ilike.${enc},client_name.ilike.${enc})&order=signed_at.desc.nullslast&limit=15`);

    // Enrich with live JN status/dates (cap the number of JN calls).
    const withJn = rows.filter((r) => r.jn_job_id).slice(0, 10);
    const jnById = {};
    await Promise.all(withJn.map(async (r) => {
      try {
        const jr = await fetch(`${JN_BASE}/jobs/${r.jn_job_id}`, { headers: { Authorization: `bearer ${JN_KEY}`, "Content-Type": "application/json" } });
        if (jr.ok) jnById[r.jn_job_id] = await jr.json();
      } catch { /* best-effort */ }
    }));

    const results = rows.map((r) => shape(r, jnById[r.jn_job_id]));
    return cors(200, JSON.stringify({ ok: true, count: results.length, results }));
  } catch (e) {
    return cors(500, JSON.stringify({ ok: false, error: e.message || "error" }));
  }
};

function shape(r, jn) {
  const notes = Array.isArray(r.pa_notes_log) ? r.pa_notes_log : [];
  const released = notes.some((n) => n.stage === "released" || /released back/i.test(n.text || ""));
  const jnStatus = (jn && jn.status_name) || r.jn_status || null;
  const startSec = jn ? Number(jn.date_start) || 0 : null;
  const soldSec = jn ? (Number(jn["Sold Date"]) || Number(jn.cf_date_5) || 0) : null;

  // Timeline (only steps that happened, in order).
  const timeline = [];
  if (r.signed_at) timeline.push({ label: "Inspection agreement signed", at: r.signed_at });
  if (r.result) timeline.push({ label: `Inspected → ${resultLabel(r.result)}`, at: r.result_at || null });
  if (r.jn_cert_uploaded_at) timeline.push({ label: "Certificate uploaded to JobNimbus", at: r.jn_cert_uploaded_at });
  if (r.pa_opened_at) timeline.push({ label: "Public adjuster opened the deal", at: r.pa_opened_at });
  if (r.pa_signed_at) timeline.push({ label: "PA signed the homeowner", at: r.pa_signed_at });
  for (const n of notes) timeline.push({ label: n.text || "(note)", at: n.at || null, note: true });
  if (r.cancelled_at) timeline.push({ label: `Cancelled${r.cancel_reason ? ` — ${r.cancel_reason}` : ""}`, at: r.cancelled_at });
  timeline.sort((a, b) => new Date(a.at || 0) - new Date(b.at || 0));

  // Stage + one-line "where it is / next step".
  let stage, stage_detail;
  if (r.cancelled_at) {
    stage = "Cancelled"; stage_detail = r.cancel_reason ? `Cancelled — ${r.cancel_reason}.` : "This deal was cancelled.";
  } else if (!r.result) {
    stage = "Signed — awaiting inspection"; stage_detail = "Signed, not yet inspected. Waiting on an inspector to sit it and record a result.";
  } else if (r.result === "no_damage") {
    stage = "No damage"; stage_detail = "No storm damage found — certificate + referral path.";
  } else if (r.result === "retail") {
    stage = "Retail options"; stage_detail = "Back-to-retail — the rep sets a retail options appointment.";
  } else if (r.result === "damage") {
    if (r.pa_signed_at) { stage = "Damage — PA working the claim"; stage_detail = "A PA has signed the homeowner and is filing the claim."; }
    else if (r.pa_stage === "waiting_docs") { stage = "Damage — PA waiting on docs"; stage_detail = "A PA is engaged and waiting on paperwork."; }
    else if (r.pa_id) { stage = "Damage — assigned to a PA"; stage_detail = "Assigned to a PA; not yet signed up."; }
    else if (released) { stage = "Damage — released back to the rep"; stage_detail = "A PA dropped it (dead PA deal); it's back on the rep's plate. Fix the reason in the notes, then reassign a PA."; }
    else if (r.pa_opened_at) { stage = "Damage — with a PA (opened, not signed)"; stage_detail = "A PA opened it but hasn't signed the homeowner. Parked — nudge or reassign the PA."; }
    else { stage = "Damage — needs a PA"; stage_detail = "Damage found but no PA assigned yet. Assign one to start the claim."; }
  } else {
    stage = r.result; stage_detail = "";
  }

  // JN status is "stale" if it still says PA/sold-PA but the deal was released.
  const jn_status_stale = !!(released && /pa/i.test(String(jnStatus || "")));

  return {
    inspection_id: r.id,
    client_name: r.client_name || "—",
    address: [r.address, r.city, r.state].filter(Boolean).join(", "),
    rep: r.sales_rep_name || r.original_sales_rep_name || "—",
    mobile: r.mobile || null,
    stage, stage_detail,
    timeline,
    notes,
    result: r.result || null,
    inspector_name: r.inspector_name || null,
    jn_status: jnStatus,
    jn_status_stale,
    jn_job_id: r.jn_job_id || null,
    jn_url: r.jn_job_id ? `https://app.jobnimbus.com/job/${r.jn_job_id}` : null,
    pa_id: r.pa_id || null,
    pa_stage: r.pa_stage || null,
    start_date: startSec ? ymdET(startSec) : null,
    sold_date: soldSec ? ymdET(soldSec) : null,
  };
}

function resultLabel(r) { return r === "damage" ? "Damage found" : r === "no_damage" ? "No damage" : r === "retail" ? "Retail" : r; }
function ymdET(sec) { try { return new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "numeric", day: "numeric", year: "numeric" }).format(new Date(sec * 1000)); } catch { return null; } }
async function sbGet(path) { const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: sb }); if (!r.ok) return []; return r.json().catch(() => []); }
function cors(status, body) {
  return { statusCode: status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" }, body };
}
