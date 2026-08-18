// Inspector Activity — LIVE report (?mode=inspectvisitreport). Real pin-by-pin data
// from the inspection visit log: per inspector, per day, each roof with its arrival
// + completion time, GPS distance, and the miles driven between stops in the order
// they were actually worked. Populates as inspectors use the Inspection Map.
import React, { useEffect, useMemo, useState } from "react";

const FONT = "'Nunito', system-ui, sans-serif";
const OSWALD = "'Oswald', sans-serif";
const t = (iso) => { if (!iso) return "—"; try { return new Date(iso).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" }); } catch { return "—"; } };
const dayLong = (d) => { try { return new Date(d + "T12:00:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" }); } catch { return d; } };

export default function InspectionVisitReport() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState("");
  const [openInsp, setOpenInsp] = useState(null);
  const [openDay, setOpenDay] = useState(null);
  const load = () => { setErr(""); fetch("/.netlify/functions/inspection-visit-report?days=60").then((r) => r.json()).then((j) => j.ok ? setData(j) : setErr(j.error || "Failed")).catch((e) => setErr(e.message)); };
  useEffect(load, []);

  if (err) return <Wrap><div style={{ color: "#b91c1c" }}>{err}</div></Wrap>;
  if (!data) return <Wrap><div style={{ color: "#94a3b8" }}>Loading…</div></Wrap>;

  return (
    <Wrap>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
        <div style={{ fontSize: 24, fontWeight: 900, fontFamily: OSWALD }}>🔍 Inspector Activity — live</div>
        <button onClick={load} style={{ background: "#0f172a", color: "#fff", border: "none", borderRadius: 10, padding: "9px 15px", fontWeight: 800, fontFamily: OSWALD, cursor: "pointer" }}>↻ Refresh</button>
      </div>
      <div style={{ fontSize: 12.5, color: "#94a3b8", margin: "4px 0 16px" }}>Real pin-by-pin timestamps + GPS from the Inspection Map. Last 60 days.</div>
      {!data.inspectors.length ? (
        <div style={{ color: "#64748b", background: "#f8fafc", borderRadius: 12, padding: 24, textAlign: "center", fontSize: 14 }}>No inspection activity logged yet — this fills in as inspectors work their routes on the Inspection Map (each "I'm here" / "Next" logs a timestamped, GPS'd visit).</div>
      ) : (
        <div style={{ display: "grid", gap: 10 }}>
          {data.inspectors.map((ins) => {
            const io = openInsp === ins.inspector;
            return (
              <div key={ins.inspector}>
                <button onClick={() => setOpenInsp(io ? null : ins.inspector)} style={{ width: "100%", textAlign: "left", cursor: "pointer", background: io ? "#0f172a" : "#eef2f7", border: "none", borderRadius: 12, padding: "12px 16px", display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                  <span style={{ fontSize: 18, fontWeight: 900, fontFamily: OSWALD, color: io ? "#fff" : "#0f172a" }}>👷 {ins.inspector}</span>
                  <span style={{ fontSize: 13, fontWeight: 800, color: io ? "#cbd5e1" : "#64748b" }}>
                    {ins.roofs} roofs · {ins.days} days · ~{ins.miles} mi
                    {/* Roofs is the work. on_map is how many were worked through the
                        map — the GPS-verified ones. A gap is a nudge to use the map,
                        NOT a smaller roof count: the report used to show only the
                        mapped ones and made a 51-roof fortnight look like 13. */}
                    {ins.on_map != null && ins.on_map < ins.roofs && (
                      <span style={{ color: io ? "#94a3b8" : "#b45309" }}> · {ins.on_map} on the map</span>
                    )}
                  </span>
                  <span style={{ marginLeft: "auto", color: io ? "#fff" : "#94a3b8" }}>{io ? "▲" : "▼"}</span>
                </button>
                {io && <div style={{ display: "grid", gap: 6, marginTop: 6 }}>
                  {ins.day_list.map((d) => {
                    const dk = ins.inspector + "|" + d.date, dopen = openDay === dk;
                    return (
                      <div key={dk} style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12, overflow: "hidden" }}>
                        <button onClick={() => setOpenDay(dopen ? null : dk)} style={{ width: "100%", textAlign: "left", background: "none", border: "none", padding: "12px 14px", cursor: "pointer", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
                          <span style={{ fontWeight: 800 }}>{dayLong(d.date)}</span>
                          <span style={{ fontSize: 12.5, color: "#334155" }}><b>{d.roofs}</b> roof{d.roofs === 1 ? "" : "s"} · <b>{t(d.first)}–{t(d.last)}</b> · <b>~{d.miles} mi</b> {dopen ? "▲" : "▼"}</span>
                        </button>
                        {dopen && <div style={{ borderTop: "1px solid #f1f5f9", padding: "10px 14px", background: "#f8fafc" }}>
                          {d.stops.map((s, i) => (
                            <div key={i} style={{ marginBottom: 8 }}>
                              {s.leg_from_prev != null && <div style={{ fontSize: 12, color: "#0891b2", margin: "0 0 3px 26px" }}>↓ {s.leg_from_prev} mi</div>}
                              <div style={{ display: "flex", gap: 8, fontSize: 13.5 }}>
                                <span style={{ color: "#94a3b8", fontWeight: 800, minWidth: 18 }}>{i + 1}.</span>
                                <span style={{ flex: 1 }}>
                                  <b>{s.name || "Homeowner"}</b> — {[s.address, s.city].filter(Boolean).join(", ")}
                                  <span style={{ display: "block", fontSize: 12, color: "#64748b" }}>🕒 {t(s.arrived)}{s.completed ? ` → ${t(s.completed)}` : ""}{s.dist_ft != null ? ` · ${s.dist_ft} ft from roof` : ""}</span>
                                </span>
                              </div>
                            </div>
                          ))}
                        </div>}
                      </div>
                    );
                  })}
                </div>}
              </div>
            );
          })}
        </div>
      )}
    </Wrap>
  );
}
function Wrap({ children }) { return <div style={{ maxWidth: 900, margin: "0 auto", padding: "20px 16px 70px", fontFamily: FONT }}>{children}</div>; }
