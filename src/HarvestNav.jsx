// Shared top nav for the Harvesting admin pages — jump between Map / Load Leads
// / Rep Links / Pin Types from anywhere. `active` = the current page's key.
import React from "react";
import { supabase } from "./lib/supabase";

const TABS = [
  { key: "map", label: "🗺️ Map", office: true },
  { key: "upload", label: "📥 Load Leads", href: "/?mode=harvestupload" },
  { key: "links", label: "🔗 Rep Links", href: "/?mode=harvestlinks" },
  { key: "types", label: "🎛️ Pin Types", href: "/?mode=harvestadmin" },
  { key: "jnsync", label: "🔄 JN Sync", href: "/?mode=harvestjnsync" },
  { key: "report", label: "📊 Reports", href: "/?mode=harvestreport" },
  { key: "training", label: "🎓 Training", href: "/?mode=harvesttrainingadmin" },
  { key: "repcard", label: "🧹 RepCard", href: "/?mode=harvestrepcardimport" },
  { key: "plannedday", label: "🧭 Planned Day", href: "/?mode=harvestplannedday" },
  { key: "skiptrace", label: "📇 Skip-Trace", href: "/?mode=harvestskiptrace" },
];

export default function HarvestNav({ active }) {
  const openMap = async () => {
    try {
      const { data } = await supabase.from("app_settings").select("value").eq("key", "harvest_admin_token").maybeSingle();
      const tok = data?.value;
      window.open(tok ? `/?mode=harvest&admin=${encodeURIComponent(tok)}` : "/?mode=harvestlinks", "_blank", "noopener");
    } catch { window.open("/?mode=harvestlinks", "_blank", "noopener"); }
  };
  const style = (on) => ({
    fontSize: 13, fontWeight: 700, fontFamily: "'Oswald', sans-serif", letterSpacing: "0.02em",
    textDecoration: "none", cursor: "pointer", padding: "8px 14px", borderRadius: 10,
    border: on ? "2px solid #0a0a0a" : "2px solid #e5e7eb",
    background: on ? "#0a0a0a" : "#fff", color: on ? "#fff" : "#374151", display: "inline-block",
  });
  return (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", borderBottom: "2px solid #e5e7eb", paddingBottom: 12, marginBottom: 16 }}>
      <span style={{ fontSize: 18, fontWeight: 800, fontFamily: "'Oswald', sans-serif", alignSelf: "center", marginRight: 6 }}>🌾 Harvesting</span>
      {TABS.map((t) => (t.office
        ? <button key={t.key} type="button" onClick={openMap} style={style(false)}>{t.label} ↗</button>
        : <a key={t.key} href={t.href} style={style(t.key === active)}>{t.label}</a>
      ))}
    </div>
  );
}
