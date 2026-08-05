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

// Two-level grouping (e.g. zone → rep, or company → PA). Zones sort naturally,
// "Unassigned"/"—" last; second level alphabetical.
function zoneRank(k) { const m = /zone\s*(\d+)/i.exec(k); if (m) return Number(m[1]); if (/^—|unassigned/i.test(k)) return 999; return 500; }
function twoLevel(rows, l1, l2, sort1 = "zone") {
  const g1 = {};
  for (const r of rows) { const a = l1(r) || "—"; (g1[a] = g1[a] || []).push(r); }
  const keys1 = Object.keys(g1).sort((a, b) => sort1 === "zone" ? (zoneRank(a) - zoneRank(b) || a.localeCompare(b)) : ((/^—/.test(a) ? 1 : 0) - (/^—/.test(b) ? 1 : 0) || a.localeCompare(b)));
  return keys1.map((k1) => {
    const g2 = {};
    for (const r of g1[k1]) { const b = l2(r) || "—"; (g2[b] = g2[b] || []).push(r); }
    const keys2 = Object.keys(g2).sort((a, b) => (/^—/.test(a) ? 1 : 0) - (/^—/.test(b) ? 1 : 0) || a.localeCompare(b));
    return { key: k1, count: g1[k1].length, subs: keys2.map((k2) => ({ key: k2, rows: g2[k2] })) };
  });
}
function Grouped({ groups, renderRow, keyFn }) {
  return (
    <div>
      {groups.map((g) => (
        <div key={g.key} style={{ marginBottom: 18 }}>
          <div style={{ fontSize: 14, fontWeight: 900, fontFamily: OSWALD, color: "#0f172a", background: "#eef2f7", borderRadius: 8, padding: "6px 12px", marginBottom: 8 }}>{g.key} · {g.count}</div>
          {g.subs.map((s) => (
            <div key={s.key} style={{ marginBottom: 14, paddingLeft: 4 }}>
              <div style={{ fontSize: 19, fontWeight: 900, fontFamily: OSWALD, color: "#0f172a", margin: "6px 0 7px 2px", display: "flex", alignItems: "baseline", gap: 8 }}>{s.key} <span style={{ fontSize: 13, fontWeight: 800, color: "#94a3b8" }}>({s.rows.length})</span></div>
              <div style={{ display: "grid", gap: 6 }}>{s.rows.map(renderRow)}</div>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

const OUT_COLOR = { signed: "#16a34a", refused: "#b91c1c", pending: "#d97706" };
const OUT_LABEL = { signed: "✅ Signed", refused: "❌ Refused", pending: "⏳ No outcome" };
const RETAIL_COLOR = { ni: "#64748b", btr_appt: "#2563eb", sold: "#16a34a", no_sale: "#b45309", pending: "#94a3b8" };
// Inspection-result display labels (per bossman): Damage → BTPA, Retail → BTR, No Damage → ND.
const GOBACK_LABEL = { damage: "BTPA", retail: "BTR", no_damage: "ND" };
const GOBACK_COLOR = { damage: "#b91c1c", retail: "#0891b2", no_damage: "#64748b" };

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
    ["retail", `BTR (${c.retail})`],
    ["damage", `Damage / PA (${c.damage})`],
    ["pa_passed", `PA Appts Passed (${c.pa_passed})`],
    ["missed", `⚠️ Missed PA (${c.missed_pa})`],
    ["inspectors", `👷 Inspectors (${c.inspectors})`],
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
      {tab === "needs_goback" && <NeedsGoBack rows={data.needs_goback_status} />}
      {tab === "retail" && <Retail retail={data.retail} />}
      {tab === "damage" && <Damage damage={data.damage} />}
      {tab === "pa_passed" && <PaPassed rows={data.pa_passed} />}
      {tab === "missed" && <Missed rows={data.missed_pa} />}
      {tab === "inspectors" && <InspectorActivity rows={data.inspector_activity} />}
    </div>
  );
}

function Overview({ data, onJump }) {
  const c = data.counts;
  const tiles = [
    ["needs_inspection", "🔍", "Need inspecting", c.needs_inspection, "#2563eb"],
    ["needs_goback", "🔁", "Need go-back status", c.needs_goback_status, "#7c3aed"],
    ["retail", "🏠", "BTR deals", c.retail, "#0891b2"],
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
  const renderRow = (r) => (
    <div key={r.id} style={rowCard}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 800, color: "#0f172a" }}>{r.name}</div>
        <div style={{ fontSize: 12.5, color: "#64748b" }}>{[r.address, r.city].filter(Boolean).join(", ")}</div>
      </div>
      <div style={{ textAlign: "right", fontSize: 12.5 }}>
        {cols.map(([key, lbl, fmt]) => (
          <div key={key}><span style={{ color: "#94a3b8" }}>{lbl}: </span><b>{fmt ? fmt(r[key]) : (r[key] || "—")}</b></div>
        ))}
      </div>
    </div>
  );
  return (
    <Section title={`${title} (${rows.length})`} sub={sub}>
      {!rows.length ? <Empty /> : <Grouped groups={twoLevel(rows, (r) => r.zone, (r) => r.rep || "—")} renderRow={renderRow} />}
    </Section>
  );
}

// BTR funnel — TWO stages, so the percentages are honest (per Neal):
//   ① Inspection → Appointment: of the leads WORKED, how many became an appointment
//      vs declined it. (Deals that later sold/no-saled DID reach an appointment.)
//   ② Appointment → Sale: of the appointments that SAT, how many sold.
function RetailBars({ retail }) {
  const b = retail.buckets || {};
  const total = retail.total || 0;
  const g = (k) => Number(b[k] || 0);
  const notWorked = g("pending");
  const worked = Math.max(0, total - notWorked);
  const reached = g("btr_appt") + g("sold") + g("no_sale");   // reached an appointment
  const declined = g("ni");                                    // worked, declined the appointment
  const sat = g("sold") + g("no_sale");                        // appointment actually sat
  const pct = (n, d) => (d > 0 ? Math.round((n / d) * 1000) / 10 : 0);
  const Bar = ({ label, n, d, color }) => (
    <div style={{ marginBottom: 9 }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, fontWeight: 700, color: "#334155", marginBottom: 3 }}>
        <span>{label}</span><span>{n} · {pct(n, d)}%</span>
      </div>
      <div style={{ height: 9, background: "#f1f5f9", borderRadius: 999, overflow: "hidden" }}>
        <div style={{ height: "100%", width: `${d > 0 ? (n / d) * 100 : 0}%`, background: color, borderRadius: 999 }} />
      </div>
    </div>
  );
  const card = { background: "#fff", border: "1px solid #e5e7eb", borderRadius: 14, padding: "16px 18px" };
  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div style={card}>
        <div style={{ fontSize: 15, fontWeight: 800, fontFamily: OSWALD }}>① Inspection → Appointment</div>
        <div style={{ fontSize: 12, color: "#94a3b8", marginBottom: 10 }}>Of <b>{worked}</b> worked retail leads (the go-back). {notWorked} not worked yet.</div>
        <Bar label="Got an appointment" n={reached} d={worked} color="#2563eb" />
        <Bar label="Not interested — declined" n={declined} d={worked} color="#64748b" />
        <div style={{ fontSize: 12, color: "#94a3b8", marginTop: 4 }}>Not worked yet: <b>{notWorked}</b> of {total} total BTR</div>
      </div>
      <div style={card}>
        <div style={{ fontSize: 15, fontWeight: 800, fontFamily: OSWALD }}>② Appointment → Sale</div>
        <div style={{ fontSize: 12, color: "#94a3b8", marginBottom: 10 }}>Of <b>{reached}</b> appointments — {sat} have sat, {g("btr_appt")} still to sit.</div>
        <Bar label="Sold" n={g("sold")} d={sat} color="#16a34a" />
        <Bar label="No sale" n={g("no_sale")} d={sat} color="#b45309" />
        <div style={{ fontSize: 12, color: "#94a3b8", marginTop: 4 }}>Close rate (of {sat} sat): <b style={{ color: "#16a34a" }}>{pct(g("sold"), sat)}%</b> · {g("btr_appt")} still on the calendar</div>
      </div>
    </div>
  );
}

// Inspected — still needs a go-back, split by result with filter buttons (BTPA / BTR / ND).
function NeedsGoBack({ rows }) {
  const [filter, setFilter] = useState("all");
  const order = ["damage", "retail", "no_damage"];
  const counts = {}; order.forEach((k) => { counts[k] = 0; });
  (rows || []).forEach((r) => { if (counts[r.result] != null) counts[r.result]++; });
  const list = filter === "all" ? (rows || []) : (rows || []).filter((r) => r.result === filter);
  const pill = (active, color) => ({
    fontFamily: OSWALD, fontSize: 12.5, fontWeight: 800, padding: "7px 13px", borderRadius: 999, cursor: "pointer",
    border: `2px solid ${color}`, background: active ? color : "#fff", color: active ? "#fff" : color, whiteSpace: "nowrap",
  });
  const row = (r) => (
    <div key={r.id} style={rowCard}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 800 }}>{r.name}</div>
        <div style={{ fontSize: 12.5, color: "#64748b" }}>{[r.address, r.city].filter(Boolean).join(", ")}</div>
      </div>
      <div style={{ textAlign: "right", fontSize: 12 }}>
        <div><span style={{ color: "#94a3b8" }}>Result: </span><b style={{ color: GOBACK_COLOR[r.result] || "#0f172a" }}>{GOBACK_LABEL[r.result] || r.result}</b></div>
        <div><span style={{ color: "#94a3b8" }}>Needs: </span><b>{r.need}</b></div>
      </div>
    </div>
  );
  return (
    <div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 14 }}>
        <button onClick={() => setFilter("all")} style={pill(filter === "all", "#334155")}>All · {(rows || []).length}</button>
        {order.map((k) => (
          <button key={k} onClick={() => setFilter(k)} style={pill(filter === k, GOBACK_COLOR[k])}>{GOBACK_LABEL[k]} · {counts[k]}</button>
        ))}
      </div>
      <Section
        title={`Inspected — still need a go-back status (${list.length})`}
        sub={filter === "all" ? "Result recorded, but the go-back isn't done — BTPA (damage, no PA appt), BTR (retail, not worked), ND (no damage, no referral go-back). Grouped by zone → rep."
          : `Only ${GOBACK_LABEL[filter]} — grouped by zone → rep.`}>
        {!list.length ? <Empty /> : <Grouped groups={twoLevel(list, (r) => r.zone, (r) => r.rep || "—")} renderRow={row} />}
      </Section>
    </div>
  );
}

