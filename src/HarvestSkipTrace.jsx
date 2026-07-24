// DoorDispatcher — Owner Skip-Trace (?mode=harvestskiptrace). Office-only.
// Non-owner-occupied (rental) doors reps marked with an X already have the owner's
// NAME + MAILING ADDRESS captured for free (from the parcel). PHONE isn't in public
// records — it needs a paid skip-trace / data-append provider. This page is the
// control panel: how many properties are queued, and the provider options + pricing.
// Not active until a provider is wired (an API key + per-lookup cost).
import React, { useEffect, useState } from "react";
import { supabase } from "./lib/supabase";
import HarvestNav from "./HarvestNav";

const FONT = "'Nunito', system-ui, sans-serif";
const OSWALD = "'Oswald', sans-serif";

// Skip-trace / data-append providers that turn owner name + mailing address into a
// phone. Pricing is APPROXIMATE (per successful lookup) and changes — confirm with the
// provider. "API" = can be run as an automated offline batch (vs manual CSV upload).
const PROVIDERS = [
  { name: "BatchData (BatchSkipTracing)", price: "~$0.07–0.15", api: true, rec: true, note: "Real-estate skip trace; bulk-friendly REST API. Common in roofing/investor use.", url: "https://batchdata.com" },
  { name: "REISkip", price: "~$0.05–0.12", api: true, note: "Low-cost bulk skip trace built for investors.", url: "https://reiskip.com" },
  { name: "Endato (PeopleConnect)", price: "~$0.10–0.25", api: true, note: "Reverse-address / identity data API (name+address → phone).", url: "https://endato.com" },
  { name: "Melissa", price: "~$0.03–0.20", api: true, note: "Property + phone append; strong data-quality focus.", url: "https://melissa.com" },
  { name: "Skip Genie", price: "~$0.10–0.18", api: false, note: "Popular investor tool; mostly CSV upload, limited API.", url: "https://skipgenie.com" },
  { name: "LexisNexis (TLOxp) / IDI", price: "Enterprise (gated)", api: true, note: "Highest match quality; requires vetting/permissible-use approval.", url: "https://tloxp.com" },
];

