// Harvest Tool Training — office authoring (?mode=harvesttrainingadmin).
// Edit the lesson sections (text + a screenshot) and the test questions for each
// track (Manager / Rep). Reps & managers must pass the test (80%) before the tool
// unlocks. Reads/writes harvest_training_sections + harvest_training_questions;
// screenshots go to the public 'harvest-training' storage bucket.
import React, { useEffect, useMemo, useState } from "react";
import { supabase } from "./lib/supabase";
import HarvestNav from "./HarvestNav";

const FONT = "'Nunito', system-ui, sans-serif";
const OSWALD = "'Oswald', sans-serif";
const TRACKS = [{ key: "manager", label: "🧭 Regional Manager" }, { key: "rep", label: "🚪 Rep" }];
const PASS_PCT = 80;

export default function HarvestTrainingAdmin() {
  const [track, setTrack] = useState("manager");
  const [sections, setSections] = useState(null);
  const [questions, setQuestions] = useState([]);
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState("");

  const load = async () => {
    const [s, q] = await Promise.all([
      supabase.from("harvest_training_sections").select("*").eq("track", track).order("sort"),
      supabase.from("harvest_training_questions").select("*").eq("track", track).order("sort"),
    ]);
    if (s.error) { setMsg({ err: s.error.message.includes("harvest_training") ? "Run sql/harvest_training.sql in Supabase first." : s.error.message }); setSections([]); return; }
    setSections(s.data || []);
    setQuestions(q.data || []);
  };
  useEffect(() => { setSections(null); load(); /* eslint-disable-next-line */ }, [track]);

  const flash = (m) => { setMsg(m); if (m?.ok) setTimeout(() => setMsg(null), 2500); };

  // ── Sections ───────────────────────────────────────────────────────────────
  const patchSection = (id, fields) => setSections((l) => l.map((s) => (s.id === id ? { ...s, ...fields, _dirty: true } : s)));
  const saveSection = async (s) => {
    setBusy(s.id);
    const { error } = await supabase.from("harvest_training_sections")
      .update({ title: s.title, body: s.body, sort: Number(s.sort) || 0, active: s.active !== false, updated_at: new Date().toISOString() }).eq("id", s.id);
    setBusy("");
    if (error) return flash({ err: error.message });
    patchSection(s.id, { _dirty: false });
    flash({ ok: "Section saved." });
  };
  const addSection = async () => {
    const sort = (sections.reduce((m, s) => Math.max(m, s.sort || 0), 0) || 0) + 10;
    const { error } = await supabase.from("harvest_training_sections").insert({ track, sort, title: "New section", body: "" });
    if (error) return flash({ err: error.message });
    flash({ ok: "Section added." }); load();
  };
  const delSection = async (id) => {
    if (!window.confirm("Delete this section? Its questions stay but lose their link.")) return;
    const { error } = await supabase.from("harvest_training_sections").delete().eq("id", id);
    if (error) return flash({ err: error.message });
    load();
  };
  const uploadShot = async (s, file) => {
    if (!file) return;
    setBusy("img_" + s.id);
    try {
      const ext = (file.name.split(".").pop() || "png").toLowerCase();
      const path = `${track}/${s.id}-${Date.now()}.${ext}`;
      const up = await supabase.storage.from("harvest-training").upload(path, file, { upsert: true, contentType: file.type });
      if (up.error) throw up.error;
      const url = supabase.storage.from("harvest-training").getPublicUrl(path).data.publicUrl;
      const { error } = await supabase.from("harvest_training_sections").update({ screenshot_url: url, updated_at: new Date().toISOString() }).eq("id", s.id);
      if (error) throw error;
      patchSection(s.id, { screenshot_url: url });
      flash({ ok: "Screenshot uploaded." });
    } catch (e) { flash({ err: e.message || "Upload failed — did you run the SQL (creates the storage bucket)?" }); }
    setBusy("");
  };

  // ── Questions ─────────────────────────────────────────────────────────────
  const patchQ = (id, fields) => setQuestions((l) => l.map((q) => (q.id === id ? { ...q, ...fields, _dirty: true } : q)));
  const saveQ = async (q) => {
    const choices = (q.choices || []).map((c) => String(c)).filter((c, i) => i < 2 || c.trim());
    if (choices.length < 2) return flash({ err: "A question needs at least 2 answers." });
    const correct = Math.min(q.correct_index || 0, choices.length - 1);
    setBusy(q.id);
    const { error } = await supabase.from("harvest_training_questions")
      .update({ prompt: q.prompt, choices, correct_index: correct, section_id: q.section_id || null, sort: Number(q.sort) || 0, active: q.active !== false, updated_at: new Date().toISOString() }).eq("id", q.id);
    setBusy("");
    if (error) return flash({ err: error.message });
    patchQ(q.id, { _dirty: false });
    flash({ ok: "Question saved." });
  };
  const addQ = async () => {
    const sort = (questions.reduce((m, q) => Math.max(m, q.sort || 0), 0) || 0) + 10;
    const { error } = await supabase.from("harvest_training_questions").insert({ track, sort, prompt: "New question", choices: ["", ""], correct_index: 0 });
    if (error) return flash({ err: error.message });
    load();
  };
  const delQ = async (id) => {
    if (!window.confirm("Delete this question?")) return;
    const { error } = await supabase.from("harvest_training_questions").delete().eq("id", id);
    if (error) return flash({ err: error.message });
    load();
  };
  const setChoice = (q, i, val) => { const c = [...(q.choices || [])]; c[i] = val; patchQ(q.id, { choices: c }); };
  const addChoice = (q) => patchQ(q.id, { choices: [...(q.choices || []), ""] });
  const rmChoice = (q, i) => { const c = (q.choices || []).filter((_, idx) => idx !== i); patchQ(q.id, { choices: c, correct_index: q.correct_index >= c.length ? 0 : q.correct_index }); };

  const sectionTitle = useMemo(() => Object.fromEntries((sections || []).map((s) => [s.id, s.title])), [sections]);
  const qCount = questions.filter((q) => q.active !== false).length;
  const allowedWrong = qCount ? Math.floor(qCount * (100 - PASS_PCT) / 100) : 0;

  return (
    <div style={{ maxWidth: 920, margin: "0 auto", padding: "20px 16px 80px", fontFamily: FONT }}>
      <HarvestNav active="training" />
      <div style={{ fontSize: 22, fontWeight: 800, fontFamily: OSWALD, marginBottom: 4 }}>🎓 Tool Training — Content</div>
      <div style={{ fontSize: 13.5, color: "#64748b", marginBottom: 14 }}>Write the lessons (text + a screenshot per section) and the test questions. Reps and managers must pass at <b>{PASS_PCT}%</b> before the tool unlocks.</div>

      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        {TRACKS.map((t) => (
          <button key={t.key} type="button" onClick={() => setTrack(t.key)}
            style={{ fontSize: 14, fontWeight: 800, padding: "9px 16px", borderRadius: 10, cursor: "pointer", border: track === t.key ? "2px solid #0a0a0a" : "1px solid #cbd5e1", background: track === t.key ? "#0a0a0a" : "#fff", color: track === t.key ? "#fff" : "#475569" }}>{t.label}</button>
        ))}
      </div>

      {msg && <div style={{ marginBottom: 14, padding: "10px 14px", borderRadius: 10, fontSize: 13.5, fontWeight: 600, background: msg.err ? "#fef2f2" : "#ecfdf5", color: msg.err ? "#b91c1c" : "#065f46", border: `1px solid ${msg.err ? "#fecaca" : "#a7f3d0"}` }}>{msg.err || msg.ok}</div>}
      {sections === null ? <div style={{ color: "#94a3b8" }}>Loading…</div> : (
        <>
          {/* ── Lesson sections ── */}
          <div style={{ fontSize: 16, fontWeight: 800, fontFamily: OSWALD, margin: "6px 0 10px" }}>📖 Lesson sections ({sections.length})</div>
          <div style={{ display: "grid", gap: 12 }}>
            {sections.map((s) => (
              <div key={s.id} style={{ border: "1px solid #e5e7eb", borderRadius: 12, padding: 14, background: s.active === false ? "#f8fafc" : "#fff" }}>
                <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}>
                  <input type="number" value={s.sort} onChange={(e) => patchSection(s.id, { sort: e.target.value })} style={{ width: 60, padding: "6px 8px", border: "1px solid #cbd5e1", borderRadius: 8, fontSize: 13 }} title="Order" />
                  <input value={s.title} onChange={(e) => patchSection(s.id, { title: e.target.value })} placeholder="Section title" style={{ flex: 1, fontSize: 15, fontWeight: 700, padding: "8px 10px", borderRadius: 8, border: "1px solid #cbd5e1" }} />
                  <label style={{ fontSize: 12, color: "#475569", display: "flex", alignItems: "center", gap: 4 }}><input type="checkbox" checked={s.active !== false} onChange={(e) => patchSection(s.id, { active: e.target.checked })} /> live</label>
                </div>
                <textarea value={s.body} onChange={(e) => patchSection(s.id, { body: e.target.value })} rows={4} placeholder="Lesson text for this section…"
                  style={{ width: "100%", boxSizing: "border-box", border: "1px solid #cbd5e1", borderRadius: 8, padding: "9px 11px", fontSize: 13.5, fontFamily: FONT, resize: "vertical" }} />
                <div style={{ display: "flex", gap: 12, alignItems: "center", marginTop: 8, flexWrap: "wrap" }}>
                  {s.screenshot_url ? <img src={s.screenshot_url} alt="" style={{ height: 70, borderRadius: 8, border: "1px solid #e5e7eb" }} /> : <span style={{ fontSize: 12, color: "#94a3b8" }}>No screenshot yet</span>}
                  <label style={{ fontSize: 12.5, fontWeight: 700, color: "#1d4ed8", cursor: "pointer" }}>
                    {busy === "img_" + s.id ? "Uploading…" : (s.screenshot_url ? "↻ Replace screenshot" : "📷 Upload screenshot")}
                    <input type="file" accept="image/*" style={{ display: "none" }} onChange={(e) => uploadShot(s, e.target.files?.[0])} />
                  </label>
                  <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
                    <button type="button" onClick={() => delSection(s.id)} style={{ fontSize: 12.5, color: "#dc2626", background: "none", border: "none", cursor: "pointer", fontWeight: 700 }}>Delete</button>
                    <button type="button" onClick={() => saveSection(s)} disabled={busy === s.id} style={{ fontSize: 13, fontWeight: 800, padding: "7px 16px", borderRadius: 8, border: "none", background: s._dirty ? "#16a34a" : "#cbd5e1", color: "#fff", cursor: "pointer" }}>{busy === s.id ? "Saving…" : s._dirty ? "Save" : "Saved"}</button>
                  </div>
                </div>
              </div>
            ))}
          </div>
          <button type="button" onClick={addSection} style={{ marginTop: 12, fontSize: 14, fontWeight: 700, padding: "10px 18px", borderRadius: 10, border: "2px solid #16a34a", background: "#fff", color: "#16a34a", cursor: "pointer" }}>+ Add section</button>

          {/* ── Test questions ── */}
          <div style={{ fontSize: 16, fontWeight: 800, fontFamily: OSWALD, margin: "28px 0 4px" }}>❓ Test questions ({qCount})</div>
          <div style={{ fontSize: 12.5, color: "#64748b", marginBottom: 10 }}>With {qCount} live question{qCount === 1 ? "" : "s"}, they can miss <b>{allowedWrong}</b> and still hit {PASS_PCT}%. Link each question to the section it tests so a fail sends them back to re-read the right spot.</div>
          <div style={{ display: "grid", gap: 12 }}>
            {questions.map((q) => (
              <div key={q.id} style={{ border: "1px solid #e5e7eb", borderRadius: 12, padding: 14, background: q.active === false ? "#f8fafc" : "#fff" }}>
                <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}>
                  <input type="number" value={q.sort} onChange={(e) => patchQ(q.id, { sort: e.target.value })} style={{ width: 60, padding: "6px 8px", border: "1px solid #cbd5e1", borderRadius: 8, fontSize: 13 }} title="Order" />
                  <input value={q.prompt} onChange={(e) => patchQ(q.id, { prompt: e.target.value })} placeholder="Question" style={{ flex: 1, fontSize: 14.5, fontWeight: 700, padding: "8px 10px", borderRadius: 8, border: "1px solid #cbd5e1" }} />
                  <label style={{ fontSize: 12, color: "#475569", display: "flex", alignItems: "center", gap: 4 }}><input type="checkbox" checked={q.active !== false} onChange={(e) => patchQ(q.id, { active: e.target.checked })} /> live</label>
                </div>
                <div style={{ display: "grid", gap: 6, marginBottom: 8 }}>
                  {(q.choices || []).map((c, i) => (
                    <div key={i} style={{ display: "flex", gap: 8, alignItems: "center" }}>
                      <input type="radio" name={"correct_" + q.id} checked={q.correct_index === i} onChange={() => patchQ(q.id, { correct_index: i })} title="Correct answer" />
                      <input value={c} onChange={(e) => setChoice(q, i, e.target.value)} placeholder={`Answer ${i + 1}`} style={{ flex: 1, fontSize: 13.5, padding: "7px 10px", borderRadius: 8, border: `1px solid ${q.correct_index === i ? "#16a34a" : "#cbd5e1"}`, background: q.correct_index === i ? "#f0fdf4" : "#fff" }} />
                      {(q.choices || []).length > 2 && <button type="button" onClick={() => rmChoice(q, i)} style={{ background: "none", border: "none", color: "#94a3b8", cursor: "pointer", fontSize: 16 }}>×</button>}
                    </div>
                  ))}
                  <button type="button" onClick={() => addChoice(q)} style={{ justifySelf: "start", fontSize: 12, color: "#1d4ed8", background: "none", border: "none", cursor: "pointer", fontWeight: 700 }}>+ add answer</button>
                </div>
                <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                  <label style={{ fontSize: 12.5, color: "#475569" }}>Tests section:&nbsp;
                    <select value={q.section_id || ""} onChange={(e) => patchQ(q.id, { section_id: e.target.value || null })} style={{ fontSize: 13, padding: "5px 8px", borderRadius: 8, border: "1px solid #cbd5e1" }}>
                      <option value="">— none —</option>
                      {sections.map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}
                    </select>
                  </label>
                  <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
                    <button type="button" onClick={() => delQ(q.id)} style={{ fontSize: 12.5, color: "#dc2626", background: "none", border: "none", cursor: "pointer", fontWeight: 700 }}>Delete</button>
                    <button type="button" onClick={() => saveQ(q)} disabled={busy === q.id} style={{ fontSize: 13, fontWeight: 800, padding: "7px 16px", borderRadius: 8, border: "none", background: q._dirty ? "#16a34a" : "#cbd5e1", color: "#fff", cursor: "pointer" }}>{busy === q.id ? "Saving…" : q._dirty ? "Save" : "Saved"}</button>
                  </div>
                </div>
              </div>
            ))}
          </div>
          <button type="button" onClick={addQ} style={{ marginTop: 12, fontSize: 14, fontWeight: 700, padding: "10px 18px", borderRadius: 10, border: "2px solid #7c3aed", background: "#fff", color: "#7c3aed", cursor: "pointer" }}>+ Add question</button>
        </>
      )}
    </div>
  );
}
