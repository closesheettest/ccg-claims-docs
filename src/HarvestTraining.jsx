// Harvest Tool Training — the take-it flow (rep or manager). Reads the office-authored
// lessons + questions for a track, walks the user through: read the lessons → take the
// test → PASS (≥80%) shows what they missed + the right answers and unlocks the tool;
// FAIL sends them back to RE-READ the sections they missed (highlighted, with the right
// answer shown, but they must re-read + check the box before retaking). Records the
// result in harvest_training_results.
import React, { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "./lib/supabase";

const FONT = "'Nunito', system-ui, sans-serif";
const OSWALD = "'Oswald', sans-serif";
const PASS_PCT = 80;

export default function HarvestTraining({ track, userType, userKey, name, toolLabel = "the tool", onPass, preview = false }) {
  const [sections, setSections] = useState(null);
  const [questions, setQuestions] = useState([]);
  const [stage, setStage] = useState("lesson"); // lesson | test | result
  const [answers, setAnswers] = useState({});   // qId -> choiceIndex
  const [result, setResult] = useState(null);   // { score, passed, wrong:[q], wrongSectionIds:[] }
  const [reread, setReread] = useState({});      // sectionId -> true (remediation)
  const [saving, setSaving] = useState(false);
  const topRef = useRef(null);

  useEffect(() => {
    (async () => {
      const [s, q] = await Promise.all([
        supabase.from("harvest_training_sections").select("*").eq("track", track).eq("active", true).order("sort"),
        supabase.from("harvest_training_questions").select("*").eq("track", track).eq("active", true).order("sort"),
      ]);
      const secs = s.data || [];
      const qs = (q.data || []).filter((x) => (x.choices || []).length >= 2);
      // No content authored yet → don't lock anyone out; pass straight through.
      // (In preview we still show whatever's authored so the office can see it.)
      if (!qs.length && !preview) { onPass && onPass(); return; }
      setSections(secs); setQuestions(qs);
    })();
    // eslint-disable-next-line
  }, [track]);

  const scrollTop = () => { try { topRef.current?.scrollTo({ top: 0, behavior: "smooth" }); } catch { /* ignore */ } };
  const correctChoice = (q) => (q.choices || [])[q.correct_index];

  const submit = async () => {
    const wrong = questions.filter((q) => answers[q.id] !== q.correct_index);
    const score = Math.round(((questions.length - wrong.length) / questions.length) * 100);
    const passed = score >= PASS_PCT;
    const wrongSectionIds = [...new Set(wrong.map((q) => q.section_id).filter(Boolean))];
    setSaving(true);
    if (!preview) {
      try {
        await supabase.from("harvest_training_results").insert({ user_type: userType, user_key: userKey, name: name || null, track, score, passed, wrong_section_ids: wrongSectionIds });
      } catch { /* non-fatal */ }
    }
    setSaving(false);
    setResult({ score, passed, wrong, wrongSectionIds });
    setReread({});
    setStage("result");
    scrollTop();
  };

  const missedSection = useMemo(() => new Set(result?.wrongSectionIds || []), [result]);
  const remediation = stage === "lesson" && result && !result.passed;
  const allReread = (result?.wrongSectionIds || []).every((id) => reread[id]);

  if (sections === null) return <Screen preview={preview} onClose={onPass}><div style={{ color: "#94a3b8", padding: 40, textAlign: "center" }}>Loading your training…</div></Screen>;

  // ── RESULT ──────────────────────────────────────────────────────────────
  if (stage === "result") {
    return (
      <Screen innerRef={topRef} preview={preview} onClose={onPass}>
        <div style={{ textAlign: "center", padding: "10px 0 18px" }}>
          <div style={{ fontSize: 44 }}>{result.passed ? "🎉" : "📚"}</div>
          <div style={{ fontSize: 24, fontWeight: 800, fontFamily: OSWALD, color: result.passed ? "#16a34a" : "#b45309" }}>
            {result.passed ? "You passed!" : "Not quite yet"}
          </div>
          <div style={{ fontSize: 15, color: "#475569", marginTop: 4 }}>You scored <b>{result.score}%</b> (need {PASS_PCT}%).</div>
        </div>

        {result.wrong.length > 0 && (
          <div style={{ marginBottom: 18 }}>
            <div style={{ fontSize: 13, fontWeight: 800, color: "#64748b", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 8 }}>
              {result.passed ? "Review — what you missed" : `You missed ${result.wrong.length}`}
            </div>
            <div style={{ display: "grid", gap: 8 }}>
              {result.wrong.map((q) => (
                <div key={q.id} style={{ background: "#fff7ed", border: "1px solid #fed7aa", borderRadius: 10, padding: "10px 12px" }}>
                  <div style={{ fontSize: 13.5, fontWeight: 700, color: "#0f172a" }}>{q.prompt}</div>
                  {result.passed
                    ? <div style={{ fontSize: 13, color: "#166534", marginTop: 3 }}>✓ Correct answer: <b>{correctChoice(q)}</b></div>
                    : <div style={{ fontSize: 12.5, color: "#9a3412", marginTop: 3 }}>Re-read the section below to get this one — then you'll retake it.</div>}
                </div>
              ))}
            </div>
          </div>
        )}

        {result.passed ? (
          <button type="button" onClick={() => onPass && onPass()} style={btn("#16a34a")}>{preview ? "✅ Looks good — close preview" : `✅ Enter ${toolLabel}`}</button>
        ) : (
          <button type="button" onClick={() => { setStage("lesson"); scrollTop(); }} style={btn("#b45309")}>📖 Back to the lessons</button>
        )}
      </Screen>
    );
  }

  // ── TEST ────────────────────────────────────────────────────────────────
  if (stage === "test") {
    const answeredAll = questions.every((q) => answers[q.id] != null);
    return (
      <Screen innerRef={topRef} preview={preview} onClose={onPass}>
        <Header title={`${track === "manager" ? "Manager" : "Rep"} test`} sub={`${questions.length} questions · pass at ${PASS_PCT}%. Pick the best answer.`} />
        <div style={{ display: "grid", gap: 14 }}>
          {questions.map((q, i) => (
            <div key={q.id} style={{ border: "1px solid #e5e7eb", borderRadius: 12, padding: 14 }}>
              <div style={{ fontSize: 14.5, fontWeight: 800, marginBottom: 8 }}>{i + 1}. {q.prompt}</div>
              <div style={{ display: "grid", gap: 6 }}>
                {(q.choices || []).map((c, ci) => {
                  const on = answers[q.id] === ci;
                  return (
                    <button key={ci} type="button" onClick={() => setAnswers((a) => ({ ...a, [q.id]: ci }))}
                      style={{ textAlign: "left", padding: "10px 12px", borderRadius: 9, fontSize: 13.5, fontWeight: on ? 800 : 600, cursor: "pointer",
                        border: `2px solid ${on ? "#2563eb" : "#e5e7eb"}`, background: on ? "#eff6ff" : "#fff", color: "#0f172a" }}>
                      {on ? "◉ " : "○ "}{c}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
        <button type="button" onClick={submit} disabled={!answeredAll || saving}
          style={{ ...btn(answeredAll ? "#2563eb" : "#cbd5e1"), cursor: answeredAll && !saving ? "pointer" : "not-allowed" }}>
          {saving ? "Scoring…" : answeredAll ? "Submit my test" : `Answer all ${questions.length} questions`}
        </button>
      </Screen>
    );
  }

  // ── LESSON (first read, or remediation re-read) ──────────────────────────
  return (
    <Screen innerRef={topRef} preview={preview} onClose={onPass}>
      <Header title={`${track === "manager" ? "Regional Manager" : "Rep"} training`}
        sub={remediation ? "Re-read the highlighted sections below, then retake the test." : "Read through, then take a short test to unlock your tools."} />
      {remediation && (
        <div style={{ background: "#fffbeb", border: "1px solid #fcd34d", color: "#92400e", borderRadius: 10, padding: "10px 14px", fontSize: 13, fontWeight: 600, marginBottom: 14 }}>
          You missed {result.wrong.length} question{result.wrong.length === 1 ? "" : "s"}. The sections they came from are highlighted — re-read each and check the box, then retake.
        </div>
      )}
      <div style={{ display: "grid", gap: 16 }}>
        {sections.map((s) => {
          const missed = remediation && missedSection.has(s.id);
          const missedQs = missed ? result.wrong.filter((q) => q.section_id === s.id) : [];
          return (
            <div key={s.id} style={{ border: `1px solid ${missed ? "#f59e0b" : "#e5e7eb"}`, borderRadius: 12, padding: 16, background: missed ? "#fffbeb" : "#fff", boxShadow: missed ? "0 0 0 2px #fde68a" : "none" }}>
              <div style={{ fontSize: 17, fontWeight: 800, fontFamily: OSWALD, marginBottom: 6 }}>{missed ? "⚠️ " : ""}{s.title}</div>
              {s.body && <div style={{ fontSize: 14, color: "#334155", lineHeight: 1.6, whiteSpace: "pre-wrap" }}>{s.body}</div>}
              {s.screenshot_url && <img src={s.screenshot_url} alt={s.title} style={{ display: "block", maxWidth: "100%", borderRadius: 10, border: "1px solid #e5e7eb", marginTop: 10 }} />}
              {missed && (
                <div style={{ marginTop: 12, borderTop: "1px dashed #f59e0b", paddingTop: 10 }}>
                  {missedQs.map((q) => (
                    <div key={q.id} style={{ fontSize: 12.5, color: "#92400e", marginBottom: 4 }}>
                      • <b>{q.prompt}</b> — the answer is <b>{correctChoice(q)}</b>. Make sure the section above explains why.
                    </div>
                  ))}
                  <label style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8, fontSize: 13.5, fontWeight: 700, color: "#0f172a", cursor: "pointer" }}>
                    <input type="checkbox" checked={!!reread[s.id]} onChange={(e) => setReread((r) => ({ ...r, [s.id]: e.target.checked }))} />
                    I've re-read this section
                  </label>
                </div>
              )}
            </div>
          );
        })}
      </div>
      <button type="button" onClick={() => { setStage("test"); setAnswers({}); scrollTop(); }} disabled={(remediation && !allReread) || questions.length === 0}
        style={{ ...btn((questions.length === 0) ? "#cbd5e1" : (!remediation || allReread ? "#16a34a" : "#cbd5e1")), cursor: questions.length && (!remediation || allReread) ? "pointer" : "not-allowed" }}>
        {questions.length === 0 ? "No test questions authored for this track yet" : remediation ? (allReread ? "🔁 Retake the test" : "Re-read the highlighted sections first") : "I'm ready — start the test →"}
      </button>
    </Screen>
  );
}

function Screen({ children, innerRef, preview, onClose }) {
  return (
    <div ref={innerRef} style={{ position: "fixed", inset: 0, overflowY: "auto", background: "#f1f5f9", fontFamily: FONT }}>
      {preview && (
        <div style={{ position: "sticky", top: 0, zIndex: 5, background: "#7c3aed", color: "#fff", fontSize: 13, fontWeight: 800, padding: "9px 16px", display: "flex", alignItems: "center", justifyContent: "space-between", fontFamily: OSWALD, letterSpacing: "0.02em" }}>
          <span>👁 PREVIEW — this is exactly what they see. Nothing is recorded.</span>
          {onClose && <button type="button" onClick={onClose} style={{ background: "rgba(255,255,255,.2)", color: "#fff", border: "none", borderRadius: 8, padding: "5px 12px", fontSize: 12.5, fontWeight: 800, cursor: "pointer" }}>✕ Close preview</button>}
        </div>
      )}
      <div style={{ maxWidth: 720, margin: "0 auto", padding: "22px 16px 60px" }}>
        <div style={{ fontSize: 20, fontWeight: 800, fontFamily: OSWALD, marginBottom: 14 }}>🌾 Harvesting — Tool Training</div>
        {children}
      </div>
    </div>
  );
}
function Header({ title, sub }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ fontSize: 22, fontWeight: 800, fontFamily: OSWALD }}>{title}</div>
      <div style={{ fontSize: 13.5, color: "#64748b", marginTop: 2 }}>{sub}</div>
    </div>
  );
}
const btn = (bg) => ({ width: "100%", marginTop: 20, background: bg, color: "#fff", border: "none", borderRadius: 12, padding: "14px", fontSize: 15.5, fontWeight: 800, fontFamily: OSWALD, letterSpacing: "0.02em" });