function Retail({ retail }) {
  const [filter, setFilter] = useState("all");
  const order = ["sold", "btr_appt", "ni", "no_sale", "pending"];
  const labels = retail.labels || {};
  const buckets = retail.buckets || {};
  const deals = filter === "all" ? retail.deals : (retail.deals || []).filter((d) => (d.outcome || "pending") === filter);
  const pill = (active, color) => ({
    fontFamily: OSWALD, fontSize: 12.5, fontWeight: 800, padding: "7px 13px", borderRadius: 999, cursor: "pointer",
    border: `2px solid ${color}`, background: active ? color : "#fff", color: active ? "#fff" : color, whiteSpace: "nowrap",
  });
  const retailRow = (r) => (
    <div key={r.id} style={rowCard}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 800 }}>{r.name}</div>
        <div style={{ fontSize: 12.5, color: "#64748b" }}>{[r.address, r.city].filter(Boolean).join(", ")}</div>
        {r.jn_status && <div style={{ fontSize: 11.5, fontWeight: 800, color: "#0891b2", marginTop: 2 }}>Status: {r.jn_status}</div>}
        {Array.isArray(r.notes) && r.notes.length > 0 && (
          <div style={{ marginTop: 5, borderLeft: "3px solid #e2e8f0", paddingLeft: 8, display: "grid", gap: 3 }}>
            {r.notes.map((n, i) => <div key={i} style={{ fontSize: 12, color: "#475569", lineHeight: 1.4 }}>{n.text}</div>)}
          </div>
        )}
      </div>
      <div style={{ textAlign: "right", fontSize: 12 }}>
        <div><span style={{ color: "#94a3b8" }}>Outcome: </span><b>{r.outcome}</b></div>
        <div><span style={{ color: "#94a3b8" }}>When: </span>{fmtDate(r.outcome_at)}</div>
      </div>
    </div>
  );
  return (
    <div>
      <RetailBars retail={retail} />
      <div style={{ height: 14 }} />
      {/* Outcome filter — press one to narrow the deal list to just those (still grouped zone → rep). */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 14 }}>
        <button onClick={() => setFilter("all")} style={pill(filter === "all", "#334155")}>All · {retail.total}</button>
        {order.filter((k) => buckets[k] != null).map((k) => (
          <button key={k} onClick={() => setFilter(k)} style={pill(filter === k, RETAIL_COLOR[k])}>{labels[k] || k} · {buckets[k]}</button>
        ))}
      </div>
      <Section
        title={`${filter === "all" ? "BTR deals" : (labels[filter] || "BTR deals")} (${deals.length})`}
        sub={filter === "all" ? "Every BTR-track deal — its current JobNimbus status + outcome, grouped by zone → rep." : `Only ${String(labels[filter] || "").toLowerCase()} — each with its current JobNimbus status, grouped by zone → rep.`}>
        {!deals.length ? <Empty /> : <Grouped groups={twoLevel(deals, (r) => r.zone, (r) => r.rep || "—")} renderRow={retailRow} />}
      </Section>
    </div>
  );
}

