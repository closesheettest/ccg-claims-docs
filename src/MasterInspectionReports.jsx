// Master Inspection Reports (?mode=masterinspreport) — the whole free-roof-inspection
// pipeline on one page: what still needs inspecting, what's inspected but has no
// go-back status yet, the retail breakdown with percentages, damage deals with/without
// a PA appointment, and every PA appointment that has passed (with outcome, PA/company,
// and when it was filed) — plus a MISSED PA appointments block up top.
import React, { useCallback, useEffect, useMemo, useState } from "react";

const FONT = "'Nunito', system-ui, sans-serif";
const OSWALD = "'Oswald', sans-serif";
const fmtDate = (iso) => { if (!iso) return "—"; try { return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "America/New_York" }); } catch { return "—"; } };
const fmtDateTime = (iso) => { if (!iso) return "—"; try { return new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/New_York" }); } catch { return "—"; } };

const OUT_COLOR = { signed: "#16a34a", refused: "#b91c1c", pending: "#d97706" };
const OUT_LABEL = { signed: "✅ Signed", refused: "❌ Refused", pending: "⏳ No outcome" };
const RETAIL_COLOR = { ni: "#64748b", btr_appt: "#2563eb", sold: "#16a34a", no_sale: "#b45309", pending: "#94a3b8" };

export default function MasterInspectionReports() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState("");
  const [tab, setTab] = useState("overview");

  const load = useCallback(() => {
    setErr("");
    fetch("/.netlify/functions/master-inspection-report")
      .then((r) => r.json())
      .then((j) => { if (j.ok) setData(j); else setErr(j.error || "Failed to load"); })
      .catch((e) => setErr(e.message || "Network error"));
  }, []);
  useEffect(() => { load(); }, [load]);

  if (err) return <Splash title="Couldn't load the report" msg={err} />;
  if (!data) return <Splash msg="Building the master inspection report…" plain />;

  const c = data.counts;
  const TABS = [
    ["overview", "Overview"],
    ["needs_inspection", `Needs Inspecting (${c.needs_inspection})`],
    ["needs_goback", `Needs Go-Back Status (${c.needs_goback_status})`],
    ["retail", `Retail (${c.retail})`],
    ["damage", `Damage / PA (${c.damage})`],
    ["pa_passed", `PA Appts Passed (${c.pa_passed})`],
    ["missed", `⚠️ Missed PA (${c.missed_pa})`],
  ];

  return (
    <div style={{ maxWidth: 1000, margin: "0 auto", padding: "20px 16px 80px", fontFamily: FONT }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
        <div style={{ fontSize: 25, fontWeight: 900, fontFamily: OSWALD }}>📑 Master Inspection Reports</div>
        <button onClick={load} style={btn("#0f172a")}>↻ Refresh</button>
      </div>
      <div style={{ fontSize: 12.5, color: "#94a3b8", marginBottom: 14 }}>Generated {fmtDateTime(data.generated_at)} · live from the pipeline</div>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 18 }}>
        {TABS.map(([k, l]) => (
          <button key={k} onClick={() => setTab(k)}
            style={{ fontSize: 13, fontWeight: 800, padding: "8px 13px", borderRadius: 999, cursor: "pointer", fontFamily: OSWALD,
              border: tab === k ? "2px solid #0a0a0a" : "1px solid #cbd5e1", background: tab === k ? "#0a0a0a" : "#fff",
              color: k === "missed" && c.missed_pa > 0 && tab !== k ? "#b91c1c" : tab === k ? "#fff" : "#475569" }}>{l}</button>
        ))}
      </div>

      {tab === "overview" && <Overview data={data} onJump={setTab} />}
      {tab === "needs_inspection" && <DealList title="Still need to be inspected" sub="Signed jobs with no inspection completed yet." rows={data.needs_inspection} cols={[["signed_at", "Signed", fmtDate], ["inspector", "Inspector"]]} />}
      {tab === "needs_goback" && <DealList title="Inspected — still need a go-back status" sub="Roof was inspected but no result (Damage / No Damage / Retail) recorded yet." rows={data.needs_goback_status} cols={[["inspection_date", "Inspected", fmtDate], ["inspector", "Inspector"], ["status", "JN status"]]} />}
      {tab === "retail" && <Retail retail={data.retail} />}
      {tab === "damage" && <Damage damage={data.damage} />}
      {tab === "pa_passed" && <PaPassed rows={data.pa_passed} />}
      {tab === "missed" && <Missed rows={data.missed_pa} />}
    </div>
  );
}

