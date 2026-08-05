// netlify/functions/pa-resched-compose.js
//
// Admin composer for the missed/unsigned-PA reschedule TEXT campaign.
//
// Lists the reschedule CANDIDATES — a PA appointment that PASSED with NO paperwork
// signed, that WASN'T converted to retail at the door, and WASN'T cancelled — so the
// office can write a personalized bulk text + edit the landing-page pitch, review
// each one's notes, and (later) send + audit delivery.
//
// The candidate rule is the structured one we settled on:
//   signed = false  AND  result != 'retail'  AND  appt not cancelled  AND  has phone
// The "went elsewhere / real refusal" call stays a human check in the UI (notes shown).
//
//   POST { action:"list" }                 → { ok, candidates:[...], five_star_id }
//   POST { action:"settings" }             → { ok, pitch:{headline,body}, sms }
//   POST { action:"save", pitch?, sms? }   → { ok }
//
// SEND is intentionally NOT here yet — build-only per Neal. When it lands it will
// write a pa_reschedule_sends row per text and a GHL webhook will fill delivery status.
//
// Env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY

const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const sb = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" };

const DEFAULT_SMS = "Hi {first_name}, it's U.S. Shingle & Metal. Your roof inspection found damage insurance may cover — but we missed you for your adjuster appointment. See your roof photos and grab a new time here: {link}";
const DEFAULT_PITCH = {
  headline: "Your roof came back with damage",
  body: "Hi {first_name} — our inspector documented damage on your roof at {address}. This is often covered by your insurance, and a licensed Public Adjuster can file the claim for you.",
  schedule: "We missed you last time — pick a new time and a Public Adjuster will meet you to get your claim started:",
};

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return cors(200, "");
  if (event.httpMethod !== "POST") return cors(405, { ok: false, error: "POST only" });
  if (!SB_URL || !SB_KEY) return cors(500, { ok: false, error: "Missing Supabase env" });
  let body; try { body = JSON.parse(event.body || "{}"); } catch { return cors(400, { ok: false, error: "bad JSON" }); }
  const action = String(body.action || "").trim();

  try {
    if (action === "settings") {
      const [pitch, sms] = await Promise.all([getSetting("pa_reschedule_pitch"), getSetting("pa_reschedule_sms")]);
      return cors(200, { ok: true, pitch: normPitch(pitch), sms: (typeof sms === "string" && sms.trim()) ? sms : DEFAULT_SMS });
    }
    if (action === "save") {
      const writes = [];
      if (body.pitch && typeof body.pitch === "object") writes.push(setSetting("pa_reschedule_pitch", { headline: String(body.pitch.headline || "").trim(), body: String(body.pitch.body || "").trim(), schedule: String(body.pitch.schedule || "").trim() }));
      if (typeof body.sms === "string") writes.push(setSetting("pa_reschedule_sms", body.sms));
      await Promise.all(writes);
      return cors(200, { ok: true, saved: writes.length });
    }
    if (action === "list") return await list();
    return cors(400, { ok: false, error: `Unknown action: ${action}` });
  } catch (e) {
    return cors(500, { ok: false, error: e.message || "error" });
  }
};

