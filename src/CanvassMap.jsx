// Canvassing map — "Sales Rabbit"-style door-knocking tool. Lives at ?mode=canvass.
//
// Baseline: the office uploads a list of addresses (geocoded server-side into
// canvass_prospects as status 'iq'); a rep opens this on their phone, sees the
// pins colored by status, taps one, and changes its status (e.g. IQ → Appt).
// v1 just records the status on the pin — no JobNimbus write yet.
import React, { useEffect, useRef, useState, useMemo } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import "leaflet.markercluster";
import "leaflet.markercluster/dist/MarkerCluster.css";
import "leaflet.markercluster/dist/MarkerCluster.Default.css";
import { supabase } from "./lib/supabase";

// Fallback used only if the harvest_pin_types config table can't be reached.
// The live pin types (label, color, allowed outcomes, who sees them) are loaded
// from that table so the office can edit them on the admin page.
const FALLBACK_TYPES = [
  { key: "iq", label: "IQ", color: "#2563eb", outcomes: ["iq_ni", "appt"] },
  { key: "appt", label: "Appointment", color: "#16a34a", outcomes: ["no_sit_reschedule"] },
  { key: "no_sit_reschedule", label: "No sit – reschedule", color: "#dc2626", outcomes: ["appt", "dead"] },
  { key: "iq_ni", label: "IQ – Not Interested", color: "#f59e0b", outcomes: ["insp_sold", "dead"] },
  { key: "insp", label: "Inspection Lead", color: "#0ea5e9", outcomes: ["insp_sold", "dead"] },
  { key: "insp_sold", label: "Inspection Sold", color: "#7c3aed", outcomes: [], is_terminal: true },
  { key: "dead", label: "Dead / DNK", color: "#111827", outcomes: [], is_terminal: true },
];
const UNKNOWN_TYPE = { color: "#64748b", label: "—", outcomes: [] };

// Gold star for installs (roofs we've already put on) — a read-only reference
// layer every rep (junior + senior) sees. Distinct shape so it never reads as a
// canvassing pin.
const INSTALL_COLOR = "#ca8a04";
const STAR_ICON = L.divIcon({
  className: "harvest-install-star",
  html: `<svg width="24" height="24" viewBox="0 0 24 24" style="filter:drop-shadow(0 1px 1.5px rgba(0,0,0,.45))"><path d="M12 1.8l3 6.1 6.7 1-4.8 4.7 1.1 6.7L12 17.9 6 21l1.1-6.7L2.3 8.9l6.7-1z" fill="${INSTALL_COLOR}" stroke="#fff" stroke-width="1.3" stroke-linejoin="round"/></svg>`,
  iconSize: [24, 24],
  iconAnchor: [12, 12],
});

// Colored dot as an L.Marker (divIcon) so it clusters — markerClusterGroup only
// clusters L.Marker, not L.circleMarker.
function dotIcon(color) {
  return L.divIcon({
    className: "harvest-dot",
    html: `<div style="width:18px;height:18px;border-radius:50%;background:${color};border:2px solid #fff;box-shadow:0 1px 2px rgba(0,0,0,.4)"></div>`,
    iconSize: [18, 18],
    iconAnchor: [9, 9],
  });
}
const FONT = "'Nunito', system-ui, sans-serif";