function Damage({ damage }) {
  const needRow = (r) => (
    <div key={r.id} style={rowCard}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 800 }}>{r.name}</div>
        <div style={{ fontSize: 12.5, color: "#64748b" }}>{[r.address, r.city].filter(Boolean).join(", ")}</div>
        <NotesBlock r={r} />
      </div>
      <div style={{ textAlign: "right", fontSize: 12.5 }}>
        <div>{r.company || r.pa || (r.assigned ? "Assigned" : <span style={{ color: "#b45309", fontWeight: 800 }}>Unassigned</span>)}</div>
      </div>
    </div>
  );
  const haveRow = (r) => (
    <div key={r.id} style={rowCard}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 800 }}>{r.name}</div>
        <div style={{ fontSize: 12.5, color: "#64748b" }}>{[r.address, r.city].filter(Boolean).join(", ")}</div>
        <div style={{ fontSize: 12, color: "#94a3b8" }}>{r.pa || r.company || "PA"}</div>
        <NotesBlock r={r} />
      </div>
      <div style={{ textAlign: "right", fontSize: 12.5 }}>
        <div><b>{fmtDateTime(r.start_at)}</b></div>
        <div style={{ color: "#94a3b8" }}>{r.appt_status}</div>
      </div>
    </div>
  );
  return (
    <div>
      <Section title={`Damage — needs a PA appointment (${damage.needs_appt.length})`} sub="Damage found, no PA appointment booked yet. By zone → rep.">
        {!damage.needs_appt.length ? <Empty /> : <Grouped groups={twoLevel(damage.needs_appt, (r) => r.zone, (r) => r.rep || "—")} renderRow={needRow} />}
      </Section>
      <div style={{ height: 16 }} />
      <Section title={`Damage — has a PA appointment (${damage.with_appt.length})`} sub="Damage deals with a PA appointment on the books. By zone → rep.">
        {!damage.with_appt.length ? <Empty /> : <Grouped groups={twoLevel(damage.with_appt, (r) => r.zone, (r) => r.rep || "—")} renderRow={haveRow} />}
      </Section>
    </div>
  );
}

