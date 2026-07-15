// Harvesting Map — office lead upload (?mode=harvestupload). Its own page,
// separate from the pin-type config. Load a CSV/paste marked as a pin type, and
// see every past upload with the ability to DELETE one (removes the pins it
// added) — a safety net against a bad upload. Not shown to reps.
import React, { useEffect, useMemo, useState } from "react";
import { supabase } from "./lib/supabase";
import HarvestNav from "./HarvestNav";

const FONT = "'Nunito', system-ui, sans-serif";
const OSWALD = "'Oswald', sans-serif";

export default function HarvestUpload() {
  const [types, setTypes] = useState([]);
  const [uploads, setUploads] = useState(null);
  const [msg, setMsg] = useState(null);

  const loadTypes = async () => {
    const { data } = await supabase.from("harvest_pin_types").select("key,label,color").eq("active", true).order("sort");
    setTypes(data || []);
  };
  const loadUploads = async () => {
    const { data, error } = await supabase.from("harvest_uploads").select("*").order("uploaded_at", { ascending: false }).limit(200);
    setUploads(error ? [] : (data || []));
  };
  useEffect(() => { loadTypes(); loadUploads(); }, []);

  const typeLabel = (k) => (types.find((t) => t.key === k)?.label) || k;
  const typeColor = (k) => (types.find((t) => t.key === k)?.color) || "#64748b";

  async function deleteUpload(u) {
    if (!window.confirm(`Delete this upload${u.list_name ? ` (“${u.list_name}”)` : ""}?\n\nThis removes the ${u.inserted} pin${u.inserted === 1 ? "" : "s"} it ADDED. Pins it only updated are left as they are. This cannot be undone.`)) return;
    setMsg(null);
    const del = await supabase.from("canvass_prospects").delete().eq("upload_id", u.id);
    if (del.error) { setMsg({ err: del.error.message }); return; }
    await supabase.from("harvest_uploads").delete().eq("id", u.id);
    setMsg({ ok: `Deleted upload${u.list_name ? ` “${u.list_name}”` : ""} — removed ${u.inserted} pin${u.inserted === 1 ? "" : "s"}.` });
    loadUploads();
  }

  const fmt = (iso) => { try { return new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }); } catch { return iso; } };

  return (
    <div style={{ maxWidth: 900, margin: "0 auto", padding: "20px 16px 60px", fontFamily: FONT }}>
      <HarvestNav active="upload" />
      <div style={{ fontSize: 22, fontWeight: 800, fontFamily: OSWALD, marginBottom: 4 }}>📥 Load Leads</div>
      <div style={{ fontSize: 13.5, color: "#64748b", marginBottom: 16 }}>Office-only — reps never see this. Upload leads and mark what type of pin they are.</div>

      {msg && <div style={{ marginBottom: 14, padding: "10px 14px", borderRadius: 10, fontSize: 13.5, fontWeight: 600, background: msg.err ? "#fef2f2" : "#ecfdf5", color: msg.err ? "#b91c1c" : "#065f46", border: `1px solid ${msg.err ? "#fecaca" : "#a7f3d0"}` }}>{msg.err || msg.ok}</div>}

      <UploadForm types={types} onDone={() => { loadUploads(); }} />

      <div style={{ fontSize: 18, fontWeight: 800, fontFamily: OSWALD, margin: "28px 0 8px" }}>Past uploads</div>
      {uploads === null ? <div style={{ color: "#94a3b8", fontSize: 13 }}>Loading…</div>
        : !uploads.length ? <div style={{ color: "#94a3b8", fontSize: 13 }}>No uploads yet.</div>
        : (
          <div style={{ display: "grid", gap: 8 }}>
            {uploads.map((u) => (
              <div key={u.id} style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", border: "1px solid #e5e7eb", borderRadius: 10, padding: "10px 14px", background: "#fff" }}>
                <span style={{ fontSize: 11.5, fontWeight: 800, color: "#fff", background: typeColor(u.default_type), borderRadius: 14, padding: "3px 10px" }}>{typeLabel(u.default_type)}</span>
                <div style={{ fontWeight: 700, fontSize: 14, minWidth: 140 }}>{u.list_name || "(unnamed)"}</div>
                <div style={{ fontSize: 12.5, color: "#64748b" }}>{u.inserted} added{u.updated ? ` · ${u.updated} updated` : ""}{u.skipped ? ` · ${u.skipped} kept` : ""}</div>
                <div style={{ fontSize: 12, color: "#94a3b8" }}>{fmt(u.uploaded_at)}</div>
                <button type="button" onClick={() => deleteUpload(u)} style={{ marginLeft: "auto", fontSize: 12.5, fontWeight: 700, color: "#b91c1c", background: "none", border: "1px solid #fca5a5", borderRadius: 8, padding: "5px 12px", cursor: "pointer" }}>🗑 Delete</button>
              </div>
            ))}
          </div>
        )}
    </div>
  );
}

