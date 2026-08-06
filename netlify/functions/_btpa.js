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

// A won/signed Public-Adjuster JN status (normalized so "Sit Sold PA", "Sitsold PA",
// "New Roof", "Install …" all match — the earlier "sitsold pa" typo missed the spaced
// form the office actually uses).
export function jnPaSigned(status) {
  return /sit sold pa|sitsold pa|signed contract|production review|job prep|funding|pace|install|new roof|roof started|paid|commission|collect/.test(norm(status));
}

// insp: the inspection row. appt: its latest NON-CANCELLED pa_appointment (or null).
// nowMs: Date.now(). Returns one of signed|dead|upcoming|missed|need_appt.
export function damageState(insp, appt, nowMs) {
  // A won JN status only counts as signed if the deal WASN'T released (else it's stale).
  // pa_signed_at / Waiting Docs / LOR-PAC are real signatures and stand on their own.
  const signed = insp.pa_signed_at || insp.pa_stage === "waiting_docs" || /\b(lor|pac)\b/i.test(insp.docs_signed || "") || (jnPaSigned(insp.jn_status) && !wasReleased(insp));
  if (signed) return "signed";
  // Explicitly closed: homeowner Not Interested (BTR-NI) or office-marked dead (DQ).
  if (norm(insp.jn_status) === "btr ni" || insp.pa_stage === "dead") return "dead";
  if (!appt) return "need_appt";
  const t = appt.start_at ? new Date(appt.start_at).getTime() : 0;
  if (t && t > nowMs) return "upcoming";
  return "missed"; // a past (or date-less) appointment that never resulted in a signing
}

export const damageNeedsGoback = (state) => state === "need_appt" || state === "missed";
