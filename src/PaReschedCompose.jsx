// Admin composer for the missed/unsigned-PA reschedule TEXT campaign (?mode=pareschedcompose).
// Lists the reschedule candidates (a PA appointment that passed with NO paperwork
// signed, not retail-converted, not cancelled), lets the office write a personalized
// bulk text + edit the landing-page pitch, review each one's notes, and preview.
// BUILD-ONLY: the Send button is deliberately disabled — nothing goes out yet.
import React, { useEffect, useMemo, useState } from "react";

const OSWALD = "'Oswald', sans-serif";
const FONT = "'Nunito', system-ui, sans-serif";
const NAVY = "#0f2557";
const api = async (action, payload = {}) => {
  const r = await fetch("/.netlify/functions/pa-resched-compose", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, ...payload }) });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) throw new Error(j.error || "Something went wrong");
  return j;
};
const ORIGIN = (() => { try { return window.location.origin; } catch { return "https://free-roof-inspections.netlify.app"; } })();
const fill = (tpl, c, link) => String(tpl || "")
  .replace(/\{first[_ ]?name\}/gi, c.first_name || "there")
  .replace(/\{address\}/gi, [c.address, c.city].filter(Boolean).join(", "))
  .replace(/\{link\}/gi, link);

export default function PaReschedCompose() {
  const [cands, setCands] = useState(null);
  const [err, setErr] = useState("");
  const [sel, setSel] = useState(() => new Set());
  const [sms, setSms] = useState("");
  const [pitch, setPitch] = useState({ headline: "", body: "" });
  const [saved, setSaved] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const s = await api("settings"); setSms(s.sms || ""); setPitch(s.pitch || { headline: "", body: "" });
        const l = await api("list");
        setCands(l.candidates || []);
        setSel(new Set((l.candidates || []).map((c) => c.appt_id)));   // default: all selected
      } catch (e) { setErr(e.message); setCands([]); }
    })();
  }, []);

  const toggle = (id) => setSel((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const selectedList = useMemo(() => (cands || []).filter((c) => sel.has(c.appt_id)), [cands, sel]);
  const previewFor = selectedList[0] || (cands || [])[0] || null;
  const sampleLink = `${ORIGIN}/?mode=pareschedule&t=…`;

  const save = async () => {
    setSaving(true); setSaved(""); setErr("");
    try { await api("save", { sms, pitch }); setSaved("Saved — the pitch is live on the reschedule page."); }
    catch (e) { setErr(e.message); }
    setSaving(false);
  };

  return (
    <div style={{ minHeight: "100vh", background: "#f1f5f9", fontFamily: FONT, padding: "22px 16px 80px" }}>
      <div style={{ maxWidth: 960, margin: "0 auto" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: 26 }}>✉️</span>
          <h1 style={{ fontFamily: OSWALD, fontSize: 26, fontWeight: 800, margin: 0, color: NAVY }}>Reschedule Text — Composer</h1>
          <span style={{ fontSize: 11, fontWeight: 800, color: "#b45309", background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 999, padding: "3px 9px" }}>BUILD MODE · NOTHING SENDS</span>
        </div>
        <p style={{ color: "#64748b", fontSize: 14, margin: "6px 0 20px", maxWidth: "72ch" }}>
          Homeowners whose PA appointment passed with <b>no paperwork signed</b> (retail conversions, cancels and signed deals are already filtered out). Write the text, review each one's notes, and uncheck anyone who went elsewhere. The link opens their <b>damage photos + a Five Star reschedule</b> page.
        </p>

        {err && <div style={{ color: "#b91c1c", fontWeight: 700, fontSize: 14, marginBottom: 12 }}>{err}</div>}

        {/* MESSAGE */}
        <Card title="The text message">
          <div style={{ fontSize: 12.5, color: "#64748b", marginBottom: 6 }}>Tokens: <Tok t="{first_name}" /> <Tok t="{link}" /> (each homeowner gets their own private link).</div>
          <textarea value={sms} onChange={(e) => setSms(e.target.value)} rows={4}
            style={{ width: "100%", boxSizing: "border-box", fontFamily: FONT, fontSize: 15, padding: 12, border: "1px solid #cbd5e1", borderRadius: 10, lineHeight: 1.5 }} />
          <div style={{ fontSize: 12, color: "#94a3b8", marginTop: 4 }}>{sms.length} chars {sms.length > 160 ? `· ${Math.ceil(sms.length / 153)} segments` : "· 1 segment"}</div>
          {previewFor && (
            <div style={{ marginTop: 12, background: "#ecfdf5", border: "1px solid #a7f3d0", borderRadius: 12, padding: "12px 14px" }}>
              <div style={{ fontSize: 11.5, fontWeight: 800, color: "#047857", textTransform: "uppercase", letterSpacing: ".04em", marginBottom: 5 }}>Preview → {previewFor.name}</div>
              <div style={{ fontSize: 14.5, color: "#064e3b", lineHeight: 1.5, whiteSpace: "pre-wrap" }}>{fill(sms, previewFor, sampleLink)}</div>
            </div>
          )}
        </Card>

        {/* PITCH */}
        <Card title="The reschedule page pitch (the “inspection result” box)">
          <div style={{ fontSize: 12.5, color: "#64748b", marginBottom: 8 }}>This is the sales message the homeowner reads above their roof photos. Tokens: <Tok t="{first_name}" /> <Tok t="{address}" />.</div>
          <label style={lbl}>Headline</label>
          <input value={pitch.headline} onChange={(e) => setPitch({ ...pitch, headline: e.target.value })}
            style={{ width: "100%", boxSizing: "border-box", fontFamily: OSWALD, fontWeight: 800, fontSize: 17, padding: "9px 12px", border: "1px solid #cbd5e1", borderRadius: 10, marginBottom: 10 }} />
          <label style={lbl}>Body</label>
          <textarea value={pitch.body} onChange={(e) => setPitch({ ...pitch, body: e.target.value })} rows={3}
            style={{ width: "100%", boxSizing: "border-box", fontFamily: FONT, fontSize: 14.5, padding: 12, border: "1px solid #cbd5e1", borderRadius: 10, lineHeight: 1.5 }} />
        </Card>

        <div style={{ display: "flex", alignItems: "center", gap: 12, margin: "4px 0 20px" }}>
          <button onClick={save} disabled={saving} style={{ fontFamily: OSWALD, fontSize: 14, fontWeight: 800, color: "#fff", background: NAVY, border: "none", borderRadius: 10, padding: "10px 20px", cursor: saving ? "default" : "pointer" }}>{saving ? "Saving…" : "Save message + pitch"}</button>
          {saved && <span style={{ color: "#16a34a", fontSize: 13.5, fontWeight: 700 }}>{saved}</span>}
        </div>

        {/* CANDIDATES */}
        <Card title={cands ? `Reschedule candidates (${selectedList.length}/${cands.length} selected)` : "Reschedule candidates"}>
          {cands === null ? <div style={{ color: "#94a3b8", padding: "14px 0" }}>Loading…</div>
            : !cands.length ? <div style={{ color: "#94a3b8", padding: "14px 0" }}>No candidates — nobody is sitting unsigned right now.</div>
            : (
            <>
              <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
                <button onClick={() => setSel(new Set(cands.map((c) => c.appt_id)))} style={miniBtn}>Select all</button>
                <button onClick={() => setSel(new Set())} style={miniBtn}>Clear</button>
              </div>
              <div style={{ display: "grid", gap: 10 }}>
                {cands.map((c) => {
                  const on = sel.has(c.appt_id);
                  return (
                    <div key={c.appt_id} onClick={() => toggle(c.appt_id)} style={{ display: "flex", gap: 12, alignItems: "flex-start", padding: "11px 13px", borderRadius: 12, cursor: "pointer",
                      border: `1px solid ${on ? "#bfdbfe" : "#e5e7eb"}`, background: on ? "#eff6ff" : "#fff" }}>
                      <input type="checkbox" checked={on} readOnly style={{ marginTop: 3, width: 17, height: 17, accentColor: NAVY }} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontWeight: 800 }}>{c.name} <span style={{ fontSize: 12, fontWeight: 700, color: "#94a3b8" }}>· {c.days_since}d ago</span>
                          {c.reschedule_sent_at && <span style={{ fontSize: 11, fontWeight: 800, color: "#7c3aed", background: "#f5f3ff", border: "1px solid #ddd6fe", borderRadius: 999, padding: "1px 7px", marginLeft: 6 }}>link sent</span>}
                        </div>
                        <div style={{ fontSize: 12.5, color: "#64748b" }}>{[c.address, c.city].filter(Boolean).join(", ")}{c.phone ? ` · ${c.phone}` : ""}</div>
                        <div style={{ fontSize: 12, color: "#94a3b8" }}>{c.rep ? `rep ${c.rep}` : ""}{c.pa ? `${c.rep ? " · " : ""}PA ${c.pa}` : (c.company ? `${c.rep ? " · " : ""}${c.company}` : "")}{c.stage ? ` · stage ${String(c.stage).replace(/_/g, " ")}` : ""}</div>
                        {Array.isArray(c.notes) && c.notes.length > 0
                          ? <div style={{ marginTop: 5, borderLeft: "3px solid #e2e8f0", paddingLeft: 8, display: "grid", gap: 2 }}>
                              {c.notes.map((n, i) => <div key={i} style={{ fontSize: 12, color: "#475569", lineHeight: 1.4 }}>{n.text}</div>)}
                            </div>
                          : <div style={{ fontSize: 11.5, color: "#cbd5e1", marginTop: 3, fontStyle: "italic" }}>No notes logged — no record of what happened.</div>}
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </Card>

        {/* SEND (disabled) + AUDIT placeholder */}
        <div style={{ background: "#fff", border: "2px dashed #cbd5e1", borderRadius: 16, padding: 20, marginTop: 4 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
            <button disabled title="Sending is off while we build & test" style={{ fontFamily: OSWALD, fontSize: 15, fontWeight: 800, color: "#94a3b8", background: "#f1f5f9", border: "1px solid #e2e8f0", borderRadius: 10, padding: "12px 24px", cursor: "not-allowed" }}>
              Send to {selectedList.length} homeowner{selectedList.length === 1 ? "" : "s"} — OFF
            </button>
            <span style={{ fontSize: 13.5, color: "#64748b" }}>Sending is disabled — this is build &amp; preview only. When it's turned on, each text is tracked below.</span>
          </div>
          <div style={{ marginTop: 16, borderTop: "1px solid #f1f5f9", paddingTop: 14 }}>
            <div style={{ fontFamily: OSWALD, fontSize: 15, fontWeight: 800, color: NAVY }}>📊 Delivery audit</div>
            <div style={{ fontSize: 13.5, color: "#94a3b8", marginTop: 4 }}>Which texts landed and which didn't will show here after the first send — sent → delivered / failed / opted-out, per homeowner.</div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Card({ title, children }) {
  return (
    <div style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 16, padding: "16px 18px", marginBottom: 16 }}>
      <div style={{ fontFamily: OSWALD, fontSize: 15, fontWeight: 800, color: NAVY, marginBottom: 10 }}>{title}</div>
      {children}
    </div>
  );
}
const Tok = ({ t }) => <code style={{ fontSize: 12, background: "#f1f5f9", border: "1px solid #e2e8f0", borderRadius: 6, padding: "1px 5px", color: "#0f172a" }}>{t}</code>;
const lbl = { display: "block", fontSize: 11, fontWeight: 800, textTransform: "uppercase", letterSpacing: ".05em", color: "#64748b", marginBottom: 4 };
const miniBtn = { fontFamily: OSWALD, fontSize: 12.5, fontWeight: 800, color: NAVY, background: "#fff", border: `1.5px solid ${NAVY}`, borderRadius: 8, padding: "5px 12px", cursor: "pointer" };
