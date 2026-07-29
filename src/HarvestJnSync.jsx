// DoorDispatcher — JobNimbus → Map sync filters (?mode=harvestjnsync). Office.
// Configure which JN records flow onto the map and how far back:
//   • Inbound-lead pins (IQ = Instant Quote, FB = Facebook, AI = AI Bot) —
//     contacts with no job, by CREATED date. Same rule for each.
//   • No-sit pins = "No Sit- Need to Reschedule" deals, by APPOINTMENT date.
// Settings live in app_settings.harvest_jn_filters; the sync fns + crons read
// them. Each card can be saved + synced on demand.
import React, { useEffect, useState } from "react";
import { supabase } from "./lib/supabase";
import HarvestNav from "./HarvestNav";

const FONT = "'Nunito', system-ui, sans-serif";
const OSWALD = "'Oswald', sans-serif";

// The three source-based lead layers (same "contacts with no job, by created date" rule).
const LEADS = [
  { key: "iq", status: "iq", color: "#2563eb", title: "🔵 IQ pins — Instant Quote", source: "Instant Quote" },
  { key: "fb", status: "fb", color: "#1877f2", title: "📘 FB pins — Facebook", source: "Facebook" },
  { key: "ai", status: "ai", color: "#0d9488", title: "🤖 AI pins — AI Bot", source: "AI Bot" },
];
const DEFAULTS = {
  iq: { enabled: false, created_after: "" },
  fb: { enabled: false, created_after: "" },
  ai: { enabled: false, created_after: "" },
  nosit: { enabled: true, appt_after: "" },
};

export default function HarvestJnSync() {
  const [cfg, setCfg] = useState(DEFAULTS);
  const [counts, setCounts] = useState({});
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState({});
  const [loaded, setLoaded] = useState(false);
  const [daily, setDaily] = useState({});   // harvest_sync_daily: new pins per day
  const [scrub, setScrub] = useState({});   // shovels_venice_scrub_daily: bad/added per day

  const loadSetting = async (k) => {
    try { const { data } = await supabase.from("app_settings").select("value").eq("key", k).maybeSingle(); return data?.value ? (typeof data.value === "string" ? JSON.parse(data.value) : data.value) : {}; } catch { return {}; }
  };

  useEffect(() => { (async () => {
    try {
      const { data } = await supabase.from("app_settings").select("value").eq("key", "harvest_jn_filters").maybeSingle();
      if (data?.value) { const v = typeof data.value === "string" ? JSON.parse(data.value) : data.value; setCfg({ iq: { ...DEFAULTS.iq, ...(v.iq || {}) }, fb: { ...DEFAULTS.fb, ...(v.fb || {}) }, ai: { ...DEFAULTS.ai, ...(v.ai || {}) }, nosit: { ...DEFAULTS.nosit, ...(v.nosit || {}) } }); }
    } catch { /* keep defaults */ }
    await refreshCounts();
    setDaily(await loadSetting("harvest_sync_daily"));
    setScrub(await loadSetting("shovels_venice_scrub_daily"));
    setLoaded(true);
  })(); }, []);

  async function refreshCounts() {
    for (const s of ["iq", "fb", "ai", "no_sit_reschedule"]) {
      const { count } = await supabase.from("canvass_prospects").select("id", { count: "exact", head: true }).eq("status", s);
      setCounts((c) => ({ ...c, [s]: count ?? 0 }));
    }
  }
  async function saveCfg(next) {
    setCfg(next);
    await supabase.from("app_settings").upsert({ key: "harvest_jn_filters", value: JSON.stringify(next), updated_at: new Date().toISOString() }, { onConflict: "key" });
  }
  const patch = (key, p) => saveCfg({ ...cfg, [key]: { ...cfg[key], ...p } });

  // Sync one source-based lead layer (iq/fb/ai) — triggers the background job,
  // then polls its result.
  async function syncLead(key) {
    setBusy(key); setMsg((m) => ({ ...m, [key]: "Pulling from JobNimbus (runs in the background)…" }));
    try {
      await fetch(`/.netlify/functions/harvest-sync-iq-background?source=${key}`, { method: "POST" });
      for (let i = 0; i < 45; i++) {
        await new Promise((r) => setTimeout(r, 4000));
        const { data } = await supabase.from("app_settings").select("value").eq("key", `harvest_leadsync_${key}`).maybeSingle();
        const v = data?.value ? (typeof data.value === "string" ? JSON.parse(data.value) : data.value) : null;
        if (v && v.finished && Date.parse(v.finished) > Date.now() - 6 * 60 * 1000) {
          if (!v.ok) { setMsg((m) => ({ ...m, [key]: `⚠️ ${v.error || "sync failed"}` })); break; }
          setMsg((m) => ({ ...m, [key]: `Done: ${v.inserted || 0} added, ${v.updated || 0} updated, ${v.removed || 0} removed · ${v.geocoded || 0} geocoded${v.skipped_ungeocoded ? `, ${v.skipped_ungeocoded} still to place (run again)` : ""}. ${v.candidates ?? 0} matched.` }));
          await refreshCounts(); break;
        }
        setMsg((m) => ({ ...m, [key]: `Working… (${(i + 1) * 4}s)` }));
      }
    } catch (e) { setMsg((m) => ({ ...m, [key]: `⚠️ ${e.message}` })); }
    setBusy("");
  }

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

  const btn = (on, color) => ({ fontSize: 13.5, fontWeight: 800, padding: "9px 16px", borderRadius: 10, cursor: on ? "not-allowed" : "pointer", border: "none", background: color, color: "#fff", opacity: on ? 0.6 : 1, fontFamily: OSWALD });

  return (
    <div style={{ maxWidth: 760, margin: "0 auto", padding: "20px 16px 60px", fontFamily: FONT }}>
      <HarvestNav active="jnsync" />
      <div style={{ fontSize: 22, fontWeight: 800, fontFamily: OSWALD, marginBottom: 4 }}>🔄 JN Sync</div>
      <div style={{ fontSize: 13, color: "#64748b", marginBottom: 20 }}>Pick which JobNimbus records flow onto the DoorDispatcher, and how far back. Changes save instantly; the crons use them, or hit <b>Sync now</b> to run it immediately. A lead's pin flips to an Appointment once a rep books it (which pushes everything to JobNimbus), and drops off once it gets a job.</div>

      {LEADS.map((L) => (
        <Card key={L.key}
          title={L.title}
          desc={<>JobNimbus contacts whose lead source is <b>{L.source}</b> with <b>no job</b> yet. They land on the map as {L.status.toUpperCase()} pins (senior-visible), routed with IQ priority.</>}
          enabled={cfg[L.key].enabled}
          onToggle={(v) => patch(L.key, { enabled: v })}
          dateLabel="Only contacts CREATED on or after:"
          dateHint="Leave blank for all. Newer leads convert better — older ones have often already gone with someone else. Adjust to find the sweet spot."
          dateVal={cfg[L.key].created_after}
          onDate={(v) => patch(L.key, { created_after: v })}
          count={counts[L.status]}
          countLabel={`${L.status.toUpperCase()} pins on the map now`}
          onSync={() => syncLead(L.key)}
          syncing={busy === L.key}
          msg={msg[L.key]}
          btnStyle={btn(busy === L.key, L.color)}
        />
      ))}

      <Card
        title="🔴 No-sit pins — Need to Reschedule"
        desc={<>JobNimbus deals in status <b>"No Sit- Need to Reschedule"</b> — appointments that never sat. Reps drive out and re-book them on the spot.</>}
        enabled={cfg.nosit.enabled}
        onToggle={(v) => patch("nosit", { enabled: v })}
        dateLabel="Only deals whose APPOINTMENT was on or after:"
        dateHint="Leave blank for all. Forward from this date — same as the IQ filter above."
        dateVal={cfg.nosit.appt_after || cfg.nosit.appt_before || ""}
        onDate={(v) => patch("nosit", { appt_after: v, appt_before: "" })}
        count={counts.no_sit_reschedule}
        countLabel="No-sit pins on the map now"
        onSync={syncNosit}
        syncing={busy === "nosit"}
        msg={msg.nosit}
        btnStyle={btn(busy === "nosit", "#dc2626")}
      />

      {/* ── Daily report: new pins added by the sync + Venice roof scrub ─────── */}
      <DailyReport daily={daily} scrub={scrub} />

      {!loaded && <div style={{ color: "#94a3b8", fontSize: 13 }}>Loading…</div>}
    </div>
  );
}

