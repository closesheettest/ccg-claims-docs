// src/DealBoard.jsx
//
// The deal board: every deal on one screen, in the column it's actually in, laid
// out like a JobNimbus board — a column per lifecycle state, a card per
// homeowner, count in the header.
//
// ONE component, two boards: PA Deal Inventory (?mode=painventory) and BTR Deal
// Inventory (?mode=btrinventory). They behave identically, so they share code —
// a fix to one is a fix to both. Only the feed, the headline stats and the
// wording differ, and those come in as props.
//
// Each board's COLUMNS come from the shared classifier its side of the app
// already uses (_btpa for damage, _retail for retail), so a board can never tell
// a different story about a deal than the master report does. That's the point:
// the screens this replaces each decided a deal's state their own way.
import React, { useEffect, useMemo, useState } from "react";
import BackBar from "./BackBar";

const FONT = "'Oswald', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";
const BODY = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";

// Days-waiting ramp. Same idea as the aging report: colour is the signal, the
// number is the detail.
const ageColor = (d) => (d == null ? "#94a3b8" : d > 180 ? "#b91c1c" : d > 90 ? "#c2410c" : d > 60 ? "#a16207" : d > 30 ? "#15803d" : "#0369a1");
const fmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" }) : null);
// Card chip: short enough to sit next to the other badges, specific enough to
// act on — the day and the hour, which is what "when is it?" actually means.
const fmtApptChip = (iso) => {
  if (!iso) return "";
  const d = new Date(iso);
  const day = d.toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" });
  const t = d.toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" }).replace(":00", "").replace(" AM", "a").replace(" PM", "p");
  return `${day} ${t}`;
};
const fmtWhen = (iso) => (iso ? new Date(iso).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) + " ET" : null);