function Overview({ data, onJump }) {
  const c = data.counts;
  const tiles = [
    ["needs_inspection", "🔍", "Need inspecting", c.needs_inspection, "#2563eb"],
    ["needs_goback", "🔁", "Need go-back status", c.needs_goback_status, "#7c3aed"],
    ["retail", "🏠", "Retail deals", c.retail, "#0891b2"],
    ["damage", "⚡", "Damage deals", c.damage, "#ca8a04"],
    ["damage", "📅", "Damage w/ PA appt", c.damage_with_appt, "#16a34a"],
    ["damage", "📌", "Damage need PA appt", c.damage_needs_appt, "#b45309"],
    ["pa_passed", "🕓", "PA appts passed", c.pa_passed, "#334155"],
    ["missed", "⚠️", "MISSED PA appts", c.missed_pa, "#b91c1c"],
  ];
  return (
    <div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(150px,1fr))", gap: 12 }}>
        {tiles.map(([jump, emoji, label, n, color], i) => (
          <button key={i} onClick={() => onJump(jump)} style={{ textAlign: "left", background: "#fff", border: "1px solid #e5e7eb", borderRadius: 14, padding: "14px 16px", cursor: "pointer" }}>
            <div style={{ fontSize: 22 }}>{emoji}</div>
            <div style={{ fontSize: 30, fontWeight: 900, fontFamily: OSWALD, color }}>{n}</div>
            <div style={{ fontSize: 12.5, color: "#64748b", fontWeight: 700 }}>{label}</div>
          </button>
        ))}
      </div>
      <div style={{ marginTop: 20 }}><RetailBars retail={data.retail} compact /></div>
    </div>
  );
}

function Section({ title, sub, children }) {
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ fontSize: 18, fontWeight: 800, fontFamily: OSWALD }}>{title}</div>
      {sub && <div style={{ fontSize: 12.5, color: "#94a3b8", margin: "2px 0 12px" }}>{sub}</div>}
      {children}
    </div>
  );
}