export default function HarvestSkipTrace() {
  const [count, setCount] = useState(null);
  const [enriched, setEnriched] = useState(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    supabase.from("canvass_prospects").select("id", { count: "exact", head: true }).eq("status", "non_owner")
      .then(({ count }) => setCount(count ?? 0)).catch(() => setCount(0));
    // Once a provider is wired, enriched rows will carry extra.owner_phone.
    supabase.from("canvass_prospects").select("id", { count: "exact", head: true }).eq("status", "non_owner").not("extra->>owner_phone", "is", null)
      .then(({ count }) => setEnriched(count ?? 0)).catch(() => setEnriched(0));
  }, []);

  return (
    <div style={{ fontFamily: FONT, background: "#f1f5f9", minHeight: "100vh" }}>
      <HarvestNav active="skiptrace" />
      <div style={{ maxWidth: 860, margin: "0 auto", padding: "18px 16px 60px" }}>
        <h1 style={{ fontFamily: OSWALD, fontSize: 24, fontWeight: 800, margin: "6px 0 2px" }}>📇 Owner Skip-Trace</h1>
        <p style={{ color: "#475569", fontSize: 14.5, lineHeight: 1.5, marginTop: 4 }}>
          Non-owner-occupied (rental) doors your reps marked with an <b>X</b> already have the owner's <b>name + mailing address</b> saved (free, from the parcel). The owner's <b>phone</b> isn't in public records — it takes a paid <b>skip-trace</b> run. Pick a provider below to turn these into a callable/mailable internal marketing list. This runs as a separate offline batch, so it never slows the map.
        </p>

        {/* Count + status */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginTop: 14 }}>
          <div style={{ background: "#fff", border: "1px solid #e2e8f0", borderRadius: 12, padding: "16px 18px" }}>
            <div style={{ fontSize: 12, fontWeight: 800, textTransform: "uppercase", letterSpacing: ".05em", color: "#94a3b8" }}>Properties captured</div>
            <div style={{ fontSize: 34, fontWeight: 900, fontFamily: OSWALD, color: "#0f172a", lineHeight: 1.1, marginTop: 4 }}>{count === null ? "…" : count.toLocaleString()}</div>
            <div style={{ fontSize: 12.5, color: "#64748b", marginTop: 2 }}>non-owner doors with owner + mailing saved</div>
          </div>
          <div style={{ background: "#fff", border: "1px solid #e2e8f0", borderRadius: 12, padding: "16px 18px" }}>
            <div style={{ fontSize: 12, fontWeight: 800, textTransform: "uppercase", letterSpacing: ".05em", color: "#94a3b8" }}>Phones appended</div>
            <div style={{ fontSize: 34, fontWeight: 900, fontFamily: OSWALD, color: "#0f172a", lineHeight: 1.1, marginTop: 4 }}>{enriched === null ? "…" : enriched.toLocaleString()}</div>
            <div style={{ fontSize: 12.5, color: "#64748b", marginTop: 2 }}>once a provider is wired</div>
          </div>
        </div>

        {/* The button — not active yet */}
        <button type="button" onClick={() => setOpen((o) => !o)}
          style={{ width: "100%", marginTop: 14, display: "flex", alignItems: "center", gap: 12, background: "#fff7ed", border: "1px solid #fed7aa", borderRadius: 12, padding: "14px 16px", cursor: "pointer", textAlign: "left" }}>
          <span style={{ fontSize: 22 }}>⚠️</span>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 15, fontWeight: 800, color: "#9a3412" }}>Skip-trace is not active — needs a provider</div>
            <div style={{ fontSize: 12.5, color: "#b45309", marginTop: 2 }}>No phone provider is connected yet. Tap to compare options and pricing, then pick one.</div>
          </div>
          <span style={{ fontSize: 13, fontWeight: 800, color: "#9a3412" }}>{open ? "Hide options ▲" : "See options ▾"}</span>
        </button>

        {/* Provider options + pricing */}
        {open && (
          <div style={{ background: "#fff", border: "1px solid #e2e8f0", borderRadius: 12, padding: 16, marginTop: 12 }}>
            <div style={{ fontFamily: OSWALD, fontWeight: 800, fontSize: 16, marginBottom: 4 }}>Provider options</div>
            <div style={{ fontSize: 12, color: "#94a3b8", marginBottom: 12 }}>Pricing is approximate, per successful match, and changes — confirm with the provider. "Batch API" = can run automatically over your list; others may need a CSV upload.</div>
            <div style={{ display: "grid", gap: 10 }}>
              {PROVIDERS.map((p) => (
                <div key={p.name} style={{ border: `1px solid ${p.rec ? "#86efac" : "#e2e8f0"}`, background: p.rec ? "#f0fdf4" : "#fff", borderRadius: 10, padding: "12px 14px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <span style={{ fontSize: 14.5, fontWeight: 800, color: "#0f172a" }}>{p.name}</span>
                    {p.rec && <span style={{ fontSize: 10.5, fontWeight: 800, color: "#166534", background: "#dcfce7", padding: "2px 7px", borderRadius: 8, textTransform: "uppercase", letterSpacing: ".03em" }}>Recommended</span>}
                    <span style={{ fontSize: 11, fontWeight: 700, color: p.api ? "#1e40af" : "#64748b", background: p.api ? "#e0edff" : "#f1f5f9", padding: "2px 7px", borderRadius: 8 }}>{p.api ? "Batch API" : "CSV upload"}</span>
                    <span style={{ marginLeft: "auto", fontSize: 14, fontWeight: 900, fontFamily: OSWALD, color: "#0f172a" }}>{p.price}<span style={{ fontSize: 11, fontWeight: 600, color: "#94a3b8" }}> / lookup</span></span>
                  </div>
                  <div style={{ fontSize: 12.5, color: "#475569", marginTop: 5 }}>{p.note}</div>
                  <div style={{ marginTop: 8, display: "flex", gap: 10, alignItems: "center" }}>
                    <a href={p.url} target="_blank" rel="noreferrer" style={{ fontSize: 12.5, fontWeight: 700, color: "#1d4ed8", textDecoration: "none" }}>Visit ↗</a>
                    <span style={{ fontSize: 11.5, color: "#94a3b8" }}>·</span>
                    <span style={{ fontSize: 12, color: "#94a3b8" }}>Pick one, get an API key, and I'll wire the batch run.</span>
                  </div>
                </div>
              ))}
            </div>
            {count !== null && count > 0 && (
              <div style={{ marginTop: 12, fontSize: 12.5, color: "#475569", background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 10, padding: "10px 12px" }}>
                💡 A one-time run of your <b>{count.toLocaleString()}</b> captured {count === 1 ? "property" : "properties"} would cost roughly <b>${(count * 0.07).toFixed(2)}–${(count * 0.20).toFixed(2)}</b> depending on the provider and match rate.
              </div>
            )}
          </div>
        )}
        <p style={{ fontSize: 12, color: "#94a3b8", marginTop: 14 }}>Office-only. When you choose a provider and add its API key, I'll build the offline batch that appends phones to these records for internal marketing.</p>
      </div>
    </div>
  );
}
