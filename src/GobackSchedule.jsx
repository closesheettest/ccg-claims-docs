// Admin CMS for the "auto-schedule the go-back after an inspection" text sequence.
// Full control: master on/off, and an ordered list of messages — each with its own
// wait (days after the inspection), send time, and body. Add/remove messages; the
// count IS how many texts go out. Reads/writes goback-autoschedule-config.
import React, { useEffect, useState } from "react";

const FONT = "'Nunito', system-ui, sans-serif";
const OSWALD = "'Oswald', sans-serif";
const TOKENS = ["{name}", "{rep}", "{link}", "{address}", "{company}"];

export default function GobackSchedule() {
  const [config, setConfig] = useState(null); // null=loading | {enabled, messages}
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    fetch("/.netlify/functions/goback-autoschedule-config")
      .then((r) => r.json())
      .then((d) => setConfig(d && d.ok ? d.config : { enabled: false, messages: [] }))
      .catch(() => setConfig({ enabled: false, messages: [] }));
  }, []);

  const setMsg = (i, patch) => setConfig((c) => ({ ...c, messages: c.messages.map((m, j) => (j === i ? { ...m, ...patch } : m)) }));
  const addMsg = () => setConfig((c) => ({ ...c, messages: [...c.messages, { delay_days: (c.messages[c.messages.length - 1]?.delay_days || 0) + 2, send_time: "10:00", body: "" }] }));
  const removeMsg = (i) => setConfig((c) => ({ ...c, messages: c.messages.filter((_, j) => j !== i) }));

  const save = async () => {
    setBusy(true); setErr(""); setSaved(false);
    try {
      const r = await fetch("/.netlify/functions/goback-autoschedule-config", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config }),
      });
      const d = await r.json();
      if (!d.ok) throw new Error(d.error || "Save failed");
      setConfig(d.config); setSaved(true); setTimeout(() => setSaved(false), 2500);
    } catch (e) { setErr(e.message || "Save failed"); }
    setBusy(false);
  };

  if (!config) return <div style={{ fontFamily: FONT, padding: 40, color: "#64748b" }}>Loading…</div>;

  const card = { background: "#fff", border: "1px solid #e5e7eb", borderRadius: 14, padding: "16px 18px", marginBottom: 14 };
  const label = { fontSize: 11, fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.05em", color: "#64748b", marginBottom: 4, display: "block" };
  const input = { fontFamily: FONT, fontSize: 14, padding: "8px 10px", borderRadius: 9, border: "1px solid #cbd5e1", width: "100%", boxSizing: "border-box" };

  return (
    <div style={{ fontFamily: FONT, maxWidth: 760, margin: "0 auto", padding: "24px 16px 80px", color: "#0f172a" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
        <span style={{ fontSize: 28 }}>🗓️</span>
        <h1 style={{ fontSize: 25, fontWeight: 800, margin: 0, fontFamily: OSWALD }}>Auto-Schedule After Inspection</h1>
      </div>
      <p style={{ color: "#64748b", fontSize: 14, margin: "0 0 18px" }}>
        After an inspection, the homeowner automatically gets these texts to book their come-back review. Control the on/off, each message's wait &amp; send time, and the body of every text. The number of messages is how many texts go out.
      </p>

      {/* Master on/off */}
      <div style={{ ...card, display: "flex", alignItems: "center", gap: 12, background: config.enabled ? "#f0fdf4" : "#f8fafc", borderColor: config.enabled ? "#bbf7d0" : "#e5e7eb" }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 15, fontWeight: 800, fontFamily: OSWALD }}>Auto-schedule is {config.enabled ? "ON" : "OFF"}</div>
          <div style={{ fontSize: 12.5, color: "#64748b" }}>{config.enabled ? "Homeowners get the sequence below after their inspection." : "No texts go out until you switch this on."}</div>
        </div>
        <button type="button" onClick={() => setConfig((c) => ({ ...c, enabled: !c.enabled }))}
          style={{ position: "relative", width: 52, height: 30, borderRadius: 999, border: "none", cursor: "pointer", background: config.enabled ? "#16a34a" : "#cbd5e1" }}>
          <span style={{ position: "absolute", top: 3, left: config.enabled ? 25 : 3, width: 24, height: 24, borderRadius: "50%", background: "#fff", boxShadow: "0 1px 3px rgba(0,0,0,.3)", transition: "left .15s" }} />
        </button>
      </div>

      {/* Merge tokens helper */}
      <div style={{ fontSize: 12, color: "#64748b", marginBottom: 12 }}>
        Drop these into any message — they fill in automatically:{" "}
        {TOKENS.map((t) => <code key={t} style={{ background: "#f1f5f9", border: "1px solid #e2e8f0", borderRadius: 6, padding: "1px 6px", margin: "0 3px", fontSize: 12 }}>{t}</code>)}
      </div>

      {/* Messages */}
      {config.messages.map((m, i) => (
        <div key={i} style={card}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
            <div style={{ fontSize: 14, fontWeight: 800, fontFamily: OSWALD }}>{i === 0 ? "Message 1 · first message" : `Message ${i + 1}`}</div>
            <button type="button" onClick={() => removeMsg(i)} style={{ fontSize: 12, fontWeight: 700, color: "#b91c1c", background: "#fff", border: "1px solid #fecaca", borderRadius: 8, padding: "4px 10px", cursor: "pointer" }}>Remove</button>
          </div>
          <div style={{ display: "flex", gap: 14, marginBottom: 10, flexWrap: "wrap" }}>
            <div style={{ minWidth: 150 }}>
              <label style={label}>Wait (days after inspection)</label>
              <input type="number" min="0" max="60" value={m.delay_days}
                onChange={(e) => setMsg(i, { delay_days: Math.max(0, Math.min(60, Math.round(Number(e.target.value) || 0))) })} style={{ ...input, width: 90 }} />
              <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 3 }}>{m.delay_days === 0 ? "same day as the inspection" : `${m.delay_days} day${m.delay_days > 1 ? "s" : ""} later`}</div>
            </div>
            <div style={{ minWidth: 130 }}>
              <label style={label}>Send time</label>
              <input type="time" value={m.send_time} onChange={(e) => setMsg(i, { send_time: e.target.value })} style={{ ...input, width: 130 }} />
              <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 3 }}>Eastern time</div>
            </div>
          </div>
          <label style={label}>Message body</label>
          <textarea value={m.body} onChange={(e) => setMsg(i, { body: e.target.value })} rows={3}
            style={{ ...input, resize: "vertical", lineHeight: 1.45 }} placeholder="What the homeowner receives…" />
          <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 4 }}>{(m.body || "").length} characters</div>
        </div>
      ))}

      <button type="button" onClick={addMsg} style={{ width: "100%", background: "#fff", border: "2px dashed #cbd5e1", color: "#475569", borderRadius: 12, padding: "12px", fontSize: 14, fontWeight: 800, cursor: "pointer", marginBottom: 18 }}>
        + Add another message
      </button>

      {err && <div style={{ color: "#b91c1c", fontSize: 13.5, marginBottom: 10 }}>{err}</div>}
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <button type="button" onClick={save} disabled={busy}
          style={{ background: busy ? "#94a3b8" : "#2563eb", color: "#fff", border: "none", borderRadius: 12, padding: "13px 28px", fontSize: 15, fontWeight: 800, fontFamily: OSWALD, letterSpacing: "0.02em", cursor: busy ? "default" : "pointer" }}>
          {busy ? "Saving…" : "Save changes"}
        </button>
        {saved && <span style={{ color: "#16a34a", fontSize: 14, fontWeight: 800 }}>✓ Saved</span>}
      </div>

      <div style={{ marginTop: 24, padding: "12px 14px", background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: 10, fontSize: 12.5, color: "#166534" }}>
        ✅ <b>Live.</b> When the toggle above is ON, the sequence fires automatically after each inspection and stops the moment the homeowner books. Every message goes out by <b>text AND email</b> — a text alone misses anyone on DND or opted out. Sends are held to <b>8 AM–9 PM ET</b>, and only for inspections completed <b>after this went live</b> (it never blasts old ones). The <code>{"{link}"}</code> opens the homeowner's booking page (their rep's come-back times) — booking drops the appointment on the rep's JobNimbus + map and texts the rep.
      </div>

      <GobackReport />
    </div>
  );
}