function DealList({ title, sub, rows, cols = [] }) {
  return (
    <Section title={`${title} (${rows.length})`} sub={sub}>
      {!rows.length ? <Empty /> : (
        <div style={{ display: "grid", gap: 8 }}>
          {rows.map((r) => (
            <div key={r.id} style={rowCard}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 800, color: "#0f172a" }}>{r.name}</div>
                <div style={{ fontSize: 12.5, color: "#64748b" }}>{[r.address, r.city].filter(Boolean).join(", ")}</div>
                <div style={{ fontSize: 12, color: "#94a3b8" }}>{r.rep ? `Rep: ${r.rep}` : ""}{r.county ? ` · ${r.county}` : ""}</div>
              </div>
              <div style={{ textAlign: "right", fontSize: 12.5 }}>
                {cols.map(([key, lbl, fmt]) => (
                  <div key={key}><span style={{ color: "#94a3b8" }}>{lbl}: </span><b>{fmt ? fmt(r[key]) : (r[key] || "—")}</b></div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </Section>
  );
}

function RetailBars({ retail, compact }) {
  const order = ["sold", "btr_appt", "ni", "no_sale", "pending"];
  const total = retail.total || 1;
  return (
    <div style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 14, padding: "16px 18px" }}>
      <div style={{ fontSize: 15, fontWeight: 800, fontFamily: OSWALD, marginBottom: 10 }}>Retail breakdown — {retail.total} deals</div>
      {order.map((k) => (
        <div key={k} style={{ marginBottom: 9 }}>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, fontWeight: 700, color: "#334155", marginBottom: 3 }}>
            <span>{retail.labels[k]}</span><span>{retail.buckets[k]} · {retail.pct[k]}%</span>
          </div>
          <div style={{ height: 9, background: "#f1f5f9", borderRadius: 999, overflow: "hidden" }}>
            <div style={{ height: "100%", width: `${(retail.buckets[k] / total) * 100}%`, background: RETAIL_COLOR[k], borderRadius: 999 }} />
          </div>
        </div>
      ))}
    </div>
  );
}

function Retail({ retail }) {
  return (
    <div>
      <RetailBars retail={retail} />
      <div style={{ height: 14 }} />
      <DealList title="Retail deals" sub="Every retail-track deal and its current outcome." rows={retail.deals}
        cols={[["outcome", "Outcome"], ["outcome_at", "When", fmtDate]]} />
    </div>
  );
}

function Damage({ damage }) {
  return (
    <div>
      <Section title={`Damage — needs a PA appointment (${damage.needs_appt.length})`} sub="Damage found, no PA appointment booked yet.">
        {!damage.needs_appt.length ? <Empty /> : (
          <div style={{ display: "grid", gap: 8 }}>
            {damage.needs_appt.map((r) => (
              <div key={r.id} style={rowCard}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 800 }}>{r.name}</div>
                  <div style={{ fontSize: 12.5, color: "#64748b" }}>{[r.address, r.city].filter(Boolean).join(", ")}</div>
                </div>
                <div style={{ textAlign: "right", fontSize: 12.5 }}>
                  <div>{r.company || r.pa || (r.assigned ? "Assigned" : <span style={{ color: "#b45309", fontWeight: 800 }}>Unassigned</span>)}</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </Section>
      <div style={{ height: 16 }} />
      <Section title={`Damage — has a PA appointment (${damage.with_appt.length})`} sub="Damage deals with a PA appointment on the books.">
        {!damage.with_appt.length ? <Empty /> : (
          <div style={{ display: "grid", gap: 8 }}>
            {damage.with_appt.map((r) => (
              <div key={r.id} style={rowCard}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 800 }}>{r.name}</div>
                  <div style={{ fontSize: 12.5, color: "#64748b" }}>{[r.address, r.city].filter(Boolean).join(", ")}</div>
                  <div style={{ fontSize: 12, color: "#94a3b8" }}>{r.pa || r.company || "PA"}</div>
                </div>
                <div style={{ textAlign: "right", fontSize: 12.5 }}>
                  <div><b>{fmtDateTime(r.start_at)}</b></div>
                  <div style={{ color: "#94a3b8" }}>{r.appt_status}</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </Section>
    </div>
  );
}

function PaPassed({ rows }) {
  return (
    <Section title={`PA appointments that have passed (${rows.length})`} sub="Every PA appointment whose date is in the past — outcome, which PA/company, when the claim was filed, and when it was booked.">
      {!rows.length ? <Empty /> : (
        <div style={{ display: "grid", gap: 8 }}>
          {rows.map((r) => (
            <div key={r.appt_id} style={rowCard}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 800 }}>{r.name} <span style={{ fontSize: 12, fontWeight: 800, color: OUT_COLOR[r.outcome] }}>· {OUT_LABEL[r.outcome]}</span></div>
                <div style={{ fontSize: 12.5, color: "#64748b" }}>{r.address}</div>
                <div style={{ fontSize: 12, color: "#94a3b8" }}>{[r.pa, r.company].filter(Boolean).join(" · ") || "PA —"}{r.rep ? ` · rep ${r.rep}` : ""}</div>
              </div>
              <div style={{ textAlign: "right", fontSize: 12 }}>
                <div><span style={{ color: "#94a3b8" }}>Appt: </span><b>{fmtDateTime(r.start_at)}</b></div>
                <div><span style={{ color: "#94a3b8" }}>Booked: </span>{fmtDate(r.booked_at)}</div>
                <div><span style={{ color: "#94a3b8" }}>Filed: </span>{fmtDate(r.filed_at)}</div>
                <div style={{ color: "#94a3b8" }}>appt: {r.appt_status}</div>
              </div>
            </div>
          ))}
        </div>
      )}
    </Section>
  );
}

function Missed({ rows }) {
  return (
    <Section title={`⚠️ Missed PA appointments (${rows.length})`} sub="The appointment date passed with no outcome recorded — the homeowner likely no-showed. These need a re-book or a fresh scheduling link.">
      {!rows.length ? <Empty msg="No missed PA appointments — nice." /> : (
        <div style={{ display: "grid", gap: 8 }}>
          {rows.map((r) => (
            <div key={r.appt_id} style={{ ...rowCard, borderColor: "#fecaca", background: "#fff7f7" }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 800 }}>{r.name}</div>
                <div style={{ fontSize: 12.5, color: "#64748b" }}>{r.address}</div>
                <div style={{ fontSize: 12, color: "#94a3b8" }}>{[r.pa, r.company].filter(Boolean).join(" · ") || "PA —"}{r.phone ? ` · ${r.phone}` : ""}{r.rep ? ` · rep ${r.rep}` : ""}</div>
              </div>
              <div style={{ textAlign: "right", fontSize: 12 }}>
                <div style={{ color: "#b91c1c", fontWeight: 800 }}>Missed {fmtDateTime(r.start_at)}</div>
                <div style={{ color: "#94a3b8" }}>booked {fmtDate(r.booked_at)}</div>
              </div>
            </div>
          ))}
        </div>
      )}
    </Section>
  );
}

const rowCard = { display: "flex", gap: 12, alignItems: "flex-start", justifyContent: "space-between", background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12, padding: "12px 14px" };
function Empty({ msg }) { return <div style={{ color: "#94a3b8", padding: 24, textAlign: "center", background: "#f8fafc", borderRadius: 12, fontSize: 14 }}>{msg || "Nothing here right now."}</div>; }
function btn(bg) { return { background: bg, color: "#fff", border: "none", borderRadius: 10, padding: "9px 15px", fontSize: 13.5, fontWeight: 800, fontFamily: OSWALD, cursor: "pointer" }; }
function Splash({ title, msg, plain }) {
  if (plain) return <div style={{ position: "fixed", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: FONT, background: "#f1f5f9", color: "#94a3b8", fontWeight: 700 }}>{msg}</div>;
  return (
    <div style={{ position: "fixed", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: FONT, background: "#f1f5f9", padding: 24 }}>
      <div style={{ maxWidth: 380, textAlign: "center", background: "#fff", borderRadius: 16, padding: "30px 24px" }}>
        <div style={{ fontSize: 40, marginBottom: 6 }}>📑</div>
        <div style={{ fontSize: 19, fontWeight: 800, fontFamily: OSWALD }}>{title}</div>
        <div style={{ fontSize: 14, color: "#475569", marginTop: 8 }}>{msg}</div>
      </div>
    </div>
  );
}
