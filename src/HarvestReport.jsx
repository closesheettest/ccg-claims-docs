// Harvesting Map — rep activity report (?mode=harvestreport). Office-only.
// Reads canvass_activity (logged on each Next-tap visit + status change) and
// rolls it up per rep: pins visited, rounds run, outcome counts (appts, not-
// interested, sold, dead, no-sit), and time of last activity.
import React, { useEffect, useMemo, useState } from "react";
import { supabase } from "./lib/supabase";
import HarvestNav from "./HarvestNav";

const FONT = "'Nunito', system-ui, sans-serif";
const OSWALD = "'Oswald', sans-serif";
const OUTCOMES = ["appt", "iq_ni", "insp_ni", "insp_sold", "no_sit_reschedule", "new_roof", "dead"];
const OUTCOME_LABELS = { appt: "Appts", iq_ni: "IQ not int.", insp_ni: "Not interested", insp_sold: "Sold", no_sit_reschedule: "No-sit", new_roof: "New Roof", dead: "Dead" };
// Friendly names for a pin's ORIGINAL status (for the New-Roof breakdown).
const STATUS_LABEL = { iq: "IQ", iq_ni: "IQ – Not Interested", no_sit_reschedule: "No-sit – need to reschedule", insp: "Inspection Lead", appt: "Appointment", insp_pending: "Pending signature", insp_sold: "Inspection Sold" };

// The date window for a report period. Weeks start Monday. Returns { gte, lt } Date
// bounds (lt is exclusive); null bound = open-ended. Custom uses the two date inputs.
function periodRange(period, fromDate, toDate) {
  const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
  const today0 = startOfDay(new Date());
  const DAY = 86400000;
  const mondayOf = (d) => startOfDay(new Date(d.getTime() - ((d.getDay() + 6) % 7) * DAY));
  if (period === "today") return { gte: today0, lt: null };
  if (period === "yesterday") return { gte: startOfDay(new Date(today0.getTime() - DAY)), lt: today0 };
  if (period === "this_week") return { gte: mondayOf(today0), lt: null };
  if (period === "last_week") { const thisMon = mondayOf(today0); return { gte: new Date(thisMon.getTime() - 7 * DAY), lt: thisMon }; }
  if (period === "custom") {
    return {
      gte: fromDate ? startOfDay(new Date(`${fromDate}T00:00:00`)) : null,
      lt: toDate ? new Date(startOfDay(new Date(`${toDate}T00:00:00`)).getTime() + DAY) : null, // inclusive of the "to" day
    };
  }
  return { gte: null, lt: null }; // all time
}