export default function CanvassMap() {
  const mapEl = useRef(null);
  const map = useRef(null);
  const layer = useRef(null);
  const fitted = useRef(false);
  const [prospects, setProspects] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState(null);
  const [filter, setFilter] = useState("all");
  const [pinTypes, setPinTypes] = useState(FALLBACK_TYPES);
  const [me, setMe] = useState(null);          // { name, level } once signed in
  const [authError, setAuthError] = useState("");
  const [apptPin, setApptPin] = useState(null); // pin being scheduled → appointment
  const [installs, setInstalls] = useState([]);        // read-only star layer (jr + sr)
  const [showInstalls, setShowInstalls] = useState(true);
  const [selectedInstall, setSelectedInstall] = useState(null);
  // "Start my day" route planner.
  const [dayMode, setDayMode] = useState(null);        // null | 'choosing' | 'active'
  const [route, setRoute] = useState([]);              // ordered stops (nearest-first)
  const [stopIdx, setStopIdx] = useState(0);
  const choosingRef = useRef(false);                   // map-click reads this (avoid stale closure)
  const shownRef = useRef([]);                         // current on-screen prospects, for routing
  const startFromRef = useRef(null);
  const S = useMemo(() => Object.fromEntries(pinTypes.map((t) => [t.key, t])), [pinTypes]);
  const repName = me?.name || "";

  // Server decides which pins this rep's level may see. Reads the personal link
  // token (?rt=) or the office view-all token (?admin=).
  const auth = (() => {
    try {
      const q = new URLSearchParams(window.location.search);
      return { rt: q.get("rt") || "", admin: q.get("admin") || "" };
    } catch { return { rt: "", admin: "" }; }
  })();

  async function load() {
    setLoading(true);
    try {
      const qs = auth.admin ? `admin=${encodeURIComponent(auth.admin)}` : `rt=${encodeURIComponent(auth.rt)}`;
      const r = await fetch(`/.netlify/functions/harvest-pins?${qs}`);
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) { setAuthError(j.error || "Couldn't load your Harvesting Map."); setLoading(false); return; }
      setAuthError("");
      setMe(j.rep || null);
      if (Array.isArray(j.pin_types) && j.pin_types.length) setPinTypes(j.pin_types);
      setProspects(j.pins || []);
      setInstalls(Array.isArray(j.installs) ? j.installs : []);
    } catch (e) { setAuthError(e.message || "Network error."); }
    setLoading(false);
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);

  // Init the Leaflet map once.
  useEffect(() => {
    if (map.current || !mapEl.current) return;
    const m = L.map(mapEl.current, { zoomControl: true }).setView([27.95, -82.46], 10); // Tampa Bay default
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19, attribution: "&copy; OpenStreetMap",
    }).addTo(m);
    map.current = m;
    // "Start my day": while choosing a start point, a map tap starts the route there.
    m.on("click", (e) => {
      if (choosingRef.current && startFromRef.current) startFromRef.current({ lat: e.latlng.lat, lng: e.latlng.lng });
    });
    // Cluster group so a zoomed-out map groups nearby pins into a numbered
    // bubble; zooming in splits them back into individual pins/stars.
    layer.current = L.markerClusterGroup({
      showCoverageOnHover: false,
      maxClusterRadius: 55,
      spiderfyOnMaxZoom: true,
      disableClusteringAtZoom: 17,
      chunkedLoading: true,
    }).addTo(m);
    // Leaflet computes its size at init; inside a flex layout the container
    // may not have its final size yet, leaving the tiles rendered for a tiny
    // box. Recalc on mount AND whenever the container resizes.
    const recalc = () => m.invalidateSize();
    setTimeout(recalc, 0); setTimeout(recalc, 300);
    const ro = new ResizeObserver(recalc);
    ro.observe(mapEl.current);
    return () => ro.disconnect();
  }, []);

  const mapped = useMemo(
    () => prospects.filter((p) => p.latitude != null && p.longitude != null),
    [prospects],
  );

  // (Re)draw pins whenever the data or the filter changes.
  useEffect(() => {
    const m = map.current, lyr = layer.current;
    if (!m || !lyr) return;
    lyr.clearLayers();
    const shown = mapped.filter((p) => filter === "all" || p.status === filter);
    shownRef.current = shown; // for "Start my day" routing
    const markers = [];
    const pts = [];
    for (const p of shown) {
      const color = (S[p.status] || UNKNOWN_TYPE).color;
      const marker = L.marker([p.latitude, p.longitude], { icon: dotIcon(color) });
      marker.on("click", () => { setSelectedInstall(null); setSelected(p); });
      markers.push(marker);
      pts.push([p.latitude, p.longitude]);
    }
    // Installs — gold stars, shown to every rep as a reference layer.
    if (showInstalls) {
      for (const it of installs) {
        if (typeof it.latitude !== "number" || typeof it.longitude !== "number") continue;
        const marker = L.marker([it.latitude, it.longitude], { icon: STAR_ICON });
        marker.on("click", () => { setSelected(null); setSelectedInstall(it); });
        markers.push(marker);
      }
    }
    lyr.addLayers(markers); // bulk add → clustered
    if (pts.length && !fitted.current) {
      m.fitBounds(pts, { padding: [40, 40], maxZoom: 15 });
      fitted.current = true;
    }
  }, [mapped, filter, installs, showInstalls]);

  async function setStatus(p, newStatus) {
    const nowIso = new Date().toISOString();
    const entry = { at: nowIso, from: p.status, to: newStatus, by: repName || "rep" };
    const log = Array.isArray(p.status_log) ? [...p.status_log, entry] : [entry];
    const patch = { status: newStatus, status_updated_at: nowIso, status_by: repName || null, status_log: log };
    const { error } = await supabase.from("canvass_prospects").update(patch).eq("id", p.id);
    if (error) { alert(error.message); return; }
    setProspects((list) => list.map((x) => (x.id === p.id ? { ...x, ...patch } : x)));
    setSelected((s) => (s && s.id === p.id ? { ...s, ...patch } : s));
  }

  // ── Start my day ───────────────────────────────────────────────────────
  // Order the on-screen prospect pins nearest-first from a start point (the
  // rep's location or a tapped spot), then walk them one stop at a time.
  useEffect(() => { choosingRef.current = dayMode === "choosing"; }, [dayMode]);

  function buildRoute(start, pins) {
    const rem = pins.filter((p) => typeof p.latitude === "number" && typeof p.longitude === "number");
    const out = [];
    let cur = start;
    while (rem.length) {
      let bi = 0, bd = Infinity;
      for (let i = 0; i < rem.length; i++) {
        const dx = cur.lat - rem[i].latitude, dy = cur.lng - rem[i].longitude;
        const d = dx * dx + dy * dy;
        if (d < bd) { bd = d; bi = i; }
      }
      const nx = rem.splice(bi, 1)[0];
      out.push(nx);
      cur = { lat: nx.latitude, lng: nx.longitude };
    }
    return out;
  }
  function startFrom(pt) {
    const r = buildRoute(pt, shownRef.current || []);
    if (!r.length) { alert("No stops on the map to route. Load leads or change the filter, then start your day."); setDayMode(null); return; }
    setRoute(r); setStopIdx(0); setDayMode("active");
    if (map.current) map.current.setView([r[0].latitude, r[0].longitude], 15);
  }
  startFromRef.current = startFrom;
  function useMyLocation() {
    if (!navigator.geolocation) { alert("Location isn't available on this device — tap the map to pick a start point."); return; }
    navigator.geolocation.getCurrentPosition(
      (pos) => startFrom({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      () => alert("Couldn't get your location. Allow location access, or tap the map to pick a start point."),
      { enableHighAccuracy: true, timeout: 10000 },
    );
  }
  function nextStop() {
    setStopIdx((i) => {
      const ni = i + 1;
      if (ni < route.length && map.current) map.current.setView([route[ni].latitude, route[ni].longitude], 15);
      return ni;
    });
  }
  function startOver() { setDayMode(null); setRoute([]); setStopIdx(0); }
  function dirTo(p) {
    const dest = [p.address, p.city, p.state, p.zip].filter(Boolean).join(", ") || `${p.latitude},${p.longitude}`;
    window.open(`https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(dest)}`, "_blank");
  }

  const counts = useMemo(() => {
    const c = {};
    for (const p of prospects) c[p.status] = (c[p.status] || 0) + 1;
    return c;
  }, [prospects]);
  const notMapped = prospects.length - mapped.length;

  // Bad/missing link → don't show any pins, just tell them what to do.
  if (authError) {
    return (
      <div style={{ position: "fixed", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: FONT, background: "#f1f5f9", padding: 24 }}>
        <div style={{ maxWidth: 360, textAlign: "center", background: "#fff", borderRadius: 16, padding: "28px 24px", boxShadow: "0 2px 12px rgba(0,0,0,.1)" }}>
          <div style={{ fontSize: 40, marginBottom: 10 }}>🔒</div>
          <div style={{ fontSize: 17, fontWeight: 800, fontFamily: "'Oswald', sans-serif", marginBottom: 8 }}>Harvesting Map</div>
          <div style={{ fontSize: 14, color: "#475569", lineHeight: 1.5 }}>{authError}</div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ position: "fixed", inset: 0, display: "flex", flexDirection: "column", fontFamily: FONT, background: "#f1f5f9" }}>
      {/* Header */}
      <div style={{ padding: "10px 14px", background: "#0f172a", color: "#fff", display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <div style={{ fontWeight: 800, fontSize: 16, fontFamily: "'Oswald', sans-serif", letterSpacing: "0.02em" }}>🌾 Harvesting Map</div>
        <div style={{ fontSize: 12, opacity: 0.8 }}>{mapped.length} pins</div>
        {me?.level === "admin" && (
          <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
            <a href="/?mode=harvestupload" style={{ color: "#cbd5e1", fontSize: 12.5, fontWeight: 700, textDecoration: "none" }}>📥 Load Leads</a>
            <a href="/?mode=harvestlinks" style={{ color: "#cbd5e1", fontSize: 12.5, fontWeight: 700, textDecoration: "none" }}>🔗 Rep Links</a>
            <a href="/?mode=harvestadmin" style={{ color: "#cbd5e1", fontSize: 12.5, fontWeight: 700, textDecoration: "none" }}>🎛️ Pin Types</a>
          </div>
        )}
        <div style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
          {me ? (
            <span style={{ fontSize: 12.5, fontWeight: 700, display: "flex", alignItems: "center", gap: 6 }}>
              {me.name}
              <span style={{ fontSize: 10.5, fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.04em", background: me.level === "senior" ? "#16a34a" : me.level === "admin" ? "#7c3aed" : "#334155", padding: "2px 8px", borderRadius: 10 }}>{me.level}</span>
            </span>
          ) : null}
        </div>
      </div>

      {/* Status filter chips */}
      <div style={{ display: "flex", gap: 6, overflowX: "auto", padding: "8px 12px", background: "#fff", borderBottom: "1px solid #e5e7eb" }}>
        <Chip active={filter === "all"} onClick={() => setFilter("all")} color="#334155" label={`All (${prospects.length})`} />
        {pinTypes.map((s) => (
          <Chip key={s.key} active={filter === s.key} onClick={() => setFilter(s.key)} color={s.color} label={`${s.label} (${counts[s.key] || 0})`} />
        ))}
        {installs.length > 0 && (
          <Chip active={showInstalls} onClick={() => setShowInstalls((v) => !v)} color={INSTALL_COLOR} label={`⭐ Installs (${installs.length})`} />
        )}
      </div>

      {/* Map */}
      <div style={{ position: "relative", flex: 1 }}>
        <div ref={mapEl} style={{ position: "absolute", inset: 0 }} />
        {loading && (
          <div style={{ position: "absolute", top: 12, left: "50%", transform: "translateX(-50%)", background: "#fff", padding: "6px 14px", borderRadius: 20, fontSize: 13, boxShadow: "0 2px 8px rgba(0,0,0,.15)", zIndex: 500 }}>Loading pins…</div>
        )}
        {!loading && prospects.length === 0 && (
          <div style={{ position: "absolute", top: 20, left: "50%", transform: "translateX(-50%)", background: "#fff", padding: "14px 18px", borderRadius: 12, fontSize: 13.5, color: "#475569", boxShadow: "0 2px 10px rgba(0,0,0,.12)", zIndex: 500, textAlign: "center", maxWidth: 320 }}>
            No pins in your area yet. The office loads leads from the admin section.
          </div>
        )}

        {/* ── Start my day ── */}
        {dayMode === null && prospects.length > 0 && (
          <button type="button" onClick={() => setDayMode("choosing")}
            style={{ position: "absolute", left: 12, bottom: 16, zIndex: 600, background: "#16a34a", color: "#fff", border: "none", borderRadius: 999, padding: "13px 20px", fontSize: 15, fontWeight: 800, fontFamily: "'Oswald', sans-serif", boxShadow: "0 3px 12px rgba(0,0,0,.25)", cursor: "pointer" }}>
            ▶ Start my day
          </button>
        )}

        {dayMode === "choosing" && (
          <div style={{ position: "absolute", left: "50%", top: 16, transform: "translateX(-50%)", zIndex: 600, background: "#fff", borderRadius: 14, padding: "16px 18px", boxShadow: "0 4px 18px rgba(0,0,0,.2)", width: "min(360px, 92%)", textAlign: "center" }}>
            <div style={{ fontSize: 16, fontWeight: 800, fontFamily: "'Oswald', sans-serif", color: "#0f172a", marginBottom: 6 }}>Where are you starting?</div>
            <div style={{ fontSize: 13, color: "#64748b", marginBottom: 14 }}>Start from your location, or <b>tap anywhere on the map</b> to start there. We'll route your stops nearest-first.</div>
            <button type="button" onClick={useMyLocation}
              style={{ width: "100%", background: "#16a34a", color: "#fff", border: "none", borderRadius: 12, padding: "13px", fontSize: 15, fontWeight: 800, cursor: "pointer", marginBottom: 8 }}>
              📍 Start from my location
            </button>
            <button type="button" onClick={() => setDayMode(null)}
              style={{ width: "100%", background: "#fff", color: "#64748b", border: "1px solid #e5e7eb", borderRadius: 12, padding: "11px", fontSize: 13.5, fontWeight: 700, cursor: "pointer" }}>
              Cancel
            </button>
          </div>
        )}

        {dayMode === "active" && (() => {
          const done = stopIdx >= route.length;
          const stop = done ? null : route[stopIdx];
          return (
            <div style={{ position: "absolute", left: "50%", top: 16, transform: "translateX(-50%)", zIndex: 600, background: "#fff", borderRadius: 14, padding: "14px 16px", boxShadow: "0 4px 18px rgba(0,0,0,.2)", width: "min(380px, 94%)" }}>
              {done ? (
                <div style={{ textAlign: "center" }}>
                  <div style={{ fontSize: 30 }}>🎉</div>
                  <div style={{ fontSize: 16, fontWeight: 800, fontFamily: "'Oswald', sans-serif", margin: "4px 0 10px" }}>That's every stop — nice work!</div>
                  <button type="button" onClick={startOver} style={{ width: "100%", background: "#16a34a", color: "#fff", border: "none", borderRadius: 12, padding: "12px", fontSize: 14.5, fontWeight: 800, cursor: "pointer" }}>▶ Start a new route</button>
                </div>
              ) : (
                <>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                    <span style={{ fontSize: 11.5, fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.05em", color: "#16a34a" }}>Stop {stopIdx + 1} of {route.length}</span>
                    <button type="button" onClick={startOver} style={{ background: "none", border: "none", fontSize: 12.5, fontWeight: 700, color: "#94a3b8", cursor: "pointer" }}>↺ Start over</button>
                  </div>
                  {stop.name && <div style={{ fontSize: 15.5, fontWeight: 800 }}>{stop.name}</div>}
                  <div style={{ fontSize: 13.5, color: "#334155", fontWeight: 600 }}>{stop.address}</div>
                  <div style={{ fontSize: 12.5, color: "#64748b" }}>{[stop.city, stop.state, stop.zip].filter(Boolean).join(", ")}</div>
                  <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                    <button type="button" onClick={() => dirTo(stop)} style={{ flex: 2, background: "#1d4ed8", color: "#fff", border: "none", borderRadius: 12, padding: "12px", fontSize: 14.5, fontWeight: 800, cursor: "pointer" }}>
                      🧭 Directions to {stopIdx === 0 ? "first stop" : "this stop"}
                    </button>
                    <button type="button" onClick={nextStop} style={{ flex: 1, background: "#fff", color: "#16a34a", border: "1px solid #16a34a", borderRadius: 12, padding: "12px", fontSize: 14, fontWeight: 800, cursor: "pointer" }}>
                      Next ›
                    </button>
                  </div>
                </>
              )}
            </div>
          );
        })()}
      </div>

      {/* Selected prospect sheet */}
      {selected && (
        <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, background: "#fff", borderTopLeftRadius: 18, borderTopRightRadius: 18, boxShadow: "0 -4px 20px rgba(0,0,0,.18)", padding: "16px 18px 22px", zIndex: 1000, maxHeight: "62vh", overflowY: "auto" }}>
          <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
            <div style={{ flex: 1 }}>
              {selected.name && <div style={{ fontWeight: 800, fontSize: 16 }}>{selected.name}</div>}
              <div style={{ fontSize: 14, color: "#334155", fontWeight: 600 }}>{selected.address}</div>
              <div style={{ fontSize: 13, color: "#64748b" }}>{[selected.city, selected.state, selected.zip].filter(Boolean).join(", ")}</div>
              <div style={{ marginTop: 6, display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12.5, fontWeight: 700 }}>
                <span style={{ width: 10, height: 10, borderRadius: 5, background: (S[selected.status] || UNKNOWN_TYPE).color, display: "inline-block" }} />
                {(S[selected.status] || UNKNOWN_TYPE).label}
                {selected.status_by ? <span style={{ color: "#94a3b8", fontWeight: 600 }}> · by {selected.status_by}</span> : null}
              </div>
            </div>
            <button type="button" onClick={() => setSelected(null)} style={{ background: "none", border: "none", fontSize: 22, color: "#94a3b8", cursor: "pointer", lineHeight: 1 }}>×</button>
          </div>

          {/* All the info we have on this pin */}
          {(() => {
            const rows = [];
            if (selected.phone) rows.push(["Phone", selected.phone]);
            if (selected.email) rows.push(["Email", selected.email]);
            if (selected.extra && typeof selected.extra === "object") {
              for (const [k, v] of Object.entries(selected.extra)) if (v != null && String(v).trim()) rows.push([k, String(v)]);
            }
            if (selected.list_name) rows.push(["List", selected.list_name]);
            if (selected.status_updated_at) rows.push(["Updated", new Date(selected.status_updated_at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })]);
            if (selected.notes) rows.push(["Notes", selected.notes]);
            if (!rows.length) return null;
            return (
              <div style={{ marginTop: 12, borderTop: "1px solid #f1f5f9", paddingTop: 10, display: "grid", gap: 4 }}>
                {rows.map(([k, v], i) => (
                  <div key={k + i} style={{ display: "flex", gap: 8, fontSize: 12.5 }}>
                    <span style={{ color: "#94a3b8", fontWeight: 700, minWidth: 96, textTransform: "capitalize", flexShrink: 0 }}>{k}</span>
                    <span style={{ color: "#334155", fontWeight: 600, wordBreak: "break-word" }}>{v}</span>
                  </div>
                ))}
              </div>
            );
          })()}

          {(() => {
            // Behavior flow: offer only the outcomes this pin type allows. If the
            // type defines none (terminal, or unconfigured), fall back to every
            // type so a mis-set pin can still be corrected.
            const cur = S[selected.status];
            const allowed = (cur?.outcomes || []).map((k) => S[k]).filter(Boolean);
            const options = allowed.length ? allowed : pinTypes;
            return (
              <>
                <div style={{ fontSize: 12, fontWeight: 700, color: "#64748b", margin: "14px 0 8px" }}>
                  {allowed.length ? "Outcome" : "Set status"}
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                  {options.map((s) => {
                    const on = selected.status === s.key;
                    return (
                      <button key={s.key} type="button" onClick={() => s.key === "appt" ? setApptPin(selected) : setStatus(selected, s.key)}
                        style={{ padding: "9px 14px", borderRadius: 10, fontSize: 13.5, fontWeight: 700, cursor: "pointer",
                          border: on ? `2px solid ${s.color}` : "1px solid #e5e7eb",
                          background: on ? s.color : "#fff", color: on ? "#fff" : "#334155" }}>
                        {s.label}
                      </button>
                    );
                  })}
                </div>
              </>
            );
          })()}

          <a href={`https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent([selected.address, selected.city, selected.state, selected.zip].filter(Boolean).join(", "))}`}
            target="_blank" rel="noreferrer"
            style={{ display: "block", textAlign: "center", marginTop: 16, padding: "12px", borderRadius: 12, background: "#1d4ed8", color: "#fff", fontWeight: 700, fontSize: 14, textDecoration: "none" }}>
            🧭 Navigate to this address
          </a>
        </div>
      )}

      {apptPin && (
        <AppointmentModal
          pin={apptPin} rt={auth.rt}
          onClose={() => setApptPin(null)}
          onBooked={(patch) => {
            setProspects((list) => list.map((x) => (x.id === apptPin.id ? { ...x, ...patch } : x)));
            setSelected((s) => (s && s.id === apptPin.id ? { ...s, ...patch } : s));
            setApptPin(null);
          }}
        />
      )}

      {/* Selected install sheet — read-only (installs aren't canvassing pins). */}
      {selectedInstall && (
        <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, background: "#fff", borderTopLeftRadius: 18, borderTopRightRadius: 18, boxShadow: "0 -4px 20px rgba(0,0,0,.18)", padding: "16px 18px 22px", zIndex: 1000, maxHeight: "50vh", overflowY: "auto" }}>
          <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
            <div style={{ flex: 1 }}>
              <div style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11, fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.04em", color: INSTALL_COLOR }}>⭐ Install</div>
              <div style={{ fontSize: 15, color: "#334155", fontWeight: 700, marginTop: 3 }}>{selectedInstall.address_line}</div>
              <div style={{ fontSize: 13, color: "#64748b" }}>{selectedInstall.city}</div>
              {(selectedInstall.product_type || selectedInstall.color) && (
                <div style={{ fontSize: 13, color: "#475569", marginTop: 6 }}>
                  {[selectedInstall.product_type, selectedInstall.color].filter(Boolean).join(" · ")}
                </div>
              )}
            </div>
            <button type="button" onClick={() => setSelectedInstall(null)} style={{ background: "none", border: "none", fontSize: 22, color: "#94a3b8", cursor: "pointer", lineHeight: 1 }}>×</button>
          </div>
          <a href={`https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent([selectedInstall.address_line, selectedInstall.city].filter(Boolean).join(", "))}`}
            target="_blank" rel="noreferrer"
            style={{ display: "block", textAlign: "center", marginTop: 14, padding: "12px", borderRadius: 12, background: "#1d4ed8", color: "#fff", fontWeight: 700, fontSize: 14, textDecoration: "none" }}>
            🧭 Navigate to this address
          </a>
        </div>
      )}
    </div>
  );
}

function Chip({ active, onClick, color, label }) {
  return (
    <button type="button" onClick={onClick}
      style={{ whiteSpace: "nowrap", padding: "6px 12px", borderRadius: 20, fontSize: 12.5, fontWeight: 700, cursor: "pointer",
        border: active ? `2px solid ${color}` : "1px solid #e5e7eb",
        background: active ? color : "#fff", color: active ? "#fff" : "#475569" }}>
      {label}
    </button>
  );
}

// Fixed appointment windows: Mon–Thu 11/2/5/7, Fri 9/12/3, Sat 9/12 (day-of-week
// 1–4 / 5 / 6). Built in the rep's local time (reps are in ET).
const APPT_HOURS = { 1: [11, 14, 17, 19], 2: [11, 14, 17, 19], 3: [11, 14, 17, 19], 4: [11, 14, 17, 19], 5: [9, 12, 15], 6: [9, 12] };
function genSlots(days = 14) {
  const out = []; const b = new Date();
  // Start at d=1 (tomorrow) — no same-day appointments.
  for (let d = 1; d <= days; d++) {
    const day = new Date(b.getFullYear(), b.getMonth(), b.getDate() + d);
    for (const h of (APPT_HOURS[day.getDay()] || [])) {
      out.push({ iso: new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, 0, 0).toISOString(), dt: new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, 0, 0) });
    }
  }
  return out;
}
const dayKey = (d) => d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
const hourLabel = (d) => d.toLocaleTimeString("en-US", { hour: "numeric" });

