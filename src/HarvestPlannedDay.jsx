// Company overview of the Enhanced Planned Day clusters (?mode=harvestplannedday).
// Office-wide, all zones at once: the region's IQ + No-sit pins auto-split into
// balanced sections, one per Sr rep. Each section is a "to be assigned" chunk —
// managers do the actual rep assignment on their own dashboard. Read-only here.
import React, { useEffect, useMemo, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import HarvestNav from "./HarvestNav";

const FONT = "'Nunito', system-ui, sans-serif";
const OSWALD = "'Oswald', sans-serif";
const FN = "/.netlify/functions/harvest-plan-clusters";
const ZONES = ["Zone 1", "Zone 2", "Zone 3", "Zone 4"];
const TEAM = { "Zone 1": "SQUAD", "Zone 2": "SitSold", "Zone 3": "SHARKS", "Zone 4": "HURRICANE" };
const PALETTE = ["#dc2626", "#2563eb", "#16a34a", "#d97706", "#7c3aed", "#0891b2", "#db2777", "#65a30d", "#ea580c", "#0d9488", "#4f46e5", "#b45309"];
const SECTION = (i) => String.fromCharCode(65 + i); // A, B, C…
// Convex hull (Andrew's monotone chain) to outline each section's territory.
function convexHull(pts) {
  if (!pts || pts.length < 3) return pts || [];
  const p = pts.map(([lat, lng]) => [lng, lat]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  for (const q of p) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop(); lower.push(q); }
  const upper = [];
  for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop(); upper.push(q); }
  lower.pop(); upper.pop();
  return lower.concat(upper).map(([lng, lat]) => [lat, lng]);
}

export default function HarvestPlannedDay() {
  const mapEl = useRef(null), mapRef = useRef(null), layerRef = useRef(null);
  const [zones, setZones] = useState({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let live = true;
    (async () => {
      const out = {};
      await Promise.all(ZONES.map(async (z) => {
        try {
          const r = await fetch(FN, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ zone: z, points: true }) });
          const j = await r.json(); if (j.ok) out[z] = j;
        } catch { /* skip zone */ }
      }));
      if (live) { setZones(out); setLoading(false); }
    })();
    return () => { live = false; };
  }, []);

  // Stable color per (zone, cluster index), shared by the map and the list.
  const colorMap = useMemo(() => {
    const m = {}; let i = 0;
    for (const z of ZONES) for (let c = 0; c < (zones[z]?.clusters?.length || 0); c++) m[`${z}:${c}`] = PALETTE[i++ % PALETTE.length];
    return m;
  }, [zones]);

  useEffect(() => {
    if (mapRef.current || !mapEl.current) return;
    const m = L.map(mapEl.current, { zoomControl: true }).setView([27.9, -81.7], 7);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { attribution: "© OpenStreetMap" }).addTo(m);
    mapRef.current = m; layerRef.current = L.layerGroup().addTo(m);
    // Container is often sized after init → tiles don't lay out until we nudge it.
    setTimeout(() => { try { m.invalidateSize(); } catch { /* ignore */ } }, 150);
  }, []);

  useEffect(() => {
    const m = mapRef.current, lyr = layerRef.current; if (!m || !lyr) return;
    lyr.clearLayers();
    for (const z of ZONES) {
      const res = zones[z]; if (!res) continue;
      res.clusters.forEach((c, ci) => {
        const color = colorMap[`${z}:${ci}`];
        const hull = convexHull(c.pts || []);
        if (hull.length >= 3) L.polygon(hull, { color, weight: 1.5, fillColor: color, fillOpacity: 0.08 }).addTo(lyr);
        (c.pts || []).forEach(([lat, lng]) => { L.circleMarker([lat, lng], { radius: 4, color: "#fff", weight: 1, fillColor: color, fillOpacity: 0.9 }).addTo(lyr); });
        if (c.centroid) {
          L.marker([c.centroid.lat, c.centroid.lng], { icon: L.divIcon({ className: "", html: `<div style="background:${color};color:#fff;font-weight:800;font-size:11px;padding:2px 7px;border-radius:8px;border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.4);white-space:nowrap">${z.replace("Zone ", "Z")}·${SECTION(ci)} · ${c.count}</div>`, iconAnchor: [22, 11] }), zIndexOffset: 1000 }).addTo(lyr);
        }
      });
    }
    // Keep the fixed Florida-wide view (all pins are in FL) — reliable, no fit-timing race.
    try { m.invalidateSize(); } catch { /* ignore */ }
  }, [zones, colorMap]);

  const grandTotal = ZONES.reduce((s, z) => s + (zones[z]?.total || 0), 0);

  return (
    <div style={{ fontFamily: FONT, background: "#f1f5f9", minHeight: "100vh" }}>
      <HarvestNav active="plannedday" />
      <div style={{ maxWidth: 1100, margin: "0 auto", padding: "18px 16px 60px" }}>
        <h1 style={{ fontFamily: OSWALD, fontSize: 24, fontWeight: 800, margin: "6px 0 2px" }}>🧭 Planned Day — Cluster Overview</h1>
        <p style={{ color: "#475569", fontSize: 14.5, lineHeight: 1.5, marginTop: 4 }}>
          Every zone's <b>IQ + No-sit</b> pins auto-split into balanced <b>sections</b>, one per Sr rep on that team. These are the chunks to be assigned — each manager assigns their zone's sections to their reps. {loading ? "" : <b>{grandTotal} pins</b>} across the company.
        </p>

        <div ref={mapEl} style={{ height: 480, borderRadius: 12, overflow: "hidden", border: "1px solid #e2e8f0", marginTop: 12, background: "#e5e7eb" }} />
        {loading && <p style={{ color: "#64748b", fontSize: 14, marginTop: 10 }}>Building clusters for all zones…</p>}

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(250px, 1fr))", gap: 12, marginTop: 16 }}>
          {ZONES.map((z) => {
            const res = zones[z];
            return (
              <div key={z} style={{ background: "#fff", border: "1px solid #e2e8f0", borderRadius: 12, padding: 14 }}>
                <div style={{ fontFamily: OSWALD, fontWeight: 800, fontSize: 16 }}>{TEAM[z]} <span style={{ color: "#94a3b8", fontSize: 12, fontWeight: 600 }}>{z}</span></div>
                {!res ? <div style={{ color: "#94a3b8", fontSize: 13, marginTop: 6 }}>{loading ? "Loading…" : "No data"}</div> : (
                  <>
                    <div style={{ fontSize: 12.5, color: "#475569", margin: "4px 0 10px" }}>{res.total} pins · {res.srReps.length} Sr rep{res.srReps.length === 1 ? "" : "s"} · {res.clusters.length} section{res.clusters.length === 1 ? "" : "s"}</div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                      {res.clusters.map((c, ci) => (
                        <div key={ci} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13.5 }}>
                          <span style={{ width: 12, height: 12, borderRadius: 3, background: colorMap[`${z}:${ci}`], flexShrink: 0 }} />
                          <span style={{ fontWeight: 800 }}>Section {SECTION(ci)}</span>
                          <span style={{ color: "#64748b", marginLeft: "auto" }}>{c.count} pins</span>
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </div>
            );
          })}
        </div>
        <p style={{ fontSize: 12, color: "#94a3b8", marginTop: 14 }}>Read-only company view. Sections rebalance automatically as pins change. Managers assign sections to specific reps on their dashboard.</p>
      </div>
    </div>
  );
}
