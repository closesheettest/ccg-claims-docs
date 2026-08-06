// netlify/functions/_btpa.js
//
// Shared BTPA (damage / Public-Adjuster) lifecycle classifier. ONE source of truth
// for the master report AND the reps' go-back map (visit-deal-list), so a damage
// deal's state can't be defined two different ways.
//
// The model is APPOINTMENT-DRIVEN and deliberately ignores the OLD auto-assign
// signals (pa_opened_at, pa_stage "active"/"dead") — those never meant a real
// appointment. A deal a PA merely "opened" but never actually sat is treated as
// having no appointment at all: it needs one scheduled.
//
//   signed    → PA signed the homeowner (pa_signed_at, a won JN status like
//               "Sit Sold PA"/"New Roof", Five Star "Waiting Docs", or LOR/PAC on
//               file). Done — off the rep's list.
//   dead      → homeowner Not Interested (BTR-NI) OR the office/PA closed the lead
//               (pa_stage "dead" — a Five Star "DQ Lead"). Off the rep's list.
//   upcoming  → a PA appointment is booked for later.
//   missed    → a PA appointment came and went with no signing → needs RESCHEDULE.
//   need_appt → no PA appointment ever → needs one SCHEDULED.
//
// NOTE the pa_stage split: "dead" is an EXPLICIT close (kept), but "active" is a
// leftover auto-assign flag that never meant a real appointment — IGNORED, so an
// "active" deal with no appointment correctly reads as need_appt.
//
// The rep goes back on exactly the two open states: need_appt + missed.

const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

// A deal that was RELEASED back to the sales rep (a dead PA deal, or pulled off a
// non-Five-Star PA) — pa_notes_log carries a { stage: "released" } entry. On release
// the PA link + stage are cleared, but the JN status often still reads "Sit Sold PA"
// from when a PA first sat it. That leftover status is STALE and must NOT count as
// signed — the deal is back on the rep's plate to (re)book with Five Star.
function wasReleased(insp) {
  let log = insp && insp.pa_notes_log;
  if (typeof log === "string") { try { log = JSON.parse(log); } catch { log = null; } }
  return Array.isArray(log) && log.some((e) => e && e.stage === "released");
}

// A won/signed Public-Adjuster JN status (normalized). KEPT for other callers, but no
// longer used to decide "signed" — the office sets "Sit Sold PA" optimistically (the PA
// may still be chasing the homeowner), so the status ALONE is not proof of a signing.
export function jnPaSigned(status) {
  return /sit sold pa|sitsold pa|signed contract|production review|job prep|funding|pace|install|new roof|roof started|paid|commission|collect/.test(norm(status));
}

function paFields(insp) {
  let f = insp && insp.pa_fields;
  if (typeof f === "string") { try { f = JSON.parse(f); } catch { f = {}; } }
  return f && typeof f === "object" ? f : {};
}

// insp: the inspection row. appt: its latest NON-CANCELLED pa_appointment (or null).
// nowMs: Date.now(). Returns one of signed|dead|upcoming|missed|need_appt.
export function damageState(insp, appt, nowMs) {
  // "Signed" requires REAL evidence, not the optimistic "Sit Sold PA" status (proven
  // meaningless — a PA can still be chasing a homeowner while the status reads that):
  //   • pa_signed_at   — homeowner signed in our app (a hard signature), OR
  //   • a PA-Filed / INS-approved / ISS milestone date — the PA actually filed the claim, OR
  //   • a signed LOR/PAC document on file / Five Star "Waiting Docs" — real paperwork.
  // The soft signals (milestone/LOR/Waiting Docs) don't count on a RELEASED deal (stale
  // from before it was handed back); a fresh app signature always does.
  const f = paFields(insp);
  const filed = !!(f.pa_filed || f.ins_approved || f.iss_uploaded);
  const released = wasReleased(insp);
  const signed = insp.pa_signed_at
    || (!released && (filed || insp.pa_stage === "waiting_docs" || /\b(lor|pac)\b/i.test(insp.docs_signed || "")));
  if (signed) return "signed";
  // Explicitly closed: homeowner Not Interested (BTR-NI) or office-marked dead (DQ).
  if (norm(insp.jn_status) === "btr ni" || insp.pa_stage === "dead") return "dead";
  if (!appt) return "need_appt";
  const t = appt.start_at ? new Date(appt.start_at).getTime() : 0;
  if (t && t > nowMs) return "upcoming";
  return "missed"; // a past (or date-less) appointment that never resulted in a signing
}

export const damageNeedsGoback = (state) => state === "need_appt" || state === "missed";
