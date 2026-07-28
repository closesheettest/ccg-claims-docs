// DoorDispatcher — HOW-TO / tool reference (?mode=harvesthowto).
//
// A list of EVERY tool a rep has. Tap a tool → it opens that tool's own
// instructional PAGE: the video (screen recording, jumped to that tool's spot)
// on top, then WHEN to use it and HOW, in plain steps. One tap, one page.
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
  const [openId, setOpenId] = useState(null); // the tool whose instructional page is open

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
  const openTool = (tools || []).find((t) => t.id === openId) || null;

  // ── A tool's own instructional page: video on top, then When / How ──────────
  if (openTool) return (
    <ToolPage tool={openTool} videoUrl={videoUrl} onBack={() => setOpenId(null)} />
  );

  return (
    <div style={{ maxWidth: 760, margin: "0 auto", padding: "18px 14px 60px", fontFamily: FONT }}>
      {showNav && <HarvestNav active="howto" />}
      <div style={{ fontSize: 24, fontWeight: 800, fontFamily: OSWALD }}>📖 DoorDispatcher — How-To</div>
      <div style={{ fontSize: 13.5, color: "#64748b", margin: "4px 0 12px" }}>
        Every tool you have. Tap one to watch how it works and read the steps.
      </div>

      {/* Hands-on: open the practice map (locked to this rep's level) in a new tab. */}
      <a href={`/?mode=harvest&demo=1&test=${role === "sr" ? "sr" : "jr"}`} target="_blank" rel="noreferrer"
        style={{ display: "flex", alignItems: "center", gap: 10, textDecoration: "none",
          background: "#16a34a", color: "#fff", borderRadius: 12, padding: "12px 16px", marginBottom: 16,
          fontSize: 14.5, fontWeight: 800, fontFamily: OSWALD, boxShadow: "0 2px 8px rgba(22,163,74,.3)" }}>
        <span style={{ fontSize: 20 }}>🧪</span>
        <span style={{ flex: 1 }}>Practice on the training map — try every tool, nothing is saved</span>
        <span style={{ fontSize: 18 }}>›</span>
      </a>

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
              <button key={s.id} type="button" onClick={() => { setOpenId(s.id); try { window.scrollTo(0, 0); } catch { /* ignore */ } }}
                style={{ textAlign: "left", width: "100%", background: "#fff", border: "1px solid #e5e7eb", borderRadius: 14,
                  padding: "14px 16px", display: "flex", alignItems: "center", gap: 12, cursor: "pointer", WebkitTapHighlightColor: "transparent" }}>
                <span style={{ fontSize: 24, flexShrink: 0, width: 30, textAlign: "center" }}>{s.icon}</span>
                <span style={{ flex: 1 }}>
                  <span style={{ display: "block", fontSize: 15.5, fontWeight: 800, color: "#0f172a" }}>{s.title}</span>
                  <span style={{ display: "block", fontSize: 12.5, color: "#94a3b8", marginTop: 1 }}>
                    {hasClip ? `▶ Watch · ${mmss(s.video_start)}` : "Tap to read the steps"}
                  </span>
                </span>
                {s.role !== "all" && <span style={{ fontSize: 10, fontWeight: 800, color: s.role === "sr" ? "#b91c1c" : "#1d4ed8", background: s.role === "sr" ? "#fef2f2" : "#eff6ff", borderRadius: 6, padding: "2px 6px" }}>{s.role === "sr" ? "SR" : "JR"}</span>}
                <span style={{ color: "#cbd5e1", fontSize: 20, fontWeight: 700 }}>›</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// One tool's instructional page — video (jumped to its timestamp) then When / How.
function ToolPage({ tool, videoUrl, onBack }) {
  const hasClip = videoUrl && tool.video_start != null;
  return (
    <div style={{ maxWidth: 760, margin: "0 auto", padding: "14px 14px 70px", fontFamily: FONT }}>
      <button type="button" onClick={onBack}
        style={{ display: "inline-flex", alignItems: "center", gap: 6, background: "none", border: "none", color: "#475569", fontSize: 14, fontWeight: 800, cursor: "pointer", padding: "6px 0", marginBottom: 8 }}>
        ‹ All tools
      </button>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 14 }}>
        <span style={{ fontSize: 30 }}>{tool.icon}</span>
        <div style={{ fontSize: 22, fontWeight: 900, fontFamily: OSWALD, color: "#0f172a", lineHeight: 1.15 }}>{tool.title}</div>
      </div>

      {/* Video — the instructional part, jumped to this tool's spot */}
      {hasClip ? (
        <VideoPlayer url={videoUrl} start={Number(tool.video_start)} />
      ) : (
        <div style={{ background: "#f1f5f9", border: "1px dashed #cbd5e1", borderRadius: 14, padding: "26px 16px", textAlign: "center", color: "#94a3b8", fontSize: 13.5, marginBottom: 16 }}>
          🎬 Video clip coming soon — read the steps below for now.
        </div>
      )}

      {tool.when_text && (
        <div style={{ marginTop: 18 }}>
          <div style={{ fontSize: 11.5, fontWeight: 800, color: "#64748b", textTransform: "uppercase", letterSpacing: "0.05em" }}>When to use it</div>
          <div style={{ fontSize: 15, color: "#334155", lineHeight: 1.6, marginTop: 4 }}>{tool.when_text}</div>
        </div>
      )}
      {tool.how_text && (
        <div style={{ marginTop: 16 }}>
          <div style={{ fontSize: 11.5, fontWeight: 800, color: "#64748b", textTransform: "uppercase", letterSpacing: "0.05em" }}>How to use it</div>
          <div style={{ fontSize: 15, color: "#334155", lineHeight: 1.6, marginTop: 4, whiteSpace: "pre-wrap" }}>{tool.how_text}</div>
        </div>
      )}

      <button type="button" onClick={onBack}
        style={{ marginTop: 26, width: "100%", background: "#0f172a", color: "#fff", border: "none", borderRadius: 12, padding: "13px 16px", fontSize: 15, fontWeight: 800, fontFamily: OSWALD, cursor: "pointer" }}>
        ‹ Back to all tools
      </button>
    </div>
  );
}

// The one instructional video, jumped to a tool's timestamp. YouTube/Vimeo → iframe
// with a start param; an uploaded .mp4 → native <video> seeked to the second.
function ytId(u) { const m = String(u).match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([\w-]{6,})/); return m ? m[1] : null; }
function vimeoId(u) { const m = String(u).match(/vimeo\.com\/(?:video\/)?(\d+)/); return m ? m[1] : null; }
function VideoPlayer({ url, start }) {
  const vref = useRef(null);
  const yt = ytId(url), vim = vimeoId(url);
  const src = yt ? `https://www.youtube.com/embed/${yt}?start=${start || 0}&autoplay=1&rel=0`
    : vim ? `https://player.vimeo.com/video/${vim}#t=${start || 0}s`
    : null;
  useEffect(() => { if (!src && vref.current) { try { vref.current.currentTime = start || 0; vref.current.play?.(); } catch { /* ignore */ } } }, [src, start]);
  return (
    <div style={{ width: "100%", background: "#000", borderRadius: 14, overflow: "hidden", position: "relative", aspectRatio: "9 / 16", maxHeight: "70vh", margin: "0 auto" }}>
      {src
        ? <iframe src={src} title="How-to" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowFullScreen style={{ position: "absolute", inset: 0, width: "100%", height: "100%", border: "none" }} />
        : <video ref={vref} src={url} controls autoPlay playsInline style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "contain", background: "#000" }} />}
    </div>
  );
}