// Insert a heading row before each rep's homeowners, with that rep's own
// contacted / booked / to-call figures.
function withRepHeadings(rows) {
  const byRep = [];
  for (const r of rows) {
    const g = byRep.find((x) => x.rep === r.rep);
    (g ? g.rows : (byRep.push({ rep: r.rep, rows: [] }), byRep[byRep.length - 1].rows)).push(r);
  }
  byRep.sort((a, b) => (a.rep || "").localeCompare(b.rep || ""));
  const out = [];
  for (const g of byRep) {
    const booked = g.rows.filter((x) => x.booked).length;
    out.push({
      __repHeading: true, rep: g.rep, __n: g.rows.length,
      __pct: Math.round((booked / g.rows.length) * 100),
      __warm: g.rows.filter((x) => x.opened_at && !x.booked).length,
    });
    // warm first inside a rep, same as the rep view
    out.push(...g.rows.slice().sort((a, b) =>
      Number(!!b.opened_at && !b.booked) - Number(!!a.opened_at && !a.booked)));
  }
  return out;
}

// The funnel report — who the sequence reached (text + email), who OPENED their
// booking page, and who self-scheduled. Collapsed by default: it's a page for
// editing the messages, and a long table under it buries the Save button.
function GobackReport() {
  const [data, setData] = useState(null);
  const [open, setOpen] = useState(false);
  const [period, setPeriod] = useState("30d");
  const [openReps, setOpenReps] = useState(() => new Set());
  // Group by REP to hand someone their call list; by DAY to compare message
  // versions. Neal changes the wording, so the only way to tell whether a new
  // message pulls better is to line the days up and read the book rate down the
  // column — impossible when everything is bucketed under a rep.
  // Team is the default view — Neal reads this report by team, the way every
  // other report is organised. Rep and Day are still a tap away.
  const [groupBy, setGroupBy] = useState('team');
  const load = (p) => {
    setData(null);
    fetch(`/.netlify/functions/goback-report?period=${encodeURIComponent(p)}`)
      .then((r) => r.json())
      .then((d) => setData(d && d.ok ? d : { rows: [], summary: {} }))
      .catch(() => setData({ rows: [], summary: {} }));
  };
  useEffect(() => { if (open) load(period); }, [open, period]);
  const when = (iso) => { try { return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" }); } catch { return ""; } };
  const S = data?.summary || { texted: 0, opened: 0, booked: 0, rate: 0, open_rate: 0, warm: 0 };

  // One block per rep (their own homeowners, warm first) — or per DAY, newest
  // first, so a change of wording can be read straight down the book-rate column.
  const dayOf = (r) => (r.first_sent || "").slice(0, 10);
  const teamOf = (r) => (r.team ? `${r.team} (${r.zone})` : "No team on file");
  const byRep = [];
  for (const r of (data?.rows || [])) {
    const key = groupBy === 'day' ? (dayOf(r) || "—") : groupBy === 'team' ? teamOf(r) : r.rep;
    const g = byRep.find((x) => x.rep === key);
    (g ? g.rows : (byRep.push({ rep: key, rows: [] }), byRep[byRep.length - 1].rows)).push(r);
  }
  if (groupBy === 'day') byRep.sort((a, b) => (b.rep || "").localeCompare(a.rep || ""));

  const PERIODS = [["today", "Today"], ["week", "This week"], ["lastweek", "Last week"], ["30d", "30 days"], ["all", "All"]];
  const stat = (l, v, c, hint) => (
    <div key={l} title={hint || ""} style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12, padding: "10px 16px", minWidth: 108 }}>
      <div style={{ fontSize: 22, fontWeight: 800, color: c }}>{v}</div>
      <div style={{ fontSize: 10.5, fontWeight: 800, textTransform: "uppercase", letterSpacing: ".04em", color: "#94a3b8" }}>{l}</div>
    </div>
  );

  return (
    <div style={{ marginTop: 30 }}>
      <button type="button" onClick={() => setOpen((v) => !v)}
        style={{ width: "100%", textAlign: "left", background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12, padding: "12px 16px", cursor: "pointer", display: "flex", alignItems: "center", gap: 10 }}>
        <span style={{ fontSize: 19, fontWeight: 800, fontFamily: OSWALD, color: "#0f172a" }}>📊 Results</span>
        <span style={{ fontSize: 13, color: "#64748b" }}>contacted → opened → self-scheduled</span>
        <span style={{ marginLeft: "auto", fontSize: 15, color: "#94a3b8" }}>{open ? "▾" : "▸"}</span>
      </button>

      {open && (
        <div style={{ marginTop: 12 }}>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12 }}>
            {PERIODS.map(([k, label]) => (
              <button key={k} type="button" onClick={() => setPeriod(k)}
                style={{ border: "1px solid " + (period === k ? "#0f2a4a" : "#e5e7eb"), background: period === k ? "#0f2a4a" : "#fff", color: period === k ? "#fff" : "#475569", borderRadius: 999, padding: "6px 13px", fontSize: 12.5, fontWeight: 800, cursor: "pointer" }}>
                {label}
              </button>
            ))}
          </div>
          <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 12 }}>
            <span style={{ fontSize: 11.5, fontWeight: 800, textTransform: "uppercase", color: "#94a3b8" }}>Group by</span>
            {[["team", "Team"], ["rep", "Rep"], ["day", "Day sent"]].map(([k, label]) => (
              <button key={k} type="button" onClick={() => { setGroupBy(k); setOpenReps(new Set()); }}
                style={{ border: "1px solid " + (groupBy === k ? "#0f2a4a" : "#e5e7eb"), background: groupBy === k ? "#0f2a4a" : "#fff", color: groupBy === k ? "#fff" : "#475569", borderRadius: 999, padding: "5px 12px", fontSize: 12, fontWeight: 800, cursor: "pointer" }}>
                {label}
              </button>
            ))}
          </div>
          <p style={{ color: "#64748b", fontSize: 12.5, margin: "0 0 12px" }}>
            Bucketed by the day we <b>first</b> reached them. <b>Opened</b> = they clicked the link and saw the times.
            <b> Warm</b> = opened and didn&rsquo;t book — the shortlist worth a call.
          </p>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 14 }}>
            {stat("Contacted", S.texted, "#0f2a4a", "Text and/or email delivered")}
            {stat("Opened", `${S.opened}`, "#1d4ed8", "Clicked through to their booking page")}
            {stat("Self-scheduled", S.booked, "#16a34a", "Booked their own come-back review")}
            {stat("Warm — no book", S.warm, "#b45309", "Opened it and stopped. Call these.")}
            {stat("Book rate", `${S.rate}%`, "#c0392b", "Booked ÷ contacted")}
          </div>

          {!data ? <div style={{ color: "#94a3b8", fontSize: 13 }}>Loading…</div>
            : !data.rows.length ? <div style={{ background: "#f8fafc", border: "1px solid #e5e7eb", borderRadius: 12, padding: 16, color: "#94a3b8", fontSize: 13.5 }}>Nobody was contacted in this period.</div>
            : byRep.map((g) => {
              const warm = g.rows.filter((r) => r.opened_at && !r.booked).length;
              const bookedN = g.rows.filter((r) => r.booked).length;
              const isOpen = openReps.has(g.rep);
              return (
                <div key={g.rep} style={{ border: "1px solid #e5e7eb", borderRadius: 12, marginBottom: 10, overflow: "hidden" }}>
                  <button type="button"
                    onClick={() => setOpenReps((s) => { const n = new Set(s); n.has(g.rep) ? n.delete(g.rep) : n.add(g.rep); return n; })}
                    style={{ width: "100%", textAlign: "left", background: "#f8fafc", border: "none", padding: "10px 14px", cursor: "pointer", display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                    <span style={{ fontWeight: 800, color: "#0f172a", fontSize: 14 }}>
                      {groupBy === 'day' && g.rep !== '—'
                        ? new Date(g.rep + "T12:00:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })
                        : g.rep}
                    </span>
                    {groupBy === 'rep' && g.rows[0]?.team && (
                      <span style={{ fontSize: 11, fontWeight: 800, textTransform: "uppercase", letterSpacing: ".03em", color: "#6d28d9", background: "#f5f3ff", border: "1px solid #ddd6fe", borderRadius: 999, padding: "1px 8px" }}>
                        {g.rows[0].team}
                      </span>
                    )}
                    <span style={{ fontSize: 12, color: "#64748b" }}>{g.rows.length} contacted</span>
                    {/* Book rate per group — read it down the day column to see
                        whether a new message is pulling better. */}
                    <span style={{ fontSize: 12, fontWeight: 800, color: "#0f172a", background: "#f1f5f9", borderRadius: 999, padding: "1px 9px" }}>
                      {Math.round((g.rows.filter((r) => r.booked).length / g.rows.length) * 100)}% booked
                    </span>
                    {bookedN > 0 && <span style={{ fontSize: 12, fontWeight: 800, color: "#16a34a" }}>{bookedN} booked</span>}
                    {warm > 0 && <span style={{ fontSize: 12, fontWeight: 800, color: "#b45309", background: "#fffbeb", border: "1px solid #fcd34d", borderRadius: 999, padding: "1px 9px" }}>{warm} to call</span>}
                    <span style={{ marginLeft: "auto", color: "#94a3b8" }}>{isOpen ? "▾" : "▸"}</span>
                  </button>
                  {isOpen && (
                    <div style={{ overflowX: "auto" }}>
                      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                        <thead><tr style={{ background: "#fff", textAlign: "left" }}>
                          {["Homeowner", "Sent", "First", "Last", "Opened", "Booked?"].map((h) => <th key={h} style={{ padding: "8px 12px", fontSize: 10.5, fontWeight: 800, textTransform: "uppercase", letterSpacing: ".04em", color: "#94a3b8", whiteSpace: "nowrap" }}>{h}</th>)}
                        </tr></thead>
                        <tbody>
                          {/* In the TEAM view the rep still has to be visible —
                              grouping by team alone left a wall of homeowners
                              with no idea whose they were. A separator row per
                              rep keeps the team as the outer sort while giving
                              each rep their own block underneath. */}
                          {(groupBy === 'team' ? withRepHeadings(g.rows) : g.rows).map((r, i) => (
                            r.__repHeading ? (
                              <tr key={`h${i}`} style={{ borderTop: "1px solid #e2e8f0", background: "#f8fafc" }}>
                                <td colSpan={6} style={{ padding: "7px 12px" }}>
                                  <span style={{ fontSize: 12.5, fontWeight: 800, color: "#0f172a" }}>{r.rep}</span>
                                  <span style={{ fontSize: 11.5, color: "#64748b" }}> · {r.__n} contacted</span>
                                  <span style={{ fontSize: 11.5, fontWeight: 800, color: "#0f172a" }}> · {r.__pct}% booked</span>
                                  {r.__warm > 0 && <span style={{ fontSize: 11.5, fontWeight: 800, color: "#b45309" }}> · {r.__warm} to call</span>}
                                </td>
                              </tr>
                            ) : (
                            <tr key={i} style={{ borderTop: "1px solid #eef2f7", background: r.booked ? "#f0fdf4" : (r.opened_at ? "#fffbeb" : "#fff") }}>
                              <td style={{ padding: "9px 12px" }}><div style={{ fontWeight: 700, color: "#0f172a" }}>{r.name}</div><div style={{ fontSize: 11.5, color: "#94a3b8" }}>{r.phone}</div></td>
                              <td style={{ padding: "9px 12px", fontWeight: 700, textAlign: "center" }}>{r.texts}</td>
                              <td style={{ padding: "9px 12px", color: "#64748b", whiteSpace: "nowrap" }}>{when(r.first_sent)}</td>
                              <td style={{ padding: "9px 12px", color: "#64748b", whiteSpace: "nowrap" }}>{when(r.last_sent)}</td>
                              <td style={{ padding: "9px 12px", whiteSpace: "nowrap" }}>{r.opened_at ? <span style={{ color: "#1d4ed8", fontWeight: 800 }}>👀 {when(r.opened_at)}</span> : <span style={{ color: "#cbd5e1" }}>—</span>}</td>
                              <td style={{ padding: "9px 12px", whiteSpace: "nowrap" }}>{r.booked ? <span style={{ color: "#16a34a", fontWeight: 800 }}>✓ {when(r.review_appt_at)}</span> : (r.opened_at ? <span style={{ color: "#b45309", fontWeight: 800 }}>call them</span> : <span style={{ color: "#cbd5e1" }}>—</span>)}</td>
                            </tr>
                            )
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              );
            })}
        </div>
      )}
    </div>
  );
}