function UploadForm({ types, onDone }) {
  const [listName, setListName] = useState("");
  const [markType, setMarkType] = useState("iq");
  const [text, setText] = useState("");
  const [fileName, setFileName] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);

  useEffect(() => { if (types.length && !types.find((t) => t.key === markType)) setMarkType(types[0].key); }, [types]); // eslint-disable-line

  const parsed = useMemo(() => parseRows(text, markType, types), [text, markType, types]);
  const typeCounts = useMemo(() => { const c = {}; for (const r of parsed) c[r.type] = (c[r.type] || 0) + 1; return c; }, [parsed]);

  const onFile = (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setFileName(f.name);
    if (!listName.trim()) setListName(f.name.replace(/\.csv$/i, ""));
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
        body: JSON.stringify({ list_name: listName.trim() || undefined, default_type: markType, rows: parsed }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) { setResult({ error: j.error || `Error ${r.status}` }); }
      else { setResult({ ok: true, ...j }); setText(""); setFileName(""); onDone && onDone(); }
    } catch (e) { setResult({ error: e.message || "Network error" }); }
    setBusy(false);
  }

  const S = (k) => (types.find((t) => t.key === k)?.label) || k;

  return (
    <div style={{ border: "1px solid #e5e7eb", borderRadius: 12, padding: 16, background: "#f8fafc" }}>
      {/* Mark this upload as — the primary, deliberate choice (safety) */}
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", marginBottom: 12, background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 10, padding: "10px 12px" }}>
        <span style={{ fontSize: 14, fontWeight: 800, color: "#92400e", fontFamily: OSWALD }}>Mark this upload as:</span>
        {(types || []).map((t) => {
          const on = markType === t.key;
          return (
            <button key={t.key} type="button" onClick={() => setMarkType(t.key)}
              style={{ fontSize: 13, fontWeight: 700, padding: "6px 14px", borderRadius: 16, cursor: "pointer",
                border: on ? `2px solid ${t.color}` : "1px solid #e5e7eb", background: on ? t.color : "#fff", color: on ? "#fff" : "#475569" }}>
              {t.label}
            </button>
          );
        })}
      </div>
      <div style={{ fontSize: 12.5, color: "#64748b", marginBottom: 10 }}>Upload a <b>CSV</b> (or paste). Columns detected: <code>address, city, state, zip, name, type</code>. A <code>type</code> column overrides the mark above per row; otherwise every row uses the mark.</div>

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", marginBottom: 10 }}>
        <input value={listName} onChange={(e) => setListName(e.target.value)} placeholder="List name (e.g. 'Seminole storm St.')"
          style={{ fontSize: 14, padding: "8px 10px", borderRadius: 8, border: "1px solid #cbd5e1", minWidth: 220 }} />
        <label style={{ fontSize: 13, fontWeight: 700, color: "#0e7490", border: "1px solid #0e7490", borderRadius: 8, padding: "7px 12px", cursor: "pointer" }}>
          Choose CSV file
          <input type="file" accept=".csv,text/csv" onChange={onFile} style={{ display: "none" }} />
        </label>
        {fileName ? <span style={{ fontSize: 12, color: "#64748b" }}>{fileName}</span> : null}
      </div>
      <textarea value={text} onChange={(e) => { setText(e.target.value); setFileName(""); }} rows={6}
        placeholder={"address,city,state,zip\n123 Main St,Tampa,FL,33606\n456 Oak Ave,St Petersburg,FL,33701"}
        style={{ width: "100%", padding: "10px 12px", borderRadius: 10, border: "1px solid #cbd5e1", fontSize: 13, fontFamily: "monospace", boxSizing: "border-box", resize: "vertical" }} />
      <div style={{ fontSize: 12, color: "#94a3b8", margin: "6px 0 12px" }}>
        {parsed.length} row{parsed.length === 1 ? "" : "s"} ready{parsed.length ? ` — ${Object.entries(typeCounts).map(([k, n]) => `${n} ${S(k)}`).join(", ")}` : ""}
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

// Parse pasted/CSV text into upload rows. Detects a header; otherwise each line
// is a full address. Resolves a `type` value (key OR label) to a pin-type key.
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
  const mapped = new Set([iA, iC, iS, iZ, iN, iT].filter((i) => i >= 0));
  const rows = [];
  for (let li = 1; li < lines.length; li++) {
    const cols = splitCsv(lines[li]);
    const get = (i) => (i >= 0 ? (cols[i] || "") : "");
    const address = (iA >= 0 ? get(iA) : cols[0]) || "";
    if (!address) continue;
    // Every OTHER column → extra, keyed by its header, so nothing is lost.
    const extra = {};
    for (let c = 0; c < header.length; c++) {
      if (mapped.has(c)) continue;
      const v = (cols[c] || "").trim();
      if (v && header[c]) extra[header[c]] = v;
    }
    rows.push({ address, city: get(iC) || null, state: get(iS) || null, zip: get(iZ) || null, name: get(iN) || null, type: resolveType(get(iT)), extra: Object.keys(extra).length ? extra : undefined });
  }
  return rows;
}
