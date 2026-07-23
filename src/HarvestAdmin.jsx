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
  const [capSr, setCapSr] = useState(30);         // daily pins — Sr (IQ / no-sit days)
  const [capJr, setCapJr] = useState(100);        // daily pins — Jr (inspection days)
  const [capsBusy, setCapsBusy] = useState(false);
  const [enhanced, setEnhanced] = useState(false); // Enhanced Planned Day (Sr assignment) on/off
  const [enhancedBusy, setEnhancedBusy] = useState(false);
  const [blitz, setBlitz] = useState(false); // Install-Radius Blitz on/off
  const [blitzBusy, setBlitzBusy] = useState(false);
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
    supabase.from("app_settings").select("value").eq("key", "harvest_smart_scheduling_enabled").maybeSingle()
      .then(({ data }) => { if (data) setSmartSched(String(data.value) !== "false"); });
    supabase.from("app_settings").select("key,value").in("key", ["harvest_route_cap_sr", "harvest_route_cap_jr"])
      .then(({ data }) => { for (const r of data || []) { const n = Number(r.value); if (Number.isFinite(n) && n > 0) { if (r.key === "harvest_route_cap_sr") setCapSr(n); else setCapJr(n); } } });
    supabase.from("app_settings").select("value").eq("key", "harvest_enhanced_planned_day_enabled").maybeSingle()
      .then(({ data }) => { if (data) setEnhanced(String(data.value) === "true"); });
    supabase.from("app_settings").select("value").eq("key", "harvest_blitz_enabled").maybeSingle()
      .then(({ data }) => { if (data) setBlitz(String(data.value) === "true"); });
  }, []);
  const saveBlitz = async (next) => {
    setBlitz(next); setBlitzBusy(true); setMsg(null);
    const { error } = await supabase.from("app_settings").upsert({ key: "harvest_blitz_enabled", value: next ? "true" : "false" }, { onConflict: "key" });
    setBlitzBusy(false);
    setMsg(error ? { err: error.message } : { ok: `Clover Leaf turned ${next ? "ON — tap ⚡ Sync now to pin the current Roof-Started installs" : "OFF"}.` });
  };
  // Manual clover sync — first-time (or impatient) runs without waiting for the
  // 2-hour cron. Processes a few installs per tap (10s function budget); the
  // result says when more are waiting — just tap again.
  const [blitzSyncing, setBlitzSyncing] = useState(false);
  const runBlitzSync = async () => {
    setBlitzSyncing(true); setMsg(null);
    try {
      const r = await fetch("/.netlify/functions/cron-install-blitz?commit=1");
      const j = await r.json().catch(() => ({}));
      if (j.ok === false || !r.ok) setMsg({ err: j.error || j.note || `Sync failed (${r.status})` });
      else if (j.enabled === false) setMsg({ err: "Clover Leaf is OFF — flip the toggle on first." });
      else setMsg({ ok: `🍀 Sync: ${j.roof_started} roofs started · ${j.new_installs} new this run · ${j.pins_created} pins dropped${j.skipped_existing_addr ? ` · ${j.skipped_existing_addr} already pinned` : ""}${j.note ? ` — ${j.note} Tap Sync again.` : "."}` });
    } catch (e) { setMsg({ err: e.message || "Sync failed" }); }
    setBlitzSyncing(false);
  };
  const saveEnhanced = async (next) => {
    setEnhanced(next); setEnhancedBusy(true); setMsg(null);
    const { error } = await supabase.from("app_settings").upsert({ key: "harvest_enhanced_planned_day_enabled", value: next ? "true" : "false" }, { onConflict: "key" });
    setEnhancedBusy(false);
    setMsg(error ? { err: error.message } : { ok: `Enhanced Planned Day turned ${next ? "ON" : "OFF"}.` });
  };
  const saveCaps = async () => {
    setCapsBusy(true); setMsg(null);
    const { error } = await supabase.from("app_settings").upsert([
      { key: "harvest_route_cap_sr", value: String(capSr) },
      { key: "harvest_route_cap_jr", value: String(capJr) },
    ], { onConflict: "key" });
    setCapsBusy(false);
    setMsg(error ? { err: error.message } : { ok: `Daily pins set — Sr ${capSr}, Jr ${capJr}.` });
  };
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

  const allKeys = useMemo(() => (types || []).map((t) => t.key), [types]);
  const [openKeys, setOpenKeys] = useState(() => new Set()); // collapsed by default
  const toggleOpen = (key) => setOpenKeys((s) => { const n = new Set(s); n.has(key) ? n.delete(key) : n.add(key); return n; });
  const visSummary = (t) => {
    const s = seesLevel(t, "senior"), j = seesLevel(t, "junior");
    if (s && j) return { text: "All reps", off: false };
    if (s) return { text: "Senior only", off: false };
    if (j) return { text: "Junior only", off: false };
    return { text: "Off map · office only", off: true };
  };

  const patch = (key, fields) => setTypes((list) => list.map((t) => (t.key === key ? { ...t, ...fields } : t)));

  const toggleArr = (key, field, val) => {
    const t = types.find((x) => x.key === key);
    const has = (t[field] || []).includes(val);
    patch(key, { [field]: has ? t[field].filter((v) => v !== val) : [...(t[field] || []), val] });
  };

  // Whether a rep LEVEL currently sees this pin. Legacy empty array = everyone,
  // so treat empty as "both levels on" for display.
  const seesLevel = (t, lv) => { const a = t.visible_levels || []; return a.length === 0 || a.includes(lv); };
  // Flip one level on/off WITHOUT the empty-array trap: an empty visible_levels
  // reads as "everyone" on the map, so when no rep level is left we store the
  // "admin" sentinel = hidden from all reps (office still sees it).
  const setVis = (key, lv, on) => {
    const t = types.find((x) => x.key === key);
    const cur = t.visible_levels || [];
    const s = new Set(cur.length === 0 ? LEVELS : cur.filter((v) => LEVELS.includes(v)));
    if (on) s.add(lv); else s.delete(lv);
    const arr = [...s];
    patch(key, { visible_levels: arr.length ? arr : ["admin"] });
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
        Each pin type: its color, <b>which reps have it on their map</b> (tap each level <b>on map / off map</b>), and the <b>outcomes</b> a rep may switch it to. Set both levels off-map to keep a pin off reps' maps entirely — <b>the office always sees every pin</b> regardless. The map and reports read this.
      </div>

      {msg && <div style={{ marginBottom: 14, padding: "10px 14px", borderRadius: 10, fontSize: 13.5, fontWeight: 600, background: msg.err ? "#fef2f2" : "#ecfdf5", color: msg.err ? "#b91c1c" : "#065f46", border: `1px solid ${msg.err ? "#fecaca" : "#a7f3d0"}` }}>{msg.err || msg.ok}</div>}

      {/* Enhanced Planned Day — company on/off. When on, managers get the section
          planner on their dashboard and assign each Sr rep a cluster. */}
      <div style={{ border: "1px solid #e5e7eb", borderRadius: 12, padding: 16, marginBottom: 16, background: "#fff", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 14 }}>
        <div>
          <div style={{ fontSize: 15, fontWeight: 800 }}>🧭 Enhanced Planned Day <span style={{ fontSize: 11, fontWeight: 700, color: "#7c3aed", background: "#ede9fe", padding: "2px 7px", borderRadius: 8 }}>Sr only</span></div>
          <div style={{ fontSize: 12.5, color: "#64748b", marginTop: 3 }}>
            When on, each <b>manager</b> plans their team's day: the zone's <b>IQ + No-sit</b> pins auto-split into balanced sections (one per Sr rep), the manager assigns each section to a rep, and every Sr rep's <b>Start my day</b> loads their assignment. Off = the planner is hidden from all dashboards. Jr reps are unaffected (they use the daily pin cap below).
          </div>
        </div>
        <button type="button" onClick={() => saveEnhanced(!enhanced)} disabled={enhancedBusy} title={enhanced ? "On — tap to turn off" : "Off — tap to turn on"}
          style={{ flexShrink: 0, width: 62, height: 32, borderRadius: 999, border: "none", cursor: enhancedBusy ? "default" : "pointer", background: enhanced ? "#7c3aed" : "#cbd5e1", position: "relative", opacity: enhancedBusy ? 0.6 : 1, transition: "background .15s" }}>
          <span style={{ position: "absolute", top: 3, left: enhanced ? 33 : 3, width: 26, height: 26, borderRadius: "50%", background: "#fff", boxShadow: "0 1px 3px rgba(0,0,0,.3)", transition: "left .15s" }} />
        </button>
      </div>

      {/* Install-Radius Blitz — when a JN job hits "Roof Started", the cron drops the
          ~30 nearest OWNER-OCCUPIED neighbors as 🔥 blitz pins so reps knock while the
          crew is on the roof. */}
      <div style={{ border: "1px solid #e5e7eb", borderRadius: 12, padding: 16, marginBottom: 16, background: "#fff", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 14 }}>
        <div>
          <div style={{ fontSize: 15, fontWeight: 800 }}>🍀 Clover Leaf</div>
          <div style={{ fontSize: 12.5, color: "#64748b", marginTop: 3 }}>
            When a JobNimbus job hits <b>“Roof Started”</b>, the map auto-drops the ~30 nearest <b>owner-occupied</b> neighbors as 🍀 clover pins — knocked “we're doing your neighbor's roof <i>right now</i>” while the crew is visibly on it. <b>The cloverleaf belongs to the rep who SOLD that roof</b> — only they see the pins; if they go inactive, the doors open up for the reps in that area. At the door: <b>Roof looks fine · Damage observed · Not home · Book appt / Sign · Not interested</b>. <b>Damage-observed doors stay forever</b>; the rest clear when the install wraps. Syncs every 2 hours, 7 AM–9 PM.
          </div>
        </div>
        <div style={{ flexShrink: 0, display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
          <button type="button" onClick={() => saveBlitz(!blitz)} disabled={blitzBusy} title={blitz ? "On — tap to turn off" : "Off — tap to turn on"}
            style={{ width: 62, height: 32, borderRadius: 999, border: "none", cursor: blitzBusy ? "default" : "pointer", background: blitz ? "#f97316" : "#cbd5e1", position: "relative", opacity: blitzBusy ? 0.6 : 1, transition: "background .15s" }}>
            <span style={{ position: "absolute", top: 3, left: blitz ? 33 : 3, width: 26, height: 26, borderRadius: "50%", background: "#fff", boxShadow: "0 1px 3px rgba(0,0,0,.3)", transition: "left .15s" }} />
          </button>
          {blitz && (
            <button type="button" onClick={runBlitzSync} disabled={blitzSyncing}
              style={{ border: "none", borderRadius: 9, padding: "7px 12px", fontSize: 12.5, fontWeight: 800, cursor: blitzSyncing ? "default" : "pointer", background: "#15803d", color: "#fff", opacity: blitzSyncing ? 0.6 : 1, whiteSpace: "nowrap" }}>
              {blitzSyncing ? "Syncing…" : "⚡ Sync now"}
            </button>
          )}
        </div>
      </div>

      {/* Daily pins per day — the "Start my day" route cap, per rep level. Tune it
          as we learn time-at-door to find the sweet spot. */}
      <div style={{ border: "1px solid #e5e7eb", borderRadius: 12, padding: 16, marginBottom: 16, background: "#fff" }}>
        <div style={{ fontSize: 15, fontWeight: 800, marginBottom: 4 }}>🎯 Daily pins per rep</div>
        <div style={{ fontSize: 12.5, color: "#64748b", marginBottom: 14 }}>
          How many doors <b>“Start my day”</b> routes at once. <b>Sr</b> = IQ / No-sit days (denser, closer work); <b>Jr</b> = inspection-lead days (more ground). Adjust anytime as we dial in time-at-door.
        </div>
        <div style={{ display: "flex", alignItems: "flex-end", gap: 20, flexWrap: "wrap" }}>
          <label style={{ fontSize: 13, fontWeight: 700, color: "#334155" }}>
            <div style={{ marginBottom: 4 }}>Sr (IQ / No-sit)</div>
            <input type="number" min={1} max={500} value={capSr} onChange={(e) => setCapSr(Math.max(1, Number(e.target.value) || 0))}
              style={{ width: 100, fontSize: 18, fontWeight: 800, fontFamily: OSWALD, padding: "8px 10px", border: "1px solid #cbd5e1", borderRadius: 8 }} />
          </label>
          <label style={{ fontSize: 13, fontWeight: 700, color: "#334155" }}>
            <div style={{ marginBottom: 4 }}>Jr (Inspection)</div>
            <input type="number" min={1} max={500} value={capJr} onChange={(e) => setCapJr(Math.max(1, Number(e.target.value) || 0))}
              style={{ width: 100, fontSize: 18, fontWeight: 800, fontFamily: OSWALD, padding: "8px 10px", border: "1px solid #cbd5e1", borderRadius: 8 }} />
          </label>
          <button type="button" onClick={saveCaps} disabled={capsBusy} style={{ fontSize: 13, fontWeight: 700, padding: "9px 18px", borderRadius: 8, border: "none", background: "#16a34a", color: "#fff", cursor: "pointer", opacity: capsBusy ? 0.6 : 1 }}>{capsBusy ? "Saving…" : "Save"}</button>
        </div>
      </div>

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
        {types.map((t) => {
          const open = openKeys.has(t.key);
          const vs = visSummary(t);
          return (
          <div key={t.key} style={{ border: "1px solid #e5e7eb", borderRadius: 12, background: t.active ? "#fff" : "#f8fafc", opacity: t.active ? 1 : 0.7, overflow: "hidden" }}>
            {/* Collapsed header — tap to expand. Shows the color, name, and who sees it. */}
            <button type="button" onClick={() => toggleOpen(t.key)}
              style={{ width: "100%", display: "flex", alignItems: "center", gap: 10, padding: "12px 14px", background: "none", border: "none", cursor: "pointer", textAlign: "left" }}>
              <span style={{ width: 18, height: 18, borderRadius: "50%", background: t.color, flexShrink: 0, boxShadow: "0 0 0 1px rgba(0,0,0,.1)" }} />
              <span style={{ fontSize: 15, fontWeight: 700, color: "#0f172a" }}>{t.label}</span>
              {t.active === false && <span style={{ fontSize: 10.5, fontWeight: 800, color: "#64748b", background: "#e2e8f0", padding: "2px 7px", borderRadius: 8 }}>inactive</span>}
              <span style={{ marginLeft: "auto", fontSize: 11.5, fontWeight: 700, color: vs.off ? "#b45309" : "#0e7490", background: vs.off ? "#fffbeb" : "#ecfeff", border: `1px solid ${vs.off ? "#fde68a" : "#a5f3fc"}`, padding: "3px 9px", borderRadius: 8 }}>{vs.off ? "🔒 " : ""}{vs.text}</span>
              <span style={{ fontSize: 15, color: "#94a3b8", transform: open ? "rotate(90deg)" : "none", transition: "transform .12s" }}>▸</span>
            </button>

            {/* Expanded body — full editor. */}
            {open && (
            <div style={{ padding: "0 14px 14px", borderTop: "1px solid #f1f5f9" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginTop: 12 }}>
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
                  <div style={{ fontSize: 11.5, fontWeight: 700, color: "#64748b", marginBottom: 5 }}>ON THE MAP FOR</div>
                  <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                    {LEVELS.map((lv) => {
                      const on = seesLevel(t, lv);
                      return (
                        <button key={lv} type="button" onClick={() => setVis(t.key, lv, !on)} title={on ? `${lv}: on the map — tap to take OFF` : `${lv}: off the map — tap to put ON`} style={pill(on, "#0e7490")}>
                          {lv} · {on ? "on map" : "off map"}
                        </button>
                      );
                    })}
                    {!seesLevel(t, "senior") && !seesLevel(t, "junior") && (
                      <span style={{ fontSize: 11, fontWeight: 700, color: "#b45309", background: "#fffbeb", border: "1px solid #fde68a", padding: "3px 8px", borderRadius: 8, alignSelf: "center" }}>🔒 Off the map for all reps (office only)</span>
                    )}
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
            )}
          </div>
          );
        })}
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
