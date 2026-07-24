// DoorDispatcher — office lead upload (?mode=harvestupload). Its own page,
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

      {/* RepCard status scrub — lives here because it's another way to load/update lead statuses. */}
      <a href="/?mode=harvestrepcardimport" style={{ display: "flex", alignItems: "center", gap: 12, textDecoration: "none", border: "1px solid #e5e7eb", borderRadius: 12, padding: "12px 16px", background: "#fff", marginBottom: 16 }}>
        <span style={{ fontSize: 22 }}>🧹</span>
        <span style={{ flex: 1 }}>
          <span style={{ display: "block", fontSize: 14.5, fontWeight: 800, color: "#0f172a", fontFamily: OSWALD }}>Import RepCard statuses</span>
          <span style={{ display: "block", fontSize: 12.5, color: "#64748b" }}>Upload RepCard CSVs (Pending / NI / NQ / Dead / No Sale) to scrub map pin statuses so reps don’t re-knock worked doors.</span>
        </span>
        <span style={{ fontSize: 13, fontWeight: 800, color: "#4f46e5" }}>Open →</span>
      </a>

      {msg &&<div style={{ marginBottom: 14, padding: "10px 14px", borderRadius: 10, fontSize: 13.5, fontWeight: 600, background: msg.err ? "#fef2f2" : "#ecfdf5", color: msg.err ? "#b91c1c" : "#065f46", border: `1px solid ${msg.err ? "#fecaca" : "#a7f3d0"}` }}>{msg.err || msg.ok}</div>}

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
  const [mapping, setMapping] = useState({});
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(null); // { done, total } while chunk-uploading
  const [result, setResult] = useState(null);

  useEffect(() => { if (types.length && !types.find((t) => t.key === markType)) setMarkType(types[0].key); }, [types]); // eslint-disable-line

  const table = useMemo(() => parseTable(text), [text]);
  const headers = table.headers;

  useEffect(() => {
    if (!headers.length) { setMapping({}); return; }
    setMapping({
      address: guessCol(headers, ["address", "street address", "street", "address1", "addr", "property address", "mailing address"]),
      name: guessCol(headers, ["first name", "contact first name", "firstname", "name", "full name", "homeowner", "owner"]),
      last_name: guessCol(headers, ["last name", "contact last name", "lastname", "surname"]),
      phone: guessCol(headers, ["phone", "mobile", "cell", "phone number", "mobile phone"]),
      email: guessCol(headers, ["email", "e-mail", "email address"]),
      city: guessCol(headers, ["city", "town"]),
      state: guessCol(headers, ["state", "st"]),
      zip: guessCol(headers, ["zip", "zipcode", "zip code", "postal", "postal code"]),
      latitude: guessCol(headers, ["latitude", "lat", "y"]),
      longitude: guessCol(headers, ["longitude", "long", "lng", "lon", "x"]),
      type: guessCol(headers, ["pin type", "pintype", "pin_type"]), // NOT generic "type" cols like "Contact Type"
    });
  }, [text]); // eslint-disable-line

  const rows = useMemo(() => buildRows(table, mapping, markType, types), [table, mapping, markType, types]);

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
    if (!rows.length) return;
    setBusy(true); setResult(null); setProgress(null);
    const post = (payload) => fetch("/.netlify/functions/canvass-upload", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
    }).then((r) => r.json().catch(() => ({ ok: false, error: `Error ${r.status}` })));
    try {
      const list = listName.trim() || undefined;
      // Small enough single upload → one call (keeps the fast path).
      if (rows.length <= 200) {
        const j = await post({ list_name: list, default_type: markType, rows });
        if (!j.ok) setResult({ error: j.error || "Upload failed" });
        else { setResult({ ok: true, ...j }); setText(""); setFileName(""); onDone && onDone(); }
        setBusy(false); return;
      }
      // Big list → chunk it: each batch geocodes + inserts a slice, tagged with a
      // shared upload_id, then one finalize call logs the upload.
      const uploadId = (crypto?.randomUUID?.() || String(Math.random()).slice(2) + Date.now());
      const BATCH = 150;
      const agg = { inserted: 0, updated: 0, skipped: 0, geocoded: 0, failed: 0, errors: 0 };
      const total = Math.ceil(rows.length / BATCH);
      setProgress({ done: 0, total });
      for (let i = 0, b = 0; i < rows.length; i += BATCH, b++) {
        const j = await post({ upload_id: uploadId, list_name: list, default_type: markType, rows: rows.slice(i, i + BATCH) });
        if (j.ok) { agg.inserted += j.inserted || 0; agg.updated += j.updated || 0; agg.skipped += j.skipped || 0; agg.geocoded += j.geocoded || 0; agg.failed += j.failed || 0; }
        else agg.errors += 1;
        setProgress({ done: b + 1, total });
      }
      await post({ finalize: true, upload_id: uploadId, list_name: list, default_type: markType, inserted: agg.inserted, updated: agg.updated, skipped: agg.skipped });
      setResult({ ok: true, ...agg });
      setText(""); setFileName(""); onDone && onDone();
    } catch (e) { setResult({ error: e.message || "Network error" }); }
    setProgress(null); setBusy(false);
  }

  const FIELDS = [
    { key: "address", label: "Street address", req: true },
    { key: "name", label: "First name" },
    { key: "last_name", label: "Last name" },
    { key: "phone", label: "Phone" },
    { key: "email", label: "Email" },
    { key: "city", label: "City" },
    { key: "state", label: "State" },
    { key: "zip", label: "ZIP" },
    { key: "latitude", label: "Latitude", hint: "already have coords? map these to skip geocoding" },
    { key: "longitude", label: "Longitude" },
    { key: "type", label: "Pin type (per row)" },
  ];
  const preview = rows.slice(0, 3);

  return (
    <div style={{ border: "1px solid #e5e7eb", borderRadius: 12, padding: 16, background: "#f8fafc" }}>
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

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", marginBottom: 10 }}>
        <input value={listName} onChange={(e) => setListName(e.target.value)} placeholder="List name (e.g. 'Seminole storm St.')"
          style={{ fontSize: 14, padding: "8px 10px", borderRadius: 8, border: "1px solid #cbd5e1", minWidth: 220 }} />
        <label style={{ fontSize: 13, fontWeight: 700, color: "#0e7490", border: "1px solid #0e7490", borderRadius: 8, padding: "7px 12px", cursor: "pointer" }}>
          Choose CSV file
          <input type="file" accept=".csv,text/csv" onChange={onFile} style={{ display: "none" }} />
        </label>
        {fileName ? <span style={{ fontSize: 12, color: "#64748b" }}>{fileName}</span> : null}
      </div>
      <textarea value={text} onChange={(e) => { setText(e.target.value); setFileName(""); }} rows={5}
        placeholder={"Paste CSV rows (include a header row) or choose a file above."}
        style={{ width: "100%", padding: "10px 12px", borderRadius: 10, border: "1px solid #cbd5e1", fontSize: 13, fontFamily: "monospace", boxSizing: "border-box", resize: "vertical" }} />

      {headers.length ? (
        <div style={{ marginTop: 14 }}>
          <div style={{ fontSize: 14, fontWeight: 800, fontFamily: OSWALD, marginBottom: 8 }}>Map your columns</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(210px, 1fr))", gap: 10 }}>
            {FIELDS.map((f) => (
              <label key={f.key} style={{ fontSize: 12.5, color: "#475569", display: "flex", flexDirection: "column", gap: 4 }}>
                <span style={{ fontWeight: 700 }}>{f.label}{f.req ? " *" : ""}</span>
                <select value={mapping[f.key] ?? -1} onChange={(e) => setMapping((m) => ({ ...m, [f.key]: Number(e.target.value) }))}
                  style={{ fontSize: 13, padding: "7px 8px", borderRadius: 8, border: "1px solid " + (f.req && (mapping[f.key] ?? -1) < 0 ? "#fca5a5" : "#cbd5e1"), background: "#fff" }}>
                  <option value={-1}>— none —</option>
                  {headers.map((h, i) => <option key={i} value={i}>{h}</option>)}
                </select>
              </label>
            ))}
          </div>
          <div style={{ fontSize: 12, color: "#94a3b8", marginTop: 8 }}>Any column you don't map is still saved and shown on the pin.</div>

          {preview.length ? (
            <div style={{ marginTop: 12, overflowX: "auto" }}>
              <div style={{ fontSize: 11.5, fontWeight: 700, color: "#64748b", marginBottom: 4 }}>PREVIEW (first {preview.length})</div>
              <table style={{ borderCollapse: "collapse", fontSize: 12 }}>
                <thead><tr>{["Address", "Name", "Phone", "Email", "City/ST/ZIP", "Type"].map((h) => <th key={h} style={cell(true)}>{h}</th>)}</tr></thead>
                <tbody>
                  {preview.map((r, i) => (
                    <tr key={i}>
                      <td style={cell()}>{r.address || <em style={{ color: "#ef4444" }}>missing</em>}</td>
                      <td style={cell()}>{r.name || "—"}</td>
                      <td style={cell()}>{r.phone || "—"}</td>
                      <td style={cell()}>{r.email || "—"}</td>
                      <td style={cell()}>{[r.city, r.state, r.zip].filter(Boolean).join(", ") || "—"}</td>
                      <td style={cell()}>{(types.find((t) => t.key === r.type) || {}).label || r.type}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </div>
      ) : null}

      <div style={{ fontSize: 12, color: "#94a3b8", margin: "10px 0 12px" }}>{rows.length} row{rows.length === 1 ? "" : "s"} ready</div>
      {result && result.error && <div style={{ color: "#b91c1c", fontSize: 13, marginBottom: 10 }}>{result.error}</div>}
      {result && result.ok && (
        <div style={{ background: "#ecfdf5", border: "1px solid #a7f3d0", borderRadius: 10, padding: "10px 12px", fontSize: 13, color: "#065f46", marginBottom: 10 }}>
          ✓ {result.inserted} new{result.updated ? ", " + result.updated + " updated" : ""}{result.skipped ? ", " + result.skipped + " kept (dedup)" : ""} — {result.geocoded} geocoded{result.failed ? ", " + result.failed + " failed" : ""}{result.errors ? ` · ⚠ ${result.errors} batch${result.errors === 1 ? "" : "es"} errored` : ""}.
        </div>
      )}
      {busy && progress && (
        <div style={{ marginBottom: 10 }}>
          <div style={{ fontSize: 12.5, color: "#475569", marginBottom: 4 }}>Geocoding batch {progress.done} of {progress.total}… (leave this tab open)</div>
          <div style={{ height: 8, borderRadius: 4, background: "#e5e7eb", overflow: "hidden" }}>
            <div style={{ height: "100%", width: `${Math.round((progress.done / progress.total) * 100)}%`, background: "#2563eb", transition: "width .2s" }} />
          </div>
        </div>
      )}
      <button type="button" onClick={submit} disabled={busy || !rows.length}
        style={{ padding: "10px 20px", borderRadius: 10, border: "none", background: "#2563eb", color: "#fff", fontWeight: 800, fontSize: 14, fontFamily: OSWALD, cursor: "pointer", opacity: busy || !rows.length ? 0.6 : 1 }}>
        {busy ? (progress ? `Uploading ${progress.done}/${progress.total}…` : "Geocoding…") : "Upload & geocode " + (rows.length || "")}
      </button>
    </div>
  );
}

const cell = (head) => ({ border: "1px solid #e5e7eb", padding: "5px 8px", textAlign: "left", whiteSpace: "nowrap", maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", background: head ? "#f8fafc" : "#fff", fontWeight: head ? 700 : 500, color: head ? "#64748b" : "#334155" });

function splitCsvLine(line) {
  const out = []; let cur = "", q = false;
  for (const c of line) {
    if (c === '"') { q = !q; continue; }
    if (c === "," && !q) { out.push(cur); cur = ""; continue; }
    cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}
function parseTable(text) {
  const lines = String(text || "").split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return { headers: [], rows: [] };
  return { headers: splitCsvLine(lines[0]), rows: lines.slice(1).map(splitCsvLine) };
}
function guessCol(headers, names) {
  const norm = (s) => String(s || "").toLowerCase().trim();
  let i = headers.findIndex((h) => names.includes(norm(h)));
  if (i < 0) i = headers.findIndex((h) => names.some((n) => norm(h).includes(n)));
  return i;
}
function buildRows(table, mapping, defaultType, types) {
  const { headers, rows } = table;
  if (!headers.length) return [];
  const resolveType = (raw) => {
    const v = String(raw || "").trim().toLowerCase();
    if (!v) return defaultType;
    const t = (types || []).find((x) => x.key.toLowerCase() === v || (x.label || "").toLowerCase() === v);
    return t ? t.key : defaultType;
  };
  const usedIdx = new Set(Object.values(mapping).filter((i) => i >= 0));
  const get = (cols, key) => { const i = mapping[key]; return i >= 0 ? (cols[i] || "").trim() : ""; };
  const num = (v) => { const n = parseFloat(String(v).replace(/[^\d.\-]/g, "")); return Number.isFinite(n) ? n : null; };
  const out = [];
  for (const cols of rows) {
    const address = get(cols, "address");
    const latitude = num(get(cols, "latitude"));
    const longitude = num(get(cols, "longitude"));
    const hasCoords = latitude != null && longitude != null;
    if (!address && !hasCoords) continue; // need an address to geocode, OR ready coords
    const extra = {};
    headers.forEach((h, i) => { if (!usedIdx.has(i) && (cols[i] || "").trim() && h) extra[h] = cols[i].trim(); });
    out.push({
      address: address || `${latitude}, ${longitude}`,
      name: [get(cols, "name"), get(cols, "last_name")].filter(Boolean).join(" ") || null,
      phone: get(cols, "phone") || null,
      email: get(cols, "email") || null,
      city: get(cols, "city") || null,
      state: get(cols, "state") || null,
      zip: get(cols, "zip") || null,
      latitude: hasCoords ? latitude : undefined,
      longitude: hasCoords ? longitude : undefined,
      type: resolveType(get(cols, "type")),
      extra: Object.keys(extra).length ? extra : undefined,
    });
  }
  return out;
}
