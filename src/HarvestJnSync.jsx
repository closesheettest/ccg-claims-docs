// Harvesting Map — JobNimbus → Map sync filters (?mode=harvestjnsync). Office.
// Configure which JN records flow onto the map and how far back:
//   • IQ pins       = "Instant Quote" contacts with no job, by CREATED date.
//   • No-sit pins   = "No Sit- Need to Reschedule" deals, by APPOINTMENT date.
// Settings live in app_settings.harvest_jn_filters; the sync functions + crons
// read them. Each card can be saved and synced on demand.
import React, { useEffect, useState } from "react";
import { supabase } from "./lib/supabase";
import HarvestNav from "./HarvestNav";

const FONT = "'Nunito', system-ui, sans-serif";
const OSWALD = "'Oswald', sans-serif";
const DEFAULTS = { iq: { enabled: false, created_before: "" }, nosit: { enabled: true, appt_before: "" } };

export default function HarvestJnSync() {
  const [cfg, setCfg] = useState(DEFAULTS);
  const [counts, setCounts] = useState({ iq: null, no_sit_reschedule: null });
  const [busy, setBusy] = useState("");            // "iq" | "nosit" while syncing
  const [msg, setMsg] = useState({ iq: "", nosit: "" });
  const [loaded, setLoaded] = useState(false);

  useEffect(() => { (async () => {
    try {
      const { data } = await supabase.from("app_settings").select("value").eq("key", "harvest_jn_filters").maybeSingle();
      if (data?.value) { const v = typeof data.value === "string" ? JSON.parse(data.value) : data.value; setCfg({ iq: { ...DEFAULTS.iq, ...(v.iq || {}) }, nosit: { ...DEFAULTS.nosit, ...(v.nosit || {}) } }); }
    } catch { /* keep defaults */ }
    await refreshCounts();
    setLoaded(true);
  })(); }, []);

  async function refreshCounts() {
    for (const s of ["iq", "no_sit_reschedule"]) {
      const { count } = await supabase.from("canvass_prospects").select("id", { count: "exact", head: true }).eq("status", s);
      setCounts((c) => ({ ...c, [s]: count ?? 0 }));
    }
  }
  async function saveCfg(next) {
    setCfg(next);
    await supabase.from("app_settings").upsert({ key: "harvest_jn_filters", value: JSON.stringify(next), updated_at: new Date().toISOString() }, { onConflict: "key" });
  }
  const setIq = (patch) => saveCfg({ ...cfg, iq: { ...cfg.iq, ...patch } });
  const setNosit = (patch) => saveCfg({ ...cfg, nosit: { ...cfg.nosit, ...patch } });

  async function syncNosit() {
    setBusy("nosit"); setMsg((m) => ({ ...m, nosit: "Syncing a batch from JobNimbus…" }));
    try {
      const r = await fetch("/.netlify/functions/harvest-sync-nosits?commit=1");
      const j = await r.json().catch(() => ({}));
      if (!j.ok) throw new Error(j.error || "sync failed");
      setMsg((m) => ({ ...m, nosit: `Done: ${j.inserted || 0} added, ${j.updated || 0} updated, ${j.removed_rebooked || 0} removed${j.skipped_ungeocoded ? ` · ${j.skipped_ungeocoded} still need geocoding (run again or wait for the cron)` : ""}.` }));
      await refreshCounts();
    } catch (e) { setMsg((m) => ({ ...m, nosit: `⚠️ ${e.message}` })); }
    setBusy("");
  }

  async function syncIq() {
    setBusy("iq"); setMsg((m) => ({ ...m, iq: "Starting — pulling Instant Quote contacts from JobNimbus (this runs in the background)…" }));
    try {
      await fetch("/.netlify/functions/harvest-sync-iq-background", { method: "POST" });
      // Poll the result the background job writes.
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 4000));
        const { data } = await supabase.from("app_settings").select("value, updated_at").eq("key", "harvest_iq_sync").maybeSingle();
        const v = data?.value ? (typeof data.value === "string" ? JSON.parse(data.value) : data.value) : null;
        if (v && v.finished && Date.parse(v.finished) > Date.now() - 5 * 60 * 1000) {
          if (!v.ok) { setMsg((m) => ({ ...m, iq: `⚠️ ${v.error || "sync failed"}` })); break; }
          setMsg((m) => ({ ...m, iq: `Done: ${v.inserted || 0} added, ${v.updated || 0} updated, ${v.removed || 0} removed · ${v.geocoded || 0} geocoded${v.skipped_ungeocoded ? `, ${v.skipped_ungeocoded} still to geocode (run again)` : ""}. ${v.candidates ?? ""} Instant-Quote leads matched.` }));
          await refreshCounts();
          break;
        }
        setMsg((m) => ({ ...m, iq: `Working… (${(i + 1) * 4}s)` }));
      }
    } catch (e) { setMsg((m) => ({ ...m, iq: `⚠️ ${e.message}` })); }
    setBusy("");
  }

  const fld = { fontSize: 14, padding: "9px 11px", borderRadius: 9, border: "1px solid #cbd5e1", fontFamily: FONT };
  const btn = (on, color) => ({ fontSize: 13.5, fontWeight: 800, padding: "9px 16px", borderRadius: 10, cursor: on ? "not-allowed" : "pointer", border: "none", background: color, color: "#fff", opacity: on ? 0.6 : 1, fontFamily: OSWALD });

  return (
    <div style={{ maxWidth: 760, margin: "0 auto", padding: "20px 16px 60px", fontFamily: FONT }}>
      <HarvestNav active="jnsync" />
      <div style={{ fontSize: 22, fontWeight: 800, fontFamily: OSWALD, marginBottom: 4 }}>🔄 JN Sync</div>
      <div style={{ fontSize: 13, color: "#64748b", marginBottom: 20 }}>Pick which JobNimbus records flow onto the Harvesting Map, and how far back. Changes are saved instantly; the twice-daily cron uses them, or hit <b>Sync now</b> to run it immediately.</div>

      {/* IQ pins */}
      <Card
        title="🔵 IQ pins — Instant Quote"
        desc={<>JobNimbus contacts whose lead source is <b>Instant Quote</b> and that have <b>no job</b> yet — leads that never got worked. They land on the map as IQ pins (senior-visible).</>}
        enabled={cfg.iq.enabled}
        onToggle={(v) => setIq({ enabled: v })}
        dateLabel="Only contacts CREATED on or before:"
        dateHint="Leave blank for all. Older leads are the ones most worth working."
        dateVal={cfg.iq.created_before}
        onDate={(v) => setIq({ created_before: v })}
        count={counts.iq}
        countLabel="IQ pins on the map now"
        onSync={syncIq}
        syncing={busy === "iq"}
        msg={msg.iq}
        btnStyle={btn(busy === "iq", "#2563eb")}
      />

      {/* No-sit pins */}
      <Card
        title="🔴 No-sit pins — Need to Reschedule"
        desc={<>JobNimbus deals in status <b>"No Sit- Need to Reschedule"</b> — appointments that never sat. Reps drive out and re-book them on the spot.</>}
        enabled={cfg.nosit.enabled}
        onToggle={(v) => setNosit({ enabled: v })}
        dateLabel="Only deals whose APPOINTMENT was on or before:"
        dateHint="Leave blank for all. e.g. only show ones at least a few weeks stale."
        dateVal={cfg.nosit.appt_before}
        onDate={(v) => setNosit({ appt_before: v })}
        count={counts.no_sit_reschedule}
        countLabel="No-sit pins on the map now"
        onSync={syncNosit}
        syncing={busy === "nosit"}
        msg={msg.nosit}
        btnStyle={btn(busy === "nosit", "#dc2626")}
      />

      {!loaded && <div style={{ color: "#94a3b8", fontSize: 13 }}>Loading…</div>}
    </div>
  );
}

