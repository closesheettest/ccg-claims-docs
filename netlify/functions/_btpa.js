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
// States mirror Five Star's own hub pipeline (pa-company-api), so the report matches it:
//   signed        → the PA signed the homeowner for the claim. EXACT Five Star rule:
//                   pa_fields.pa_signup === "Signed" OR pa_signed_at. NOT the optimistic
//                   "Sit Sold PA" status, NOT the intake LOR, NOT "Waiting on Docs".
//   dead          → homeowner Not Interested (BTR-NI) OR office-closed DQ (pa_stage "dead").
//   waiting_docs  → the PA is collecting documents (Five Star "Waiting on Docs"). The PA's
//                   job — OFF the rep's go-back list.
//   rescheduling  → an appointment fell through (PA marked "rescheduling", OR the booked
//                   time came and went) → needs rebooking. Rep OR PA can grab it.
//   upcoming      → a PA appointment is booked for later.
//   need_appt     → no PA appointment ever → needs one SCHEDULED (the rep).
//
// "active" pa_stage is leftover auto-assign noise and is ignored. The rep works exactly
// two states: need_appt + rescheduling (the PA also works rescheduling; whoever gets it).

const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

// A won/signed Public-Adjuster JN status (normalized). KEPT for other callers, but NOT
// used to decide "signed" — the office sets "Sit Sold PA" optimistically (the PA may
// still be chasing the homeowner), so the status alone is not proof of a signing.
export function jnPaSigned(status) {
  return /sit sold pa|sitsold pa|signed contract|production review|job prep|funding|pace|install|new roof|roof started|paid|commission|collect/.test(norm(status));
}

function paFields(insp) {
  let f = insp && insp.pa_fields;
  if (typeof f === "string") { try { f = JSON.parse(f); } catch { f = {}; } }
  return f && typeof f === "object" ? f : {};
}

// insp: the inspection row. appt: its latest NON-CANCELLED pa_appointment (or null).
// nowMs: Date.now(). Returns signed|dead|waiting_docs|rescheduling|upcoming|need_appt.
export function damageState(insp, appt, nowMs) {
  const f = paFields(insp);
  // SIGNED — the exact rule Five Star's hub uses, nothing looser.
  if (f.pa_signup === "Signed" || insp.pa_signed_at) return "signed";
  // Explicitly closed: homeowner Not Interested (BTR-NI) or office-marked dead (DQ).
  if (norm(insp.jn_status) === "btr ni" || insp.pa_stage === "dead") return "dead";
  // The PA is collecting documents — their job, off the rep's list.
  if (insp.pa_stage === "waiting_docs") return "waiting_docs";
  const t = appt && appt.start_at ? new Date(appt.start_at).getTime() : 0;
  const future = t && t > nowMs;
  // A no-sit that was REBOOKED ("Reschedule — pick a time") and its new appointment is
  // still ahead → "rescheduled" (No sit rescheduled), distinct from a fresh first appt.
  if (insp.pa_stage === "rescheduled" && future) return "rescheduled";
  // A booked future appointment (no reschedule history) → upcoming.
  if (future) return "upcoming";
  // No upcoming appointment: an explicit no-sit stage (needs (re)booking), or a past
  // appt that fell through — both mean "no-sit → needs rebooking" (rep or PA).
  if (insp.pa_stage === "rescheduling" || insp.pa_stage === "rescheduled") return "rescheduling";
  if (!appt) return "need_appt";
  return "rescheduling"; // a past (or date-less) appointment that never resulted in a signing
}

export const damageNeedsGoback = (state) => state === "need_appt" || state === "rescheduling";
