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
const RETAIL_COLOR = { ni: "#64748b", btr_appt: "#2563eb", sold: "#16a34a", credit_denial: "#0891b2", no_sale: "#b45309", pending: "#94a3b8" };
// Inspection-result display labels (per bossman): Damage → BTPA, Retail → BTR, No Damage → ND.
const GOBACK_LABEL = { damage: "BTPA", retail: "BTR", no_damage: "ND" };
const GOBACK_COLOR = { damage: "#b91c1c", retail: "#0891b2", no_damage: "#64748b" };
// BTPA lifecycle buckets — the filter buttons on the BTPA tab.
const BTPA_BUCKETS = [
  { key: "need_appt", label: "Needs appointment", color: "#b45309" },
  { key: "missed", label: "Needs reschedule", color: "#b91c1c" },
  { key: "upcoming", label: "Upcoming", color: "#2563eb" },
  { key: "signed", label: "Signed", color: "#16a34a" },
  { key: "dead", label: "Dead / Not interested", color: "#64748b" },
];
const BTPA_META = Object.fromEntries(BTPA_BUCKETS.map((b) => [b.key, b]));
// The real BTR pipeline stages, from live JobNimbus status.
const STAGE_LABEL = { not_worked: "Not worked yet", declined: "Declined", no_sit: "No-sit / no-show", appt_scheduled: "Appointment set", sit_pending: "Sit-Pending (working)", no_sale: "No sale", credit_denial: "Credit denial", sold: "Sold", lost: "Lost / dead" };
const STAGE_COLOR = { not_worked: "#94a3b8", declined: "#64748b", no_sit: "#a16207", appt_scheduled: "#2563eb", sit_pending: "#7c3aed", no_sale: "#b45309", credit_denial: "#0891b2", sold: "#16a34a", lost: "#9ca3af" };

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
    ["damage", `BTPA (${c.damage})`],
    ["inspectors", `👷 Inspectors (${c.inspectors})`],
  ];

  return (
    <div style={{ maxWidth: 1000, margin: "0 auto", padding: "20px 16px 80px", fontFamily: FONT }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
        <div style={{ fontSize: 25, fontWeight: 900, fontFamily: OSWALD }}>📑 Master Inspection Reports</div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <a href="/?mode=pareschedcompose" style={{ ...btn("#7c3aed"), textDecoration: "none" }}>✉️ Message for PA Appointment</a>
          <button onClick={load} style={btn("#0f172a")}>↻ Refresh</button>
        </div>
      </div>
      <div style={{ fontSize: 12.5, color: "#94a3b8", marginBottom: 14 }}>Generated {fmtDateTime(data.generated_at)} · live from the pipeline</div>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 18 }}>
        {TABS.map(([k, l]) => (
          <button key={k} onClick={() => setTab(k)}
            style={{ fontSize: 13, fontWeight: 800, padding: "8px 13px", borderRadius: 999, cursor: "pointer", fontFamily: OSWALD,
              border: tab === k ? "2px solid #0a0a0a" : "1px solid #cbd5e1", background: tab === k ? "#0a0a0a" : "#fff",
              color: tab === k ? "#fff" : "#475569" }}>{l}</button>
        ))}
      </div>

      {tab === "overview" && <Overview data={data} onJump={setTab} />}
      {tab === "needs_inspection" && <DealList title="Still need to be inspected" sub="Signed jobs with no inspection completed yet." rows={data.needs_inspection} cols={[["signed_at", "Signed", fmtDate], ["inspector", "Inspector"]]} />}
      {tab === "needs_goback" && <NeedsGoBack rows={data.needs_goback_status} />}
      {tab === "retail" && <Retail retail={data.retail} />}
      {tab === "damage" && <Damage damage={data.damage} />}
      {tab === "inspectors" && <InspectorActivity rows={data.inspector_activity} />}
    </div>
  );
}

