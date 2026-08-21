// src/PaInventory.jsx
//
// ?mode=painventory — PA DEAL INVENTORY (New).
//
// Every damage deal on one board, in the column it's actually in, laid out like
// a JobNimbus board: a column per lifecycle state, a card per homeowner, count
// in the header. Built as the first of the rebuilt PA screens — the old ones
// each decided a deal's state their own way, so nobody could tell what was what.
// The columns here come from the shared BTPA classifier, so this board and the
// master report can never disagree.
import React, { useEffect, useMemo, useState } from "react";

const FONT = "'Oswald', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";
const BODY = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";

// Days-waiting ramp. Same idea as the aging report: colour is the signal, the
// number is the detail.
const ageColor = (d) => (d == null ? "#94a3b8" : d > 180 ? "#b91c1c" : d > 90 ? "#c2410c" : d > 60 ? "#a16207" : d > 30 ? "#15803d" : "#0369a1");
const fmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" }) : null);
const fmtWhen = (iso) => (iso ? new Date(iso).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) + " ET" : null);

export default function PaInventory() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState("");
  const [q, setQ] = useState("");
  const [onlyOpen, setOnlyOpen] = useState(false);
  const [onlyNoPa, setOnlyNoPa] = useState(false);
  const [open, setOpen] = useState(null); // expanded card id

  const load = async () => {
    setErr("");
    try {
      const r = await fetch("/.netlify/functions/pa-inventory");
      const j = await r.json();
      if (!j.ok) { setErr(j.error || "Couldn't load the board."); return; }
      setData(j);
    } catch { setErr("Couldn't reach the server."); }
  };
  useEffect(() => { load(); }, []);

  const columns = useMemo(() => {
    if (!data) return [];
    const needle = q.trim().toLowerCase();
    return data.columns.map((c) => {
      const deals = c.deals.filter((d) => {
        if (onlyOpen && !d.appt_open) return false;
        if (onlyNoPa && d.pa) return false;
        if (!needle) return true;
        return [d.name, d.address, d.rep, d.pa, d.company, d.phone].some((v) => String(v || "").toLowerCase().includes(needle));
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
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", gap: 10 }}>
          <div style={{ fontFamily: FONT, fontWeight: 700, fontSize: 21, color: "#0f172a" }}>🗂️ PA Deal Inventory <span style={{ color: "#7c3aed" }}>(New)</span></div>
          <div style={{ fontSize: 12.5, color: "#64748b" }}>
            Every damage deal, in the column it's actually in. Columns come from the same classifier the master report uses.
          </div>
        </div>

        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 10, alignItems: "center" }}>
          <Stat n={t.deals} l="live deals" />
          <Stat n={t.unsigned} l="not signed" c="#b45309" />
          <Stat n={t.no_pa} l="no PA assigned" c="#b91c1c" />
          <Stat n={t.appt_open} l="appt not closed out" c="#c2410c" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, address, rep, PA…"
            style={{ flex: "1 1 220px", minWidth: 180, padding: "8px 11px", borderRadius: 9, border: "1px solid #cbd5e1", fontSize: 13.5, fontFamily: BODY }} />
          <Toggle on={onlyOpen} set={setOnlyOpen} label="Appt not closed out" />
          <Toggle on={onlyNoPa} set={setOnlyNoPa} label="No PA" />
          <button type="button" onClick={load}
            style={{ padding: "8px 13px", borderRadius: 9, border: "1px solid #cbd5e1", background: "#fff", fontWeight: 700, fontSize: 13, cursor: "pointer" }}>↻ Refresh</button>
        </div>
      </div>

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
                  <Card key={d.id} d={d} color={c.color} open={open === d.id} onClick={() => setOpen(open === d.id ? null : d.id)} />
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </Shell>
  );
}

function Card({ d, color, open, onClick }) {
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
          : <span style={{ fontSize: 11, fontWeight: 700, color: "#b91c1c", border: "1px solid #fca5a5", borderRadius: 6, padding: "1px 6px" }}>No PA</span>}
        {d.appt_at && <span style={{ fontSize: 11, color: "#475569", border: "1px solid #e2e8f0", borderRadius: 6, padding: "1px 6px" }}>📅 {fmtDate(d.appt_at)}</span>}
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
          {d.appt_at && <div><b>Appointment:</b> {fmtWhen(d.appt_at)}</div>}
          {d.jn_status && <div><b>JobNimbus:</b> {d.jn_status}</div>}
          {d.last_note && <div style={{ fontStyle: "italic", color: "#64748b" }}>“{d.last_note}”{d.last_note_at ? ` — ${fmtDate(d.last_note_at)}` : ""}</div>}
          {!d.last_note && <div style={{ color: "#94a3b8" }}>No notes on this deal.</div>}
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