const slotKey = (d) => `${d.toDateString()}-${d.getHours()}`;

// Pull a phone/email out of the pin's CSV "extra" columns if present.
const extraVal = (pin, names) => {
  const e = pin.extra || {};
  for (const k of Object.keys(e)) if (names.some((n) => k.toLowerCase().includes(n)) && e[k]) return String(e[k]);
  return "";
};

function AppointmentModal({ pin, rt, onClose, onBooked }) {
  const [phone, setPhone] = useState(pin.phone || extraVal(pin, ["phone", "mobile", "cell"]));
  const [email, setEmail] = useState(pin.email || extraVal(pin, ["email", "e-mail"]));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [booked, setBooked] = useState(null); // null = still checking JN

  // Pull the rep's already-booked appointments so we only offer free times.
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const r = await fetch(`/.netlify/functions/harvest-availability?rt=${encodeURIComponent(rt)}`);
        const j = await r.json().catch(() => ({}));
        if (live) setBooked(Array.isArray(j.booked) ? j.booked : []);
      } catch { if (live) setBooked([]); }
    })();
    return () => { live = false; };
  }, [rt]);

  const bookedKeys = useMemo(() => new Set((booked || []).map((ms) => slotKey(new Date(ms)))), [booked]);
  const slots = useMemo(() => genSlots(14).filter((s) => !bookedKeys.has(slotKey(s.dt))), [bookedKeys]);
  const byDay = {};
  for (const s of slots) (byDay[dayKey(s.dt)] = byDay[dayKey(s.dt)] || []).push(s);

  async function book(slot) {
    if (phone.replace(/\D/g, "").length < 10) { setErr("Enter the homeowner's phone number first."); return; }
    setBusy(slot.iso); setErr("");
    try {
      const r = await fetch("/.netlify/functions/harvest-book-appt", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rt, pin_id: pin.id, appt_iso: slot.iso, phone, email }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) { setErr(j.error || "Couldn't book — try again."); setBusy(false); return; }
      onBooked({ status: "appt", jn_job_id: j.job_id, status_updated_at: new Date().toISOString() });
    } catch (e) { setErr(e.message || "Network error"); setBusy(false); }
  }

  return (
    <div style={{ position: "absolute", inset: 0, background: "rgba(15,23,42,.55)", zIndex: 3000, display: "flex", alignItems: "flex-end", justifyContent: "center" }} onClick={() => !busy && onClose()}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: "#fff", width: "100%", maxWidth: 520, borderTopLeftRadius: 18, borderTopRightRadius: 18, padding: "16px 18px 22px", maxHeight: "88vh", overflowY: "auto", fontFamily: FONT }}>
        <div style={{ display: "flex", alignItems: "center", marginBottom: 4 }}>
          <div style={{ fontSize: 16, fontWeight: 800, fontFamily: "'Oswald', sans-serif", color: "#166534" }}>📅 Schedule appointment</div>
          <button type="button" onClick={() => !busy && onClose()} style={{ marginLeft: "auto", background: "none", border: "none", fontSize: 22, color: "#94a3b8", cursor: "pointer" }}>×</button>
        </div>
        <div style={{ fontSize: 13, color: "#475569", fontWeight: 600, marginBottom: 12 }}>{pin.address}{pin.city ? `, ${pin.city}` : ""}</div>

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 6 }}>
          <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="Phone (required)" inputMode="tel"
            style={{ flex: 1, minWidth: 150, fontSize: 14, padding: "10px 12px", borderRadius: 10, border: "1px solid #cbd5e1", boxSizing: "border-box" }} />
          <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email (optional)" inputMode="email"
            style={{ flex: 1, minWidth: 150, fontSize: 14, padding: "10px 12px", borderRadius: 10, border: "1px solid #cbd5e1", boxSizing: "border-box" }} />
        </div>
        <div style={{ fontSize: 12, color: "#64748b", marginBottom: 12 }}>Pick a time — it books the appointment into JobNimbus and turns this pin into an Appointment. Times you're already booked are hidden.</div>
        {err && <div style={{ color: "#b91c1c", fontSize: 13, marginBottom: 10 }}>{err}</div>}

        {booked === null ? <div style={{ fontSize: 13, color: "#6b7280", padding: "8px 0" }}>Checking your calendar…</div>
          : !slots.length ? <div style={{ fontSize: 13, color: "#6b7280", padding: "8px 0" }}>No open times in the next 2 weeks.</div>
          : (
        <div style={{ maxHeight: "48vh", overflowY: "auto" }}>
          {Object.keys(byDay).map((k) => (
            <div key={k} style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 12.5, fontWeight: 800, color: "#374151", marginBottom: 6 }}>{k}</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                {byDay[k].map((s) => (
                  <button key={s.iso} type="button" disabled={!!busy} onClick={() => book(s)}
                    style={{ border: "1px solid #16a34a", color: "#16a34a", background: "#fff", borderRadius: 12, padding: "9px 16px", fontSize: 14, fontWeight: 700, cursor: "pointer", opacity: busy ? 0.5 : 1 }}>
                    {busy === s.iso ? "…" : hourLabel(s.dt)}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
        )}
      </div>
    </div>
  );
}