function Overview({ data, onJump }) {
  const c = data.counts;
  const ndCount = (data.needs_goback_status || []).filter((r) => r.result === "no_damage").length;
  const tiles = [
    ["needs_inspection", "🔍", "Need inspecting", c.needs_inspection, "#2563eb"],
    ["needs_goback", "🔁", "Need go-back status", c.needs_goback_status, "#7c3aed"],
    ["retail", "🏠", "BTR", c.retail, GOBACK_COLOR.retail],
    ["damage", "🏚️", "BTPA", c.damage, GOBACK_COLOR.damage],
    ["needs_goback", "✅", "ND", ndCount, GOBACK_COLOR.no_damage],
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
  const p = retail.pipeline || {};
  const total = retail.total || 0;
  const g = (k) => Number(p[k] || 0);
  const lost = g("lost");
  const notWorked = g("not_worked");
  const active = Math.max(0, total - lost);                    // exclude dead deals from the funnel
  const worked = Math.max(0, active - notWorked);              // worked = active minus not-yet-worked
  const reached = g("appt_scheduled") + g("sit_pending") + g("no_sale") + g("credit_denial") + g("sold"); // got an appointment
  const declined = g("declined");
  const noSit = g("no_sit");                                   // set an appt but didn't sit
  const sat = g("sit_pending") + g("no_sale") + g("credit_denial") + g("sold");   // actually sat down
  const resulted = g("no_sale") + g("credit_denial") + g("sold");                 // sat AND has a result
  const grossSold = g("sold") + g("credit_denial");            // credit denial = SOLD, couldn't finance
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
        <div style={{ fontSize: 12, color: "#94a3b8", marginBottom: 10 }}>Of <b>{worked}</b> worked leads (excludes {notWorked} not-worked &amp; {lost} lost/dead).</div>
        <Bar label="Got an appointment" n={reached} d={worked} color={STAGE_COLOR.appt_scheduled} />
        <Bar label="No-sit / no-show" n={noSit} d={worked} color={STAGE_COLOR.no_sit} />
        <Bar label="Declined" n={declined} d={worked} color={STAGE_COLOR.declined} />
        <div style={{ fontSize: 12, color: "#94a3b8", marginTop: 4 }}>Not worked yet: <b>{notWorked}</b> · Lost/dead: <b>{lost}</b> · of {total} total BTR</div>
      </div>
      <div style={card}>
        <div style={{ fontSize: 15, fontWeight: 800, fontFamily: OSWALD }}>② Appointment → Sale</div>
        <div style={{ fontSize: 12, color: "#94a3b8", marginBottom: 10 }}>Of <b>{reached}</b> appointments — <b>{resulted}</b> resolved. Close rates are off the resolved ones (pending is still live, so it's not a loss).</div>
        <Bar label="Sold" n={g("sold")} d={resulted} color={STAGE_COLOR.sold} />
        {g("credit_denial") > 0 && <Bar label="Credit denial — sold, couldn't finance" n={g("credit_denial")} d={resulted} color={STAGE_COLOR.credit_denial} />}
        <Bar label="Not interested (no sale)" n={g("no_sale")} d={resulted} color={STAGE_COLOR.no_sale} />
        <div style={{ fontSize: 12, color: "#334155", marginTop: 6, lineHeight: 1.7 }}>
          Net close (funded — sold ÷ {resulted} resolved): <b style={{ color: STAGE_COLOR.sold }}>{pct(g("sold"), resulted)}%</b><br />
          Gross close (incl. {g("credit_denial")} credit denial{g("credit_denial") === 1 ? "" : "s"}): <b style={{ color: STAGE_COLOR.credit_denial }}>{pct(grossSold, resulted)}%</b>
        </div>
        {(g("sit_pending") > 0 || g("appt_scheduled") > 0) && (
          <div style={{ marginTop: 10, padding: "8px 11px", background: "#faf5ff", border: "1px solid #e9d5ff", borderRadius: 10, fontSize: 12.5, color: "#6b21a8", lineHeight: 1.6 }}>
            🟣 <b>Pending — still live: {g("sit_pending")}</b> (sat, still being worked — NOT counted as a loss){g("appt_scheduled") > 0 ? <> · <b>{g("appt_scheduled")}</b> still to sit</> : null}
          </div>
        )}
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
        {r.visits > 0 && (
          <div style={{ fontSize: 11.5, fontWeight: 800, color: "#0891b2", marginTop: 3 }}>
            🚪 Rep went {r.visits}× — nobody home{r.last_visit ? ` · last ${fmtDate(r.last_visit)}` : ""}
          </div>
        )}
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
  const order = ["sold", "credit_denial", "no_sale", "sit_pending", "appt_scheduled", "no_sit", "declined", "not_worked", "lost"];
  const pipe = retail.pipeline || {};
  const deals = filter === "all" ? retail.deals : (retail.deals || []).filter((d) => d.stage === filter);
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
        <div><b style={{ color: STAGE_COLOR[r.stage] || "#0f172a" }}>{STAGE_LABEL[r.stage] || r.stage}</b></div>
        {r.outcome_at && <div style={{ color: "#94a3b8" }}>{fmtDate(r.outcome_at)}</div>}
      </div>
    </div>
  );
  return (
    <div>
      <RetailBars retail={retail} />
      <div style={{ height: 14 }} />
      {/* Pipeline-stage filter — press one to narrow the deal list to just that stage (grouped zone → rep). */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 14 }}>
        <button onClick={() => setFilter("all")} style={pill(filter === "all", "#334155")}>All · {retail.total}</button>
        {order.filter((k) => (pipe[k] || 0) > 0).map((k) => (
          <button key={k} onClick={() => setFilter(k)} style={pill(filter === k, STAGE_COLOR[k])}>{STAGE_LABEL[k]} · {pipe[k]}</button>
        ))}
      </div>
      <Section
        title={`${filter === "all" ? "BTR deals" : STAGE_LABEL[filter]} (${deals.length})`}
        sub={filter === "all" ? "Every BTR-track deal — its real pipeline stage from live JobNimbus status, grouped by zone → rep." : `Only ${String(STAGE_LABEL[filter] || "").toLowerCase()} — grouped by zone → rep.`}>
        {!deals.length ? <Empty /> : <Grouped groups={twoLevel(deals, (r) => r.zone, (r) => r.rep || "—")} renderRow={retailRow} />}
      </Section>
    </div>
  );
}

