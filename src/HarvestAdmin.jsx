// Harvesting Map — pin-type admin (?mode=harvestadmin).
// Create/edit the pin types that drive the map: label, color, WHICH REP LEVELS
// can see them, and the allowed OUTCOMES (behavior flow). Everything the map and
// (later) the reports read comes from harvest_pin_types.
import React, { useEffect, useMemo, useState } from "react";
import { supabase } from "./lib/supabase";

const LEVELS = ["senior", "junior"];
const FONT = "'Nunito', system-ui, sans-serif";
const OSWALD = "'Oswald', sans-serif";

export default function HarvestAdmin() {
  const [types, setTypes] = useState(null);
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState(null);
  const [adding, setAdding] = useState(false);
  const [newType, setNewType] = useState({ key: "", label: "", color: "#2563eb" });

  const load = async () => {
    const { data, error } = await supabase.from("harvest_pin_types").select("*").order("sort");
    if (error) { setMsg({ err: error.message }); setTypes([]); return; }
    setTypes(data || []);
  };
  useEffect(() => { load(); }, []);

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
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 6 }}>
        <a href="/?mode=harvest" style={{ fontSize: 13, color: "#0e7490", textDecoration: "none", fontWeight: 700 }}>← Harvesting Map</a>
        <div style={{ fontSize: 22, fontWeight: 800, fontFamily: OSWALD }}>🌾 Harvesting Admin</div>
      </div>

      {msg && <div style={{ marginBottom: 14, padding: "10px 14px", borderRadius: 10, fontSize: 13.5, fontWeight: 600, background: msg.err ? "#fef2f2" : "#ecfdf5", color: msg.err ? "#b91c1c" : "#065f46", border: `1px solid ${msg.err ? "#fecaca" : "#a7f3d0"}` }}>{msg.err || msg.ok}</div>}

      {/* Load leads — office only; not shown to reps on the map */}
      <LeadUpload types={types} />

      <div style={{ fontSize: 18, fontWeight: 800, fontFamily: OSWALD, margin: "26px 0 4px" }}>Pin types</div>
      <div style={{ fontSize: 13.5, color: "#64748b", marginBottom: 14 }}>
        Each pin type: its color, <b>who can see it</b> (rep level), and the <b>outcomes</b> a rep may switch it to. The map and reports read this.
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

