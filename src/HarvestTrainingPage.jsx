// Training landing (?mode=harvesttraining). Managers open it via ?manager=<token>, reps via
// ?rt=<token>. Flow:
//   1. "Why you want to use DoorDispatcher" video plays at top.
//   2. "How to use DoorDispatcher" card → opens the How-To tool list (each tool marks WATCHED
//      when opened, carrying this rep's token as ?train=).
//   3. Progress bar (X of N tools watched). At 100% the 80% TEST unlocks.
//   4. Pass the test → certified (their dashboard re-checks and unlocks the tools).
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import HarvestTraining from "./HarvestTraining";
import { supabase } from "./lib/supabase";

const FONT = "'Nunito', system-ui, sans-serif";
const OSWALD = "'Oswald', sans-serif";

export default function HarvestTrainingPage({ onDone } = {}) {
  const { userType, userKey, isManager, previewRole } = useMemo(() => {
    try {
      const q = new URLSearchParams(window.location.search);
      const pv = (q.get("preview") || "").toLowerCase();
      // Office preview — see the JR or SR landing without a real rep token.
      if (pv === "jr" || pv === "junior") return { userType: "preview", userKey: "preview-jr", previewRole: "junior" };
      if (pv === "sr" || pv === "senior") return { userType: "preview", userKey: "preview-sr", previewRole: "senior" };
      const mgr = q.get("manager");
      if (mgr) return { userType: "manager", userKey: mgr, isManager: true };
      const rt = q.get("rt");
      if (rt) return { userType: "rep", userKey: rt, isManager: false };
    } catch { /* ignore */ }
    return {};
  }, []);

  const [track, setTrack] = useState(isManager ? "manager" : previewRole || null);
  useEffect(() => {
    if (previewRole) { setTrack(previewRole); return; }
    if (isManager) { setTrack("manager"); return; }
    if (!userKey) return;
    let live = true;
    supabase.from("sales_reps").select("harvest_level").eq("harvest_token", userKey).maybeSingle()
      .then(({ data }) => { if (live) setTrack(data?.harvest_level === "senior" ? "senior" : "junior"); },
        () => { if (live) setTrack("junior"); });
    return () => { live = false; };
  }, [isManager, userKey]);

  const roleKey = track === "senior" ? "sr" : track === "junior" ? "jr" : "everything";
  const [stage, setStage] = useState("landing"); // landing | test
  const [done, setDone] = useState(false);
  const [whyUrl, setWhyUrl] = useState("");
  const [total, setTotal] = useState(null);
  const [watched, setWatched] = useState(0);

  // Load the "Why" video + how many tools this rep must watch + how many they have.
  const loadProgress = useCallback(async () => {
    if (!track || !userKey) return;
    const [cfg, toolsRes] = await Promise.all([
      supabase.from("harvest_howto_config").select("why_video_url_jr,why_video_url_sr").eq("id", "main").maybeSingle(),
      supabase.from("harvest_howto_tools").select("id,role").eq("active", true),
    ]);
    // Junior gets the JR "why" pitch; senior + manager get the SR one.
    setWhyUrl((track === "junior" ? cfg.data?.why_video_url_jr : cfg.data?.why_video_url_sr) || "");
    const visible = (toolsRes.data || []).filter((t) => roleKey === "everything" || t.role === "all" || t.role === roleKey);
    const visibleIds = new Set(visible.map((t) => t.id));
    setTotal(visible.length);
    const w = await supabase.from("harvest_howto_watched").select("tool_id").eq("user_key", userKey);
    setWatched((w.data || []).filter((r) => visibleIds.has(r.tool_id)).length);
  }, [track, userKey, roleKey]);

  useEffect(() => { loadProgress(); }, [loadProgress]);
  // Re-check progress whenever they come back to this tab (after watching tools).
  useEffect(() => {
    const on = () => { if (document.visibilityState === "visible") loadProgress(); };
    document.addEventListener("visibilitychange", on);
    window.addEventListener("focus", on);
    return () => { document.removeEventListener("visibilitychange", on); window.removeEventListener("focus", on); };
  }, [loadProgress]);

  if (!userKey) return <Splash emoji="🎓" title="Tool Training" msg="Open this from your dashboard link so we know who you are." />;
  if (!track || total === null) return <Splash msg="Loading your training…" plain />;
  if (done) return <Splash emoji="🎉" title="You're certified!" msg="Head back to your dashboard — your DoorDispatcher tools are unlocked now." good />;

  if (stage === "test") {
    return <HarvestTraining track={track} userType={userType} userKey={userKey} startAtTest toolLabel="your DoorDispatcher tools" onPass={() => { setDone(true); onDone && onDone(); }} />;
  }

  const allWatched = total > 0 && watched >= total;
  const pct = total > 0 ? Math.round((watched / total) * 100) : 0;
  const howToHref = `/?mode=harvesthowto&role=${track}&train=${encodeURIComponent(userKey)}`;

  return (
    <div style={{ maxWidth: 720, margin: "0 auto", padding: "22px 16px 70px", fontFamily: FONT }}>
      <div style={{ fontSize: 25, fontWeight: 900, fontFamily: OSWALD, textAlign: "center" }}>🎓 DoorDispatcher Certification</div>
      <div style={{ fontSize: 13.5, color: "#64748b", textAlign: "center", margin: "4px 0 20px" }}>Watch both parts, then the test unlocks.</div>

      {/* 1) WHY */}
      <div style={{ fontSize: 12, fontWeight: 800, color: "#64748b", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 6 }}>Part 1 — Watch this first</div>
      <div style={{ fontSize: 18, fontWeight: 800, fontFamily: OSWALD, marginBottom: 8 }}>WHY WE USE IT!</div>
      {whyUrl ? <VideoEmbed url={whyUrl} /> : <Placeholder text="🎬 The office is adding this video." />}

      {/* 2) HOW → the tool list */}
      <div style={{ fontSize: 12, fontWeight: 800, color: "#64748b", textTransform: "uppercase", letterSpacing: "0.05em", margin: "26px 0 6px" }}>Part 2 — Learn every tool</div>
      <a href={howToHref} style={{ display: "flex", alignItems: "center", gap: 12, textDecoration: "none", background: "#0f172a", color: "#fff", borderRadius: 14, padding: "16px 18px" }}>
        <span style={{ fontSize: 26 }}>📖</span>
        <span style={{ flex: 1 }}>
          <span style={{ display: "block", fontSize: 16.5, fontWeight: 800, fontFamily: OSWALD }}>HOW WE USE IT!</span>
          <span style={{ display: "block", fontSize: 12.5, opacity: 0.8, marginTop: 1 }}>Open each tool and watch it — that's what unlocks your test.</span>
        </span>
        <span style={{ fontSize: 22 }}>›</span>
      </a>

      {/* Progress */}
      <div style={{ marginTop: 16, background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12, padding: "14px 16px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, fontWeight: 800, color: "#334155" }}>
          <span>Tools watched</span><span>{watched} of {total}</span>
        </div>
        <div style={{ height: 10, background: "#e5e7eb", borderRadius: 999, marginTop: 8, overflow: "hidden" }}>
          <div style={{ height: "100%", width: `${pct}%`, background: allWatched ? "#16a34a" : "#2563eb", borderRadius: 999, transition: "width .3s" }} />
        </div>
        {!allWatched && <div style={{ fontSize: 12, color: "#94a3b8", marginTop: 8 }}>Open every tool above. Come back here — this updates automatically.</div>}
      </div>

      {/* 3) TEST */}
      <div style={{ marginTop: 22, textAlign: "center" }}>
        {allWatched ? (
          <button type="button" onClick={() => setStage("test")}
            style={{ width: "100%", background: "#16a34a", color: "#fff", border: "none", borderRadius: 14, padding: "16px", fontSize: 17, fontWeight: 900, fontFamily: OSWALD, cursor: "pointer", boxShadow: "0 3px 12px rgba(22,163,74,.3)" }}>
            ✅ Take the test
          </button>
        ) : (
          <div style={{ background: "#f8fafc", border: "1px dashed #cbd5e1", borderRadius: 14, padding: "16px", color: "#94a3b8", fontSize: 15, fontWeight: 800, fontFamily: OSWALD }}>
            🔒 Test unlocks once you've watched all {total} tools
          </div>
        )}
      </div>
    </div>
  );
}

function ytId(u) { const m = String(u).match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([\w-]{6,})/); return m ? m[1] : null; }
function vimeoId(u) { const m = String(u).match(/vimeo\.com\/(?:video\/)?(\d+)/); return m ? m[1] : null; }
function VideoEmbed({ url }) {
  const vref = useRef(null);
  const yt = ytId(url), vim = vimeoId(url);
  const src = yt ? `https://www.youtube.com/embed/${yt}?rel=0` : vim ? `https://player.vimeo.com/video/${vim}` : null;
  return (
    <div style={{ width: "100%", background: "#000", borderRadius: 14, overflow: "hidden", position: "relative", aspectRatio: "16 / 9" }}>
      {src
        ? <iframe src={src} title="Why DoorDispatcher" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowFullScreen style={{ position: "absolute", inset: 0, width: "100%", height: "100%", border: "none" }} />
        : <video ref={vref} src={url} controls playsInline style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "contain", background: "#000" }} />}
    </div>
  );
}
function Placeholder({ text }) {
  return <div style={{ background: "#f1f5f9", border: "1px dashed #cbd5e1", borderRadius: 14, padding: "34px 16px", textAlign: "center", color: "#94a3b8", fontSize: 14 }}>{text}</div>;
}
function Splash({ emoji, title, msg, good, plain }) {
  if (plain) return <div style={{ position: "fixed", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: FONT, background: "#f1f5f9", color: "#94a3b8", fontWeight: 700 }}>{msg}</div>;
  return (
    <div style={{ position: "fixed", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: FONT, background: "#f1f5f9", padding: 24 }}>
      <div style={{ maxWidth: 400, textAlign: "center", background: "#fff", borderRadius: 16, padding: "32px 26px", boxShadow: "0 2px 12px rgba(0,0,0,.1)" }}>
        <div style={{ fontSize: 46, marginBottom: 6 }}>{emoji}</div>
        <div style={{ fontSize: 21, fontWeight: 800, fontFamily: OSWALD, color: good ? "#16a34a" : "#0f172a" }}>{title}</div>
        <div style={{ fontSize: 14.5, color: "#475569", lineHeight: 1.55, marginTop: 8 }}>{msg}</div>
      </div>
    </div>
  );
}
