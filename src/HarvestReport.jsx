// Harvesting Map — rep activity report (?mode=harvestreport). Office-only.
// Reads canvass_activity (logged on each Next-tap visit + status change) and
// rolls it up per rep: pins visited, rounds run, outcome counts (appts, not-
// interested, sold, dead, no-sit), and time of last activity.
import React, { useEffect, useMemo, useState } from "react";
import { supabase } from "./lib/supabase";
import HarvestNav from "./HarvestNav";

const FONT = "'Nunito', system-ui, sans-serif";
const OSWALD = "'Oswald', sans-serif";
const OUTCOMES = ["appt", "iq_ni", "insp_sold", "no_sit_reschedule", "dead"];
const OUTCOME_LABELS = { appt: "Appts", iq_ni: "Not interested", insp_sold: "Sold", no_sit_reschedule: "No-sit", dead: "Dead" };

export default function HarvestReport() {
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState("");
  const [period, setPeriod] = useState("all"); // today | 7d | all
  const [pinMap, setPinMap] = useState({});    // pin_id → { name, address }
  const [openRep, setOpenRep] = useState(null); // expanded rep row

  useEffect(() => {
    (async () => {
      setRows(null); setErr(""); setOpenRep(null);
      let q = supabase.from("canvass_activity")
        .select("rep_name, pin_id, kind, to_status, round, created_at")
        .order("created_at", { ascending: false }).limit(50000);
      if (period === "today") { const d = new Date(); d.setHours(0, 0, 0, 0); q = q.gte("created_at", d.toISOString()); }
      else if (period === "7d") { q = q.gte("created_at", new Date(Date.now() - 7 * 86400000).toISOString()); }
      const { data, error } = await q;
      if (error) { setErr(error.message.includes("canvass_activity") ? "Run sql/canvass_activity.sql in Supabase to turn on reporting." : error.message); return; }
      setRows(data || []);
      // Pull the addresses for the pins referenced (for the click-in detail).
      const ids = [...new Set((data || []).map((r) => r.pin_id).filter(Boolean))].slice(0, 3000);
      if (ids.length) {
        const { data: pins } = await supabase.from("canvass_prospects").select("id, name, address").in("id", ids);
        setPinMap(Object.fromEntries((pins || []).map((p) => [p.id, p])));
      } else setPinMap({});
    })();
  }, [period]);

  const byRep = useMemo(() => {
    const m = new Map();
    for (const r of (rows || [])) {
      const name = r.rep_name || "(unknown)";
      const cur = m.get(name) || { name, visits: 0, pins: new Set(), rounds: 0, last: null, outcomes: {}, notHome: 0, acts: [] };
      cur.acts.push(r);
      if (r.kind === "visit") { cur.visits += 1; if (r.pin_id) cur.pins.add(r.pin_id); if (r.to_status === "not_home") cur.notHome += 1; }
      if (r.kind === "status" && r.to_status) cur.outcomes[r.to_status] = (cur.outcomes[r.to_status] || 0) + 1;
      if (typeof r.round === "number") cur.rounds = Math.max(cur.rounds, r.round);
      if (!cur.last || new Date(r.created_at) > new Date(cur.last)) cur.last = r.created_at;
      m.set(name, cur);
    }
    // Avg time at spot = arrival → the outcome tap (paired per stop, chronologically).
    for (const cur of m.values()) {
      cur.acts.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
      let arrival = null, sum = 0, n = 0;
      for (const r of cur.acts) {
        if (r.kind === "arrival") arrival = new Date(r.created_at).getTime();
        else if (r.kind === "visit" && arrival != null) {
          const d = (new Date(r.created_at).getTime() - arrival) / 1000;
          if (d >= 0 && d <= 30 * 60) { sum += d; n += 1; }
          arrival = null;
        }
      }
      cur.avgSpot = n ? sum / n : null;
    }
    return [...m.values()].map((r) => ({ ...r, pinsVisited: r.pins.size }))
      .sort((a, b) => new Date(b.last) - new Date(a.last));
  }, [rows]);

  const fmt = (iso) => { try { return new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }); } catch { return "—"; } };
  const fmtT = (iso) => { try { return new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }); } catch { return ""; } };
  const fmtDur = (s) => { if (s == null) return "—"; const m = Math.floor(s / 60), sec = Math.round(s % 60); return m ? `${m}m ${sec}s` : `${sec}s`; };
  const ACT_LABEL = (r) => r.kind === "arrival" ? "📍 Arrived" : r.kind === "status" ? `✏️ ${OUTCOME_LABELS[r.to_status] || r.to_status}` : r.to_status === "not_home" ? "🏠 Not home" : "🚶 Visit";

  return (
    <div style={{ maxWidth: 940, margin: "0 auto", padding: "20px 16px 60px", fontFamily: FONT }}>
      <HarvestNav active="report" />
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10, marginBottom: 6 }}>
        <div style={{ fontSize: 22, fontWeight: 800, fontFamily: OSWALD }}>📊 Rep Activity</div>
        <div style={{ display: "flex", gap: 6 }}>
          {[["today", "Today"], ["7d", "7 days"], ["all", "All time"]].map(([k, l]) => (
            <button key={k} type="button" onClick={() => setPeriod(k)}
              style={{ fontSize: 12.5, fontWeight: 700, padding: "6px 12px", borderRadius: 8, cursor: "pointer", border: period === k ? "2px solid #0a0a0a" : "1px solid #cbd5e1", background: period === k ? "#0a0a0a" : "#fff", color: period === k ? "#fff" : "#475569" }}>{l}</button>
          ))}
        </div>
      </div>
      <div style={{ fontSize: 13, color: "#64748b", marginBottom: 16 }}>Each door a rep works (within 200 ft) is a visit; the outcome they tap fills in the columns. <b>Avg at spot</b> = time from arriving to tapping the outcome. <b>Tap a rep's row</b> for a stop-by-stop breakdown.</div>

      {err && <div style={{ color: "#b91c1c", fontSize: 13.5, marginBottom: 12 }}>{err}</div>}
      {rows === null && !err ? <div style={{ color: "#94a3b8", fontSize: 13 }}>Loading…</div> : null}
      {rows && byRep.length === 0 && !err && <div style={{ color: "#64748b", fontSize: 13.5, background: "#f8fafc", border: "1px solid #e5e7eb", borderRadius: 12, padding: "18px 16px" }}>No activity yet for this period. Reps' visits and status changes show up here as they work the map.</div>}

      {byRep.length > 0 && (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13.5 }}>
            <thead>
              <tr style={{ textAlign: "left", color: "#64748b", fontSize: 11, textTransform: "uppercase", letterSpacing: "0.04em" }}>
                <th style={{ padding: "8px 10px" }}>Rep</th>
                <th style={{ padding: "8px 10px" }}>Pins visited</th>
                <th style={{ padding: "8px 10px" }}>Avg at spot</th>
                <th style={{ padding: "8px 10px" }}>Rounds</th>
                {OUTCOMES.map((o) => <th key={o} style={{ padding: "8px 10px" }}>{OUTCOME_LABELS[o]}</th>)}
                <th style={{ padding: "8px 10px" }}>Not home</th>
                <th style={{ padding: "8px 10px" }}>Last active</th>
              </tr>
            </thead>
            <tbody>
              {byRep.map((r) => {
                const open = openRep === r.name;
                const colSpan = 5 + OUTCOMES.length;
                return (
                <React.Fragment key={r.name}>
                <tr onClick={() => setOpenRep(open ? null : r.name)} style={{ borderTop: "1px solid #e5e7eb", cursor: "pointer", background: open ? "#f8fafc" : "#fff" }}>
                  <td style={{ padding: "9px 10px", fontWeight: 700 }}><span style={{ color: "#94a3b8", marginRight: 5 }}>{open ? "▾" : "▸"}</span>{r.name}</td>
                  <td style={{ padding: "9px 10px" }}>{r.pinsVisited}{r.visits !== r.pinsVisited ? <span style={{ color: "#94a3b8" }}> ({r.visits} taps)</span> : null}</td>
                  <td style={{ padding: "9px 10px", fontWeight: r.avgSpot != null ? 700 : 400, color: r.avgSpot != null ? "#0f172a" : "#cbd5e1" }}>{fmtDur(r.avgSpot)}</td>
                  <td style={{ padding: "9px 10px" }}>{r.rounds || "—"}</td>
                  {OUTCOMES.map((o) => <td key={o} style={{ padding: "9px 10px", fontWeight: r.outcomes[o] ? 700 : 400, color: r.outcomes[o] ? "#0f172a" : "#cbd5e1" }}>{r.outcomes[o] || 0}</td>)}
                  <td style={{ padding: "9px 10px", fontWeight: r.notHome ? 700 : 400, color: r.notHome ? "#0f172a" : "#cbd5e1" }}>{r.notHome || 0}</td>
                  <td style={{ padding: "9px 10px", color: "#64748b", whiteSpace: "nowrap" }}>{fmt(r.last)}</td>
                </tr>
                {open && (
                  <tr>
                    <td colSpan={colSpan} style={{ padding: "4px 10px 14px", background: "#f8fafc" }}>
                      <div style={{ fontSize: 11, fontWeight: 800, color: "#64748b", textTransform: "uppercase", letterSpacing: "0.04em", margin: "6px 0 6px" }}>Stop-by-stop</div>
                      <div style={{ display: "grid", gap: 3 }}>
                        {[...r.acts].reverse()
                          // A statused stop logs both a "visit" and the "status" row —
                          // hide the redundant visit; the status line is the outcome.
                          // A not-home stop's visit IS its outcome, so keep that.
                          .filter((a) => !(a.kind === "visit" && a.to_status !== "not_home"))
                          .map((a, i) => {
                          const pin = pinMap[a.pin_id] || {};
                          return (
                            <div key={i} style={{ display: "flex", gap: 10, alignItems: "baseline", fontSize: 12.5, color: "#334155", padding: "3px 8px", background: a.kind === "arrival" ? "transparent" : "#fff", borderRadius: 6, border: a.kind === "arrival" ? "none" : "1px solid #eef2f7" }}>
                              <span style={{ color: "#94a3b8", minWidth: 62, flexShrink: 0 }}>{fmtT(a.created_at)}</span>
                              <span style={{ fontWeight: 700, minWidth: 96, flexShrink: 0 }}>{ACT_LABEL(a)}</span>
                              <span style={{ color: "#475569" }}>{pin.name || pin.address || (a.pin_id ? "(pin)" : "")}{pin.name && pin.address ? ` · ${pin.address}` : ""}{a.round > 1 ? ` · round ${a.round}` : ""}</span>
                            </div>
                          );
                        })}
                      </div>
                    </td>
                  </tr>
                )}
                </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