// The story behind a PA appointment — its pipeline stage + the recent PA notes, so
// the office can see WHY it refused / what "no outcome" actually means, instead of a
// bare verdict. "No notes logged" is itself the answer: nobody recorded what happened.
function NotesBlock({ r }) {
  const cap = (s) => String(s || "").replace(/_/g, " ");
  const notes = Array.isArray(r.notes) ? r.notes : [];
  return (
    <>
      {typeof r.signed === "boolean" && (
        <div style={{ fontSize: 12, fontWeight: 800, marginTop: 3, color: r.signed ? "#16a34a" : "#9a3412" }}>
          {r.signed ? "✅ Signed PA paperwork" : "❌ No PA paperwork signed — reschedule candidate"}
        </div>
      )}
      {r.stage && <div style={{ fontSize: 11.5, fontWeight: 800, color: "#7c3aed", marginTop: 3, textTransform: "capitalize" }}>PA stage: {cap(r.stage)}</div>}
      {notes.length > 0 ? (
        <div style={{ marginTop: 5, borderLeft: "3px solid #e2e8f0", paddingLeft: 8, display: "grid", gap: 3 }}>
          {notes.map((n, i) => (
            <div key={i} style={{ fontSize: 12, color: "#475569", lineHeight: 1.4 }}>
              {n.stage && <b style={{ color: "#94a3b8", fontWeight: 800 }}>[{cap(n.stage)}] </b>}{n.text}
            </div>
          ))}
        </div>
      ) : (
        <div style={{ fontSize: 11.5, color: "#cbd5e1", marginTop: 4, fontStyle: "italic" }}>No notes logged — no record of what happened.</div>
      )}
    </>
  );
}