// Rolling per-day report. `daily` = { date: { iq, fb, ai, nosit } } new pins the sync
// added; `scrub` = { date: { bad, aging, processed } } from the Venice roof scrub.
function DailyReport({ daily, scrub }) {
  const days = [...new Set([...Object.keys(daily || {}), ...Object.keys(scrub || {})])].sort().reverse().slice(0, 14);
  if (!days.length) return null;
  const fmt = (d) => { try { return new Date(d + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" }); } catch { return d; } };
  const th = { textAlign: "right", padding: "6px 8px", fontSize: 11.5, fontWeight: 800, color: "#64748b", textTransform: "uppercase", letterSpacing: "0.03em", borderBottom: "1px solid #e5e7eb" };
  const td = { textAlign: "right", padding: "7px 8px", fontSize: 13.5, color: "#0f172a", borderBottom: "1px solid #f1f5f9" };
  const td0 = { ...td, textAlign: "left", fontWeight: 700, color: "#334155" };
  return (
    <div style={{ border: "1px solid #e5e7eb", borderRadius: 14, padding: "16px 18px", marginTop: 8, background: "#fff", boxShadow: "0 1px 3px rgba(0,0,0,.04)" }}>
      <div style={{ fontSize: 16.5, fontWeight: 800, fontFamily: OSWALD, marginBottom: 4 }}>📊 Daily report</div>
      <div style={{ fontSize: 12.5, color: "#64748b", marginBottom: 12 }}>New pins the sync added each day, and the Venice roof-age scrub (bad = flipped to New Roof).</div>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 520 }}>
          <thead>
            <tr>
              <th style={{ ...th, textAlign: "left" }}>Day</th>
              <th style={th}>IQ</th><th style={th}>FB</th><th style={th}>AI</th><th style={th}>No-Sit</th>
              <th style={{ ...th, color: "#0f172a" }}>Added</th>
              <th style={{ ...th, borderLeft: "2px solid #e5e7eb" }}>Checked</th>
              <th style={{ ...th, color: "#b45309" }}>New Roof</th>
              <th style={th}>Aging</th>
            </tr>
          </thead>
          <tbody>
            {days.map((d) => {
              const s = daily[d] || {}, v = scrub[d] || {};
              const added = (s.iq || 0) + (s.fb || 0) + (s.ai || 0) + (s.nosit || 0);
              return (
                <tr key={d}>
                  <td style={td0}>{fmt(d)}</td>
                  <td style={td}>{s.iq || 0}</td><td style={td}>{s.fb || 0}</td><td style={td}>{s.ai || 0}</td><td style={td}>{s.nosit || 0}</td>
                  <td style={{ ...td, fontWeight: 800 }}>{added}</td>
                  <td style={{ ...td, borderLeft: "2px solid #e5e7eb" }}>{v.processed || 0}</td>
                  <td style={{ ...td, fontWeight: 800, color: "#b45309" }}>{v.bad || 0}</td>
                  <td style={td}>{v.aging || 0}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
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