function Damage({ damage }) {
  const [filter, setFilter] = useState("all");
  const all = damage.all || [];
  const counts = damage.buckets || {};
  const deals = filter === "all" ? all : all.filter((d) => d.bucket === filter);
  const pill = (active, color) => ({
    fontFamily: OSWALD, fontSize: 12.5, fontWeight: 800, padding: "7px 13px", borderRadius: 999, cursor: "pointer",
    border: `2px solid ${color}`, background: active ? color : "#fff", color: active ? "#fff" : color, whiteSpace: "nowrap",
  });
  const meta = (k) => BTPA_META[k] || { label: k, color: "#64748b" };
  const row = (r) => (
    <div key={r.id} style={rowCard}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 800 }}>{r.name}</div>
        <div style={{ fontSize: 12.5, color: "#64748b" }}>{[r.address, r.city].filter(Boolean).join(", ")}</div>
        {(r.company || r.pa) ? (
          <div style={{ fontSize: 12, color: "#0e7490", fontWeight: 700 }}>
            {r.company ? `🏢 ${r.company}` : "🧑‍💼 PA"}{r.pa ? ` · ${r.pa}` : ""}
          </div>
        ) : r.bucket === "need_appt" ? (
          <div style={{ fontSize: 12, color: "#94a3b8" }}>{r.assigned ? "Assigned — no appt yet" : "Unassigned"}</div>
        ) : null}
        <NotesBlock r={r} needsAppt={r.bucket === "need_appt"} />
      </div>
      <div style={{ textAlign: "right", fontSize: 12 }}>
        <div><b style={{ color: meta(r.bucket).color }}>{meta(r.bucket).label}</b></div>
        {r.bucket === "signed" ? (
          (r.signed_at || r.start_at) && <div style={{ color: "#16a34a", fontWeight: 700 }}>Signed {fmtDate(r.signed_at || r.start_at)}</div>
        ) : (
          <>
            {r.start_at && <div style={{ color: "#94a3b8" }}>{fmtDateTime(r.start_at)}</div>}
            {r.appt_status && <div style={{ color: "#94a3b8" }}>{r.appt_status}</div>}
          </>
        )}
      </div>
    </div>
  );
  return (
    <div>
      <div style={{ background: "#f8fafc", border: "1px solid #e5e7eb", borderRadius: 10, padding: "9px 12px", fontSize: 12.5, color: "#475569", marginBottom: 12 }}>
        Every BTPA (damage) deal, sorted by where it is with the Public Adjuster. Tap a button to see just that group — grouped by zone → rep.
      </div>
      {/* BTPA lifecycle filter — need appt / missed / signed / no idea. */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 14 }}>
        <button onClick={() => setFilter("all")} style={pill(filter === "all", "#334155")}>All BTPA · {all.length}</button>
        {BTPA_BUCKETS.map((b) => (
          <button key={b.key} onClick={() => setFilter(b.key)} style={pill(filter === b.key, b.color)}>{b.label} · {counts[b.key] || 0}</button>
        ))}
      </div>
      <Section
        title={`${filter === "all" ? "All BTPA" : meta(filter).label} (${deals.length})`}
        sub={filter === "all"
          ? "Needs appointment (never had one → rep schedules) · Needs reschedule (appt came and went, nothing signed → rep rebooks) · Upcoming (scheduled, hasn't happened) · Signed (PA signed the homeowner) · Dead (Not Interested or office-closed DQ)."
          : filter === "need_appt" ? "Damage roofs that never had a PA appointment — the rep goes back to schedule the first one. (A PA merely 'opening' the deal doesn't count; only a real booked appointment does.)"
          : filter === "upcoming" ? "A PA appointment is on the books and hasn't happened yet — scheduled for later."
          : filter === "missed" ? "Had a PA appointment that came and went with nothing signed — the rep goes back to reschedule it."
          : filter === "signed" ? "The PA signed the homeowner (or is collecting docs) — the claim is moving."
          : "Homeowner Not Interested, or the office/PA closed the lead as a dead DQ — no go-back needed."}>
        {!deals.length ? <Empty /> : <Grouped groups={filter === "signed" ? twoLevel(deals, (r) => r.company || "No company", (r) => r.pa || "—", "alpha") : twoLevel(deals, (r) => r.zone, (r) => r.rep || "—")} renderRow={row} />}
      </Section>
    </div>
  );
}

