// Inspector map links (?mode=inspectorlinks). Office-only. Each active inspector's
// personal Inspection Map link (?mode=inspectmap&it=<map_token>) to hand out.
import React, { useEffect, useMemo, useState } from "react";
import { supabase } from "./lib/supabase";

const FONT = "'Nunito', system-ui, sans-serif";
const OSWALD = "'Oswald', sans-serif";

export default function InspectorLinks() {
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState("");
  const [copied, setCopied] = useState("");
  const base = useMemo(() => { try { return window.location.origin; } catch { return ""; } }, []);

  useEffect(() => {
    supabase.from("inspectors").select("id,name,map_token,active,info_updated_at").order("name")
      .then(({ data, error }) => {
        if (error) { setErr(error.message); return; }
        setRows((data || []).filter((r) => r.map_token));
      }, (e) => setErr(e.message || "Network error"));
  }, []);

  const copy = (text, id) => { try { navigator.clipboard.writeText(text); setCopied(id); setTimeout(() => setCopied(""), 1500); } catch { window.prompt("Copy this link:", text); } };
  const link = (r) => `${base}/?mode=inspectmap&it=${r.map_token}`;

  if (err) return <div style={{ padding: 30, fontFamily: FONT, color: "#b91c1c" }}>{err}</div>;

  const active = (rows || []).filter((r) => r.active !== false && r.info_updated_at);
  const setup = (rows || []).filter((r) => r.active !== false && !r.info_updated_at);
  const inactive = (rows || []).filter((r) => r.active === false);

  const Card = ({ r, tag }) => (
    <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", border: "1px solid #e5e7eb", borderRadius: 10, padding: "9px 12px", background: "#fff" }}>
      {tag && <span style={{ fontSize: 10, fontWeight: 800, textTransform: "uppercase", background: tag.bg, color: tag.color, padding: "2px 8px", borderRadius: 10 }}>{tag.label}</span>}
      <span style={{ fontSize: 14, fontWeight: 700 }}>{r.name}</span>
      <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
        <a href={link(r)} target="_blank" rel="noreferrer" style={{ fontSize: 12.5, fontWeight: 700, color: "#0e7490", textDecoration: "none" }}>Open ↗</a>
        <button type="button" onClick={() => copy(link(r), r.id)} style={btn}>{copied === r.id ? "✓ Copied" : "Copy link"}</button>
      </div>
    </div>
  );

  return (
    <div style={{ maxWidth: 760, margin: "0 auto", padding: "20px 16px 60px", fontFamily: FONT }}>
      <div style={{ fontSize: 22, fontWeight: 800, fontFamily: OSWALD, marginBottom: 4 }}>🔍 Inspector Map Links</div>
      <div style={{ fontSize: 13.5, color: "#64748b", marginBottom: 16 }}>Each inspector opens their <b>personal link</b> to see the roofs needing inspection and route their day. Boxing a route hides those roofs from other inspectors.</div>
      {!rows ? <div style={{ color: "#94a3b8" }}>Loading…</div> : (
        <>
          <div style={{ fontSize: 15, fontWeight: 800, fontFamily: OSWALD, margin: "8px 0" }}>Active inspectors ({active.length})</div>
          <div style={{ display: "grid", gap: 6 }}>{active.map((r) => <Card key={r.id} r={r} />)}</div>
          {setup.length > 0 && <>
            <div style={{ fontSize: 15, fontWeight: 800, fontFamily: OSWALD, margin: "18px 0 8px" }}>Still finishing setup ({setup.length})</div>
            <div style={{ display: "grid", gap: 6 }}>{setup.map((r) => <Card key={r.id} r={r} tag={{ label: "setup", bg: "#fffbeb", color: "#b45309" }} />)}</div>
          </>}
          {inactive.length > 0 && <>
            <div style={{ fontSize: 15, fontWeight: 800, fontFamily: OSWALD, margin: "18px 0 8px", color: "#94a3b8" }}>Inactive ({inactive.length})</div>
            <div style={{ display: "grid", gap: 6, opacity: 0.7 }}>{inactive.map((r) => <Card key={r.id} r={r} tag={{ label: "inactive", bg: "#f1f5f9", color: "#94a3b8" }} />)}</div>
          </>}
        </>
      )}
    </div>
  );
}
const btn = { fontSize: 12.5, fontWeight: 700, color: "#334155", background: "#fff", border: "1px solid #cbd5e1", borderRadius: 8, padding: "6px 12px", cursor: "pointer" };
