// Regional-manager team map for the Harvesting Map. Shows ONLY this manager's zone
// reps: live position + a breadcrumb trail + last action, plus today's counts per rep.
// Data: /.netlify/functions/harvest-team-manager?manager=<token> (zone-scoped server
// side — the manager token never sees another zone's reps). Polls every 30s.
import React, { useEffect, useMemo, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

const FONT = "'Nunito', system-ui, sans-serif";
// Distinct colors so each rep's dot + trail is tellable apart at a glance.
const REP_COLORS = ["#2563eb", "#16a34a", "#dc2626", "#9333ea", "#ea580c", "#0891b2", "#db2777", "#65a30d", "#4f46e5", "#b45309", "#0d9488", "#be123c"];
const repColor = (i) => REP_COLORS[i % REP_COLORS.length];

function esc(s) { return String(s || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

export default function ManagerHarvestMap({ token, theme }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState("");
  const [loadedOnce, setLoadedOnce] = useState(false);
  const mapEl = useRef(null);
  const map = useRef(null);
  const layer = useRef(null);
  const fitted = useRef(false);
  const accent = theme?.deep || "#0f172a";

  // Poll the zone-scoped team feed.
  useEffect(() => {
    let live = true;
    const pull = async () => {
      try {
        const r = await fetch(`/.netlify/functions/harvest-team-manager?manager=${encodeURIComponent(token)}&mins=180`);
        const j = await r.json();
        if (!live) return;
        if (!j.ok) { setErr(j.error || "Couldn't load the team map."); return; }
        setErr(""); setData(j); setLoadedOnce(true);
      } catch { if (live) setErr("Network error loading the team map."); }
    };
    pull();
    const t = setInterval(pull, 30000);
    return () => { live = false; clearInterval(t); };
  }, [token]);

  // Init Leaflet once.
  useEffect(() => {
    if (map.current || !mapEl.current) return;
    const m = L.map(mapEl.current, { zoomControl: true, attributionControl: true }).setView([27.9, -82.3], 9);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© OpenStreetMap" }).addTo(m);
    layer.current = L.layerGroup().addTo(m);
    map.current = m;
    setTimeout(() => { try { m.invalidateSize(); } catch { /* ignore */ } }, 60);
  }, []);

  const reps = data?.reps || [];

  // Draw rep trails + labelled position dots.
  useEffect(() => {
    const m = map.current, lyr = layer.current;
    if (!m || !lyr) return;
    lyr.clearLayers();
    const pts = [];
    reps.forEach((rep, i) => {
      const color = repColor(i);
      const trail = (rep.pings || []).filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));
      if (trail.length > 1) L.polyline(trail.map((p) => [p.lat, p.lng]), { color, weight: 3.5, opacity: 0.75 }).addTo(lyr);
      const pos = rep.last_pos && Number.isFinite(rep.last_pos.lat) ? rep.last_pos : null;
      if (!pos) return;
      pts.push([pos.lat, pos.lng]);
      const dim = rep.live ? "" : ";opacity:.55;filter:grayscale(.4)";
      const icon = L.divIcon({
        className: "mgr-rep",
        html: `<div style="display:flex;flex-direction:column;align-items:center;transform:translateY(-4px)${dim}">
          <div style="background:${color};color:#fff;font-size:10px;font-weight:800;padding:1px 7px;border-radius:8px;white-space:nowrap;box-shadow:0 1px 3px rgba(0,0,0,.4);margin-bottom:2px">${esc(rep.name)}${rep.live ? "" : " · idle"}${rep.last_action ? " · " + esc(rep.last_action) : ""}</div>
          <div style="width:15px;height:15px;border-radius:50%;background:${color};border:2px solid #fff;box-shadow:0 1px 3px rgba(0,0,0,.5)"></div>
        </div>`,
        iconSize: [1, 1], iconAnchor: [0, 7],
      });
      L.marker([pos.lat, pos.lng], { icon, zIndexOffset: rep.live ? 2000 : 800 }).addTo(lyr);
    });
    if (pts.length && !fitted.current) { try { m.fitBounds(pts, { padding: [40, 40], maxZoom: 15 }); fitted.current = true; } catch { /* ignore */ } }
  }, [reps]);

  const liveCount = useMemo(() => reps.filter((r) => r.live).length, [reps]);
  const totals = useMemo(() => reps.reduce((a, r) => ({
    knocks: a.knocks + r.today.knocks, sold: a.sold + r.today.sold, appts: a.appts + r.today.appts, notHome: a.notHome + r.today.notHome, ni: a.ni + r.today.ni,
  }), { knocks: 0, sold: 0, appts: 0, notHome: 0, ni: 0 }), [reps]);

  return (
    <div style={{ fontFamily: FONT }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8, marginBottom: 10 }}>
        <div style={{ fontSize: 13, color: "#475569" }}>
          <b style={{ color: accent }}>{liveCount}</b> out working now{reps.length ? ` · ${reps.length} on the team` : ""}
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <Stat label="Knocks" value={totals.knocks} color="#475569" />
          <Stat label="Signed" value={totals.sold} color="#16a34a" />
          <Stat label="Appts" value={totals.appts} color="#2563eb" />
          <Stat label="Not home" value={totals.notHome} color="#94a3b8" />
        </div>
      </div>

      {err && <div style={{ color: "#b91c1c", fontSize: 13, marginBottom: 8 }}>{err}</div>}
      {!loadedOnce && !err && <div style={{ color: "#94a3b8", fontSize: 13, marginBottom: 8 }}>Loading team map…</div>}

      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "stretch" }}>
        <div ref={mapEl} style={{ flex: "1 1 420px", minWidth: 300, height: 440, borderRadius: 12, overflow: "hidden", border: "1px solid #e5e7eb" }} />
        <div style={{ flex: "1 1 260px", minWidth: 240, maxHeight: 440, overflowY: "auto" }}>
          {loadedOnce && reps.length === 0 && (
            <div style={{ fontSize: 13, color: "#64748b", background: "#f8fafc", border: "1px solid #e5e7eb", borderRadius: 10, padding: "16px 14px" }}>
              No reps on this team have worked the map today. Their live position and today's counts show up here as they knock.
            </div>
          )}
          {reps.map((rep, i) => (
            <div key={rep.rep_id || rep.name} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", marginBottom: 6, borderRadius: 10, border: "1px solid #eef2f7", background: rep.live ? "#f0fdf4" : "#fff" }}>
              <span style={{ width: 11, height: 11, borderRadius: 6, background: repColor(i), flexShrink: 0, boxShadow: rep.live ? `0 0 0 3px ${repColor(i)}33` : "none" }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13.5, fontWeight: 800, color: "#0f172a", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {rep.name} {rep.live ? <span style={{ fontSize: 10.5, fontWeight: 800, color: "#16a34a" }}>● LIVE</span> : <span style={{ fontSize: 10.5, fontWeight: 700, color: "#cbd5e1" }}>idle</span>}
                </div>
                <div style={{ fontSize: 11.5, color: "#64748b" }}>
                  {rep.today.knocks} knock{rep.today.knocks === 1 ? "" : "s"} · {rep.today.sold} signed · {rep.today.appts} appt{rep.today.appts === 1 ? "" : "s"}{rep.last_action ? ` · ${rep.last_action}` : ""}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
      <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 8 }}>Live positions refresh every 30s · a rep drops to “idle” after 15 min without a ping. Trails cover the last 3 hours.</div>
    </div>
  );
}

function Stat({ label, value, color }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "baseline", gap: 4, background: "#fff", border: "1px solid #e5e7eb", borderRadius: 999, padding: "3px 10px" }}>
      <b style={{ fontSize: 14, color }}>{value}</b>
      <span style={{ fontSize: 11, color: "#64748b", fontWeight: 700 }}>{label}</span>
    </span>
  );
}
