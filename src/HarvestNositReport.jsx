// Harvesting Map — "No Sit- Need to Reschedule" creator report (?mode=harvestnositreport).
// Office-only. Who CREATED each No-Sit job in JobNimbus — grouped by creator, with a
// per-job detail list + CSV export.
import React, { useEffect, useMemo, useState } from "react";
import HarvestNav from "./HarvestNav";

const FONT = "'Nunito', system-ui, sans-serif";
const OSWALD = "'Oswald', sans-serif";
const FN = "/.netlify/functions/harvest-nosit-creators";
const fmtDate = (ms) => (ms ? new Date(ms).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" }) : "—");

export default function HarvestNositReport() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(true);
  const [pick, setPick] = useState(null); // creator name filtered in the detail list

  useEffect(() => {
    let live = true;
    fetch(FN).then((r) => r.json())
      .then((j) => { if (!live) return; if (!j.ok) { setErr(j.error || "Could not load."); } else setData(j); })
      .catch(() => { if (live) setErr("Network error."); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, []);

  const max = data?.creators?.[0]?.count || 1;
  const jobs = useMemo(() => (data?.jobs || []).filter((j) => !pick || j.creator === pick), [data, pick]);

  const downloadCsv = () => {
    if (!data) return;
    const esc = (v) => { const s = String(v ?? ""); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    const rows = [["Creator", "Customer", "Address", "Sales Rep", "Created", "Appt Date"]];
    for (const j of data.jobs) rows.push([j.creator, j.customer, j.address, j.sales_rep, fmtDate(j.created_ms), fmtDate(j.appt_ms)]);
    const csv = rows.map((r) => r.map(esc).join(",")).join("\n");
    const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    a.download = "no-sit-creators.csv"; a.click();
  };

  return (
    <div style={{ fontFamily: FONT, background: "#f1f5f9", minHeight: "100vh" }}>
      <HarvestNav active="nosit" />
      <div style={{ maxWidth: 980, margin: "0 auto", padding: "18px 16px 60px" }}>
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
          <h1 style={{ fontFamily: OSWALD, fontSize: 24, fontWeight: 800, margin: "6px 0 2px" }}>🔄 No-Sit Creators</h1>
          {data && <button type="button" onClick={downloadCsv} style={{ fontSize: 13, fontWeight: 700, padding: "8px 14px", borderRadius: 8, border: "1px solid #cbd5e1", background: "#fff", color: "#334155", cursor: "pointer" }}>⬇ CSV</button>}
        </div>
        <p style={{ color: "#475569", fontSize: 14.5, lineHeight: 1.5, marginTop: 4 }}>
          Who <b>created</b> each “No Sit- Need to Reschedule” job in JobNimbus. {loading ? "" : <b>{data?.total || 0} jobs</b>} total.
        </p>

        {loading && <p style={{ color: "#64748b", fontSize: 14, marginTop: 12 }}>Pulling no-sit jobs from JobNimbus… (a few seconds)</p>}
        {err && <p style={{ color: "#dc2626", fontSize: 14, marginTop: 12 }}>{err}</p>}

        {data && (
          <div style={{ display: "grid", gridTemplateColumns: "minmax(240px, 340px) 1fr", gap: 16, marginTop: 14, alignItems: "start" }}>
            {/* Creator breakdown */}
            <div style={{ background: "#fff", border: "1px solid #e2e8f0", borderRadius: 12, padding: 14 }}>
              <div style={{ fontSize: 12, fontWeight: 800, textTransform: "uppercase", letterSpacing: ".05em", color: "#94a3b8", marginBottom: 8 }}>By creator</div>
              {pick && <button type="button" onClick={() => setPick(null)} style={{ fontSize: 12, fontWeight: 700, color: "#1d4ed8", background: "none", border: "none", cursor: "pointer", padding: 0, marginBottom: 8 }}>← Show all creators</button>}
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {data.creators.map((c) => (
                  <button key={c.name} type="button" onClick={() => setPick(pick === c.name ? null : c.name)}
                    style={{ textAlign: "left", background: pick === c.name ? "#eef2ff" : "transparent", border: "1px solid", borderColor: pick === c.name ? "#c7d2fe" : "transparent", borderRadius: 8, padding: "6px 8px", cursor: "pointer" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13.5 }}>
                      <span style={{ fontWeight: 700, color: "#0f172a" }}>{c.name}</span>
                      <span style={{ fontWeight: 800, color: "#334155" }}>{c.count}</span>
                    </div>
                    <div style={{ height: 6, background: "#f1f5f9", borderRadius: 999, marginTop: 3, overflow: "hidden" }}>
                      <div style={{ height: "100%", width: `${Math.round((c.count / max) * 100)}%`, background: "#4f46e5", borderRadius: 999 }} />
                    </div>
                  </button>
                ))}
              </div>
            </div>

            {/* Detail list */}
            <div style={{ background: "#fff", border: "1px solid #e2e8f0", borderRadius: 12, padding: 14 }}>
              <div style={{ fontSize: 12, fontWeight: 800, textTransform: "uppercase", letterSpacing: ".05em", color: "#94a3b8", marginBottom: 8 }}>
                {pick ? `${pick}'s no-sits` : "All no-sits"} ({jobs.length})
              </div>
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
                  <thead>
                    <tr style={{ textAlign: "left", color: "#64748b", fontSize: 11, textTransform: "uppercase", letterSpacing: ".04em" }}>
                      {!pick && <th style={{ padding: "5px 6px" }}>Creator</th>}
                      <th style={{ padding: "5px 6px" }}>Customer</th>
                      <th style={{ padding: "5px 6px" }}>Address</th>
                      <th style={{ padding: "5px 6px" }}>Sales rep</th>
                      <th style={{ padding: "5px 6px", whiteSpace: "nowrap" }}>Created</th>
                    </tr>
                  </thead>
                  <tbody>
                    {jobs.slice(0, 600).map((j, i) => (
                      <tr key={i} style={{ borderTop: "1px solid #eef2f7" }}>
                        {!pick && <td style={{ padding: "6px", fontWeight: 700, color: "#4338ca", whiteSpace: "nowrap" }}>{j.creator}</td>}
                        <td style={{ padding: "6px", fontWeight: 600 }}>{j.customer}</td>
                        <td style={{ padding: "6px", color: "#64748b" }}>{j.address}</td>
                        <td style={{ padding: "6px", color: "#64748b", whiteSpace: "nowrap" }}>{j.sales_rep || "—"}</td>
                        <td style={{ padding: "6px", color: "#94a3b8", whiteSpace: "nowrap" }}>{fmtDate(j.created_ms)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {jobs.length > 600 && <p style={{ fontSize: 12, color: "#94a3b8", marginTop: 8 }}>Showing first 600 — use CSV for the full list.</p>}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
