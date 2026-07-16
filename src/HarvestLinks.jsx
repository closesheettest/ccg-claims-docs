// Harvesting Map — rep links & access (?mode=harvestlinks). Office-only.
// The office's own "view all" map link, an Admins list (people with their own
// view-all link), and every rep's personal link with their level. The office
// can promote anyone to Admin (view-all) or set senior/junior from here.
import React, { useEffect, useState } from "react";
import HarvestNav from "./HarvestNav";

const FONT = "'Nunito', system-ui, sans-serif";
const OSWALD = "'Oswald', sans-serif";

export default function HarvestLinks() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState("");
  const [copied, setCopied] = useState("");
  const [q, setQ] = useState("");
  const [assignQ, setAssignQ] = useState("");
  const [saving, setSaving] = useState("");   // rep id currently saving
  const [note, setNote] = useState("");

  const load = async () => {
    try {
      const r = await fetch("/.netlify/functions/harvest-rep-links");
      const j = await r.json().catch(() => ({}));
      if (!j.ok) { setErr(j.error || "Couldn't load."); return; }
      setErr("");
      setData(j);
    } catch (e) { setErr(e.message || "Network error"); }
  };
  useEffect(() => { load(); }, []);

  const copy = (text, id) => {
    try { navigator.clipboard.writeText(text); setCopied(id); setTimeout(() => setCopied(""), 1500); }
    catch { window.prompt("Copy this link:", text); }
  };

  // Set (or clear) a person's harvest level, then refresh the roster.
  const setLevel = async (repId, level, name) => {
    setSaving(repId); setNote("");
    try {
      const r = await fetch("/.netlify/functions/harvest-set-level", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rep_id: repId, level: level || "none" }),
      });
      const j = await r.json().catch(() => ({}));
      if (!j.ok) { setNote(`⚠️ ${name}: ${j.error || "couldn't save"}`); }
      else {
        const label = !level ? "set to default (zone level)" : level === "admin" ? "made an Admin (view-all)" : `set to ${level}`;
        setNote(`✓ ${name} ${label}.`);
        setAssignQ("");
        await load();
      }
    } catch (e) { setNote(`⚠️ ${e.message || "network error"}`); }
    finally { setSaving(""); }
  };

  const admins = data?.admins || [];
  const reps = (data?.reps || []).filter((r) => !q.trim() || (r.name || "").toLowerCase().includes(q.toLowerCase()));
  // Assign picker: match anyone in the full roster (min 2 chars), cap the list.
  const cardedIds = new Set([...(data?.admins || []), ...(data?.reps || [])].map((c) => c.id));
  const matches = assignQ.trim().length >= 2
    ? (data?.all || []).filter((r) => (r.name || "").toLowerCase().includes(assignQ.toLowerCase())).slice(0, 8)
    : [];

  return (
    <div style={{ maxWidth: 820, margin: "0 auto", padding: "20px 16px 60px", fontFamily: FONT }}>
      <HarvestNav active="links" />
      <div style={{ fontSize: 22, fontWeight: 800, fontFamily: OSWALD, marginBottom: 4 }}>🔗 Rep Links &amp; Access</div>
      <div style={{ fontSize: 13.5, color: "#64748b", marginBottom: 16 }}>Each person opens their <b>personal link</b> to work the map. <b>Admins</b> see every pin (view-all); reps see only what their level (senior / junior) allows.</div>

      {err && <div style={{ color: "#b91c1c", fontSize: 13.5, marginBottom: 12 }}>{err}</div>}
      {note && <div style={{ color: note[0] === "✓" ? "#15803d" : "#b45309", fontSize: 13, marginBottom: 12, fontWeight: 700 }}>{note}</div>}
      {!data && !err ? <div style={{ color: "#94a3b8", fontSize: 13 }}>Loading…</div> : null}

      {data?.admin_link && (
        <div style={{ background: "#f5f3ff", border: "1px solid #ddd6fe", borderRadius: 12, padding: 14, marginBottom: 20, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <span style={{ fontSize: 11, fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.04em", background: "#7c3aed", color: "#fff", padding: "3px 10px", borderRadius: 10 }}>Office</span>
          <div style={{ fontSize: 14, fontWeight: 700, color: "#4c1d95" }}>Your view — every pin</div>
          <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
            <a href={data.admin_link} target="_blank" rel="noreferrer" style={{ fontSize: 13, fontWeight: 700, color: "#fff", background: "#7c3aed", borderRadius: 8, padding: "7px 14px", textDecoration: "none" }}>Open map ↗</a>
            <button type="button" onClick={() => copy(data.admin_link, "admin")} style={btn}>{copied === "admin" ? "✓ Copied" : "Copy link"}</button>
          </div>
        </div>
      )}

      {data && (
        <>
          {/* Assign access — promote anyone to Admin (view-all) or set their level. */}
          <div style={{ background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 12, padding: 14, marginBottom: 22 }}>
            <div style={{ fontSize: 14, fontWeight: 800, fontFamily: OSWALD, marginBottom: 2 }}>➕ Give someone access</div>
            <div style={{ fontSize: 12.5, color: "#64748b", marginBottom: 10 }}>Search a name, then pick <b>Admin</b> (sees all pins on their own link), <b>Senior</b>, or <b>Junior</b>.</div>
            <input value={assignQ} onChange={(e) => setAssignQ(e.target.value)} placeholder="Type a name…" style={{ fontSize: 13.5, padding: "8px 11px", borderRadius: 8, border: "1px solid #cbd5e1", width: "100%", maxWidth: 340, boxSizing: "border-box" }} />
            {matches.length > 0 && (
              <div style={{ display: "grid", gap: 6, marginTop: 10 }}>
                {matches.map((m) => (
                  <div key={m.id} style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", border: "1px solid #e5e7eb", borderRadius: 10, padding: "8px 11px", background: "#fff" }}>
                    <span style={{ fontSize: 13.5, fontWeight: 700 }}>{m.name}</span>
                    {cardedIds.has(m.id) && <span style={{ fontSize: 11, color: "#94a3b8" }}>(already listed{m.override ? ` · ${m.override}` : ""})</span>}
                    <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
                      <button type="button" disabled={saving === m.id} onClick={() => setLevel(m.id, "admin", m.name)} style={{ ...pill, background: "#7c3aed" }}>{saving === m.id ? "…" : "Admin"}</button>
                      <button type="button" disabled={saving === m.id} onClick={() => setLevel(m.id, "senior", m.name)} style={{ ...pill, background: "#16a34a" }}>Senior</button>
                      <button type="button" disabled={saving === m.id} onClick={() => setLevel(m.id, "junior", m.name)} style={{ ...pill, background: "#334155" }}>Junior</button>
                    </div>
                  </div>
                ))}
              </div>
            )}
            {assignQ.trim().length >= 2 && matches.length === 0 && <div style={{ fontSize: 12.5, color: "#94a3b8", marginTop: 8 }}>No match.</div>}
          </div>

          {/* Admins — view-all links. */}
          {admins.length > 0 && (
            <div style={{ marginBottom: 22 }}>
              <div style={{ fontSize: 16, fontWeight: 800, fontFamily: OSWALD, marginBottom: 8 }}>👑 Admins — view all ({admins.length})</div>
              <div style={{ display: "grid", gap: 6 }}>
                {admins.map((r) => (
                  <div key={r.id} style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", border: "1px solid #ddd6fe", borderRadius: 10, padding: "9px 12px", background: "#faf5ff" }}>
                    <span style={{ fontSize: 10.5, fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.04em", background: "#7c3aed", color: "#fff", padding: "2px 8px", borderRadius: 10 }}>admin</span>
                    <span style={{ fontSize: 14, fontWeight: 700 }}>{r.name}</span>
                    <div style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
                      <LevelSelect card={r} disabled={saving === r.id} onPick={(lv) => setLevel(r.id, lv, r.name)} />
                      <a href={r.link} target="_blank" rel="noreferrer" style={{ fontSize: 12.5, fontWeight: 700, color: "#7c3aed", textDecoration: "none" }}>Open ↗</a>
                      <button type="button" onClick={() => copy(r.link, r.link)} style={btn}>{copied === r.link ? "✓ Copied" : "Copy link"}</button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Reps — level links, grouped by region. */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 10, marginBottom: 8 }}>
            <div style={{ fontSize: 16, fontWeight: 800, fontFamily: OSWALD }}>Reps ({data.reps.length})</div>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search reps…" style={{ fontSize: 13, padding: "7px 10px", borderRadius: 8, border: "1px solid #cbd5e1", minWidth: 180 }} />
          </div>
          <div style={{ display: "grid", gap: 6 }}>
            {reps.map((r, i) => {
              const showRegion = i === 0 || r.region !== reps[i - 1].region;
              return (
              <React.Fragment key={r.id}>
                {showRegion && <div style={{ fontSize: 13, fontWeight: 800, fontFamily: OSWALD, color: "#0f172a", margin: i === 0 ? "0 0 2px" : "12px 0 2px" }}>📍 {r.region || "No region"}</div>}
                <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", border: "1px solid #e5e7eb", borderRadius: 10, padding: "9px 12px", background: "#fff" }}>
                <span style={{ fontSize: 10.5, fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.04em", background: r.level === "senior" ? "#16a34a" : "#334155", color: "#fff", padding: "2px 8px", borderRadius: 10 }}>{r.level}{r.override ? " ·set" : ""}</span>
                <span style={{ fontSize: 14, fontWeight: 700 }}>{r.name}</span>
                <div style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
                  <LevelSelect card={r} disabled={saving === r.id} onPick={(lv) => setLevel(r.id, lv, r.name)} />
                  <a href={r.link} target="_blank" rel="noreferrer" style={{ fontSize: 12.5, fontWeight: 700, color: "#0e7490", textDecoration: "none" }}>Open ↗</a>
                  <button type="button" onClick={() => copy(r.link, r.link)} style={btn}>{copied === r.link ? "✓ Copied" : "Copy link"}</button>
                </div>
              </div>
              </React.Fragment>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

// Per-person level dropdown. Value reflects the explicit office override; picking
// "Default" clears it (rep falls back to their rep-zones level).
function LevelSelect({ card, disabled, onPick }) {
  return (
    <select
      value={card.override || ""}
      disabled={disabled}
      onChange={(e) => onPick(e.target.value)}
      title="Set access level"
      style={{ fontSize: 12, fontWeight: 700, color: "#334155", background: "#fff", border: "1px solid #cbd5e1", borderRadius: 8, padding: "5px 7px", cursor: "pointer" }}
    >
      <option value="">Default{card.region ? " (zone)" : ""}</option>
      <option value="admin">Admin · view all</option>
      <option value="senior">Senior</option>
      <option value="junior">Junior</option>
    </select>
  );
}

const btn = { fontSize: 12.5, fontWeight: 700, color: "#334155", background: "#fff", border: "1px solid #cbd5e1", borderRadius: 8, padding: "6px 12px", cursor: "pointer" };
const pill = { fontSize: 12, fontWeight: 800, color: "#fff", border: "none", borderRadius: 8, padding: "6px 12px", cursor: "pointer" };
