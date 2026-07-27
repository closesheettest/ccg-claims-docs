// DoorDispatcher — HOW-TO library authoring (?mode=harvesthowtoadmin).
// The office builds the rep tool reference: every tool, WHEN to use it, HOW to use it,
// which role sees it, and the timestamp into the one instructional video. Reps see it
// from the ❓ button on their map. Reads/writes harvest_howto_tools + harvest_howto_config.
import React, { useEffect, useMemo, useState } from "react";
import { supabase } from "./lib/supabase";
import HarvestNav from "./HarvestNav";

const FONT = "'Nunito', system-ui, sans-serif";
const OSWALD = "'Oswald', sans-serif";
const ROLES = [{ v: "all", label: "Everyone" }, { v: "sr", label: "Senior" }, { v: "jr", label: "Junior" }];

const mmss = (sec) => { const n = Number(sec); if (!Number.isFinite(n) || n < 0) return ""; const m = Math.floor(n / 60), s = n % 60; return `${m}:${String(s).padStart(2, "0")}`; };

export default function HarvestHowToAdmin() {
  const [tools, setTools] = useState(null);
  const [videoUrl, setVideoUrl] = useState("");
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState("");

  const load = async () => {
    const [t, c] = await Promise.all([
      supabase.from("harvest_howto_tools").select("*").order("sort"),
      supabase.from("harvest_howto_config").select("video_url").eq("id", "main").maybeSingle(),
    ]);
    if (t.error) { setMsg({ err: t.error.message.includes("harvest_howto") ? "Run sql/harvest_howto_library.sql in Supabase first." : t.error.message }); setTools([]); return; }
    setTools(t.data || []);
    setVideoUrl(c.data?.video_url || "");
  };
  useEffect(() => { load(); }, []);
  const flash = (m) => { setMsg(m); if (m?.ok) setTimeout(() => setMsg(null), 2500); };

  const saveVideo = async () => {
    setBusy("vid");
    const { error } = await supabase.from("harvest_howto_config").upsert({ id: "main", video_url: videoUrl.trim() || null, updated_at: new Date().toISOString() }, { onConflict: "id" });
    setBusy("");
    flash(error ? { err: error.message } : { ok: "Video saved." });
  };

  const patch = (id, fields) => setTools((l) => l.map((t) => (t.id === id ? { ...t, ...fields, _dirty: true } : t)));
  const saveTool = async (t) => {
    setBusy(t.id);
    const { error } = await supabase.from("harvest_howto_tools").update({
      role: t.role, sort: Number(t.sort) || 0, icon: t.icon || "🛠️", title: t.title, when_text: t.when_text, how_text: t.how_text,
      video_start: (t.video_start === "" || t.video_start == null) ? null : Number(t.video_start), active: t.active !== false, updated_at: new Date().toISOString(),
    }).eq("id", t.id);
    setBusy("");
    if (error) return flash({ err: error.message });
    patch(t.id, { _dirty: false }); flash({ ok: "Saved." });
  };
  const addTool = async () => {
    const sort = (tools.reduce((m, t) => Math.max(m, t.sort || 0), 0) || 0) + 10;
    const { error } = await supabase.from("harvest_howto_tools").insert({ role: "all", sort, icon: "🛠️", title: "New tool", when_text: "", how_text: "" });
    if (error) return flash({ err: error.message });
    load();
  };
  const delTool = async (id) => {
    if (!window.confirm("Delete this tool from the how-to library?")) return;
    const { error } = await supabase.from("harvest_howto_tools").delete().eq("id", id);
    if (error) return flash({ err: error.message });
    load();
  };

  const grouped = useMemo(() => {
    const g = { all: [], sr: [], jr: [] };
    for (const t of tools || []) (g[t.role] || g.all).push(t);
    return g;
  }, [tools]);

  return (
    <div style={{ maxWidth: 920, margin: "0 auto", padding: "20px 16px 80px", fontFamily: FONT }}>
      <HarvestNav active="howto" />
      <div style={{ fontSize: 22, fontWeight: 800, fontFamily: OSWALD, marginBottom: 4 }}>📖 How-To Library — every tool</div>
      <div style={{ fontSize: 13.5, color: "#64748b", marginBottom: 16 }}>Reps open this from the <b>❓</b> button on their map. List every tool, <b>when</b> to use it and <b>how</b>, and set the timestamp into your one instructional video so each links to that spot.</div>

      {/* Shared video */}
      <div style={{ border: "1px solid #e5e7eb", borderRadius: 12, padding: 14, background: "#fff", marginBottom: 18 }}>
        <div style={{ fontSize: 15, fontWeight: 800, fontFamily: OSWALD, marginBottom: 6 }}>🎬 The instructional video (one, screen-recorded)</div>
        <div style={{ fontSize: 12.5, color: "#64748b", marginBottom: 8 }}>Paste the YouTube (or Vimeo / .mp4) link. Each tool below opens this video at its timestamp.</div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <input value={videoUrl} onChange={(e) => setVideoUrl(e.target.value)} placeholder="Paste the video link"
            style={{ flex: 1, minWidth: 240, fontSize: 13.5, padding: "9px 11px", borderRadius: 8, border: "1px solid #cbd5e1" }} />
          <button type="button" onClick={saveVideo} disabled={busy === "vid"} style={{ fontSize: 13, fontWeight: 800, padding: "9px 16px", borderRadius: 8, border: "none", background: "#16a34a", color: "#fff", cursor: "pointer" }}>{busy === "vid" ? "Saving…" : "Save video"}</button>
        </div>
      </div>

      {msg && <div style={{ marginBottom: 14, padding: "10px 14px", borderRadius: 10, fontSize: 13.5, fontWeight: 600, background: msg.err ? "#fef2f2" : "#ecfdf5", color: msg.err ? "#b91c1c" : "#065f46", border: `1px solid ${msg.err ? "#fecaca" : "#a7f3d0"}` }}>{msg.err || msg.ok}</div>}

      {tools === null ? <div style={{ color: "#94a3b8" }}>Loading…</div> : (
        <>
          <div style={{ fontSize: 12.5, color: "#64748b", marginBottom: 10 }}>{tools.length} tools · Everyone {grouped.all.length} · Senior {grouped.sr.length} · Junior {grouped.jr.length}</div>
          <div style={{ display: "grid", gap: 12 }}>
            {tools.map((t) => (
              <div key={t.id} style={{ border: "1px solid #e5e7eb", borderRadius: 12, padding: 14, background: t.active === false ? "#f8fafc" : "#fff" }}>
                <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8, flexWrap: "wrap" }}>
                  <input type="number" value={t.sort} onChange={(e) => patch(t.id, { sort: e.target.value })} style={{ width: 56, padding: "6px 8px", border: "1px solid #cbd5e1", borderRadius: 8, fontSize: 13 }} title="Order" />
                  <input value={t.icon} onChange={(e) => patch(t.id, { icon: e.target.value })} style={{ width: 46, padding: "6px 8px", border: "1px solid #cbd5e1", borderRadius: 8, fontSize: 15, textAlign: "center" }} title="Icon" />
                  <input value={t.title} onChange={(e) => patch(t.id, { title: e.target.value })} placeholder="Tool name" style={{ flex: 1, minWidth: 160, fontSize: 15, fontWeight: 700, padding: "8px 10px", borderRadius: 8, border: "1px solid #cbd5e1" }} />
                  <select value={t.role} onChange={(e) => patch(t.id, { role: e.target.value })} style={{ fontSize: 13, padding: "7px 8px", borderRadius: 8, border: "1px solid #cbd5e1" }}>
                    {ROLES.map((r) => <option key={r.v} value={r.v}>{r.label}</option>)}
                  </select>
                  <label style={{ fontSize: 12, color: "#475569", display: "flex", alignItems: "center", gap: 4 }}><input type="checkbox" checked={t.active !== false} onChange={(e) => patch(t.id, { active: e.target.checked })} /> live</label>
                </div>
                <div style={{ fontSize: 11.5, fontWeight: 800, color: "#64748b", textTransform: "uppercase", letterSpacing: "0.04em", margin: "4px 0 3px" }}>When to use it</div>
                <textarea value={t.when_text} onChange={(e) => patch(t.id, { when_text: e.target.value })} rows={2} placeholder="When a rep should reach for this tool…" style={{ width: "100%", boxSizing: "border-box", border: "1px solid #cbd5e1", borderRadius: 8, padding: "8px 10px", fontSize: 13.5, fontFamily: FONT, resize: "vertical" }} />
                <div style={{ fontSize: 11.5, fontWeight: 800, color: "#64748b", textTransform: "uppercase", letterSpacing: "0.04em", margin: "8px 0 3px" }}>How to use it</div>
                <textarea value={t.how_text} onChange={(e) => patch(t.id, { how_text: e.target.value })} rows={3} placeholder="Short steps…" style={{ width: "100%", boxSizing: "border-box", border: "1px solid #cbd5e1", borderRadius: 8, padding: "8px 10px", fontSize: 13.5, fontFamily: FONT, resize: "vertical" }} />
                <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 10, flexWrap: "wrap" }}>
                  <label style={{ fontSize: 12.5, color: "#475569", display: "flex", alignItems: "center", gap: 6 }}>
                    🎬 Video timestamp (seconds):
                    <input type="number" value={t.video_start ?? ""} onChange={(e) => patch(t.id, { video_start: e.target.value })} placeholder="e.g. 90" style={{ width: 80, padding: "6px 8px", border: "1px solid #cbd5e1", borderRadius: 8, fontSize: 13 }} />
                    {t.video_start != null && t.video_start !== "" ? <span style={{ fontWeight: 800, color: "#0f172a" }}>= {mmss(t.video_start)}</span> : <span style={{ color: "#94a3b8" }}>no clip yet</span>}
                  </label>
                  <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
                    <button type="button" onClick={() => delTool(t.id)} style={{ fontSize: 12.5, color: "#dc2626", background: "none", border: "none", cursor: "pointer", fontWeight: 700 }}>Delete</button>
                    <button type="button" onClick={() => saveTool(t)} disabled={busy === t.id} style={{ fontSize: 13, fontWeight: 800, padding: "7px 16px", borderRadius: 8, border: "none", background: t._dirty ? "#16a34a" : "#cbd5e1", color: "#fff", cursor: "pointer" }}>{busy === t.id ? "Saving…" : t._dirty ? "Save" : "Saved"}</button>
                  </div>
                </div>
              </div>
            ))}
          </div>
          <button type="button" onClick={addTool} style={{ marginTop: 12, fontSize: 14, fontWeight: 700, padding: "10px 18px", borderRadius: 10, border: "2px solid #16a34a", background: "#fff", color: "#16a34a", cursor: "pointer" }}>+ Add tool</button>
        </>
      )}
    </div>
  );
}
