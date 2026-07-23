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
import React, { useEffect, useMemo, useState } from "react";
import HarvestNav from "./HarvestNav";
import { supabase } from "./lib/supabase";

const OSWALD = "'Oswald', sans-serif";
const FONT = "'Nunito', -apple-system, sans-serif";

const ROLE_LABEL = { all: "Everyone", sr: "Senior", jr: "Junior" };
const ROLE_COLOR = { all: "#475569", sr: "#b91c1c", jr: "#1d4ed8" };

// ── The playbook ─────────────────────────────────────────────────────────────
const SCENARIOS = [
  {
    key: "selfgen", icon: "🏚️", role: "all",
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
    key: "clover", icon: "🍀", role: "all",
    q: "Green 🍀 clover pins showed up around a job we're installing",
    steps: [
      "That's a Clover Leaf — when one of our roofs STARTS, the map auto-pins the owner-occupied neighbors so you can knock while the crew is visibly on it: “we're doing your neighbor's roof right now.”",
      "At each clover door, tap the result: ✅ Roof looks fine · 🏚️ Damage observed · 🏠 Not home · 📅 Book an appt / ✍️ Sign the inspection · 🚫 Not interested.",
      "The first rep to work a clover door OWNS it — it's yours to finish (others see it belongs to you).",
      "🏚️ Damage-observed doors stay on the map for good (an old roof with damage is a lead). The rest clear once the install wraps.",
    ],
    note: "These are pre-checked against county records — every clover door is owner-occupied, so you're always talking to the decision-maker.",
  },
  {
    key: "owner_more", icon: "🏘️", role: "sr",
    q: "That owner owns MORE properties",
    steps: [
      "On your self-gen pin's card, tap “Owner owns another property.”",
      "Type the other address — it drops a live pin under the same owner.",
      "Repeat for every house they own. Sign them all without walking to each one.",
    ],
  },
  {
    key: "appt_day", icon: "📅", role: "sr",
    q: "I have an appointment today",
    steps: [
      "The map tells you the moment you open it — right at the top.",
      "Tap “📅 Have an appt? Plan your day!” → set your start time → Build my plan.",
      "It builds your whole day AROUND the appointment: doors before you're due (kept close so you're never far), then more doors after, until 8 PM.",
      "When you finish the appointment, tap “Appt done” — it re-plans the rest from wherever you're standing, off the real clock. Run long, it trims. Finish early, it adds.",
    ],
  },
  {
    key: "mgr_plan", icon: "🟣", role: "sr",
    q: "My manager planned my day",
    steps: [
      "You'll see a purple banner: “Your day is planned by your manager,” with your doors ready.",
      "Tap ▶ Start my day — it routes your assigned block.",
      "Also have an appointment that day? Plan around the appointment instead — the map will point you the right way so the two never collide.",
    ],
  },
  {
    key: "open_day", icon: "🗺️", role: "all",
    q: "Open day — nothing planned",
    steps: [
      "Tap ▢ Route an area and drag a box around the neighborhood you want.",
      "It routes every door inside the box in clean street order — no criss-crossing, no backtracking.",
      "Have an appointment today? Use “📅 Plan your day” instead — it builds the day around it.",
    ],
  },
  {
    key: "locked_pin", icon: "🔒", role: "all",
    q: "I tapped a pin and the homeowner info is locked",
    steps: [
      "Homeowner name + address only show once the door is ON your route — that keeps every knock an honest, routed knock.",
      "Route the area (or run your manager-planned day) — the moment that door is a stop, the details open up.",
    ],
  },
  {
    key: "not_home", icon: "🚪", role: "all",
    q: "Nobody answered",
    steps: [
      "Tap 🏠 Not home and keep moving — it's saved, your manager sees it live.",
      "At the end of the round, tap “Next round” — it re-runs your not-homes in fresh street order for a second pass.",
    ],
  },
  {
    key: "restatus", icon: "🔁", role: "all",
    q: "I statused a door… then the homeowner came out",
    steps: [
      "While you're on your route, just tap that pin again and change the status.",
      "Nothing's ever locked while you're working it — the latest status wins.",
    ],
  },
  {
    key: "nosit_rebook", icon: "🔄", role: "sr",
    q: "A no-sit wants to re-book",
    steps: [
      "Tap the pin → “🔄 Reschedule appointment.” You'll see the original appointment that fell through.",
      "Pick the new time — SAME-DAY slots are allowed on no-sits, so book them for later TODAY while you're standing there.",
      "It resets the appointment in JobNimbus and assigns the deal to YOU — contact and job.",
    ],
  },
  {
    key: "sign_now", icon: "✍️", role: "all",
    q: "They're ready to sign RIGHT NOW",
    steps: [
      "Tap “Sign Inspection” — the claim form opens already filled with their address.",
      "Confirm the details, have them sign on your phone.",
      "The pin flips to Sold and JobNimbus gets the job + signed agreement automatically. No paperwork later.",
    ],
  },
  {
    key: "retail_btr", icon: "🏠", role: "all",
    q: "They declined the inspection — but want retail",
    steps: [
      "Tap “Retail (BTR) appointment” and pick a time.",
      "It books the retail appointment in JobNimbus and counts on your pay like a signup.",
    ],
  },
  {
    key: "come_back", icon: "⏳", role: "all",
    q: "“Come back Tuesday”",
    steps: [
      "Tap “⏳ Pending (come back)” → set the date and a quick note.",
      "The door shows back up when it's due — no sticky notes, nothing forgotten.",
    ],
  },
  {
    key: "gps_far", icon: "📍", role: "all",
    q: "GPS says I'm far away — but I'm AT the door",
    steps: [
      "Tap “Status anyway” and keep working.",
      "Heads up: every status logs its distance and managers see it — use the override only when you're truly at the door.",
    ],
  },
  {
    key: "reroute", icon: "🧭", role: "all",
    q: "My route doesn't match where I'm standing anymore",
    steps: [
      "Tap “📍 Re-route from where I am.”",
      "Everything still left to work gets re-ordered from your live location — no walking away and back.",
    ],
  },
  {
    key: "baby_blue", icon: "🔵", role: "all",
    q: "A door is showing baby blue",
    steps: [
      "That door was already worked TODAY by another rep. Skip it — it's handled.",
    ],
  },
  {
    key: "gobacks", icon: "📋", role: "all",
    q: "Where do my follow-ups live?",
    steps: [
      "Open the “Today's go-backs” card — every damage, no-damage, and retail come-back, dated.",
      "Handle each one right from the card with its inline buttons.",
    ],
  },
  {
    key: "rotate", icon: "🧭", role: "all",
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
  // OFFICE-EDITABLE audience per card — stored in app_settings.harvest_howto_roles
  // as { cardKey: 'all'|'sr'|'jr' }, overriding the in-code defaults. Neal flips who
  // sees a card right on the admin view (&nav=1), no deploy needed.
  const [roleOverrides, setRoleOverrides] = useState({});
  useEffect(() => {
    (async () => {
      try {
        const { data } = await supabase.from("app_settings").select("value").eq("key", "harvest_howto_roles").maybeSingle();
        const v = data?.value;
        const parsed = v ? (typeof v === "string" ? JSON.parse(v) : v) : {};
        if (parsed && typeof parsed === "object") setRoleOverrides(parsed);
      } catch { /* defaults stand */ }
    })();
  }, []);
  const roleOf = (s) => roleOverrides[s.key] || s.role;
  const saveRole = async (cardKey, newRole) => {
    const next = { ...roleOverrides, [cardKey]: newRole };
    setRoleOverrides(next);
    try {
      await supabase.from("app_settings").upsert(
        { key: "harvest_howto_roles", value: JSON.stringify(next), updated_at: new Date().toISOString() },
        { onConflict: "key" },
      );
    } catch { /* stays local this session */ }
  };
  const list = SCENARIOS.filter((s) => role === "everything" || roleOf(s) === "all" || roleOf(s) === role);

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
              {showNav ? (
                // Office view: the audience is EDITABLE — tap a chip to change who sees
                // this card (saved instantly, applies to every rep's view).
                <span style={{ display: "inline-flex", gap: 4, flexShrink: 0 }} onClick={(e) => e.preventDefault()}>
                  {["all", "sr", "jr"].map((rk) => (
                    <button key={rk} type="button"
                      onClick={(e) => { e.preventDefault(); e.stopPropagation(); saveRole(s.key, rk); }}
                      style={{ fontSize: 10.5, fontWeight: 800, cursor: "pointer", borderRadius: 999, padding: "3px 9px", letterSpacing: "0.03em", textTransform: "uppercase",
                        color: roleOf(s) === rk ? "#fff" : ROLE_COLOR[rk],
                        background: roleOf(s) === rk ? ROLE_COLOR[rk] : `${ROLE_COLOR[rk]}11`,
                        border: `1px solid ${ROLE_COLOR[rk]}${roleOf(s) === rk ? "" : "33"}` }}>
                      {ROLE_LABEL[rk]}
                    </button>
                  ))}
                </span>
              ) : (
                <span style={{ fontSize: 10.5, fontWeight: 800, color: ROLE_COLOR[roleOf(s)], border: `1px solid ${ROLE_COLOR[roleOf(s)]}33`, background: `${ROLE_COLOR[roleOf(s)]}11`, borderRadius: 999, padding: "3px 9px", flexShrink: 0, letterSpacing: "0.03em", textTransform: "uppercase" }}>{ROLE_LABEL[roleOf(s)]}</span>
              )}
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
