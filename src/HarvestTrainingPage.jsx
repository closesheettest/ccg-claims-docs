// Standalone training page (?mode=harvesttraining). Managers open it from their TMS
// dashboard via ?manager=<token>; reps could use ?rt=<token>. Runs the take-it flow for
// the right track and, on pass, shows a "certified" screen (their dashboard re-checks
// and unlocks the tools). Records the pass keyed by their token.
import React, { useEffect, useMemo, useState } from "react";
import HarvestTraining from "./HarvestTraining";
import { supabase } from "./lib/supabase";

const FONT = "'Nunito', system-ui, sans-serif";
const OSWALD = "'Oswald', sans-serif";

export default function HarvestTrainingPage() {
  const { userType, userKey, isManager } = useMemo(() => {
    try {
      const q = new URLSearchParams(window.location.search);
      const mgr = q.get("manager");
      if (mgr) return { userType: "manager", userKey: mgr, isManager: true };
      const rt = q.get("rt");
      if (rt) return { userType: "rep", userKey: rt, isManager: false };
    } catch { /* ignore */ }
    return {};
  }, []);
  // A rep's track is their LEVEL (senior/junior) — resolve it from their token. Managers
  // are the manager track. null = still resolving.
  const [track, setTrack] = useState(isManager ? "manager" : null);
  useEffect(() => {
    if (isManager) { setTrack("manager"); return; }
    if (!userKey) return;
    let live = true;
    supabase.from("sales_reps").select("harvest_level").eq("harvest_token", userKey).maybeSingle()
      .then(({ data }) => { if (live) setTrack(data?.harvest_level === "senior" ? "senior" : "junior"); },
        () => { if (live) setTrack("junior"); });
    return () => { live = false; };
  }, [isManager, userKey]);
  const [done, setDone] = useState(false);

  if (!userKey) {
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
  if (!track) {
    return <div style={{ position: "fixed", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: FONT, background: "#f1f5f9", color: "#94a3b8", fontWeight: 700 }}>Loading your training…</div>;
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
