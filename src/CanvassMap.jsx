// Canvassing map — "Sales Rabbit"-style door-knocking tool. Lives at ?mode=canvass.
//
// Baseline: the office uploads a list of addresses (geocoded server-side into
// canvass_prospects as status 'iq'); a rep opens this on their phone, sees the
// pins colored by status, taps one, and changes its status (e.g. IQ → Appt).
// v1 just records the status on the pin — no JobNimbus write yet.
import React, { useEffect, useRef, useState, useMemo } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { supabase } from "./lib/supabase";

const STATUSES = [
  { key: "iq", label: "IQ (new)", color: "#2563eb" },
  { key: "appt", label: "Appointment", color: "#16a34a" },
  { key: "not_home", label: "Not Home", color: "#9ca3af" },
  { key: "callback", label: "Callback", color: "#f59e0b" },
  { key: "not_interested", label: "Not Interested", color: "#ef4444" },
  { key: "sold", label: "Sold", color: "#7c3aed" },
  { key: "dnk", label: "Do Not Knock", color: "#111827" },
];
const S = Object.fromEntries(STATUSES.map((s) => [s.key, s]));
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
  const [repName, setRepName] = useState(() => { try { return localStorage.getItem("canvass_rep") || ""; } catch { return ""; } });
  const [showUpload, setShowUpload] = useState(false);

  async function load() {
    setLoading(true);
    const { data, error } = await supabase
      .from("canvass_prospects")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(5000);
    if (!error) setProspects(data || []);
    setLoading(false);
  }
  useEffect(() => { load(); }, []);

  // Init the Leaflet map once.
  useEffect(() => {
    if (map.current || !mapEl.current) return;
    const m = L.map(mapEl.current, { zoomControl: true }).setView([27.95, -82.46], 10); // Tampa Bay default
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19, attribution: "&copy; OpenStreetMap",
    }).addTo(m);
    map.current = m;
    layer.current = L.layerGroup().addTo(m);
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
    const pts = [];
    for (const p of shown) {
      const color = (S[p.status] || S.iq).color;
      const marker = L.circleMarker([p.latitude, p.longitude], {
        radius: 9, color: "#fff", weight: 2, fillColor: color, fillOpacity: 0.95,
      });
      marker.on("click", () => setSelected(p));
      marker.addTo(lyr);
      pts.push([p.latitude, p.longitude]);
    }
    if (pts.length && !fitted.current) {
      m.fitBounds(pts, { padding: [40, 40], maxZoom: 15 });
      fitted.current = true;
    }
  }, [mapped, filter]);

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

  const counts = useMemo(() => {
    const c = {};
    for (const p of prospects) c[p.status] = (c[p.status] || 0) + 1;
    return c;
  }, [prospects]);
  const notMapped = prospects.length - mapped.length;

  const saveRep = (v) => { setRepName(v); try { localStorage.setItem("canvass_rep", v); } catch { /* private mode */ } };

  return (
    <div style={{ position: "fixed", inset: 0, display: "flex", flexDirection: "column", fontFamily: FONT, background: "#f1f5f9" }}>
      {/* Header */}
      <div style={{ padding: "10px 14px", background: "#0f172a", color: "#fff", display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <div style={{ fontWeight: 800, fontSize: 16, fontFamily: "'Oswald', sans-serif", letterSpacing: "0.02em" }}>🗺️ Canvassing Map</div>
        <div style={{ fontSize: 12, opacity: 0.8 }}>{mapped.length} mapped{notMapped ? ` · ${notMapped} un-geocoded` : ""}</div>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
          <input value={repName} onChange={(e) => saveRep(e.target.value)} placeholder="Your name"
            style={{ fontSize: 12, padding: "6px 8px", borderRadius: 8, border: "none", width: 110 }} />
          <button type="button" onClick={() => setShowUpload((v) => !v)}
            style={{ fontSize: 12, fontWeight: 700, padding: "7px 12px", borderRadius: 8, border: "none", background: "#22c55e", color: "#052e16", cursor: "pointer" }}>
            ⬆ Upload
          </button>
        </div>
      </div>

      {/* Status filter chips */}
      <div style={{ display: "flex", gap: 6, overflowX: "auto", padding: "8px 12px", background: "#fff", borderBottom: "1px solid #e5e7eb" }}>
        <Chip active={filter === "all"} onClick={() => setFilter("all")} color="#334155" label={`All (${prospects.length})`} />
        {STATUSES.map((s) => (
          <Chip key={s.key} active={filter === s.key} onClick={() => setFilter(s.key)} color={s.color} label={`${s.label} (${counts[s.key] || 0})`} />
        ))}
      </div>

      {/* Map */}
      <div style={{ position: "relative", flex: 1 }}>
        <div ref={mapEl} style={{ position: "absolute", inset: 0 }} />
        {loading && (
          <div style={{ position: "absolute", top: 12, left: "50%", transform: "translateX(-50%)", background: "#fff", padding: "6px 14px", borderRadius: 20, fontSize: 13, boxShadow: "0 2px 8px rgba(0,0,0,.15)", zIndex: 500 }}>Loading pins…</div>
        )}
        {!loading && prospects.length === 0 && (
          <div style={{ position: "absolute", top: 20, left: "50%", transform: "translateX(-50%)", background: "#fff", padding: "14px 18px", borderRadius: 12, fontSize: 13.5, color: "#475569", boxShadow: "0 2px 10px rgba(0,0,0,.12)", zIndex: 500, textAlign: "center", maxWidth: 320 }}>
            No prospects yet. Tap <b>⬆ Upload</b> to add a list of addresses.
          </div>
        )}
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
                <span style={{ width: 10, height: 10, borderRadius: 5, background: (S[selected.status] || S.iq).color, display: "inline-block" }} />
                {(S[selected.status] || S.iq).label}
                {selected.status_by ? <span style={{ color: "#94a3b8", fontWeight: 600 }}> · by {selected.status_by}</span> : null}
              </div>
            </div>
            <button type="button" onClick={() => setSelected(null)} style={{ background: "none", border: "none", fontSize: 22, color: "#94a3b8", cursor: "pointer", lineHeight: 1 }}>×</button>
          </div>

          <div style={{ fontSize: 12, fontWeight: 700, color: "#64748b", margin: "14px 0 8px" }}>Set status</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {STATUSES.map((s) => {
              const on = selected.status === s.key;
              return (
                <button key={s.key} type="button" onClick={() => setStatus(selected, s.key)}
                  style={{ padding: "9px 14px", borderRadius: 10, fontSize: 13.5, fontWeight: 700, cursor: "pointer",
                    border: on ? `2px solid ${s.color}` : "1px solid #e5e7eb",
                    background: on ? s.color : "#fff", color: on ? "#fff" : "#334155" }}>
                  {s.label}
                </button>
              );
            })}
          </div>

          <a href={`https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent([selected.address, selected.city, selected.state, selected.zip].filter(Boolean).join(", "))}`}
            target="_blank" rel="noreferrer"
            style={{ display: "block", textAlign: "center", marginTop: 16, padding: "12px", borderRadius: 12, background: "#1d4ed8", color: "#fff", fontWeight: 700, fontSize: 14, textDecoration: "none" }}>
            🧭 Navigate to this address
          </a>
        </div>
      )}

      {/* Upload panel */}
      {showUpload && <UploadPanel onClose={() => setShowUpload(false)} onDone={() => { setShowUpload(false); fitted.current = false; load(); }} />}
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

function UploadPanel({ onClose, onDone }) {
  const [listName, setListName] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);

  async function submit() {
    if (!lines.length) return;
    setBusy(true); setResult(null);
    try {
      const r = await fetch("/.netlify/functions/canvass-upload", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ list_name: listName.trim() || undefined, rows: lines }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) { setResult({ error: j.error || `Error ${r.status}` }); setBusy(false); return; }
      setResult({ ok: true, ...j });
    } catch (e) { setResult({ error: e.message || "Network error" }); }
    setBusy(false);
  }

  return (
    <div style={{ position: "absolute", inset: 0, background: "rgba(15,23,42,.55)", zIndex: 2000, display: "flex", alignItems: "flex-end", justifyContent: "center" }} onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: "#fff", width: "100%", maxWidth: 560, borderTopLeftRadius: 18, borderTopRightRadius: 18, padding: "18px 20px 24px", maxHeight: "88vh", overflowY: "auto", fontFamily: FONT }}>
        <div style={{ display: "flex", alignItems: "center" }}>
          <div style={{ fontWeight: 800, fontSize: 17, fontFamily: "'Oswald', sans-serif" }}>Upload addresses</div>
          <button type="button" onClick={onClose} style={{ marginLeft: "auto", background: "none", border: "none", fontSize: 22, color: "#94a3b8", cursor: "pointer" }}>×</button>
        </div>
        <div style={{ fontSize: 13, color: "#64748b", margin: "6px 0 14px" }}>One address per line (include city/state/ZIP for best results). They'll be geocoded and dropped on the map as <b>IQ</b>.</div>
        <input value={listName} onChange={(e) => setListName(e.target.value)} placeholder="List name (optional, e.g. 'Seminole Storm St.')"
          style={{ width: "100%", padding: "10px 12px", borderRadius: 10, border: "1px solid #cbd5e1", fontSize: 14, marginBottom: 10, boxSizing: "border-box" }} />
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={8}
          placeholder={"123 Main St, Tampa, FL 33606\n456 Oak Ave, St Petersburg, FL 33701"}
          style={{ width: "100%", padding: "10px 12px", borderRadius: 10, border: "1px solid #cbd5e1", fontSize: 14, fontFamily: "monospace", boxSizing: "border-box", resize: "vertical" }} />
        <div style={{ fontSize: 12, color: "#94a3b8", margin: "6px 0 12px" }}>{lines.length} address{lines.length === 1 ? "" : "es"} ready</div>

        {result?.error && <div style={{ color: "#b91c1c", fontSize: 13, marginBottom: 10 }}>{result.error}</div>}
        {result?.ok && (
          <div style={{ background: "#ecfdf5", border: "1px solid #a7f3d0", borderRadius: 10, padding: "10px 12px", fontSize: 13, color: "#065f46", marginBottom: 10 }}>
            ✓ Added {result.inserted} — {result.geocoded} mapped{result.failed ? `, ${result.failed} couldn't be geocoded` : ""}.
          </div>
        )}

        {result?.ok ? (
          <button type="button" onClick={onDone} style={btn("#16a34a")}>Done — show on map</button>
        ) : (
          <button type="button" onClick={submit} disabled={busy || !lines.length} style={{ ...btn("#2563eb"), opacity: busy || !lines.length ? 0.6 : 1 }}>
            {busy ? "Geocoding…" : `Upload & geocode ${lines.length || ""}`}
          </button>
        )}
      </div>
    </div>
  );
}

const btn = (bg) => ({ width: "100%", padding: "13px", borderRadius: 12, border: "none", background: bg, color: "#fff", fontWeight: 800, fontSize: 15, cursor: "pointer", fontFamily: "'Oswald', sans-serif", letterSpacing: "0.02em" });
