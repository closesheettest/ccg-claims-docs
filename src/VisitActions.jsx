// src/VisitActions.jsx
//
// The three post-inspection go-back action panels — Damage (set PA appt),
// No-Damage (referrals + certificate), Retail (schedule / record outcome) —
// extracted so BOTH the Rep Visit Hub and the DoorDispatcher render the exact
// same flows against the same backend endpoints. Self-contained: it takes a
// `deal`, a `rep` ({name, jobnimbus_id, email}), and an `api(fn, payload)` that
// POSTs {token, ...payload} to /.netlify/functions/<fn>.

import { useEffect, useMemo, useState } from "react";

const NAVY = "#1a2e5a";
const RETAIL_HOURS = { 1: [11, 14, 17, 19], 2: [11, 14, 17, 19], 3: [11, 14, 17, 19], 4: [11, 14, 17, 19], 5: [9, 12, 15], 6: [9, 12] };
const S = {
  input: { width: "100%", boxSizing: "border-box", height: 46, padding: "0 12px", borderRadius: 12, border: "1px solid #d1d5db", fontSize: 16, background: "#fff" },
  back: { background: "none", border: "none", color: "#6b7280", fontSize: 14, cursor: "pointer", padding: 0 },
  done: { background: "#ecfdf5", border: "1px solid #a7f3d0", color: "#065f46", borderRadius: 14, padding: "20px 16px", textAlign: "center", fontSize: 15, fontWeight: 700 },
};

// Renders the right panel for a bucket ("damage" | "no_damage" | "retail").
// Every bucket also gets the shared "Nobody home" action up top: a rep who
// arrives at a scheduled go-back and finds no one home re-dates it to the
// homeowner's next preferred day and logs the attempt (never removes it).
export default function VisitActions({ type, deal, rep, api }) {
  const panel = type === "damage" ? <DamagePanel deal={deal} rep={rep} api={api} />
    : type === "no_damage" ? <NoDamagePanel deal={deal} rep={rep} api={api} />
    : type === "retail" ? <RetailPanel deal={deal} rep={rep} api={api} />
    : null;
  if (!panel) return null;
  return <><ViewCertButton deal={deal} /><NotHomeButton deal={deal} api={api} />{panel}</>;
}