// The story behind a PA appointment — its pipeline stage + the recent PA notes, so
// the office can see WHY it refused / what "no outcome" actually means, instead of a
// bare verdict. "No notes logged" is itself the answer: nobody recorded what happened.
function NotesBlock({ r, needsAppt }) {
  const cap = (s) => String(s || "").replace(/_/g, " ");
  const notes = Array.isArray(r.notes) ? r.notes : [];
  return (
    <>
      {typeof r.signed === "boolean" && (
        <div style={{ fontSize: 12, fontWeight: 800, marginTop: 3, color: r.signed ? "#16a34a" : needsAppt ? "#b45309" : "#9a3412" }}>
          {r.signed ? "✅ Signed PA paperwork"
            : needsAppt ? "◻︎ No PA appointment yet — rep still needs to set the first one"
            : "❌ No PA paperwork signed — reschedule candidate"}
        </div>
      )}
      {r.stage && <div style={{ fontSize: 11.5, fontWeight: 800, color: "#7c3aed", marginTop: 3, textTransform: "capitalize" }}>PA stage: {cap(r.stage)}</div>}
      {r.visits > 0 && (
        <div style={{ fontSize: 11.5, fontWeight: 800, color: "#0891b2", marginTop: 3 }}>
          🚪 Rep went {r.visits}× — nobody home{r.last_visit ? ` · last ${fmtDate(r.last_visit)}` : ""}
        </div>
      )}
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
