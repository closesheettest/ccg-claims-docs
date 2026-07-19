// Standalone training page (?mode=harvesttraining). Managers open it from their TMS
// dashboard via ?manager=<token>; reps could use ?rt=<token>. Runs the take-it flow for
// the right track and, on pass, shows a "certified" screen (their dashboard re-checks
// and unlocks the tools). Records the pass keyed by their token.
import React, { useMemo, useState } from "react";
import HarvestTraining from "./HarvestTraining";

const FONT = "'Nunito', system-ui, sans-serif";
const OSWALD = "'Oswald', sans-serif";

export default function HarvestTrainingPage() {
  const { track, userType, userKey } = useMemo(() => {
    try {
      const q = new URLSearchParams(window.location.search);
      const mgr = q.get("manager");
      if (mgr) return { track: "manager", userType: "manager", userKey: mgr };
      const rt = q.get("rt");
      if (rt) return { track: "rep", userType: "rep", userKey: rt };
    } catch { /* ignore */ }
    return { track: null };
  }, []);
  const [done, setDone] = useState(false);

  if (!track) {
    return (
      <div style={{ position: "fixed", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: FONT, background: "#f1f5f9", padding: 24 }}>
        <div style={{ maxWidth: 380, textAlign: "center", background: "#fff", borderRadius: 16, padding: "28px 24px", boxShadow: "0 2px 12px rgba(0,0,0,.1)" }}>
          <div style={{ fontSize: 40, marginBottom: 10 }}>🎓</div>
          <div style={{ fontSize: 17, fontWeight: 800, fontFamily: OSWALD, marginBottom: 8 }}>Tool Training</div>
          <div style={{ fontSize: 14, color: "#475569", lineHeight: 1.5 }}>Open this from your dashboard link so we know who you are.</div>
        </div>
      </div>
    );
  }

  if (done) {
    return (
      <div style={{ position: "fixed", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: FONT, background: "#f1f5f9", padding: 24 }}>
        <div style={{ maxWidth: 400, textAlign: "center", background: "#fff", borderRadius: 16, padding: "32px 26px", boxShadow: "0 2px 12px rgba(0,0,0,.1)" }}>
          <div style={{ fontSize: 48, marginBottom: 6 }}>🎉</div>
          <div style={{ fontSize: 22, fontWeight: 800, fontFamily: OSWALD, color: "#16a34a" }}>You're certified!</div>
          <div style={{ fontSize: 14.5, color: "#475569", lineHeight: 1.55, marginTop: 8 }}>Head back to your dashboard — your Harvesting tools are unlocked now.</div>
        </div>
      </div>
    );
  }

  return <HarvestTraining track={track} userType={userType} userKey={userKey} toolLabel="your Harvesting tools" onPass={() => setDone(true)} />;
}
