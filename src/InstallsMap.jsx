// DoorDispatcher — Installs Map (?mode=installs). Office view of every CURRENT
// roof install (Roof Started + Upcoming Installs), each pin colored by its
// JOBSITE FOREMAN. First slice of install tracking — foreman links + per-foreman
// day-planning come next (same system as reps).
import React, { useEffect, useMemo, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { supabase } from "./lib/supabase";
import HarvestNav from "./HarvestNav";

const OSWALD = "'Oswald', sans-serif";
const FONT = "'Nunito', system-ui, sans-serif";
// Distinct, high-contrast palette — one per foreman. "Unassigned" always grey.
const PALETTE = ["#2563eb", "#16a34a", "#ea580c", "#7c3aed", "#dc2626", "#0891b2", "#ca8a04", "#db2777", "#4d7c0f", "#9333ea", "#0d9488", "#b45309", "#1d4ed8", "#be123c", "#15803d", "#c026d3"];
const colorFor = (foreman, idx) => (foreman === "Unassigned" ? "#94a3b8" : PALETTE[idx % PALETTE.length]);

export default function InstallsMap() {
  const [state, setState] = useState({ loading: true });
  const mapEl = useRef(null);
  const map = useRef(null);
  const layer = useRef(null);
  const [hidden, setHidden] = useState(() => new Set()); // foremen toggled off

  // Load: token → installs-live
  useEffect(() => {
    (async () => {
      try {
        const { data } = await supabase.from("app_settings").select("value").eq("key", "visit_token").maybeSingle();
        const token = data?.value;
        if (!token) { setState({ loading: false, error: "Map token not set." }); return; }
        const r = await fetch(`/.netlify/functions/installs-live?token=${encodeURIComponent(token)}`);
        const j = await r.json();
        if (!j.ok) { setState({ loading: false, error: j.error || "Couldn't load installs." }); return; }
        setState({ loading: false, installs: j.installs || [], foremen: j.foremen || [] });
      } catch (e) { setState({ loading: false, error: e.message || "Load failed" }); }
    })();
  }, []);

  // foreman → { color, count }
  const foremanMeta = useMemo(() => {
    const m = {};
    (state.foremen || []).forEach((f, i) => { m[f] = { color: colorFor(f, i), count: 0 }; });
    (state.installs || []).forEach((it) => { if (m[it.foreman]) m[it.foreman].count += 1; });
    return m;
  }, [state.foremen, state.installs]);

  // Build the map once installs are loaded
  useEffect(() => {
    if (state.loading || state.error || !mapEl.current) return;
    if (!map.current) {
      map.current = L.map(mapEl.current, { zoomControl: true }).setView([27.9, -82.0], 7);
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© OpenStreetMap" }).addTo(map.current);
      layer.current = L.layerGroup().addTo(map.current);
    }
    layer.current.clearLayers();
    const pts = [];
    for (const it of state.installs || []) {
      if (hidden.has(it.foreman)) continue;
      if (typeof it.lat !== "number" || typeof it.lng !== "number") continue;
      const color = (foremanMeta[it.foreman] || {}).color || "#94a3b8";
      const icon = L.divIcon({
        className: "install-dot",
        html: `<div style="width:16px;height:16px;border-radius:50%;background:${color};border:2px solid #fff;box-shadow:0 1px 3px rgba(0,0,0,.4)"></div>`,
        iconSize: [16, 16], iconAnchor: [8, 8],
      });
      const mk = L.marker([it.lat, it.lng], { icon });
      mk.bindPopup(`<b>${esc(it.name)}</b><br>${esc(it.address || "")}<br><span style="color:${color};font-weight:700">👷 ${esc(it.foreman)}</span><br><span style="color:#64748b">${esc(it.status || "")}</span>`);
      mk.addTo(layer.current);
      pts.push([it.lat, it.lng]);
    }
    if (pts.length) { try { map.current.fitBounds(pts, { padding: [40, 40], maxZoom: 12 }); } catch { /* ignore */ } }
  }, [state, hidden, foremanMeta]);

  const toggle = (f) => setHidden((s) => { const n = new Set(s); n.has(f) ? n.delete(f) : n.add(f); return n; });

  return (
    <div style={{ fontFamily: FONT, height: "100vh", display: "flex", flexDirection: "column" }}>
      <div style={{ padding: "14px 16px 4px" }}><HarvestNav active="installs" /></div>
      <div style={{ padding: "6px 16px 12px", display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
        <h1 style={{ fontFamily: OSWALD, fontSize: 24, fontWeight: 800, margin: 0, color: "#0f172a" }}>🏗️ Roof Installs</h1>
        <span style={{ fontSize: 13.5, color: "#64748b" }}>
          {state.loading ? "Loading current installs…" : state.error ? "" : `${state.installs.length} current installs · ${state.foremen.length} foremen · colored by jobsite foreman`}
        </span>
      </div>

      {state.error && <div style={{ padding: 24, color: "#b91c1c", fontWeight: 700 }}>{state.error}</div>}

      {!state.error && (
        <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
          {/* Foreman legend */}
          <div style={{ width: 230, borderRight: "1px solid #e5e7eb", overflowY: "auto", padding: "10px 12px", background: "#f8fafc" }}>
            <div style={{ fontSize: 11, fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.05em", color: "#94a3b8", margin: "2px 4px 8px" }}>Foremen · tap to toggle</div>
            {(state.foremen || []).map((f) => {
              const meta = foremanMeta[f] || {}; const off = hidden.has(f);
              return (
                <button key={f} type="button" onClick={() => toggle(f)}
                  style={{ display: "flex", alignItems: "center", gap: 9, width: "100%", textAlign: "left", padding: "7px 8px", border: "none", background: off ? "transparent" : "#fff", borderRadius: 9, cursor: "pointer", marginBottom: 4, opacity: off ? 0.45 : 1, boxShadow: off ? "none" : "0 1px 2px rgba(0,0,0,.05)" }}>
                  <span style={{ width: 14, height: 14, borderRadius: "50%", background: meta.color || "#94a3b8", flexShrink: 0, border: "1.5px solid #fff", boxShadow: "0 0 0 1px rgba(0,0,0,.1)" }} />
                  <span style={{ fontSize: 13, fontWeight: 700, color: "#334155", flex: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{f}</span>
                  <span style={{ fontSize: 12, fontWeight: 800, color: "#64748b" }}>{meta.count || 0}</span>
                </button>
              );
            })}
            {!state.loading && !(state.foremen || []).length && <div style={{ fontSize: 12.5, color: "#94a3b8", padding: 6 }}>No current installs found.</div>}
          </div>
          <div ref={mapEl} style={{ flex: 1, minHeight: 0 }} />
        </div>
      )}
    </div>
  );
}

function esc(s) { return String(s || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
