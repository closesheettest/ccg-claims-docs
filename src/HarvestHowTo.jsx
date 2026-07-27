// DoorDispatcher — HOW-TO / tool reference (?mode=harvesthowto).
//
// A list of EVERY tool a rep has: what it is, WHEN to use it, HOW to use it, and a
// "▶ Watch" that jumps to that tool's spot in one screen-recorded instructional video.
// Office-editable at ?mode=harvesthowtoadmin (harvest_howto_tools + harvest_howto_config).
//
// Two ways in:
//   • Reps: the ❓ button on their map → /?mode=harvesthowto (defaults to their role).
//   • Office: the "📖 How-To" nav (&nav=1 shows the admin nav).
import React, { useEffect, useMemo, useRef, useState } from "react";
import HarvestNav from "./HarvestNav";
import { supabase } from "./lib/supabase";

const OSWALD = "'Oswald', sans-serif";
const FONT = "'Nunito', -apple-system, sans-serif";
const ROLE_TABS = [["everything", "Everything"], ["sr", "Senior"], ["jr", "Junior"]];
const mmss = (sec) => { const n = Number(sec); if (!Number.isFinite(n) || n < 0) return ""; const m = Math.floor(n / 60), s = n % 60; return `${m}:${String(s).padStart(2, "0")}`; };

export default function HarvestHowTo() {
  const params = useMemo(() => { try { return new URLSearchParams(window.location.search); } catch { return new URLSearchParams(); } }, []);
  const showNav = params.get("nav") === "1";
  const urlRole = (params.get("role") || "").toLowerCase(); // rep's level, passed from the map
  const [role, setRole] = useState(urlRole === "senior" || urlRole === "sr" ? "sr" : urlRole === "junior" || urlRole === "jr" ? "jr" : "everything");
  const [tools, setTools] = useState(null);
  const [videoUrl, setVideoUrl] = useState("");
  const [play, setPlay] = useState(null); // { start } — open the video modal at this second

  useEffect(() => {
    (async () => {
      const [t, c] = await Promise.all([
        supabase.from("harvest_howto_tools").select("*").eq("active", true).order("sort"),
        supabase.from("harvest_howto_config").select("video_url").eq("id", "main").maybeSingle(),
      ]);
      setTools(t.data || []);
      setVideoUrl(c.data?.video_url || "");
    })();
  }, []);

  const list = (tools || []).filter((s) => role === "everything" || s.role === "all" || s.role === role);

  return (
    <div style={{ maxWidth: 760, margin: "0 auto", padding: "18px 14px 60px", fontFamily: FONT }}>
      {showNav && <HarvestNav active="howto" />}
      <div style={{ fontSize: 24, fontWeight: 800, fontFamily: OSWALD }}>📖 DoorDispatcher — How-To</div>
      <div style={{ fontSize: 13.5, color: "#64748b", margin: "4px 0 14px" }}>
        Every tool you have — when to use it, how, and a quick video. Tap a card.
      </div>

      {/* Role filter */}
      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        {ROLE_TABS.map(([k, l]) => (
          <button key={k} type="button" onClick={() => setRole(k)}
            style={{ fontSize: 13, fontWeight: 700, padding: "7px 14px", borderRadius: 999, cursor: "pointer",
              border: role === k ? "2px solid #0a0a0a" : "1px solid #cbd5e1",
              background: role === k ? "#0a0a0a" : "#fff", color: role === k ? "#fff" : "#475569" }}>{l}</button>
        ))}
      </div>

      {tools === null ? <div style={{ color: "#94a3b8", padding: 30, textAlign: "center" }}>Loading…</div>
        : list.length === 0 ? <div style={{ color: "#94a3b8", padding: 30, textAlign: "center" }}>Nothing here yet — the office is still building this guide.</div>
        : (
        <div style={{ display: "grid", gap: 10 }}>
          {list.map((s) => {
            const hasClip = videoUrl && s.video_start != null;
            return (
              <details key={s.id} style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 14, overflow: "hidden" }}>
                <summary style={{ listStyle: "none", cursor: "pointer", padding: "14px 16px", display: "flex", alignItems: "center", gap: 12, WebkitTapHighlightColor: "transparent" }}>
                  <span style={{ fontSize: 22, flexShrink: 0 }}>{s.icon}</span>
                  <span style={{ fontSize: 15.5, fontWeight: 800, color: "#0f172a", flex: 1 }}>{s.title}</span>
                  {s.role !== "all" && <span style={{ fontSize: 10, fontWeight: 800, color: s.role === "sr" ? "#b91c1c" : "#1d4ed8", background: s.role === "sr" ? "#fef2f2" : "#eff6ff", borderRadius: 6, padding: "2px 6px" }}>{s.role === "sr" ? "SR" : "JR"}</span>}
                  <span style={{ color: "#94a3b8", fontSize: 13 }}>▾</span>
                </summary>
                <div style={{ padding: "0 16px 16px", borderTop: "1px solid #f1f5f9" }}>
                  {s.when_text && (
                    <div style={{ marginTop: 12 }}>
                      <div style={{ fontSize: 11, fontWeight: 800, color: "#64748b", textTransform: "uppercase", letterSpacing: "0.05em" }}>When to use it</div>
                      <div style={{ fontSize: 14, color: "#334155", lineHeight: 1.55, marginTop: 3 }}>{s.when_text}</div>
                    </div>
                  )}
                  {s.how_text && (
                    <div style={{ marginTop: 12 }}>
                      <div style={{ fontSize: 11, fontWeight: 800, color: "#64748b", textTransform: "uppercase", letterSpacing: "0.05em" }}>How</div>
                      <div style={{ fontSize: 14, color: "#334155", lineHeight: 1.55, marginTop: 3, whiteSpace: "pre-wrap" }}>{s.how_text}</div>
                    </div>
                  )}
                  {hasClip && (
                    <button type="button" onClick={() => setPlay({ start: Number(s.video_start) })}
                      style={{ marginTop: 14, display: "inline-flex", alignItems: "center", gap: 8, background: "#0f172a", color: "#fff", border: "none", borderRadius: 10, padding: "10px 16px", fontSize: 14, fontWeight: 800, fontFamily: OSWALD, cursor: "pointer" }}>
                      ▶ Watch this ({mmss(s.video_start)})
                    </button>
                  )}
                </div>
              </details>
            );
          })}
        </div>
      )}

      {play && <VideoModal url={videoUrl} start={play.start} onClose={() => setPlay(null)} />}
    </div>
  );
}