function PaPassed({ rows }) {
  const renderRow = (r) => (
    <div key={r.appt_id} style={rowCard}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 800 }}>{r.name} <span style={{ fontSize: 12, fontWeight: 800, color: OUT_COLOR[r.outcome] }}>· {OUT_LABEL[r.outcome]}</span></div>
        <div style={{ fontSize: 12.5, color: "#64748b" }}>{[r.address, r.city].filter(Boolean).join(", ")}</div>
        {r.rep && <div style={{ fontSize: 12, color: "#94a3b8" }}>rep {r.rep}</div>}
        <NotesBlock r={r} />
      </div>
      <div style={{ textAlign: "right", fontSize: 12 }}>
        <div><span style={{ color: "#94a3b8" }}>Appt: </span><b>{fmtDateTime(r.start_at)}</b></div>
        <div><span style={{ color: "#94a3b8" }}>Booked: </span>{fmtDate(r.booked_at)}</div>
        <div><span style={{ color: "#94a3b8" }}>Filed: </span>{fmtDate(r.filed_at)}</div>
        <div style={{ color: "#94a3b8" }}>appt: {r.appt_status}</div>
      </div>
    </div>
  );
  return (
    <Section title={`PA appointments that have passed (${rows.length})`} sub="Whose date is in the past — grouped by company → PA. Outcome, when the claim was filed, and when it was booked.">
      {!rows.length ? <Empty /> : <Grouped groups={twoLevel(rows, (r) => r.company || "No company", (r) => r.pa || "—", "alpha")} renderRow={renderRow} />}
    </Section>
  );
}

function Missed({ rows }) {
  const renderRow = (r) => (
    <div key={r.appt_id} style={{ ...rowCard, borderColor: "#fecaca", background: "#fff7f7" }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 800 }}>{r.name}</div>
        <div style={{ fontSize: 12.5, color: "#64748b" }}>{[r.address, r.city].filter(Boolean).join(", ")}</div>
        <div style={{ fontSize: 12, color: "#94a3b8" }}>{r.phone ? r.phone : ""}{r.rep ? `${r.phone ? " · " : ""}rep ${r.rep}` : ""}</div>
        <NotesBlock r={r} />
      </div>
      <div style={{ textAlign: "right", fontSize: 12 }}>
        <div style={{ color: "#b91c1c", fontWeight: 800 }}>Missed {fmtDateTime(r.start_at)}</div>
        <div style={{ color: "#94a3b8" }}>booked {fmtDate(r.booked_at)}</div>
      </div>
    </div>
  );
  return (
    <Section title={`⚠️ Missed PA appointments (${rows.length})`} sub="Passed with no outcome — the homeowner likely no-showed. Grouped by company → PA. These need a re-book or a fresh scheduling link.">
      {!rows.length ? <Empty msg="No missed PA appointments — nice." /> : <Grouped groups={twoLevel(rows, (r) => r.company || "No company", (r) => r.pa || "—", "alpha")} renderRow={renderRow} />}
    </Section>
  );
}

