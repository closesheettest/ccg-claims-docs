// netlify/functions/_retail.js
//
// Shared back-to-retail (BTR) stage classifier. ONE source of truth so the master
// report's "needs go-back status" and the reps' go-back map (visit-deal-list) can
// never drift apart — a drift here is exactly what put LOST/DQ deals on reps' retail
// go-back lists while the report correctly excluded them.
//
// retailStage(jn_status, retail_outcome) → one of RETAIL_STAGES. "not_worked" is the
// only stage that still needs a rep to go back and work the retail roof; everything
// else is either handled, dead, or in another workflow.

export const RETAIL_STAGES = ["not_worked", "declined", "no_sit", "appt_scheduled", "sit_pending", "no_sale", "credit_denial", "sold", "lost"];

export function retailNorm(s) { return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(); }

export function retailStage(status, outcome) {
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