// Play the one instructional video, jumped to a tool's timestamp. YouTube/Vimeo → iframe
// with a start param; an uploaded .mp4 → native <video> seeked to the second.
function ytId(u) { const m = String(u).match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([\w-]{6,})/); return m ? m[1] : null; }
function vimeoId(u) { const m = String(u).match(/vimeo\.com\/(?:video\/)?(\d+)/); return m ? m[1] : null; }
function VideoModal({ url, start, onClose }) {
  const vref = useRef(null);
  const yt = ytId(url), vim = vimeoId(url);
  const src = yt ? `https://www.youtube.com/embed/${yt}?start=${start || 0}&autoplay=1&rel=0`
    : vim ? `https://player.vimeo.com/video/${vim}#t=${start || 0}s`
    : null;
  useEffect(() => { if (!src && vref.current) { try { vref.current.currentTime = start || 0; vref.current.play?.(); } catch { /* ignore */ } } }, [src, start]);
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(15,23,42,.75)", zIndex: 5000, display: "flex", alignItems: "center", justifyContent: "center", padding: 14 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: "100%", maxWidth: 520, background: "#000", borderRadius: 14, overflow: "hidden", position: "relative" }}>
        <button type="button" onClick={onClose} style={{ position: "absolute", top: 8, right: 10, zIndex: 2, background: "rgba(0,0,0,.6)", color: "#fff", border: "none", borderRadius: 999, width: 32, height: 32, fontSize: 18, cursor: "pointer" }}>×</button>
        <div style={{ position: "relative", width: "100%", aspectRatio: "9 / 16", maxHeight: "82vh" }}>
          {src
            ? <iframe src={src} title="How-to" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowFullScreen style={{ position: "absolute", inset: 0, width: "100%", height: "100%", border: "none" }} />
            : <video ref={vref} src={url} controls autoPlay playsInline style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "contain", background: "#000" }} />}
        </div>
      </div>
    </div>
  );
}
