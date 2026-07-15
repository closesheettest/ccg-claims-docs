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

  useEffect(() => {
    (async () => {
      setRows(null); setErr("");
      let q = supabase.from("canvass_activity")
        .select("rep_name, pin_id, kind, to_status, round, created_at")
        .order("created_at", { ascending: false }).limit(50000);
      if (period === "today") { const d = new Date(); d.setHours(0, 0, 0, 0); q = q.gte("created_at", d.toISOString()); }
      else if (period === "7d") { q = q.gte("created_at", new Date(Date.now() - 7 * 86400000).toISOString()); }
      const { data, error } = await q;
      if (error) { setErr(error.message.includes("canvass_activity") ? "Run sql/canvass_activity.sql in Supabase to turn on reporting." : error.message); return; }
      setRows(data || []);
    })();
  }, [period]);

  const byRep = useMemo(() => {
    const m = new Map();
    for (const r of (rows || [])) {
      const name = r.rep_name || "(unknown)";
      const cur = m.get(name) || { name, visits: 0, pins: new Set(), rounds: 0, last: null, outcomes: {} };
      if (r.kind === "visit") { cur.visits += 1; if (r.pin_id) cur.pins.add(r.pin_id); }
      if (r.kind === "status" && r.to_status) cur.outcomes[r.to_status] = (cur.outcomes[r.to_status] || 0) + 1;
      if (typeof r.round === "number") cur.rounds = Math.max(cur.rounds, r.round);
      if (!cur.last || new Date(r.created_at) > new Date(cur.last)) cur.last = r.created_at;
      m.set(name, cur);
    }
    return [...m.values()].map((r) => ({ ...r, pinsVisited: r.pins.size }))
      .sort((a, b) => new Date(b.last) - new Date(a.last));
  }, [rows]);

  const fmt = (iso) => { try { return new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }); } catch { return "—"; } };

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
      <div style={{ fontSize: 13, color: "#64748b", marginBottom: 16 }}>Every time a rep taps <b>Next</b> at a door (they're within 100 ft), that's a visit. Status changes (appt / not-interested / dead / sold) count too.</div>

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
                <th style={{ padding: "8px 10px" }}>Rounds</th>
                {OUTCOMES.map((o) => <th key={o} style={{ padding: "8px 10px" }}>{OUTCOME_LABELS[o]}</th>)}
                <th style={{ padding: "8px 10px" }}>Last active</th>
              </tr>
            </thead>
            <tbody>
              {byRep.map((r) => (
                <tr key={r.name} style={{ borderTop: "1px solid #e5e7eb" }}>
                  <td style={{ padding: "9px 10px", fontWeight: 700 }}>{r.name}</td>
                  <td style={{ padding: "9px 10px" }}>{r.pinsVisited}{r.visits !== r.pinsVisited ? <span style={{ color: "#94a3b8" }}> ({r.visits} taps)</span> : null}</td>
                  <td style={{ padding: "9px 10px" }}>{r.rounds || "—"}</td>
                  {OUTCOMES.map((o) => <td key={o} style={{ padding: "9px 10px", fontWeight: r.outcomes[o] ? 700 : 400, color: r.outcomes[o] ? "#0f172a" : "#cbd5e1" }}>{r.outcomes[o] || 0}</td>)}
                  <td style={{ padding: "9px 10px", color: "#64748b", whiteSpace: "nowrap" }}>{fmt(r.last)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