// feed:    the function name to load
// title:   board name (the (New) marker is passed in, not assumed)
// blurb:   one line under the title
// stats:   (totals) => [{ n, l, c? }]
export default function DealBoard({ feed, title, tag, blurb, stats }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState("");
  const [q, setQ] = useState("");
  const [onlyOpen, setOnlyOpen] = useState(false);
  const [onlyNoPa, setOnlyNoPa] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);   // the "?" behind the appt flag
  const [open, setOpen] = useState(null); // expanded card id
  // JobNimbus notes, fetched when a card is opened and kept for the session.
  // The boards used to show our own app-side note log, which is empty on most
  // deals — the rep's actual write-up ("Sit no sale, 39 sq, 13 years old, 44
  // solar panels…") lives in JN (Neal, 2026-08-21). Loaded per card rather than
  // per board: 280 deals would be 280 JobNimbus calls on every page load.
  const [jnNotes, setJnNotes] = useState({});   // jn_job_id → { loading, notes, error }
  const loadNotes = async (jnid) => {
    if (!jnid || jnNotes[jnid]) return;
    setJnNotes((m) => ({ ...m, [jnid]: { loading: true } }));
    try {
      const r = await fetch(`/.netlify/functions/deal-notes?jnid=${encodeURIComponent(jnid)}`);
      const j = await r.json();
      setJnNotes((m) => ({ ...m, [jnid]: j.ok ? { notes: j.notes } : { error: j.error || "Couldn't load" } }));
    } catch { setJnNotes((m) => ({ ...m, [jnid]: { error: "Couldn't reach JobNimbus" } })); }
  };

  const load = async () => {
    setErr("");
    try {
      const r = await fetch(`/.netlify/functions/${feed}`);
      const j = await r.json();
      if (!j.ok) { setErr(j.error || "Couldn't load the board."); return; }
      setData(j);
    } catch { setErr("Couldn't reach the server."); }
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [feed]);

  const columns = useMemo(() => {
    if (!data) return [];
    const needle = q.trim().toLowerCase();
    return data.columns.map((c) => {
      const deals = c.deals.filter((d) => {
        if (onlyOpen && !d.appt_open) return false;
        if (onlyNoPa && d.pa) return false;
        if (!needle) return true;
        return [d.name, d.address, d.rep, d.pa, d.company, d.phone, d.booked_by].some((v) => String(v || "").toLowerCase().includes(needle));
      });
      return { ...c, deals, shown: deals.length };
    });
  }, [data, q, onlyOpen, onlyNoPa]);

  if (err) return <Shell><div style={{ padding: 40, textAlign: "center", color: "#b91c1c", fontWeight: 700 }}>{err}</div></Shell>;
  if (!data) return <Shell><div style={{ padding: 40, textAlign: "center", color: "#64748b" }}>Loading the board…</div></Shell>;

  const t = data.totals;
  return (
    <Shell>
      <div style={{ padding: "14px 16px 8px", borderBottom: "1px solid #e2e8f0", background: "#fff" }}>
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10 }}>
          <BackBar />
          <div style={{ fontFamily: FONT, fontWeight: 700, fontSize: 21, color: "#0f172a" }}>{title}{tag ? <span style={{ color: "#7c3aed" }}> {tag}</span> : null}</div>
          <div style={{ fontSize: 12.5, color: "#64748b" }}>{blurb}</div>
        </div>

        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 10, alignItems: "center" }}>
          {stats(t).map((s) => <Stat key={s.l} n={s.n} l={s.l} c={s.c} />)}
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, address, rep, PA…"
            style={{ flex: "1 1 220px", minWidth: 180, padding: "8px 11px", borderRadius: 9, border: "1px solid #cbd5e1", fontSize: 13.5, fontFamily: BODY }} />
          <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
            <Toggle on={onlyOpen} set={setOnlyOpen} label="Appt not closed out" />
            <button type="button" onClick={() => setHelpOpen(!helpOpen)} aria-label="What does this mean?"
              title="What does this mean?"
              style={{ width: 22, height: 22, borderRadius: "50%", cursor: "pointer", fontWeight: 800, fontSize: 12.5, lineHeight: 1,
                border: `1.5px solid ${helpOpen ? "#1d4ed8" : "#94a3b8"}`, background: helpOpen ? "#1d4ed8" : "#fff", color: helpOpen ? "#fff" : "#64748b" }}>?</button>
          </span>
          <Toggle on={onlyNoPa} set={setOnlyNoPa} label="No PA" />
          <button type="button" onClick={load}
            style={{ padding: "8px 13px", borderRadius: 9, border: "1px solid #cbd5e1", background: "#fff", fontWeight: 700, fontSize: 13, cursor: "pointer" }}>↻ Refresh</button>
        </div>
      </div>

      {/* What that flag means. A "?" rather than a tooltip: this gets read on a
          tablet, where hover doesn't exist, and it's worth more than one line. */}
      {helpOpen && (
        <div style={{ margin: "12px 16px 0", background: "#eff6ff", border: "1px solid #bfdbfe", borderRadius: 12, padding: "13px 15px", maxWidth: 760 }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "baseline" }}>
            <div style={{ fontFamily: FONT, fontWeight: 700, fontSize: 15, color: "#1e3a8a" }}>“Appt not closed out” — what it means</div>
            <button type="button" onClick={() => setHelpOpen(false)}
              style={{ background: "none", border: "none", color: "#64748b", fontWeight: 800, fontSize: 13, cursor: "pointer", padding: 0 }}>✕ Close</button>
          </div>
          <div style={{ fontSize: 13.5, color: "#1e293b", marginTop: 7, lineHeight: 1.55 }}>
            <b>Somebody went out, and nothing came back.</b> A deal is flagged when both of these are true:
            <div style={{ margin: "7px 0 7px 2px", display: "grid", gap: 4 }}>
              <div>1. An appointment was booked and <b>its time has already passed</b>.</div>
              <div>2. The deal is <b>still in an open column</b> — nobody has recorded sold, no sale, credit denied, not interested or lost.</div>
            </div>
            We know a visit was meant to happen, the clock says it happened, and no one ever told the system how it went.
          </div>
          <div style={{ fontSize: 13, color: "#334155", marginTop: 9, background: "#fff", border: "1px solid #dbeafe", borderRadius: 9, padding: "9px 11px", lineHeight: 1.5 }}>
            <b>Why it matters:</b> each of these is misreporting itself. A deal sitting in <i>Not Worked</i> with a passed
            appointment isn’t untouched — someone drove there. It reads as never-started only because the outcome was never
            written down, which makes that column look worse than it is and the close rate look better than it is.
          </div>
          <div style={{ fontSize: 12.5, color: "#475569", marginTop: 9 }}>
            <b>It is not a column.</b> It cuts across several at once — right now:
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 5 }}>
              {data.columns.filter((c) => c.deals.some((d) => d.appt_open)).map((c) => (
                <span key={c.key} style={{ fontSize: 12, fontWeight: 700, color: c.color, border: `1px solid ${c.color}55`, borderRadius: 999, padding: "2px 9px" }}>
                  {c.label} · {c.deals.filter((d) => d.appt_open).length}
                </span>
              ))}
            </div>
            <div style={{ marginTop: 7 }}>Tap the button itself to show only these deals.</div>
          </div>
        </div>
      )}

      {/* The board. Columns scroll sideways as a group; each column scrolls on its own. */}
      <div style={{ flex: 1, overflowX: "auto", overflowY: "hidden", background: "#f1f5f9", padding: "12px 12px 16px" }}>
        <div style={{ display: "flex", gap: 12, height: "100%", alignItems: "stretch" }}>
          {columns.map((c) => (
            <div key={c.key} style={{ flex: "0 0 288px", display: "flex", flexDirection: "column", background: "#fff", borderRadius: 12, border: "1px solid #e2e8f0", overflow: "hidden" }}>
              <div style={{ borderTop: `3px solid ${c.color}`, padding: "10px 12px 8px", borderBottom: "1px solid #eef2f7" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                  <span style={{ fontFamily: FONT, fontWeight: 700, fontSize: 14.5, color: "#0f172a" }}>{c.label}</span>
                  <span style={{ fontSize: 12, fontWeight: 800, color: c.color, background: `${c.color}14`, borderRadius: 999, padding: "1px 8px", fontVariantNumeric: "tabular-nums" }}>{c.shown}</span>
                  {c.shown !== c.count && <span style={{ fontSize: 11, color: "#94a3b8" }}>of {c.count}</span>}
                </div>
                <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 2, lineHeight: 1.35 }}>{c.hint}</div>
              </div>
              <div style={{ overflowY: "auto", padding: 9, display: "flex", flexDirection: "column", gap: 8 }}>
                {!c.deals.length && <div style={{ color: "#cbd5e1", fontSize: 12.5, textAlign: "center", padding: "18px 6px" }}>Nothing here</div>}
                {c.deals.map((d) => (
                  <Card key={d.id} d={d} color={c.color} open={open === d.id} jn={jnNotes[d.jn_job_id]}
                    onClick={() => { const now = open === d.id ? null : d.id; setOpen(now); if (now) loadNotes(d.jn_job_id); }} />
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </Shell>
  );
}

function Card({ d, color, open, jn, onClick }) {
  return (
    <div onClick={onClick} style={{
      border: `1px solid ${d.appt_open ? "#fdba74" : "#e2e8f0"}`, borderLeft: `3px solid ${color}`,
      background: d.appt_open ? "#fffbf5" : "#fff", borderRadius: 9, padding: "9px 10px", cursor: "pointer",
    }}>
      <div style={{ fontWeight: 800, fontSize: 13.5, color: "#0f172a", lineHeight: 1.25 }}>{d.name}</div>
      {d.address && <div style={{ fontSize: 11.5, color: "#64748b", marginTop: 1 }}>{d.address}</div>}
      {d.phone && <div style={{ fontSize: 11.5, color: "#64748b" }}>{d.phone}</div>}

      <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginTop: 7, alignItems: "center" }}>
        <span title="Days since we found damage" style={{ fontSize: 11, fontWeight: 800, color: "#fff", background: ageColor(d.age_days), borderRadius: 6, padding: "1px 6px", fontVariantNumeric: "tabular-nums" }}>
          {d.age_days == null ? "—" : `${d.age_days}d`}
        </span>
        {d.pa
          ? <span title={d.company || ""} style={{ fontSize: 11, fontWeight: 700, color: "#0e7490", border: "1px solid #a5d8e3", borderRadius: 6, padding: "1px 6px" }}>🧑‍⚖️ {d.pa.split(/\s+/)[0]}</span>
          : d.pa === null && "pa" in d
          ? <span style={{ fontSize: 11, fontWeight: 700, color: "#b91c1c", border: "1px solid #fca5a5", borderRadius: 6, padding: "1px 6px" }}>No PA</span>
          : d.rep
          ? <span style={{ fontSize: 11, fontWeight: 700, color: "#475569", border: "1px solid #e2e8f0", borderRadius: 6, padding: "1px 6px" }}>🧑 {d.rep.split(/\s+/)[0]}</span>
          : null}
        {d.not_home > 0 && <span title="Times nobody was home" style={{ fontSize: 11, color: "#b45309", border: "1px solid #fed7aa", borderRadius: 6, padding: "1px 6px" }}>🚪 {d.not_home}</span>}
        {d.appt_at && (
          <span title={`${fmtWhen(d.appt_at)}${d.appt_from_jn ? " — from JobNimbus" : ""}${d.appt_title ? `\n${d.appt_title}` : ""}`}
            style={{ fontSize: 11, fontWeight: 700, color: Date.parse(d.appt_at) < Date.now() ? "#b45309" : "#1d4ed8", border: `1px solid ${Date.parse(d.appt_at) < Date.now() ? "#fed7aa" : "#bfdbfe"}`, borderRadius: 6, padding: "1px 6px" }}>
            📅 {fmtApptChip(d.appt_at)}
          </span>
        )}
        {d.notes > 0 && <span style={{ fontSize: 11, color: "#64748b", border: "1px solid #e2e8f0", borderRadius: 6, padding: "1px 6px" }}>📝 {d.notes}</span>}
      </div>

      {d.appt_open && (
        <div style={{ marginTop: 6, fontSize: 11, fontWeight: 700, color: "#9a3412", background: "#ffedd5", borderRadius: 6, padding: "4px 7px", lineHeight: 1.35 }}>
          ⚠ Appointment came and went — no outcome recorded
        </div>
      )}

      {open && (
        <div style={{ marginTop: 8, paddingTop: 8, borderTop: "1px solid #eef2f7", fontSize: 11.5, color: "#475569", display: "grid", gap: 3 }}>
          {d.rep && <div><b>Rep:</b> {d.rep}</div>}
          {d.pa && <div><b>PA:</b> {d.pa}{d.company ? ` · ${d.company}` : ""}</div>}
          {d.appt_at && <div><b>Appointment:</b> {fmtWhen(d.appt_at)}{d.appt_from_jn ? " · from JobNimbus" : ""}</div>}
          {d.appt_title && <div style={{ color: "#94a3b8" }}>{d.appt_title}</div>}
          {d.since_signed_days != null && <div><b>Signed:</b> {d.signed_at ? fmtDate(d.signed_at) : "—"} · {d.since_signed_days}d ago</div>}
          {d.milestones && (
            <div style={{ display: "grid", gap: 1, marginTop: 1 }}>
              {[["filed", "Claim filed"], ["coverage", "Coverage opened"], ["settlement", "Settlement / iink"], ["closed", "Closed / cancelled"]]
                .filter(([k]) => d.milestones[k])
                .map(([k, lbl]) => <div key={k}><b>{lbl}:</b> {fmtDate(d.milestones[k])}</div>)}
            </div>
          )}
          {d.outcome && <div><b>Outcome:</b> {d.outcome}{d.outcome_by ? ` — ${d.outcome_by}` : ""}</div>}
          {d.booked_by && <div><b>Booked by:</b> {d.booked_by}</div>}
          {d.jn_status && <div><b>JobNimbus:</b> {d.jn_status}</div>}
          {d.last_note && <div style={{ fontStyle: "italic", color: "#64748b" }}>“{d.last_note}”{d.last_note_at ? ` — ${fmtDate(d.last_note_at)}` : ""}</div>}

          {/* What JobNimbus knows — the rep's own words about why it's here. */}
          <div style={{ marginTop: 5, paddingTop: 5, borderTop: "1px dashed #e2e8f0" }}>
            <div style={{ fontSize: 10.5, fontWeight: 800, textTransform: "uppercase", letterSpacing: ".05em", color: "#94a3b8", marginBottom: 3 }}>From JobNimbus</div>
            {!jn && <div style={{ color: "#94a3b8" }}>…</div>}
            {jn && jn.loading && <div style={{ color: "#94a3b8" }}>Loading notes…</div>}
            {jn && jn.error && <div style={{ color: "#b45309" }}>{jn.error}</div>}
            {jn && jn.notes && !jn.notes.length && <div style={{ color: "#94a3b8" }}>Nothing written on this deal in JobNimbus either.</div>}
            {jn && jn.notes && jn.notes.length > 0 && (
              <div style={{ display: "grid", gap: 5 }}>
                {jn.notes.slice(0, 6).map((n, idx) => (
                  <div key={idx} style={{ borderLeft: `2px solid ${n.type === "note" ? "#7c3aed" : "#cbd5e1"}`, paddingLeft: 7 }}>
                    <div style={{ fontSize: 10.5, color: "#94a3b8" }}>{fmtDate(n.at)} · {n.by}{n.type === "status" ? " · status" : ""}</div>
                    <div style={{ color: n.type === "note" ? "#334155" : "#64748b", fontStyle: n.type === "note" ? "normal" : "italic" }}>{n.text}</div>
                  </div>
                ))}
                {jn.notes.length > 6 && <div style={{ color: "#94a3b8" }}>+{jn.notes.length - 6} more in JobNimbus</div>}
              </div>
            )}
          </div>
          {d.jn_job_id && (
            <a href={`https://app.jobnimbus.com/job/${d.jn_job_id}`} target="_blank" rel="noreferrer"
              onClick={(e) => e.stopPropagation()} style={{ color: "#0e7490", fontWeight: 700, marginTop: 2 }}>Open in JobNimbus ↗</a>
          )}
        </div>
      )}
    </div>
  );
}

function Stat({ n, l, c = "#0f172a" }) {
  return (
    <div style={{ border: "1px solid #e2e8f0", borderRadius: 9, padding: "5px 11px", background: "#fff" }}>
      <span style={{ fontWeight: 800, fontSize: 15, color: c, fontVariantNumeric: "tabular-nums" }}>{n}</span>
      <span style={{ fontSize: 11, color: "#64748b", marginLeft: 5, textTransform: "uppercase", letterSpacing: ".04em", fontWeight: 700 }}>{l}</span>
    </div>
  );
}
function Toggle({ on, set, label }) {
  return (
    <button type="button" onClick={() => set(!on)} style={{
      padding: "8px 12px", borderRadius: 9, fontSize: 12.5, fontWeight: 700, cursor: "pointer",
      border: `1px solid ${on ? "#c2410c" : "#cbd5e1"}`, background: on ? "#c2410c" : "#fff", color: on ? "#fff" : "#475569",
    }}>{label}</button>
  );
}
function Shell({ children }) {
  return <div style={{ position: "fixed", inset: 0, display: "flex", flexDirection: "column", background: "#f1f5f9", fontFamily: BODY }}>{children}</div>;
}
