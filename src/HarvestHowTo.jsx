// Harvesting Map — HOW-TO / playbook page (?mode=harvesthowto).
//
// A collapsible, scenario-based instruction page: "here's the situation → here's
// exactly what you do." One card per real-world situation (a damaged roof with no
// pin, a no-sit that wants to re-book, GPS showing you far, …), each tagged for
// who it applies to (Everyone / Senior / Junior) with a role filter up top.
//
// Two ways in:
//   • Office/admin: the "📖 How-To" tab on the harvest nav (?mode=harvesthowto&nav=1
//     shows the admin nav).
//   • Reps: the ❓ button on their map opens the plain page (no admin nav).
//
// Static content by design — update this file when a flow changes (same commit,
// per the keep-docs-in-sync rule).
import React, { useMemo, useState } from "react";
import HarvestNav from "./HarvestNav";

const OSWALD = "'Oswald', sans-serif";
const FONT = "'Nunito', -apple-system, sans-serif";

const ROLE_LABEL = { all: "Everyone", sr: "Senior", jr: "Junior" };
const ROLE_COLOR = { all: "#475569", sr: "#b91c1c", jr: "#1d4ed8" };

// ── The playbook ─────────────────────────────────────────────────────────────
const SCENARIOS = [
  {
    icon: "🏚️", role: "all",
    q: "A house has storm damage — but it's NOT a pin",
    steps: [
      "Tap the purple 🏠 button (top-right of the map), then tap the roof of the house.",
      "The map runs the county records check — “Owner occupied?” tells you if the person living there actually owns it, BEFORE you knock.",
      "Owner-occupied → pick your move: ✍️ Sign Inspection · 🏠 Retail appointment · ⏳ Pending (come back) · 🚫 Not interested.",
      "NOT owner-occupied (a rental) → mark the ✕ so no rep wastes that door again. If the landlord's interested anyway, use the override and add their phone.",
    ],
    note: "It logs as YOUR self-generated lead — JobNimbus source “Self Generated,” credited to you.",
  },
  {
    icon: "🏘️", role: "sr",
    q: "That owner owns MORE properties",
    steps: [
      "On your self-gen pin's card, tap “Owner owns another property.”",
      "Type the other address — it drops a live pin under the same owner.",
      "Repeat for every house they own. Sign them all without walking to each one.",
    ],
  },
  {
    icon: "📅", role: "sr",
    q: "I have an appointment today",
    steps: [
      "The map tells you the moment you open it — right at the top.",
      "Tap “📅 Have an appt? Plan your day!” → set your start time → Build my plan.",
      "It builds your whole day AROUND the appointment: doors before you're due (kept close so you're never far), then more doors after, until 8 PM.",
      "When you finish the appointment, tap “Appt done” — it re-plans the rest from wherever you're standing, off the real clock. Run long, it trims. Finish early, it adds.",
    ],
  },
  {
    icon: "🟣", role: "sr",
    q: "My manager planned my day",
    steps: [
      "You'll see a purple banner: “Your day is planned by your manager,” with your doors ready.",
      "Tap ▶ Start my day — it routes your assigned block.",
      "Also have an appointment that day? Plan around the appointment instead — the map will point you the right way so the two never collide.",
    ],
  },
  {
    icon: "🗺️", role: "all",
    q: "Open day — nothing planned",
    steps: [
      "▶ Start my day — routes the nearest doors from where you're standing, street by street.",
      "Or ▢ Route an area — drag a box around the neighborhood you want; it routes every door inside it in clean street order.",
    ],
  },
  {
    icon: "🔒", role: "all",
    q: "I tapped a pin and the homeowner info is locked",
    steps: [
      "Homeowner name + address only show once the door is ON your route — that keeps every knock an honest, routed knock.",
      "Start your day or route the area — the moment that door is a stop, the details open up.",
    ],
  },
  {
    icon: "🚪", role: "all",
    q: "Nobody answered",
    steps: [
      "Tap 🏠 Not home and keep moving — it's saved, your manager sees it live.",
      "At the end of the round, tap “Next round” — it re-runs your not-homes in fresh street order for a second pass.",
    ],
  },
  {
    icon: "🔁", role: "all",
    q: "I statused a door… then the homeowner came out",
    steps: [
      "While you're on your route, just tap that pin again and change the status.",
      "Nothing's ever locked while you're working it — the latest status wins.",
    ],
  },
  {
    icon: "🔄", role: "sr",
    q: "A no-sit wants to re-book",
    steps: [
      "Tap the pin → “🔄 Reschedule appointment.” You'll see the original appointment that fell through.",
      "Pick the new time — SAME-DAY slots are allowed on no-sits, so book them for later TODAY while you're standing there.",
      "It resets the appointment in JobNimbus and assigns the deal to YOU — contact and job.",
    ],
  },
  {
    icon: "✍️", role: "all",
    q: "They're ready to sign RIGHT NOW",
    steps: [
      "Tap “Sign Inspection” — the claim form opens already filled with their address.",
      "Confirm the details, have them sign on your phone.",
      "The pin flips to Sold and JobNimbus gets the job + signed agreement automatically. No paperwork later.",
    ],
  },
  {
    icon: "🏠", role: "all",
    q: "They declined the inspection — but want retail",
    steps: [
      "Tap “Retail (BTR) appointment” and pick a time.",
      "It books the retail appointment in JobNimbus and counts on your pay like a signup.",
    ],
  },
  {
    icon: "⏳", role: "all",
    q: "“Come back Tuesday”",
    steps: [
      "Tap “⏳ Pending (come back)” → set the date and a quick note.",
      "The door shows back up when it's due — no sticky notes, nothing forgotten.",
    ],
  },
  {
    icon: "📍", role: "all",
    q: "GPS says I'm far away — but I'm AT the door",
    steps: [
      "Tap “Status anyway” and keep working.",
      "Heads up: every status logs its distance and managers see it — use the override only when you're truly at the door.",
    ],
  },
  {
    icon: "🧭", role: "all",
    q: "My route doesn't match where I'm standing anymore",
    steps: [
      "Tap “📍 Re-route from where I am.”",
      "Everything still left to work gets re-ordered from your live location — no walking away and back.",
    ],
  },
  {
    icon: "🔵", role: "all",
    q: "A door is showing baby blue",
    steps: [
      "That door was already worked TODAY by another rep. Skip it — it's handled.",
    ],
  },
  {
    icon: "📋", role: "all",
    q: "Where do my follow-ups live?",
    steps: [
      "Open the “Today's go-backs” card — every damage, no-damage, and retail come-back, dated.",
      "Handle each one right from the card with its inline buttons.",
    ],
  },
  {
    icon: "🧭", role: "all",
    q: "Rotate the map like a car GPS",
    steps: [
      "Twist two fingers on the map to rotate it.",
      "Tap the compass for heading-up — the way you're facing is up, like driving directions.",
      "Tap the compass again to snap back to North (taps on pins are exact again).",
    ],
  },
];