function Card({ title, desc, enabled, onToggle, dateLabel, dateHint, dateVal, onDate, count, countLabel, onSync, syncing, msg, btnStyle }) {
  const fld = { fontSize: 14, padding: "9px 11px", borderRadius: 9, border: "1px solid #cbd5e1", fontFamily: "'Nunito', sans-serif" };
  return (
    <div style={{ border: "1px solid #e5e7eb", borderRadius: 14, padding: "16px 18px", marginBottom: 18, background: "#fff", boxShadow: "0 1px 3px rgba(0,0,0,.04)" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
        <div style={{ fontSize: 16.5, fontWeight: 800, fontFamily: "'Oswald', sans-serif" }}>{title}</div>
        <label style={{ display: "flex", alignItems: "center", gap: 7, cursor: "pointer", fontSize: 13, fontWeight: 700, color: enabled ? "#16a34a" : "#94a3b8" }}>
          <input type="checkbox" checked={enabled} onChange={(e) => onToggle(e.target.checked)} style={{ width: 17, height: 17 }} />
          {enabled ? "On" : "Off"}
        </label>
      </div>
      <div style={{ fontSize: 13, color: "#475569", margin: "6px 0 14px" }}>{desc}</div>

      <div style={{ opacity: enabled ? 1 : 0.5, pointerEvents: enabled ? "auto" : "none" }}>
        <label style={{ fontSize: 13, fontWeight: 700, color: "#334155", display: "block", marginBottom: 6 }}>{dateLabel}</label>
        <input type="date" value={dateVal || ""} onChange={(e) => onDate(e.target.value)} style={fld} />
        <div style={{ fontSize: 11.5, color: "#94a3b8", margin: "5px 0 14px" }}>{dateHint}</div>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
        <button type="button" disabled={syncing} onClick={onSync} style={btnStyle}>{syncing ? "Syncing…" : "🔄 Sync now"}</button>
        <span style={{ fontSize: 13, color: "#334155" }}><b>{count == null ? "…" : count.toLocaleString()}</b> {countLabel}</span>
      </div>
      {msg && <div style={{ fontSize: 12.5, color: msg.startsWith("⚠️") ? "#b91c1c" : "#166534", marginTop: 10, background: msg.startsWith("⚠️") ? "#fef2f2" : "#f0fdf4", border: `1px solid ${msg.startsWith("⚠️") ? "#fecaca" : "#bbf7d0"}`, borderRadius: 9, padding: "8px 11px" }}>{msg}</div>}
    </div>
  );
}