// "View certificate" — every go-back (damage / no-damage / retail) gets this so the
// rep can show the homeowner the inspection report WITH PHOTOS on the spot. Builds
// the report PDF (cache-first, so it's near-instant once rendered) and opens it.
// Pages painted into the report tab so it's never a blank white screen: a loading
// state while the PDF builds, then a hand-off that auto-opens the PDF AND shows a
// tappable link (for in-app browsers that block the silent redirect).
const PAGE_HEAD = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Inspection Report</title><style>body{margin:0;font-family:-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;background:#0f172a;color:#e2e8f0;display:flex;min-height:100vh;align-items:center;justify-content:center;text-align:center;padding:24px}.box{max-width:340px}.spin{width:40px;height:40px;border:4px solid #334155;border-top-color:#22d3ee;border-radius:50%;margin:0 auto 18px;animation:s 1s linear infinite}@keyframes s{to{transform:rotate(360deg)}}h1{font-size:19px;margin:0 0 8px}p{color:#94a3b8;font-size:14px;line-height:1.5;margin:0 0 18px}a.btn{display:inline-block;background:#22d3ee;color:#083344;font-weight:800;text-decoration:none;padding:14px 22px;border-radius:12px;font-size:16px}</style></head><body><div class="box">`;
const PAGE_FOOT = `</div></body></html>`;
const LOADING_HTML = `${PAGE_HEAD}<div class="spin"></div><h1>Building your inspection report…</h1><p>Pulling the photos together — this takes a few seconds. Please keep this tab open.</p>${PAGE_FOOT}`;
function readyHtml(url) {
  const safe = String(url).replace(/"/g, "&quot;");
  return `${PAGE_HEAD}<h1>Your report is ready</h1><p>Opening it now… if it doesn't open on its own, tap below.</p><a class="btn" href="${safe}">📄 Open the report</a><script>setTimeout(function(){try{location.replace(${JSON.stringify(url)})}catch(e){location.href=${JSON.stringify(url)}}},300)<\/script>${PAGE_FOOT}`;
}
function errorHtml(msg) {
  const safe = String(msg || "Couldn't build the report").replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]));
  return `${PAGE_HEAD}<h1>Couldn't open the report</h1><p>${safe}</p><p style="font-size:13px">Close this tab and try again, or tell the office.</p>${PAGE_FOOT}`;
}
function ViewCertButton({ deal }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const view = async () => {
    if (busy) return;
    const jnid = deal?.jn_job_id;
    if (!jnid) { setErr("No JobNimbus job on this deal yet — can't build the report."); return; }
    setBusy(true); setErr("");
    // Open the tab synchronously (before the await) so mobile Safari doesn't block it,
    // and paint a loading page immediately — building the PDF takes a few seconds, and
    // a blank tab reads as "broken / white screen" (and some in-app browsers silently
    // drop a delayed w.location redirect, leaving it white forever).
    const w = window.open("", "_blank");
    if (w) { try { w.document.write(LOADING_HTML); w.document.close(); } catch { /* ignore */ } }
    try {
      const r = await fetch("/.netlify/functions/generate-and-upload-insp-report", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jnid, view: true }),
      });
      const o = await r.json().catch(() => ({}));
      if (!o.ok || !o.pdf_signed_url) throw new Error(o.error || "Couldn't build the report");
      const url = o.pdf_signed_url;
      if (w) {
        // Hand off with BOTH an auto-redirect and a big tappable link — so it opens even
        // on in-app browsers that block the silent redirect.
        try { w.document.open(); w.document.write(readyHtml(url)); w.document.close(); }
        catch { try { w.location = url; } catch { window.open(url, "_blank"); } }
      } else {
        window.open(url, "_blank");
      }
    } catch (e) {
      if (w) { try { w.document.open(); w.document.write(errorHtml(e.message)); w.document.close(); } catch { try { w.close(); } catch { /* ignore */ } } }
      setErr(e.message || "Couldn't load the certificate");
    }
    setBusy(false);
  };
  return (
    <div style={{ marginBottom: 14 }}>
      <button type="button" onClick={view} disabled={busy}
        style={{ width: "100%", border: "1px solid #0e7490", color: "#0e7490", background: "#ecfeff", borderRadius: 12, padding: "11px 0", fontSize: 14, fontWeight: 800, cursor: "pointer", opacity: busy ? 0.6 : 1 }}>
        {busy ? "Building the report…" : "📸 View certificate — show the inspection photos"}
      </button>
      {err && <div style={{ fontSize: 12.5, color: "#b91c1c", marginTop: 6, textAlign: "center" }}>{err}</div>}
    </div>
  );
}