async function list() {
  const nowIso = new Date().toISOString();
  // The active, unpaused PA company = Five Star (the only one taking appointments).
  const companies = await sbGet(`pa_companies?select=id,name,active,scheduling_paused`);
  const coName = {}; for (const c of companies) coName[c.id] = c.name;
  const fiveStar = companies.find((c) => c.active && !c.scheduling_paused);
  const pas = await sbGet(`pas?select=id,name,pa_company_id`);
  const paName = {}, paCompany = {}; for (const p of pas) { paName[p.id] = p.name; paCompany[p.id] = p.pa_company_id; }

  // Passed, non-cancelled PA appointments (the ones that could need a reschedule).
  const appts = await sbGet(`pa_appointments?status=neq.cancelled&start_at=lt.${encodeURIComponent(nowIso)}&select=id,inspection_id,homeowner_name,homeowner_phone,address,start_at,status,pa_id,pa_company_id,reschedule_sent_at&order=start_at.desc&limit=2000`);
  const inspIds = [...new Set(appts.map((a) => a.inspection_id).filter(Boolean))];
  const inspById = {};
  for (let i = 0; i < inspIds.length; i += 100) {
    const rows = await sbGet(`inspections?id=in.(${inspIds.slice(i, i + 100).join(",")})&select=id,client_name,mobile,email,address,city,sales_rep_name,result,pa_id,pa_company_id,pa_signed_at,pa_status,pa_fields,pa_stage,pa_notes_log,cancelled_at`);
    for (const r of rows) inspById[r.id] = r;
  }

  const candidates = [];
  const seenInsp = new Set();
  for (const a of appts) {
    const insp = a.inspection_id ? inspById[a.inspection_id] : null;
    if (!insp) continue;
    if (insp.cancelled_at) continue;                         // inspection was cancelled/lost
    if (String(insp.result || "").toLowerCase() === "retail") continue;   // converted to retail at the door
    if (isSigned(insp)) continue;                            // PA paperwork already signed — a win
    const phone = a.homeowner_phone || insp.mobile || null;
    if (!phone) continue;                                    // nothing to text
    if (seenInsp.has(a.inspection_id)) continue;             // one candidate per homeowner (latest appt wins — appts sorted desc)
    seenInsp.add(a.inspection_id);
    const paId = a.pa_id || insp.pa_id || null;
    const coId = a.pa_company_id || (paId && paCompany[paId]) || insp.pa_company_id || null;
    candidates.push({
      appt_id: a.id,
      inspection_id: a.inspection_id,
      name: a.homeowner_name || insp.client_name || "—",
      first_name: String(a.homeowner_name || insp.client_name || "").trim().split(/\s+/)[0] || "",
      address: a.address || insp.address || null,
      city: insp.city || null,
      phone,
      email: insp.email || null,
      rep: insp.sales_rep_name || null,
      pa: paId ? (paName[paId] || null) : null,
      company: coId ? (coName[coId] || null) : null,
      pa_is_five_star: !!(coId && fiveStar && coId === fiveStar.id),
      stage: insp.pa_stage || null,
      notes: recentNotes(insp),
      signed: false,
      start_at: a.start_at,
      days_since: Math.max(0, Math.round((Date.now() - new Date(a.start_at).getTime()) / 86400000)),
      reschedule_sent_at: a.reschedule_sent_at || null,
    });
  }
  candidates.sort((x, y) => (y.days_since - x.days_since));
  return cors(200, { ok: true, candidates, five_star: fiveStar ? { id: fiveStar.id, name: fiveStar.name } : null });
}

function paFields(insp) { let f = insp.pa_fields || {}; if (typeof f === "string") { try { f = JSON.parse(f); } catch { f = {}; } } return f; }
function isSigned(insp) {
  const signup = String(paFields(insp).pa_signup || "").toLowerCase();
  return !!(insp.pa_signed_at || insp.pa_status === "signed" || signup.startsWith("signed"));
}
function recentNotes(insp) {
  let log = insp.pa_notes_log;
  if (typeof log === "string") { try { log = JSON.parse(log); } catch { log = []; } }
  if (!Array.isArray(log)) return [];
  const out = [], seen = new Set();
  for (const e of log.slice().reverse()) {
    const text = String((e && e.text) || "").trim();
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue; seen.add(key);
    out.push({ text: text.slice(0, 240), stage: (e && e.stage) || null });
    if (out.length >= 4) break;
  }
  return out;
}
function normPitch(p) {
  if (typeof p === "string") { try { p = JSON.parse(p); } catch { p = null; } }
  if (!p || typeof p !== "object") return { ...DEFAULT_PITCH };
  return { headline: p.headline || DEFAULT_PITCH.headline, body: p.body || DEFAULT_PITCH.body, schedule: p.schedule || DEFAULT_PITCH.schedule };
}

async function getSetting(key) { const rows = await sbGet(`app_settings?key=eq.${encodeURIComponent(key)}&select=value&limit=1`); return rows[0]?.value ?? null; }
async function setSetting(key, value) {
  return fetch(`${SB_URL}/rest/v1/app_settings?on_conflict=key`, {
    method: "POST", headers: { ...sb, Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ key, value, updated_at: new Date().toISOString() }),
  });
}
async function sbGet(path) { const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: sb }); if (!r.ok) return []; return r.json().catch(() => []); }
function cors(status, body) { return { statusCode: status, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" }, body: typeof body === "string" ? body : JSON.stringify(body) }; }