export default function HarvestReport() {
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState("");
  const [period, setPeriod] = useState("today"); // today | yesterday | this_week | last_week | custom | all
  const [fromDate, setFromDate] = useState(""); // YYYY-MM-DD, custom range
  const [toDate, setToDate] = useState("");     // YYYY-MM-DD, custom range
  const [pinMap, setPinMap] = useState({});    // pin_id → { name, address }
  const [openRep, setOpenRep] = useState(null); // expanded rep row
  const [auditOff, setAuditOff] = useState(false); // location columns not migrated yet

  useEffect(() => {
    (async () => {
      setRows(null); setErr(""); setOpenRep(null);
      const RICH = "rep_name, pin_id, kind, from_status, to_status, round, created_at, dist_ft, loc_flag, lat, lng";
      const BASIC = "rep_name, pin_id, kind, from_status, to_status, round, created_at";
      // PAGE through every row — a single `.limit()` is silently capped at 1000 by
      // the server, which (ordered newest-first) drops older reps entirely. At 80
      // reps a day easily clears 1000 actions, so we must page to stay accurate.
      const PAGE = 1000;
      const fetchAll = async (cols) => {
        const all = [];
        for (let from = 0; from < 500000; from += PAGE) {
          let q = supabase.from("canvass_activity").select(cols).order("created_at", { ascending: false }).range(from, from + PAGE - 1);
          const { gte, lt } = periodRange(period, fromDate, toDate);
          if (gte) q = q.gte("created_at", gte.toISOString());
          if (lt) q = q.lt("created_at", lt.toISOString());
          const { data, error } = await q;
          if (error) return { data: all, error };
          all.push(...(data || []));
          if (!data || data.length < PAGE) break;
        }
        return { data: all, error: null };
      };
      // Try the location-aware columns; if the migration hasn't run yet, fall back to
      // the basic report rather than erroring the whole page.
      let { data, error } = await fetchAll(RICH);
      let off = false;
      if (error && /loc_flag|dist_ft|\blat\b|\blng\b|column/i.test(error.message || "")) { off = true; ({ data, error } = await fetchAll(BASIC)); }
      setAuditOff(off);
      if (error) { setErr(error.message.includes("canvass_activity") ? "Run sql/canvass_activity.sql in Supabase to turn on reporting." : error.message); return; }
      setRows(data || []);
      // Pull the addresses for the pins referenced (for the click-in detail).
      const ids = [...new Set((data || []).map((r) => r.pin_id).filter(Boolean))].slice(0, 3000);
      if (ids.length) {
        const { data: pins } = await supabase.from("canvass_prospects").select("id, name, address").in("id", ids);
        setPinMap(Object.fromEntries((pins || []).map((p) => [p.id, p])));
      } else setPinMap({});
    })();
  }, [period, fromDate, toDate]);

  const byRep = useMemo(() => {
    // Collapse duplicate rows first — the app was logging the same door + kind +
    // outcome several times (double-tap / GPS re-fire while approaching), which both
    // inflated the counts and spammed the stop-by-stop list. Keep ONE per rep + door +
    // kind + outcome + round (a genuine round-2 re-knock still counts); pinless rows kept.
    const seen = new Set();
    const deduped = (rows || []).filter((r) => {
      if (!r.pin_id) return true;
      const k = `${r.rep_name || ""}|${r.pin_id}|${r.kind}|${r.to_status || ""}|${r.round ?? ""}`;
      if (seen.has(k)) return false;
      seen.add(k); return true;
    });
    const m = new Map();
    for (const r of deduped) {
      const name = r.rep_name || "(unknown)";
      const cur = m.get(name) || { name, visits: 0, pins: new Set(), rounds: 0, last: null, outcomes: {}, notHome: 0, acts: [], offSpot: 0, farCount: 0, gpsOff: 0, coords: [] };
      cur.acts.push(r);
      if (r.kind === "visit") { cur.visits += 1; if (r.pin_id) cur.pins.add(r.pin_id); if (r.to_status === "not_home") cur.notHome += 1; }
      if (r.kind === "status" && r.to_status) cur.outcomes[r.to_status] = (cur.outcomes[r.to_status] || 0) + 1;
      // Appts are logged as a "visit" (or appt_done), NOT a "status" row — so counting
      // only status rows left the APPTS column at 0. Count them here (rows are already
      // deduped, so one per door).
      else if (r.to_status === "appt") cur.outcomes.appt = (cur.outcomes.appt || 0) + 1;
      if (typeof r.round === "number") cur.rounds = Math.max(cur.rounds, r.round);
      if (!cur.last || new Date(r.created_at) > new Date(cur.last)) cur.last = r.created_at;
      // Location audit: count off-the-door actions, and gather coords for the
      // "all from one spot" (couch-canvassing) check. Only real work counts — an
      // 'arrival' isn't an outcome, so skip it.
      if (r.kind !== "arrival") {
        const offSpot = r.loc_flag === "far" || r.loc_flag === "gps_off";
        if (r.loc_flag === "far") { cur.farCount += 1; cur.offSpot += 1; }
        else if (r.loc_flag === "gps_off") { cur.gpsOff += 1; cur.offSpot += 1; }
        // Only OFF-spot coords feed the cluster check — a pile of verified-at-door
        // actions near one spot (e.g. parking in the same lot) is legit and mustn't flag.
        if (offSpot && typeof r.lat === "number" && typeof r.lng === "number") cur.coords.push([r.lat, r.lng]);
      }
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
      // Biggest group of actions logged from the SAME ~180ft spot. A rep working the
      // street moves; a rep statusing a route from their couch doesn't — so a large
      // single-spot cluster is the tell.
      const buckets = new Map();
      for (const [la, ln] of cur.coords) { const k = `${Math.round(la * 1000)}_${Math.round(ln * 1000)}`; buckets.set(k, (buckets.get(k) || 0) + 1); }
      cur.maxSameSpot = buckets.size ? Math.max(...buckets.values()) : 0;
      // Flag for a manager's eyes: several confidently-far statuses, or a big pile of
      // actions from one spot. Not proof — a prompt to look at their stop-by-stop.
      cur.flagged = cur.farCount >= 3 || cur.maxSameSpot >= 10;
    }
    return [...m.values()].map((r) => ({ ...r, pinsVisited: r.pins.size }))
      .sort((a, b) => new Date(b.last) - new Date(a.last));
  }, [rows]);

  // "Dropping the ball" data point: doors we found already had a NEW ROOF
  // (a competitor got it), broken down by what the pin WAS — e.g. how many of
  // our no-sits we lost because we didn't stay on them.
  const newRoof = useMemo(() => {
    const bySrc = {}; let total = 0;
    for (const r of (rows || [])) {
      if (r.kind === "status" && r.to_status === "new_roof") {
        const src = r.from_status || "(unknown)";
        bySrc[src] = (bySrc[src] || 0) + 1; total++;
      }
    }
    return { total, bySrc: Object.entries(bySrc).sort((a, b) => b[1] - a[1]) };
  }, [rows]);

  const flaggedReps = useMemo(() => byRep.filter((r) => r.flagged), [byRep]);

  const fmt = (iso) => { try { return new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }); } catch { return "—"; } };
  const fmtT = (iso) => { try { return new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }); } catch { return ""; } };
  const fmtDur = (s) => { if (s == null) return "—"; const m = Math.floor(s / 60), sec = Math.round(s % 60); return m ? `${m}m ${sec}s` : `${sec}s`; };
  const ACT_LABEL = (r) => {
    if (r.kind === "arrival") return "📍 Arrived";
    if (r.kind === "status") return `✏️ ${OUTCOME_LABELS[r.to_status] || r.to_status}`;
    if (r.to_status === "not_home") return "🏠 Not home";
    // Appts log as a visit — show them as a CONVERSION, with what the door was (e.g.
    // "📅 Appt (from No-sit)") so the log makes the reschedule/booking visible.
    if (r.to_status === "appt") {
      const from = r.from_status && r.from_status !== "appt" ? ` (from ${OUTCOME_LABELS[r.from_status] || r.from_status})` : "";
      return `📅 Appt${from}`;
    }
    return "🚶 Visit";
  };
  // Location tag shown on each stop in the detail view.
  const LOC_TAG = (r) => {
    if (r.loc_flag === "far") return { txt: `⚠️ ${r.dist_ft != null ? `${r.dist_ft.toLocaleString()} ft away` : "far from door"}`, color: "#b91c1c" };
    if (r.loc_flag === "gps_off") return { txt: "📶 weak GPS", color: "#b45309" };
    if (r.loc_flag === "verified") return { txt: "✓ at door", color: "#16a34a" };
    return null;
  };

  return (
    <div style={{ maxWidth: 940, margin: "0 auto", padding: "20px 16px 60px", fontFamily: FONT }}>
      <HarvestNav active="report" />
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10, marginBottom: 6 }}>
        <div style={{ fontSize: 22, fontWeight: 800, fontFamily: OSWALD }}>📊 Rep Activity</div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
          {[["today", "Today"], ["yesterday", "Yesterday"], ["this_week", "This week"], ["last_week", "Last week"], ["custom", "From–To"], ["all", "All time"]].map(([k, l]) => (
            <button key={k} type="button" onClick={() => setPeriod(k)}
              style={{ fontSize: 12.5, fontWeight: 700, padding: "6px 12px", borderRadius: 8, cursor: "pointer", border: period === k ? "2px solid #0a0a0a" : "1px solid #cbd5e1", background: period === k ? "#0a0a0a" : "#fff", color: period === k ? "#fff" : "#475569" }}>{l}</button>
          ))}
          {period === "custom" && (
            <span style={{ display: "inline-flex", gap: 6, alignItems: "center", fontSize: 12.5, color: "#475569" }}>
              <input type="date" value={fromDate} max={toDate || undefined} onChange={(e) => setFromDate(e.target.value)}
                style={{ fontSize: 12.5, padding: "5px 8px", borderRadius: 8, border: "1px solid #cbd5e1" }} />
              <span>to</span>
              <input type="date" value={toDate} min={fromDate || undefined} onChange={(e) => setToDate(e.target.value)}
                style={{ fontSize: 12.5, padding: "5px 8px", borderRadius: 8, border: "1px solid #cbd5e1" }} />
            </span>
          )}
        </div>
      </div>
      <div style={{ fontSize: 13, color: "#64748b", marginBottom: 16 }}>Each door a rep works (within 200 ft) is a visit; the outcome they tap fills in the columns. <b>Avg at spot</b> = time from arriving to tapping the outcome. <b>Tap a rep's row</b> for a stop-by-stop breakdown.</div>

      {newRoof.total > 0 && (
        <div style={{ background: "#ecfeff", border: "1px solid #67e8f9", borderRadius: 12, padding: "14px 16px", marginBottom: 18 }}>
          <div style={{ fontSize: 14.5, fontWeight: 800, color: "#0e7490", fontFamily: OSWALD }}>🚩 New Roofs we lost — {newRoof.total}</div>
          <div style={{ fontSize: 12.5, color: "#155e75", margin: "3px 0 10px" }}>Doors that already had a new roof (a competitor got it) — i.e. deals we let slip. Broken down by what the lead <b>was</b>:</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {newRoof.bySrc.map(([src, n]) => (
              <div key={src} style={{ background: "#fff", border: "1px solid #cffafe", borderRadius: 10, padding: "8px 12px" }}>
                <span style={{ fontSize: 17, fontWeight: 800, color: "#0891b2" }}>{n}</span>
                <span style={{ fontSize: 12.5, color: "#475569", marginLeft: 6 }}>{STATUS_LABEL[src] || src}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {auditOff && rows && (
        <div style={{ background: "#f8fafc", border: "1px dashed #cbd5e1", borderRadius: 12, padding: "12px 14px", marginBottom: 16, fontSize: 12.5, color: "#475569" }}>
          📍 <b>Location check is off.</b> Run <code>sql/harvest_location_audit.sql</code> in Supabase to record where each door was worked from — then this report flags statuses done far from the door or all from one spot.
        </div>
      )}
      {!auditOff && flaggedReps.length > 0 && (
        <div style={{ background: "#fef2f2", border: "1px solid #fca5a5", borderRadius: 12, padding: "14px 16px", marginBottom: 18 }}>
          <div style={{ fontSize: 14.5, fontWeight: 800, color: "#b91c1c", fontFamily: OSWALD }}>🚩 Location check — {flaggedReps.length} rep{flaggedReps.length > 1 ? "s" : ""} to look at</div>
          <div style={{ fontSize: 12.5, color: "#7f1d1d", margin: "3px 0 10px" }}>Not proof of anything — just doors statused <b>far from the pin</b> or a pile of them logged <b>from one spot</b> (a rep working the street moves around). Tap the rep below for their stop-by-stop.</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {flaggedReps.map((r) => (
              <button key={r.name} type="button" onClick={() => setOpenRep(r.name)}
                style={{ textAlign: "left", background: "#fff", border: "1px solid #fecaca", borderRadius: 10, padding: "8px 12px", cursor: "pointer" }}>
                <span style={{ fontSize: 13.5, fontWeight: 800, color: "#991b1b" }}>{r.name}</span>
                <span style={{ fontSize: 12, color: "#7f1d1d", marginLeft: 8 }}>
                  {r.farCount > 0 ? `${r.farCount} far` : ""}{r.farCount > 0 && r.maxSameSpot >= 10 ? " · " : ""}{r.maxSameSpot >= 10 ? `${r.maxSameSpot} from one spot` : ""}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

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
                {!auditOff && <th style={{ padding: "8px 10px" }}>Off-spot</th>}
                <th style={{ padding: "8px 10px" }}>Last active</th>
              </tr>
            </thead>
            <tbody>
              {byRep.map((r) => {
                const open = openRep === r.name;
                const colSpan = (auditOff ? 6 : 7) + OUTCOMES.length;
                return (
                <React.Fragment key={r.name}>
                <tr onClick={() => setOpenRep(open ? null : r.name)} style={{ borderTop: "1px solid #e5e7eb", cursor: "pointer", background: r.flagged ? "#fff7f7" : open ? "#f8fafc" : "#fff" }}>
                  <td style={{ padding: "9px 10px", fontWeight: 700 }}><span style={{ color: "#94a3b8", marginRight: 5 }}>{open ? "▾" : "▸"}</span>{r.flagged ? <span title="Location check — see the banner above">🚩 </span> : null}{r.name}</td>
                  <td style={{ padding: "9px 10px" }}>{r.pinsVisited}{r.visits !== r.pinsVisited ? <span style={{ color: "#94a3b8" }}> ({r.visits} taps)</span> : null}</td>
                  <td style={{ padding: "9px 10px", fontWeight: r.avgSpot != null ? 700 : 400, color: r.avgSpot != null ? "#0f172a" : "#cbd5e1" }}>{fmtDur(r.avgSpot)}</td>
                  <td style={{ padding: "9px 10px" }}>{r.rounds || "—"}</td>
                  {OUTCOMES.map((o) => <td key={o} style={{ padding: "9px 10px", fontWeight: r.outcomes[o] ? 700 : 400, color: r.outcomes[o] ? "#0f172a" : "#cbd5e1" }}>{r.outcomes[o] || 0}</td>)}
                  <td style={{ padding: "9px 10px", fontWeight: r.notHome ? 700 : 400, color: r.notHome ? "#0f172a" : "#cbd5e1" }}>{r.notHome || 0}</td>
                  {!auditOff && (
                    <td style={{ padding: "9px 10px", fontWeight: r.offSpot ? 800 : 400, color: r.farCount ? "#b91c1c" : r.offSpot ? "#b45309" : "#cbd5e1", whiteSpace: "nowrap" }}
                      title={r.offSpot ? `${r.farCount} far from door, ${r.gpsOff} weak-GPS${r.maxSameSpot >= 10 ? `, up to ${r.maxSameSpot} from one spot` : ""}` : ""}>
                      {r.offSpot || 0}{r.farCount ? ` (${r.farCount}⚠️)` : ""}
                    </td>
                  )}
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
                          // KEEP visits that ARE the outcome: not-home, and appt (a
                          // booking/reschedule logs only a visit, no status row — hiding
                          // it is why conversions like Dorothy's no-sit→appt vanished).
                          .filter((a) => !(a.kind === "visit" && a.to_status !== "not_home" && a.to_status !== "appt"))
                          .map((a, i) => {
                          const pin = pinMap[a.pin_id] || {};
                          const tag = a.kind !== "arrival" ? LOC_TAG(a) : null;
                          return (
                            <div key={i} style={{ display: "flex", gap: 10, alignItems: "baseline", fontSize: 12.5, color: "#334155", padding: "3px 8px", background: a.kind === "arrival" ? "transparent" : "#fff", borderRadius: 6, border: a.kind === "arrival" ? "none" : "1px solid #eef2f7" }}>
                              <span style={{ color: "#94a3b8", minWidth: 62, flexShrink: 0 }}>{fmtT(a.created_at)}</span>
                              <span style={{ fontWeight: 700, minWidth: 96, flexShrink: 0 }}>{ACT_LABEL(a)}</span>
                              <span style={{ color: "#475569", flex: 1, minWidth: 0 }}>{pin.name || pin.address || (a.pin_id ? "(pin)" : "")}{pin.name && pin.address ? ` · ${pin.address}` : ""}{a.round > 1 ? ` · round ${a.round}` : ""}</span>
                              {tag && <span style={{ color: tag.color, fontWeight: 700, fontSize: 11.5, whiteSpace: "nowrap", flexShrink: 0 }}>{tag.txt}</span>}
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
