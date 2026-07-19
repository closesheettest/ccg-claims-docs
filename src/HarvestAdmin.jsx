// Harvesting Map — pin-type admin (?mode=harvestadmin).
// Create/edit the pin types that drive the map: label, color, WHICH REP LEVELS
// can see them, and the allowed OUTCOMES (behavior flow). Everything the map and
// (later) the reports read comes from harvest_pin_types.
import React, { useEffect, useMemo, useState } from "react";
import { supabase } from "./lib/supabase";
import HarvestNav from "./HarvestNav";

const LEVELS = ["senior", "junior"];
const FONT = "'Nunito', system-ui, sans-serif";
const OSWALD = "'Oswald', sans-serif";

export default function HarvestAdmin() {
  const [types, setTypes] = useState(null);
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState(null);
  const [adding, setAdding] = useState(false);
  const [newType, setNewType] = useState({ key: "", label: "", color: "#2563eb" });
  const [radius, setRadius] = useState(5);        // go-back route radius (miles)
  const [radiusBusy, setRadiusBusy] = useState(false);
  const [mgrMap, setMgrMap] = useState(true);     // regional-manager team map on/off
  const [mgrBusy, setMgrBusy] = useState(false);
  const [smartSched, setSmartSched] = useState(false); // Smart Scheduling on/off (default OFF until turned on)
  const [smartBusy, setSmartBusy] = useState(false);

  const load = async () => {
    const { data, error } = await supabase.from("harvest_pin_types").select("*").order("sort");
    if (error) { setMsg({ err: error.message }); setTypes([]); return; }
    setTypes(data || []);
  };
  useEffect(() => { load(); }, []);
  useEffect(() => {
    supabase.from("app_settings").select("value").eq("key", "harvest_goback_radius_mi").maybeSingle()
      .then(({ data }) => { const n = Number(data?.value); if (Number.isFinite(n) && n > 0) setRadius(n); });
    supabase.from("app_settings").select("value").eq("key", "harvest_manager_map_enabled").maybeSingle()
      .then(({ data }) => { if (data) setMgrMap(String(data.value) !== "false"); });
    supabase.from("app_settings").select("value").eq("key", "harvest_smart_scheduling_enabled").maybeSingle()
      .then(({ data }) => { if (data) setSmartSched(String(data.value) !== "false"); });
  }, []);
  const saveSmartSched = async (next) => {
    setSmartSched(next); setSmartBusy(true); setMsg(null);
    const { error } = await supabase.from("app_settings").upsert({ key: "harvest_smart_scheduling_enabled", value: next ? "true" : "false" }, { onConflict: "key" });
    setSmartBusy(false);
    setMsg(error ? { err: error.message } : { ok: `Smart Scheduling turned ${next ? "ON" : "OFF"}.` });
  };
  const saveRadius = async () => {
    setRadiusBusy(true); setMsg(null);
    const { error } = await supabase.from("app_settings").upsert({ key: "harvest_goback_radius_mi", value: String(radius) }, { onConflict: "key" });
    setRadiusBusy(false);
    setMsg(error ? { err: error.message } : { ok: `Go-back radius set to ${radius} mi.` });
  };
  const saveMgrMap = async (next) => {
    setMgrMap(next); setMgrBusy(true); setMsg(null);
    const { error } = await supabase.from("app_settings").upsert({ key: "harvest_manager_map_enabled", value: next ? "true" : "false" }, { onConflict: "key" });
    setMgrBusy(false);
    setMsg(error ? { err: error.message } : { ok: `Regional managers' team map turned ${next ? "ON" : "OFF"}.` });
  };

  const allKeys = useMemo(() => (types || []).map((t) => t.key), [types]);

  const patch = (key, fields) => setTypes((list) => list.map((t) => (t.key === key ? { ...t, ...fields } : t)));

  const toggleArr = (key, field, val) => {
    const t = types.find((x) => x.key === key);
    const has = (t[field] || []).includes(val);
    patch(key, { [field]: has ? t[field].filter((v) => v !== val) : [...(t[field] || []), val] });
  };

  const save = async (t) => {
    setBusy(t.key); setMsg(null);
    const { error } = await supabase.from("harvest_pin_types")
      .update({ label: t.label, color: t.color, sort: t.sort, visible_levels: t.visible_levels, outcomes: t.outcomes, is_terminal: t.is_terminal, active: t.active, updated_at: new Date().toISOString() })
      .eq("key", t.key);
    setBusy("");
    setMsg(error ? { err: error.message } : { ok: `Saved “${t.label}”.` });
  };

  const addType = async () => {
    const key = newType.key.trim().toLowerCase().replace(/[^a-z0-9_]/g, "_");
    if (!key) { setMsg({ err: "Give the pin a short key (e.g. callback)." }); return; }
    if (allKeys.includes(key)) { setMsg({ err: "That key already exists." }); return; }
    setBusy("__new");
    const row = { key, label: newType.label.trim() || key, color: newType.color, sort: (types.length + 1) * 10, visible_levels: [], outcomes: [], is_terminal: false, active: true };
    const { error } = await supabase.from("harvest_pin_types").insert(row);
    setBusy("");
    if (error) { setMsg({ err: error.message }); return; }
    setAdding(false); setNewType({ key: "", label: "", color: "#2563eb" });
    setMsg({ ok: `Added “${row.label}”.` });
    load();
  };

  if (types === null) return <div style={{ padding: 40, fontFamily: FONT, color: "#64748b" }}>Loading pin types…</div>;

  return (
    <div style={{ maxWidth: 1000, margin: "0 auto", padding: "20px 16px 60px", fontFamily: FONT }}>
      <HarvestNav active="types" />
      <div style={{ fontSize: 22, fontWeight: 800, fontFamily: OSWALD, marginBottom: 4 }}>🎛️ Pin Types</div>
      <div style={{ fontSize: 13.5, color: "#64748b", marginBottom: 16 }}>
        Each pin type: its color, <b>who can see it</b> (rep level), and the <b>outcomes</b> a rep may switch it to. The map and reports read this.
      </div>

      {msg && <div style={{ marginBottom: 14, padding: "10px 14px", borderRadius: 10, fontSize: 13.5, fontWeight: 600, background: msg.err ? "#fef2f2" : "#ecfdf5", color: msg.err ? "#b91c1c" : "#065f46", border: `1px solid ${msg.err ? "#fecaca" : "#a7f3d0"}` }}>{msg.err || msg.ok}</div>}

      {/* Go-back route radius — how near a stop a go-back must be to get folded in. */}
      <div style={{ border: "1px solid #e5e7eb", borderRadius: 12, padding: 16, marginBottom: 16, background: "#fff" }}>
        <div style={{ fontSize: 15, fontWeight: 800, marginBottom: 4 }}>📍 Go-back route radius</div>
        <div style={{ fontSize: 12.5, color: "#64748b", marginBottom: 14 }}>
          When a rep taps <b>“Add the go-backs within my route”</b>, only go-backs within this many miles of a route stop get added. Higher = casts a wider net; lower = keeps it tight to the route.
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <input type="range" min={1} max={25} step={1} value={radius} onChange={(e) => setRadius(Number(e.target.value))} style={{ flex: 1, accentColor: "#16a34a" }} />
          <span style={{ fontSize: 20, fontWeight: 800, fontFamily: OSWALD, minWidth: 62, textAlign: "right" }}>{radius} mi</span>
          <button type="button" onClick={saveRadius} disabled={radiusBusy} style={{ fontSize: 13, fontWeight: 700, padding: "9px 18px", borderRadius: 8, border: "none", background: "#16a34a", color: "#fff", cursor: "pointer", opacity: radiusBusy ? 0.6 : 1 }}>{radiusBusy ? "Saving…" : "Save"}</button>
        </div>
      </div>

      {/* Regional managers' Team Map — company on/off. */}
      <div style={{ border: "1px solid #e5e7eb", borderRadius: 12, padding: 16, marginBottom: 16, background: "#fff", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 14 }}>
        <div>
          <div style={{ fontSize: 15, fontWeight: 800 }}>🗺️ Regional managers' Team Map</div>
          <div style={{ fontSize: 12.5, color: "#64748b", marginTop: 3 }}>
            Shows each regional manager a live map of <b>their zone's reps</b> (positions, trails, today's counts) on their dashboard. Turn off to hide it from <b>all</b> managers.
          </div>
        </div>
        <button type="button" onClick={() => saveMgrMap(!mgrMap)} disabled={mgrBusy} title={mgrMap ? "On — tap to turn off" : "Off — tap to turn on"}
          style={{ flexShrink: 0, width: 62, height: 32, borderRadius: 999, border: "none", cursor: mgrBusy ? "default" : "pointer", background: mgrMap ? "#16a34a" : "#cbd5e1", position: "relative", opacity: mgrBusy ? 0.6 : 1, transition: "background .15s" }}>
          <span style={{ position: "absolute", top: 3, left: mgrMap ? 33 : 3, width: 26, height: 26, borderRadius: "50%", background: "#fff", boxShadow: "0 1px 3px rgba(0,0,0,.3)", transition: "left .15s" }} />
        </button>
      </div>

      {/* Smart Scheduling — company on/off (shut it off if it needs tweaking). */}
      <div style={{ border: "1px solid #e5e7eb", borderRadius: 12, padding: 16, marginBottom: 16, background: "#fff", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 14 }}>
        <div>
          <div style={{ fontSize: 15, fontWeight: 800 }}>🧠 Smart Scheduling</div>
          <div style={{ fontSize: 12.5, color: "#64748b", marginTop: 3 }}>
            Lets reps <b>plan their day around their appointments</b> — the map fills the gaps before/between/after appts with doors that fit the clock. Turn off to hide it from <b>all</b> reps while it's being tuned.
          </div>
        </div>
        <button type="button" onClick={() => saveSmartSched(!smartSched)} disabled={smartBusy} title={smartSched ? "On — tap to turn off" : "Off — tap to turn on"}
          style={{ flexShrink: 0, width: 62, height: 32, borderRadius: 999, border: "none", cursor: smartBusy ? "default" : "pointer", background: smartSched ? "#7c3aed" : "#cbd5e1", position: "relative", opacity: smartBusy ? 0.6 : 1, transition: "background .15s" }}>
          <span style={{ position: "absolute", top: 3, left: smartSched ? 33 : 3, width: 26, height: 26, borderRadius: "50%", background: "#fff", boxShadow: "0 1px 3px rgba(0,0,0,.3)", transition: "left .15s" }} />
        </button>
      </div>

      <div style={{ display: "grid", gap: 12 }}>
        {types.map((t) => (
          <div key={t.key} style={{ border: "1px solid #e5e7eb", borderRadius: 12, padding: 14, background: t.active ? "#fff" : "#f8fafc", opacity: t.active ? 1 : 0.7 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <input type="color" value={t.color} onChange={(e) => patch(t.key, { color: e.target.value })} style={{ width: 34, height: 34, border: "none", background: "none", cursor: "pointer" }} />
              <input value={t.label} onChange={(e) => patch(t.key, { label: e.target.value })} style={{ fontSize: 15, fontWeight: 700, padding: "6px 10px", borderRadius: 8, border: "1px solid #cbd5e1", minWidth: 180 }} />
              <code style={{ fontSize: 12, color: "#94a3b8" }}>{t.key}</code>
              <label style={{ fontSize: 12.5, color: "#475569", display: "flex", alignItems: "center", gap: 5, marginLeft: "auto" }}>
                <input type="checkbox" checked={!!t.is_terminal} onChange={(e) => patch(t.key, { is_terminal: e.target.checked })} /> finished (terminal)
              </label>
              <label style={{ fontSize: 12.5, color: "#475569", display: "flex", alignItems: "center", gap: 5 }}>
                <input type="checkbox" checked={t.active !== false} onChange={(e) => patch(t.key, { active: e.target.checked })} /> active
              </label>
            </div>

            <div style={{ display: "flex", gap: 24, flexWrap: "wrap", marginTop: 12 }}>
              <div>
                <div style={{ fontSize: 11.5, fontWeight: 700, color: "#64748b", marginBottom: 5 }}>VISIBLE TO</div>
                <div style={{ display: "flex", gap: 6 }}>
                  {LEVELS.map((lv) => {
                    const on = (t.visible_levels || []).includes(lv);
                    return <button key={lv} type="button" onClick={() => toggleArr(t.key, "visible_levels", lv)} style={pill(on, "#0e7490")}>{lv}</button>;
                  })}
                  <span style={{ fontSize: 11, color: "#94a3b8", alignSelf: "center" }}>{(t.visible_levels || []).length ? "" : "everyone"}</span>
                </div>
              </div>
              <div>
                <div style={{ fontSize: 11.5, fontWeight: 700, color: "#64748b", marginBottom: 5 }}>CAN BECOME (outcomes)</div>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {allKeys.filter((k) => k !== t.key).map((k) => {
                    const on = (t.outcomes || []).includes(k);
                    return <button key={k} type="button" onClick={() => toggleArr(t.key, "outcomes", k)} style={pill(on, "#7c3aed")}>{S(types, k)}</button>;
                  })}
                </div>
              </div>
            </div>

            <div style={{ marginTop: 12, textAlign: "right" }}>
              <button type="button" onClick={() => save(t)} disabled={busy === t.key} style={{ fontSize: 13, fontWeight: 700, padding: "8px 16px", borderRadius: 8, border: "none", background: "#16a34a", color: "#fff", cursor: "pointer", opacity: busy === t.key ? 0.6 : 1 }}>{busy === t.key ? "Saving…" : "Save"}</button>
            </div>
          </div>
        ))}
      </div>

      {adding ? (
        <div style={{ border: "2px dashed #cbd5e1", borderRadius: 12, padding: 14, marginTop: 14, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <input type="color" value={newType.color} onChange={(e) => setNewType({ ...newType, color: e.target.value })} style={{ width: 34, height: 34, border: "none", background: "none", cursor: "pointer" }} />
          <input value={newType.label} onChange={(e) => setNewType({ ...newType, label: e.target.value })} placeholder="Label (e.g. Callback)" style={{ fontSize: 14, padding: "8px 10px", borderRadius: 8, border: "1px solid #cbd5e1" }} />
          <input value={newType.key} onChange={(e) => setNewType({ ...newType, key: e.target.value })} placeholder="key (e.g. callback)" style={{ fontSize: 13, padding: "8px 10px", borderRadius: 8, border: "1px solid #cbd5e1", width: 140, fontFamily: "monospace" }} />
          <button type="button" onClick={addType} disabled={busy === "__new"} style={{ fontSize: 13, fontWeight: 700, padding: "8px 16px", borderRadius: 8, border: "none", background: "#2563eb", color: "#fff", cursor: "pointer" }}>{busy === "__new" ? "Adding…" : "Add"}</button>
          <button type="button" onClick={() => setAdding(false)} style={{ fontSize: 13, color: "#64748b", background: "none", border: "none", cursor: "pointer" }}>Cancel</button>
        </div>
      ) : (
        <button type="button" onClick={() => setAdding(true)} style={{ marginTop: 16, fontSize: 14, fontWeight: 700, padding: "10px 18px", borderRadius: 10, border: "2px solid #2563eb", background: "#fff", color: "#2563eb", cursor: "pointer" }}>+ Add pin type</button>
      )}
    </div>
  );
}

function S(types, key) {
  const t = (types || []).find((x) => x.key === key);
  return t ? t.label : key;
}
function pill(on, color) {
  return { fontSize: 12, fontWeight: 700, padding: "5px 11px", borderRadius: 16, cursor: "pointer",
    border: on ? `2px solid ${color}` : "1px solid #e5e7eb", background: on ? color : "#fff", color: on ? "#fff" : "#475569" };
}