export default function HarvestHowTo() {
  const showNav = useMemo(() => { try { return new URLSearchParams(window.location.search).get("nav") === "1"; } catch { return false; } }, []);
  const [role, setRole] = useState("everything"); // everything | sr | jr
  const list = SCENARIOS.filter((s) => role === "everything" || s.role === "all" || s.role === role);

  return (
    <div style={{ maxWidth: 760, margin: "0 auto", padding: "18px 14px 60px", fontFamily: FONT }}>
      {showNav && <HarvestNav active="howto" />}
      <div style={{ fontSize: 24, fontWeight: 800, fontFamily: OSWALD }}>📖 Harvesting Map — How-To</div>
      <div style={{ fontSize: 13.5, color: "#64748b", margin: "4px 0 14px" }}>
        Real situations, exact moves. Tap any card to open it.
      </div>

      {/* Role filter */}
      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        {[["everything", "Everything"], ["sr", "Senior rep"], ["jr", "Junior rep"]].map(([k, l]) => (
          <button key={k} type="button" onClick={() => setRole(k)}
            style={{ fontSize: 13, fontWeight: 700, padding: "7px 14px", borderRadius: 999, cursor: "pointer",
              border: role === k ? "2px solid #0a0a0a" : "1px solid #cbd5e1",
              background: role === k ? "#0a0a0a" : "#fff", color: role === k ? "#fff" : "#475569" }}>{l}</button>
        ))}
      </div>

      <div style={{ display: "grid", gap: 10 }}>
        {list.map((s, i) => (
          <details key={i} style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 14, overflow: "hidden" }}>
            <summary style={{ listStyle: "none", cursor: "pointer", padding: "14px 16px", display: "flex", alignItems: "center", gap: 12, WebkitTapHighlightColor: "transparent" }}>
              <span style={{ fontSize: 22, flexShrink: 0 }}>{s.icon}</span>
              <span style={{ flex: 1, fontSize: 15, fontWeight: 800, color: "#0f172a", lineHeight: 1.3 }}>{s.q}</span>
              <span style={{ fontSize: 10.5, fontWeight: 800, color: ROLE_COLOR[s.role], border: `1px solid ${ROLE_COLOR[s.role]}33`, background: `${ROLE_COLOR[s.role]}11`, borderRadius: 999, padding: "3px 9px", flexShrink: 0, letterSpacing: "0.03em", textTransform: "uppercase" }}>{ROLE_LABEL[s.role]}</span>
              <span style={{ color: "#94a3b8", fontSize: 13, flexShrink: 0 }}>▾</span>
            </summary>
            <div style={{ padding: "0 16px 14px 50px" }}>
              <ol style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 7 }}>
                {s.steps.map((st, j) => (
                  <li key={j} style={{ fontSize: 13.5, color: "#334155", lineHeight: 1.5 }}>{st}</li>
                ))}
              </ol>
              {s.note && (
                <div style={{ marginTop: 10, background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: 10, padding: "8px 12px", fontSize: 12.5, color: "#166534", fontWeight: 600 }}>
                  💡 {s.note}
                </div>
              )}
            </div>
          </details>
        ))}
      </div>

      <div style={{ marginTop: 22, textAlign: "center", fontSize: 12.5, color: "#94a3b8" }}>
        Statusing always happens on a route — that's how every knock gets logged in order, at the door.
      </div>
    </div>
  );
}