function NotHomeButton({ deal, api }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const go = async () => {
    if (busy || !deal?.inspection_id) return;
    setBusy(true); setMsg("");
    try {
      const o = await api("goback-not-home", { inspection_id: deal.inspection_id });
      setMsg(`🚪 Not home — moved to ${o.label || "the next preferred day"}${o.count > 1 ? ` · attempt #${o.count}` : ""}. Still on your list.`);
    } catch (e) { setMsg(e?.body?.error || "Couldn't update — try again."); }
    setBusy(false);
  };
  return (
    <div style={{ marginBottom: 14 }}>
      <button type="button" onClick={go} disabled={busy}
        style={{ width: "100%", border: "1px solid #cbd5e1", color: "#475569", background: "#f8fafc", borderRadius: 12, padding: "11px 0", fontSize: 14, fontWeight: 700, cursor: "pointer", opacity: busy ? 0.6 : 1 }}>
        {busy ? "Saving…" : "🚪 Nobody home — try again next time"}
      </button>
      {msg && <div style={{ fontSize: 12.5, color: "#475569", marginTop: 6, textAlign: "center" }}>{msg}</div>}
    </div>
  );
}

export function DamagePanel({ deal, rep, api, reschedule = false }) {
  const [slots, setSlots] = useState(null);
  const [err, setErr] = useState("");
  const [booking, setBooking] = useState("");
  const [done, setDone] = useState(null);
  const [ni, setNi] = useState(false);
  const [note, setNote] = useState("");   // reschedule: a note the rep sends the PA (wrong address, gate code, what went wrong)
  useEffect(() => {
    api("pa-schedule-api", { action: "slots", inspection_id: deal.inspection_id, lat: deal.latitude, lng: deal.longitude })
      .then((o) => setSlots(o.slots || [])).catch((e) => { setErr(e.message); setSlots([]); });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const doBook = async (s, force) =>
    api("pa-schedule-api", { action: "book", pa_id: s.pa_id, start_at: s.start_at, inspection_id: deal.inspection_id, homeowner_name: deal.client_name, homeowner_phone: deal.mobile, address: deal.address, booked_by: rep.name, force, reschedule, note: note.trim() || undefined });
  const book = async (s) => {
    setBooking(s.start_at + s.pa_id); setErr("");
    try {
      await doBook(s, false);
      setDone(`Booked with ${s.pa_name} — ${s.label}. The PA was notified${note.trim() ? " with your note" : ""}.`);
    } catch (e) {
      if (e.body?.duplicate) {
        const ex = e.body.existing || {};
        const when = ex.start_at ? new Date(ex.start_at).toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit" }) : "another time";
        if (window.confirm(`⚠️ ${deal.client_name || "This homeowner"} already has a PA appointment scheduled for ${when}${ex.pa_name ? ` with ${ex.pa_name}` : ""}.\n\nBook a SECOND appointment anyway?\n\n• OK = book anyway\n• Cancel = go back and pick a different time`)) {
          try { await doBook(s, true); setDone(`Booked with ${s.pa_name} — ${s.label}. The PA was notified${note.trim() ? " with your note" : ""}.`); }
          catch (e2) { setErr(e2.message); }
        } else {
          setErr("Didn't book — this homeowner already has a PA appointment. Pick a different time or leave the existing one.");
        }
      } else { setErr(e.message); }
    }
    setBooking("");
  };
  const markNotInterested = async () => {
    if (!window.confirm(`Mark ${deal.client_name || "this homeowner"} Not Interested?\n\nThey'll move to "BTR - NI" in JobNimbus and drop off your damage list.`)) return;
    setNi(true); setErr("");
    try {
      await api("retail-not-interested", { inspection_id: deal.inspection_id });
      setDone(`Marked Not Interested (BTR - NI). Removed from your list.`);
    } catch (e) { setErr(e.message); setNi(false); }
  };
  // A PA already assigned/working this claim changes what "going retail" does:
  // the sale becomes its own job and the PA keeps the insurance one.
  const paOnIt = !!deal.pa_id || ["active", "waiting_docs", "signed"].includes(deal.pa_stage || "");
  const [goRetail, setGoRetail] = useState(false);
  const [wentRetail, setWentRetail] = useState(false);   // just went retail → offer the homeowner a PA visit anyway
  const [picking, setPicking] = useState("");
  const retailDays = useMemo(() => buildRetailDays(14), []);
  const pickRetail = async (slot) => {
    setPicking(slot.iso); setErr("");
    try {
      const o = await api("damage-to-retail", { inspection_id: deal.inspection_id, start_at_iso: slot.iso, rep_jobnimbus_id: rep.jobnimbus_id, booked_by: rep.name });
      // A PA already working the claim is NOT fired by the retail sale — the deal
      // stays theirs and there's nothing to re-book, so skip the PA-visit offer.
      setWentRetail(!o.pa_stays);
      setDone(o.pa_stays
        ? `Retail appointment set for ${slot.label}. The PA stays on the claim — they're still going.`
        : `Switched to Retail — appointment set for ${slot.label}. JobNimbus updated.`);
    } catch (e) { setErr(e.message); }
    setPicking("");
  };
  if (done) return (
    <div>
      <div style={S.done}>✓ {done}</div>
      {/* The PA visit was just wiped by going retail. This is the one moment the
          rep can still hand the homeowner one, so offer it here. */}
      {wentRetail && <BtrPaBooking deal={deal} rep={rep} api={api} />}
    </div>
  );
  if (slots === null) return <p style={{ textAlign: "center", color: "#9ca3af", padding: "16px 0", fontSize: 14 }}>Loading availability…</p>;

  const todayKey = ymdET();
  const byDay = {};
  for (const s of slots) {
    const k = ymdET(new Date(s.start_at));
    if (k === todayKey) continue;
    (byDay[k] = byDay[k] || []).push(s);
  }
  const dayKeys = [...new Set([todayKey, ...Object.keys(byDay)])].sort();
  return (
    <div>
      {Array.isArray(deal.pa_notes_log) && deal.pa_notes_log.length > 0 && (
        <div style={{ marginBottom: 12, background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 10, padding: "8px 10px" }}>
          <div style={{ fontSize: 11, fontWeight: 800, color: "#92400e", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 3 }}>📝 PA notes — what the adjuster found</div>
          <div style={{ maxHeight: 120, overflowY: "auto" }}>
            {deal.pa_notes_log.map((n, i) => <div key={i} style={{ fontSize: 13, color: "#374151", marginBottom: 3 }}>• {n.text}</div>)}
          </div>
        </div>
      )}
      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        <button type="button" disabled={ni || !!booking} onClick={markNotInterested}
          style={{ flex: 1, border: "1px solid #dc2626", color: "#dc2626", background: "#fff", borderRadius: 12, padding: "11px 8px", fontSize: 13.5, fontWeight: 800, cursor: "pointer", opacity: ni ? 0.6 : 1 }}>
          {ni ? "Saving…" : "🚫 Not Interested"}
        </button>
        <button type="button" disabled={!!booking || !!picking} onClick={() => { setGoRetail((v) => !v); setErr(""); }}
          style={{ flex: 1, border: "1px solid #b45309", color: goRetail ? "#fff" : "#b45309", background: goRetail ? "#b45309" : "#fff", borderRadius: 12, padding: "11px 8px", fontSize: 13.5, fontWeight: 800, cursor: "pointer" }}>
          🏠 Going retail
        </button>
      </div>
      {err && <div style={{ color: "#b91c1c", fontSize: 14, marginBottom: 8 }}>{err}</div>}
      {goRetail ? (
        <div>
          {/* Two different outcomes — say which one this is BEFORE they pick a time. */}
          {paOnIt ? (
            <p style={{ fontSize: 14, fontWeight: 700, color: "#374151", margin: "0 0 8px" }}>
              🏠 Going retail — pick a retail appointment time.{" "}
              <span style={{ color: "#6d28d9" }}>
                A PA is already working this claim, so this does <b>not</b> take it off them. You'll get a separate Retail job for the sale in JobNimbus; the insurance job stays with the PA and they keep going.
              </span>
            </p>
          ) : (
            <p style={{ fontSize: 14, fontWeight: 700, color: "#374151", margin: "0 0 8px" }}>🏠 Going retail — pick a retail appointment time. This switches the deal to Retail in JobNimbus and books it.</p>
          )}
          <div style={{ maxHeight: "55vh", overflowY: "auto" }}>
            {retailDays.map((day) => (
              <div key={day.key} style={{ marginBottom: 14 }}>
                <p style={{ fontSize: 11.5, fontWeight: 800, textTransform: "uppercase", color: "#9ca3af", margin: "0 0 6px" }}>{day.label}</p>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                  {day.slots.map((s) => (
                    <button key={s.iso} disabled={!!picking} onClick={() => pickRetail(s)}
                      style={{ border: "1px solid #d97706", color: "#d97706", background: "#fff", borderRadius: 12, padding: "9px 14px", fontSize: 14, fontWeight: 700, cursor: "pointer", opacity: picking ? 0.6 : 1 }}>
                      {picking === s.iso ? "…" : s.time}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <>
          {reschedule && (
            <div style={{ marginBottom: 14, background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 10, padding: "10px 12px" }}>
              <label style={{ display: "block", fontSize: 12, fontWeight: 800, color: "#92400e", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 5 }}>📝 Note for the PA (optional)</label>
              <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2}
                placeholder="e.g. PA went to the wrong house — correct address is 1204 N New Hampshire Ave, blue door on the corner. Gate code 1234."
                style={{ width: "100%", boxSizing: "border-box", fontFamily: "inherit", fontSize: 13.5, padding: "8px 10px", border: "1px solid #fcd34d", borderRadius: 8, resize: "vertical" }} />
              <div style={{ fontSize: 11.5, color: "#a16207", marginTop: 4 }}>Sent to the PA with the new appointment — in their text/email and on the JobNimbus job.</div>
            </div>
          )}
          <p style={{ fontSize: 14, fontWeight: 700, color: "#374151", margin: "0 0 8px" }}>…or pick a day & time for the PA to come out:</p>
          <div style={{ maxHeight: "55vh", overflowY: "auto" }}>
            {dayKeys.map((k) => {
              const isToday = k === todayKey;
              const seen = new Set(); const uniq = [];
              for (const s of (byDay[k] || [])) { const t = hourLabel(s.start_at); if (seen.has(t)) continue; seen.add(t); uniq.push(s); }
              return (
                <div key={k} style={{ marginBottom: 12 }}>
                  <p style={{ fontSize: 12.5, fontWeight: 800, margin: "0 0 6px", padding: isToday ? "3px 8px" : "0", borderRadius: 8, display: "inline-block", background: isToday ? "#fef3c7" : "transparent", color: isToday ? "#92400e" : "#374151" }}>
                    {dayLabel(k)}{isToday ? " · Today" : ""}
                  </p>
                  {isToday ? <p style={{ fontSize: 12, color: "#9ca3af", margin: 0 }}>(for reference — book a day below)</p>
                    : !uniq.length ? <p style={{ fontSize: 12, color: "#9ca3af", margin: 0 }}>No openings</p>
                      : <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                        {uniq.map((s) => (
                          <button key={s.start_at + s.pa_id} disabled={!!booking} onClick={() => book(s)}
                            style={{ border: "1px solid #16a34a", color: "#16a34a", background: "#fff", borderRadius: 12, padding: "9px 16px", fontSize: 14, fontWeight: 700, cursor: "pointer", opacity: booking ? 0.6 : 1 }}>
                            {booking === s.start_at + s.pa_id ? "…" : hourLabel(s.start_at)}
                          </button>
                        ))}
                      </div>}
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

export function NoDamagePanel({ deal, rep, api }) {
  const [rows, setRows] = useState([{ name: "", phone: "", address: "" }]);
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState("");
  const [done, setDone] = useState(null);
  const [decl, setDecl] = useState(false);
  const set = (i, k, v) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, [k]: v } : r)));
  const declineReferral = async () => {
    setDecl(true); setErr("");
    try {
      await api("referral-decline", { inspection_id: deal.inspection_id, rep_name: rep.name });
      setDone(`Logged — ${deal.client_name || "homeowner"} doesn't want to give a referral. (Not sent to JobNimbus.)`);
    } catch (e) { setErr(e.message); setDecl(false); }
  };
  const send = async () => {
    setSending(true); setErr("");
    try {
      const referrals = rows.filter((r) => r.name || r.phone);
      const o = await api("no-damage-send", { inspection_id: deal.inspection_id, referrals, rep_name: rep.name });
      setDone(`Sent to ${deal.client_name}.${o.emailed ? " ✉️" : ""}${o.texted ? " 💬" : ""}${o.hadCert ? " (certificate attached)" : ""}`);
    } catch (e) { setErr(e.message); }
    setSending(false);
  };
  if (done) return <div style={S.done}>✓ {done}</div>;
  const halfInput = { ...S.input, height: 42, fontSize: 15 };
  return (
    <div>
      <p style={{ fontSize: 14, fontWeight: 700, color: "#374151", margin: "0 0 8px" }}>Ask for referrals</p>
      {rows.map((r, i) => (
        <div key={i} style={{ border: "1px solid #e5e7eb", borderRadius: 12, padding: 8, marginBottom: 8 }}>
          <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
            <input value={r.name} onChange={(e) => set(i, "name", e.target.value)} placeholder="Name" style={{ ...halfInput, width: "55%" }} />
            <input value={r.phone} onChange={(e) => set(i, "phone", e.target.value)} placeholder="Phone" style={{ ...halfInput, width: "45%" }} inputMode="tel" />
          </div>
          <input value={r.address} onChange={(e) => set(i, "address", e.target.value)} placeholder="Address" style={{ ...halfInput, width: "100%" }} />
        </div>
      ))}
      <button onClick={() => setRows((rs) => [...rs, { name: "", phone: "", address: "" }])} style={{ ...S.back, color: NAVY, fontWeight: 700, fontSize: 13, marginBottom: 14 }}>+ add another</button>
      {err && <div style={{ color: "#b91c1c", fontSize: 14, marginBottom: 8 }}>{err}</div>}
      <button onClick={send} disabled={sending} style={{ width: "100%", background: "#16a34a", color: "#fff", border: "none", borderRadius: 12, padding: "14px 0", fontSize: 15, fontWeight: 800, cursor: "pointer", opacity: sending ? 0.6 : 1 }}>
        {sending ? "Sending…" : "Send certificate + review link"}
      </button>
      <button onClick={declineReferral} disabled={sending || decl} style={{ width: "100%", marginTop: 10, border: "1px solid #b45309", color: "#b45309", background: "#fff", borderRadius: 12, padding: "11px 0", fontSize: 14, fontWeight: 700, cursor: "pointer", opacity: decl ? 0.6 : 1 }}>
        {decl ? "Saving…" : "🙅 Doesn't want to give a referral"}
      </button>
    </div>
  );
}


// ── BTRPA ────────────────────────────────────────────────────────────────────
// Back-to-retail, PA anyway. The rep sold (or booked) the roof retail, and the
// homeowner still wants an adjuster out. Until now that was impossible: going
// retail nulls pa_id/pa_stage and moves the JN job out of Insurance, and nothing
// could send them back — so the homeowner simply lost their PA visit.
//
// This books the PA appointment WITHOUT touching the retail outcome. It's safe
// because pa-schedule-api's `book` only writes pa_appointments and notifies the
// PA — it never writes to the inspection, so the retail sale can't be undone.
//
// Nothing here is tracked or reported. Neal: "I don't even want to track it, I
// just want to be able to hook the homeowner up with a PA appointment."
export function BtrPaBooking({ deal, rep, api }) {
  const [open, setOpen] = useState(false);
  const [slots, setSlots] = useState(null);
  const [busy, setBusy] = useState("");
  const [done, setDone] = useState(null);
  const [err, setErr] = useState("");

  const load = () => {
    setOpen(true);
    if (slots !== null) return;
    api("pa-schedule-api", { action: "slots", inspection_id: deal.inspection_id, lat: deal.latitude, lng: deal.longitude })
      .then((o) => setSlots(o.slots || []))
      .catch((e) => { setErr(e.message); setSlots([]); });
  };
  const book = async (s) => {
    setErr(""); setBusy(s.start_at);
    try {
      // Deliberately booked WITHOUT inspection_id. Passing it would flip that
      // record back to pa_stage "active" and reassign it to this PA — dragging a
      // sold retail roof back into the PA pipeline and onto go-back lists. The
      // homeowner still gets their visit; we just don't track it as our claim.
      await api("pa-schedule-api", {
        action: "book", pa_id: s.pa_id, start_at: s.start_at,
        homeowner_name: deal.client_name, homeowner_phone: deal.mobile, address: deal.address,
        booked_by: rep.name, note: "BTRPA — roof sold retail; PA visit booked for the homeowner only.",
      });
      setDone(`PA booked with ${s.pa_name} — ${s.label}. The retail sale is untouched.`);
    } catch (e) { setErr(e.message || "Couldn't book."); }
    setBusy("");
  };

  if (done) return <p style={{ background: "#ecfdf5", border: "1px solid #6ee7b7", color: "#065f46", borderRadius: 10, padding: 10, fontSize: 14, fontWeight: 700, margin: "12px 0 0" }}>✅ {done}</p>;

  if (!open) {
    return (
      <button type="button" onClick={load}
        style={{ marginTop: 14, width: "100%", border: "1px dashed #7c3aed", color: "#6d28d9", background: "#faf5ff", borderRadius: 12, padding: "11px 14px", fontSize: 14, fontWeight: 800, cursor: "pointer" }}>
        🧾 They still want a PA visit — book one
      </button>
    );
  }

  const byDay = [];
  for (const s of (slots || [])) {
    const d = byDay.find((x) => x.label === s.day_label);
    (d ? d.slots : (byDay.push({ label: s.day_label, slots: [] }), byDay[byDay.length - 1].slots)).push(s);
  }

  return (
    <div style={{ marginTop: 14, borderTop: "1px solid #e5e7eb", paddingTop: 12 }}>
      <p style={{ fontSize: 14, fontWeight: 700, color: "#374151", margin: "0 0 4px" }}>🧾 Book their PA visit</p>
      <p style={{ fontSize: 12, color: "#6b7280", margin: "0 0 10px" }}>
        For the homeowner's benefit. This does not change the retail sale.
      </p>
      {err && <p style={{ color: "#b91c1c", fontSize: 13, fontWeight: 700 }}>{err}</p>}
      {slots === null && <p style={{ color: "#9ca3af", fontSize: 14 }}>Loading availability…</p>}
      {slots !== null && slots.length === 0 && <p style={{ color: "#9ca3af", fontSize: 14 }}>No PA availability showing right now.</p>}
      <div style={{ maxHeight: "45vh", overflowY: "auto" }}>
        {byDay.map((day) => (
          <div key={day.label} style={{ marginBottom: 12 }}>
            <p style={{ fontSize: 11.5, fontWeight: 800, textTransform: "uppercase", color: "#9ca3af", margin: "0 0 6px" }}>{day.label}</p>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {day.slots.map((s) => (
                <button key={s.start_at} disabled={!!busy} onClick={() => book(s)}
                  style={{ border: "1px solid #7c3aed", color: "#6d28d9", background: "#fff", borderRadius: 12, padding: "9px 14px", fontSize: 14, fontWeight: 700, cursor: "pointer", opacity: busy ? 0.6 : 1 }}>
                  {busy === s.start_at ? "…" : `${s.time || s.label} · ${s.pa_name || "PA"}`}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function RetailPanel({ deal, rep, api }) {
  const [picking, setPicking] = useState("");
  const [err, setErr] = useState("");
  const [done, setDone] = useState(null);
  const [recording, setRecording] = useState("");
  const [blocked, setBlocked] = useState(() => new Set());
  const [booked, setBooked] = useState(() => new Set());
  const [dateBlocked, setDateBlocked] = useState(() => new Set());
  useEffect(() => {
    if (!rep || !rep.jobnimbus_id) return;
    const now = new Date(), end = new Date(now.getTime() + 15 * 864e5);
    api("rep-calendar-api", { action: "load", rep_jobnimbus_id: rep.jobnimbus_id, start: now.toISOString(), end: end.toISOString() })
      .then((o) => {
        setBlocked(new Set((o.blocks || []).map((b) => `${b.weekday}:${b.start_min}`)));
        setBooked(new Set((o.events || []).map((ev) => etApptKey(ev.start))));
        setDateBlocked(new Set((o.date_blocks || []).map((b) => `${b.date}:${b.start_min}`)));
      })
      .catch(() => {});
  }, [rep && rep.jobnimbus_id]); // eslint-disable-line react-hooks/exhaustive-deps
  const days = useMemo(() => buildRetailDays(14, blocked, booked, dateBlocked), [blocked, booked, dateBlocked]);
  const pick = async (slot) => {
    setPicking(slot.iso); setErr("");
    try {
      await api("retail-task-create", { inspection_id: deal.inspection_id, start_at_iso: slot.iso, rep_jobnimbus_id: rep.jobnimbus_id, booked_by: rep.name });
      setDone(`Retail appointment set for ${slot.label}. Added to JobNimbus.`);
    } catch (e) { setErr(e.message); }
    setPicking("");
  };
  const recordOutcome = async (outcome, label) => {
    if (!window.confirm(`Record this deal as "${label}"? It drops off your retail list.`)) return;
    setRecording(outcome); setErr("");
    try {
      await api("retail-outcome-set", { inspection_id: deal.inspection_id, outcome, rep_name: rep.name });
      setDone(`Recorded: ${label}. Removed from your retail list.`);
    } catch (e) { setErr(e.message); setRecording(""); }
  };
  if (done) return <div style={S.done}>✓ {done}</div>;
  const oBtn = (color, off) => ({ flex: 1, minWidth: 96, border: `1px solid ${color}`, color, background: "#fff", borderRadius: 12, padding: "11px 6px", fontSize: 13.5, fontWeight: 800, cursor: off ? "default" : "pointer", opacity: off ? 0.6 : 1 });
  const off = !!recording || !!picking;
  return (
    <div>
      {err && <div style={{ color: "#b91c1c", fontSize: 14, marginBottom: 8 }}>{err}</div>}
      <p style={{ fontSize: 14, fontWeight: 700, color: "#374151", margin: "0 0 6px" }}>Already sat with them? Record the outcome:</p>
      <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
        <button type="button" disabled={off} onClick={() => recordOutcome("sold", "Sit Sold")} style={oBtn("#047857", off)}>{recording === "sold" ? "…" : "✅ Sit Sold"}</button>
        <button type="button" disabled={off} onClick={() => recordOutcome("no_sale", "Sit - No Sale")} style={oBtn("#6b7280", off)}>{recording === "no_sale" ? "…" : "➖ No Sale"}</button>
        <button type="button" disabled={off} onClick={() => recordOutcome("ni", "Not Interested")} style={oBtn("#dc2626", off)}>{recording === "ni" ? "…" : "🚫 Not Interested"}</button>
      </div>
      <p style={{ fontSize: 14, fontWeight: 700, color: "#374151", margin: "0 0 8px" }}>…or schedule a retail appointment for later:</p>
      <div style={{ maxHeight: "55vh", overflowY: "auto" }}>
        {days.map((day) => (
          <div key={day.key} style={{ marginBottom: 14 }}>
            <p style={{ fontSize: 11.5, fontWeight: 800, textTransform: "uppercase", color: "#9ca3af", margin: "0 0 6px" }}>{day.label}</p>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {day.slots.map((s) => (
                <button key={s.iso} disabled={!!picking} onClick={() => pick(s)} style={{ border: "1px solid #d97706", color: "#d97706", background: "#fff", borderRadius: 12, padding: "9px 14px", fontSize: 14, fontWeight: 700, cursor: "pointer", opacity: picking ? 0.6 : 1 }}>
                  {picking === s.iso ? "…" : s.time}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
      <BtrPaBooking deal={deal} rep={rep} api={api} />
    </div>
  );
}

// ── ET date helpers (shared by the panels) ──────────────────────────────────
function ymdET(d = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}
function dayLabel(key) {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" });
}
function hourLabel(iso) {
  return new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric" }).format(new Date(iso));
}
function etParts(ms) {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "numeric", day: "numeric", weekday: "short" });
  const p = {}; for (const x of f.formatToParts(new Date(ms))) p[x.type] = x.value;
  const wmap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { y: +p.year, mo: +p.month, day: +p.day, weekday: wmap[p.weekday], wname: p.weekday };
}
function etToISO(y, mo, day, hour) {
  const guess = Date.UTC(y, mo - 1, day, hour, 0);
  const asEt = new Date(new Date(guess).toLocaleString("en-US", { timeZone: "America/New_York" }));
  return new Date(guess + (guess - asEt.getTime())).toISOString();
}
function etApptKey(iso) {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", hour12: false });
  const p = {}; for (const x of f.formatToParts(new Date(iso))) p[x.type] = x.value;
  return `${p.year}-${p.month}-${p.day}@${parseInt(p.hour, 10)}`;
}
function buildRetailDays(n, blocked = new Set(), booked = new Set(), dateBlocked = new Set()) {
  const now = Date.now(), out = [];
  for (let d = 0; d < n; d++) {
    const ms = now + d * 864e5;
    const { y, mo, day, weekday, wname } = etParts(ms);
    const dateStr = `${y}-${String(mo).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    const hours = (RETAIL_HOURS[weekday] || []).filter((h) => !blocked.has(`${weekday}:${h * 60}`) && !dateBlocked.has(`${dateStr}:${h * 60}`) && !booked.has(`${y}-${mo}-${day}@${h}`));
    if (!hours.length) continue;
    const slots = hours.map((h) => ({ iso: etToISO(y, mo, day, h), time: `${((h + 11) % 12) + 1}${h < 12 ? "am" : "pm"}`, label: `${wname} ${mo}/${day} ${((h + 11) % 12) + 1}${h < 12 ? "am" : "pm"}` }))
      .filter((s) => Date.parse(s.iso) > now);
    if (slots.length) out.push({ key: `${y}-${mo}-${day}`, label: `${wname}, ${mo}/${day}`, slots });
  }
  return out;
}