const fmtDayLong = (d) => { try { return new Date(d + "T12:00:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" }); } catch { return d; } };
function InspectorActivity({ rows }) {
  const [open, setOpen] = useState(null); // "inspector|date"
  const [openInsp, setOpenInsp] = useState(null); // which inspector is expanded
  if (!rows || !rows.length) return <Empty msg="No inspector activity yet." />;
  return (
    <Section title={`Inspector activity (${rows.length})`} sub="Tap an inspector to see their days, then a day for the roofs + miles between each. Miles are estimated (shortest route through the day's roofs). On-roof times come with the inspector map.">
      <div style={{ display: "grid", gap: 10 }}>
        {rows.map((insp) => {
          const inspOpen = openInsp === insp.inspector;
          return (
          <div key={insp.inspector}>
            <button onClick={() => setOpenInsp(inspOpen ? null : insp.inspector)}
              style={{ width: "100%", textAlign: "left", cursor: "pointer", background: inspOpen ? "#0f172a" : "#eef2f7", border: "none", borderRadius: 12, padding: "12px 16px", display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <span style={{ fontSize: 18, fontWeight: 900, fontFamily: OSWALD, color: inspOpen ? "#fff" : "#0f172a" }}>👷 {insp.inspector}</span>
              <span style={{ fontSize: 13, fontWeight: 800, color: inspOpen ? "#cbd5e1" : "#64748b" }}>{insp.roofs} roofs · {insp.days} days · ~{insp.miles} mi</span>
              <span style={{ marginLeft: "auto", fontSize: 14, color: inspOpen ? "#fff" : "#94a3b8" }}>{inspOpen ? "▲" : "▼"}</span>
            </button>
            {inspOpen && (
            <div style={{ display: "grid", gap: 6, marginTop: 6 }}>
              {insp.day_list.map((d) => {
                const key = insp.inspector + "|" + d.date;
                const isOpen = open === key;
                return (
                  <div key={key} style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12, overflow: "hidden" }}>
                    <button onClick={() => setOpen(isOpen ? null : key)} style={{ width: "100%", textAlign: "left", background: "none", border: "none", padding: "12px 14px", cursor: "pointer", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
                      <span style={{ fontWeight: 800 }}>{fmtDayLong(d.date)}</span>
                      <span style={{ fontSize: 13, color: "#334155" }}><b>{d.roofs}</b> roof{d.roofs === 1 ? "" : "s"} · <b>~{d.miles} mi</b> {isOpen ? "▲" : "▼"}</span>
                    </button>
                    {isOpen && (
                      <div style={{ borderTop: "1px solid #f1f5f9", padding: "10px 14px", background: "#f8fafc" }}>
                        {d.stops.map((s, i) => (
                          <div key={i}>
                            <div style={{ display: "flex", gap: 8, fontSize: 13.5 }}>
                              <span style={{ color: "#94a3b8", fontWeight: 800, minWidth: 18 }}>{i + 1}.</span>
                              <span><b>{s.name}</b> — {[s.address, s.city].filter(Boolean).join(", ")} <span style={{ color: "#94a3b8" }}>({s.result})</span></span>
                            </div>
                            {i < d.legs.length && <div style={{ fontSize: 12, color: "#0891b2", margin: "2px 0 2px 26px" }}>↓ {d.legs[i].miles} mi</div>}
                          </div>
                        ))}
                        <div style={{ marginTop: 8, fontSize: 12.5, color: "#64748b", fontWeight: 700 }}>Total ~{d.miles} mi (estimated route){d.missing_geo > 0 ? ` · ${d.missing_geo} roof${d.missing_geo === 1 ? "" : "s"} not geocoded — miles partial` : ""}</div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            )}
          </div>
          );
        })}
      </div>
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