// ── Office lead upload (CSV or paste) — not shown to reps ──────────────
function LeadUpload({ types }) {
  const [listName, setListName] = useState("");
  const [defaultType, setDefaultType] = useState("iq");
  const [text, setText] = useState("");
  const [fileName, setFileName] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);

  const parsed = useMemo(() => parseRows(text, defaultType, types), [text, defaultType, types]);

  const onFile = (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setFileName(f.name);
    const reader = new FileReader();
    reader.onload = () => setText(String(reader.result || ""));
    reader.readAsText(f);
  };

  async function submit() {
    if (!parsed.length) return;
    setBusy(true); setResult(null);
    try {
      const r = await fetch("/.netlify/functions/canvass-upload", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ list_name: listName.trim() || undefined, default_type: defaultType, rows: parsed }),
      });
      const j = await r.json().catch(() => ({}));
      setResult(!r.ok || !j.ok ? { error: j.error || `Error ${r.status}` } : { ok: true, ...j });
    } catch (e) { setResult({ error: e.message || "Network error" }); }
    setBusy(false);
  }

  const typeCounts = useMemo(() => {
    const c = {}; for (const r of parsed) c[r.type] = (c[r.type] || 0) + 1; return c;
  }, [parsed]);

  return (
    <div style={{ border: "1px solid #e5e7eb", borderRadius: 12, padding: 16, background: "#f8fafc", marginBottom: 8 }}>
      <div style={{ fontSize: 16, fontWeight: 800, fontFamily: OSWALD, marginBottom: 4 }}>📥 Load leads</div>
      <div style={{ fontSize: 13, color: "#64748b", marginBottom: 12 }}>
        Upload a <b>CSV</b> (or paste rows). Columns detected: <code>address, city, state, zip, name, type</code>. A <code>type</code> column sets each pin's type; rows without one use the default below. Reps never see this — it's office-only.
      </div>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", marginBottom: 10 }}>
        <input value={listName} onChange={(e) => setListName(e.target.value)} placeholder="List name (optional)"
          style={{ fontSize: 14, padding: "8px 10px", borderRadius: 8, border: "1px solid #cbd5e1", minWidth: 200 }} />
        <label style={{ fontSize: 13, color: "#475569", display: "flex", alignItems: "center", gap: 6 }}>
          Default type:
          <select value={defaultType} onChange={(e) => setDefaultType(e.target.value)} style={{ fontSize: 14, padding: "7px 8px", borderRadius: 8, border: "1px solid #cbd5e1" }}>
            {(types || []).map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
          </select>
        </label>
        <label style={{ fontSize: 13, fontWeight: 700, color: "#0e7490", border: "1px solid #0e7490", borderRadius: 8, padding: "7px 12px", cursor: "pointer" }}>
          Choose CSV file
          <input type="file" accept=".csv,text/csv" onChange={onFile} style={{ display: "none" }} />
        </label>
        {fileName ? <span style={{ fontSize: 12, color: "#64748b" }}>{fileName}</span> : null}
      </div>
      <textarea value={text} onChange={(e) => { setText(e.target.value); setFileName(""); }} rows={6}
        placeholder={"address,city,state,zip,type\n123 Main St,Tampa,FL,33606,iq\n456 Oak Ave,St Petersburg,FL,33701,insp"}
        style={{ width: "100%", padding: "10px 12px", borderRadius: 10, border: "1px solid #cbd5e1", fontSize: 13, fontFamily: "monospace", boxSizing: "border-box", resize: "vertical" }} />
      <div style={{ fontSize: 12, color: "#94a3b8", margin: "6px 0 12px" }}>
        {parsed.length} row{parsed.length === 1 ? "" : "s"} ready{parsed.length ? ` — ${Object.entries(typeCounts).map(([k, n]) => `${n} ${S(types, k)}`).join(", ")}` : ""}
      </div>

      {result?.error && <div style={{ color: "#b91c1c", fontSize: 13, marginBottom: 10 }}>{result.error}</div>}
      {result?.ok && (
        <div style={{ background: "#ecfdf5", border: "1px solid #a7f3d0", borderRadius: 10, padding: "10px 12px", fontSize: 13, color: "#065f46", marginBottom: 10 }}>
          ✓ {result.inserted} new{result.updated ? `, ${result.updated} updated` : ""}{result.skipped ? `, ${result.skipped} kept (dedup)` : ""} — {result.geocoded} geocoded{result.failed ? `, ${result.failed} failed` : ""}.
        </div>
      )}
      <button type="button" onClick={submit} disabled={busy || !parsed.length}
        style={{ padding: "10px 20px", borderRadius: 10, border: "none", background: "#2563eb", color: "#fff", fontWeight: 800, fontSize: 14, fontFamily: OSWALD, cursor: "pointer", opacity: busy || !parsed.length ? 0.6 : 1 }}>
        {busy ? "Geocoding…" : `Upload & geocode ${parsed.length || ""}`}
      </button>
    </div>
  );
}

// Parse pasted/CSV text into upload rows. Detects a header row; otherwise treats
// each line as a full address string. Resolves a `type` value (key OR label) to
// a pin-type key, falling back to the batch default.
function parseRows(text, defaultType, types) {
  const lines = String(text || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return [];
  const splitCsv = (line) => {
    const out = []; let cur = "", q = false;
    for (const c of line) {
      if (c === '"') { q = !q; continue; }
      if (c === "," && !q) { out.push(cur); cur = ""; continue; }
      cur += c;
    }
    out.push(cur);
    return out.map((s) => s.trim());
  };
  const resolveType = (raw) => {
    const v = String(raw || "").trim().toLowerCase();
    if (!v) return defaultType;
    const t = (types || []).find((x) => x.key.toLowerCase() === v || (x.label || "").toLowerCase() === v);
    return t ? t.key : defaultType;
  };
  const header = splitCsv(lines[0]).map((h) => h.toLowerCase());
  const looksLikeHeader = header.some((h) => /address|street|city|state|zip|name|type|status|pin/.test(h));
  if (!looksLikeHeader) return lines.map((l) => ({ address: l, type: defaultType }));
  const idx = (names) => header.findIndex((h) => names.includes(h));
  const iA = idx(["address", "street address", "street", "address1", "addr"]);
  const iC = idx(["city", "town"]);
  const iS = idx(["state", "st"]);
  const iZ = idx(["zip", "zipcode", "zip code", "postal", "postal code"]);
  const iN = idx(["name", "homeowner", "owner", "full name"]);
  const iT = idx(["type", "pin type", "pintype", "status", "pin"]);
  const rows = [];
  for (let li = 1; li < lines.length; li++) {
    const cols = splitCsv(lines[li]);
    const get = (i) => (i >= 0 ? (cols[i] || "") : "");
    const address = (iA >= 0 ? get(iA) : cols[0]) || "";
    if (!address) continue;
    rows.push({ address, city: get(iC) || null, state: get(iS) || null, zip: get(iZ) || null, name: get(iN) || null, type: resolveType(get(iT)) });
  }
  return rows;
}
