// Harvesting Map — rep links & access (?mode=harvestlinks). Office-only.
// The office's own "view all" map link, an Admins list (people with their own
// view-all link), and every rep's personal link with their level. The office
// can promote anyone to Admin (view-all) or set senior/junior from here.
import React, { useEffect, useState } from "react";
import HarvestNav from "./HarvestNav";

const FONT = "'Nunito', system-ui, sans-serif";
const OSWALD = "'Oswald', sans-serif";
const esc = (s) => String(s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const money = (n) => `$${Number(n || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export default function HarvestLinks() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState("");
  const [copied, setCopied] = useState("");
  const [q, setQ] = useState("");
  const [assignQ, setAssignQ] = useState("");
  const [saving, setSaving] = useState("");   // rep id currently saving
  const [note, setNote] = useState("");
  const [week, setWeek] = useState(null);     // this week's TMS trainees
  const [granting, setGranting] = useState(""); // phone being granted
  const [invoice, setInvoice] = useState(null); // generated monthly invoice
  const [invBusy, setInvBusy] = useState(false);
  const [sendingId, setSendingId] = useState(""); // rep id currently being sent their link

  // Admin token (needed for the invoice call) is embedded in the office link.
  const adminTok = (data?.admin_link || "").match(/admin=([^&]+)/)?.[1] || "";
  // Text + email a rep their personal link (both channels — a text alone misses
  // anyone on DND/opted out), then refresh so the "✓ Sent" flag shows.
  const sendLink = async (r) => {
    if (!adminTok) { setNote("⚠️ Office link not loaded yet — try again in a moment."); return; }
    setSendingId(r.id); setNote("");
    try {
      const res = await fetch("/.netlify/functions/harvest-send-link", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ admin: adminTok, rep_id: r.id }),
      });
      const j = await res.json();
      if (!j.ok) setNote(`⚠️ ${j.error || "Couldn't send the link."}`);
      else { setNote(`✓ ${j.name} — link sent${j.sent_sms ? " 📲" : ""}${j.sent_email ? " ✉️" : ""}.`); await load(); }
    } catch { setNote("⚠️ Network error — try again."); }
    setSendingId("");
  };
  // Send button + "already sent" flag, shown on every link card (admins/trainees/reps).
  const sendCell = (r) => {
    const noContact = !r.phone && !r.email;
    return (
      <>
        <button type="button" disabled={sendingId === r.id || noContact} onClick={() => sendLink(r)}
          title={noContact ? "No phone or email on file for this rep" : "Text + email them their link"}
          style={{ ...btn, ...(noContact ? { opacity: 0.45, cursor: "not-allowed" } : {}) }}>
          {sendingId === r.id ? "Sending…" : r.sent_at ? "Resend" : "📲 Send link"}
        </button>
        {r.sent_at && (
          <span title={new Date(r.sent_at).toLocaleString()}
            style={{ fontSize: 11.5, fontWeight: 800, color: "#166534", background: "#dcfce7", border: "1px solid #86efac", borderRadius: 999, padding: "3px 8px", whiteSpace: "nowrap" }}>
            ✓ Sent {fmtSent(r.sent_at)}
          </span>
        )}
      </>
    );
  };
  const genInvoice = async () => {
    if (!adminTok) { setNote("⚠️ Office link not loaded yet — try again in a moment."); return; }
    setInvBusy(true); setNote("");
    try {
      const r = await fetch(`/.netlify/functions/harvest-invoice?admin=${encodeURIComponent(adminTok)}`);
      const j = await r.json().catch(() => ({}));
      if (!j.ok) setNote(`⚠️ ${j.error || "couldn't generate invoice"}`);
      else setInvoice(j);
    } catch (e) { setNote(`⚠️ ${e.message || "network error"}`); }
    finally { setInvBusy(false); }
  };
  const printInvoice = () => {
    if (!invoice) return;
    const rows = invoice.people.map((p, i) => `<tr><td style="padding:4px 10px;color:#64748b">${i + 1}</td><td style="padding:4px 10px">${esc(p.name)}</td><td style="padding:4px 10px;color:#64748b;text-transform:capitalize">${esc(p.level || "")}</td></tr>`).join("");
    const money = (n) => `$${Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    const html = `<!doctype html><html><head><title>Harvesting Map Invoice — ${esc(invoice.month)}</title><style>body{font-family:system-ui,sans-serif;color:#0f172a;max-width:680px;margin:32px auto;padding:0 20px}h1{font-size:22px;margin:0 0 2px}table{width:100%;border-collapse:collapse;font-size:13.5px;margin-top:8px}th{text-align:left;color:#64748b;font-size:11px;text-transform:uppercase;letter-spacing:.04em;padding:4px 10px;border-bottom:1px solid #e5e7eb}tr:nth-child(even){background:#f8fafc}</style></head><body>
      <h1>🌾 Harvesting Map — Invoice</h1>
      <div style="color:#64748b;font-size:14px;margin-bottom:18px">Billing period: <b>${esc(invoice.month)}</b></div>
      <div style="border:1px solid #e5e7eb;border-radius:12px;padding:16px 18px;margin-bottom:18px">
        <div style="display:flex;justify-content:space-between;font-size:15px"><span>Harvesting Map access — ${invoice.count} ${invoice.count === 1 ? "person" : "people"} × ${money(invoice.rate)}</span><b>${money(invoice.total)}</b></div>
        <div style="border-top:2px solid #0f172a;margin-top:12px;padding-top:10px;display:flex;justify-content:space-between;font-size:18px;font-weight:800"><span>Total due</span><span>${money(invoice.total)}</span></div>
      </div>
      <div style="font-size:12px;color:#94a3b8;margin-bottom:6px">People with map access (${invoice.count}):</div>
      <table><thead><tr><th>#</th><th>Name</th><th>Level</th></tr></thead><tbody>${rows}</tbody></table>
      <div style="margin-top:24px;color:#94a3b8;font-size:11px">Generated ${new Date().toLocaleDateString("en-US")}</div>
    </body></html>`;
    const w = window.open("", "_blank");
    if (!w) { setNote("⚠️ Allow pop-ups to print the invoice."); return; }
    w.document.write(html); w.document.close(); w.focus(); setTimeout(() => w.print(), 300);
  };

  const load = async () => {
    try {
      const r = await fetch("/.netlify/functions/harvest-rep-links");
      const j = await r.json().catch(() => ({}));
      if (!j.ok) { setErr(j.error || "Couldn't load."); return; }
      setErr("");
      setData(j);
    } catch (e) { setErr(e.message || "Network error"); }
  };
  const loadWeek = async () => {
    try {
      const r = await fetch("/.netlify/functions/harvest-trainees");
      const j = await r.json().catch(() => ({}));
      if (j.ok) setWeek(j.trainees || []);
    } catch { /* non-fatal */ }
  };
  useEffect(() => { load(); loadWeek(); }, []);

  // Grant a trainee map access (trainee level) + text them their link.
  const grantTrainee = async (t) => {
    setGranting(t.phone); setNote("");
    try {
      const r = await fetch("/.netlify/functions/harvest-trainees", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "grant", name: t.name, phone: t.phone }),
      });
      const j = await r.json().catch(() => ({}));
      if (!j.ok) { setNote(`⚠️ ${t.name}: ${j.error || "couldn't grant"}`); }
      else {
        const via = [j.sent && "texted 📲", j.emailed && "emailed ✉️"].filter(Boolean).join(" + ");
        setNote(`✓ ${t.name} — access granted${via ? ` and link ${via}` : " (couldn't text or email — copy the link)"}.`);
        await loadWeek(); await load();
      }
    } catch (e) { setNote(`⚠️ ${e.message || "network error"}`); }
    finally { setGranting(""); }
  };

  const copy = (text, id) => {
    try { navigator.clipboard.writeText(text); setCopied(id); setTimeout(() => setCopied(""), 1500); }
    catch { window.prompt("Copy this link:", text); }
  };
  // Office "Open" = a spot-check link: appends the admin token (adminTok, above) so it
  // bypasses the rep training gate and shows the rep's actual map. "Copy link" stays the
  // plain rep link (what you hand the rep — still gated by their training).
  const spot = (link) => (adminTok && link ? `${link}${link.includes("?") ? "&" : "?"}admin=${encodeURIComponent(adminTok)}` : link);

  // Set (or clear) a person's harvest level, then refresh the roster.
  const setLevel = async (repId, level, name) => {
    setSaving(repId); setNote("");
    try {
      const r = await fetch("/.netlify/functions/harvest-set-level", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rep_id: repId, level: level || "none" }),
      });
      const j = await r.json().catch(() => ({}));
      if (!j.ok) { setNote(`⚠️ ${name}: ${j.error || "couldn't save"}`); }
      else {
        const label = !level ? "set to default (zone level)" : level === "admin" ? "made an Admin (view-all)" : `set to ${level}`;
        setNote(`✓ ${name} ${label}.`);
        setAssignQ("");
        await load();
      }
    } catch (e) { setNote(`⚠️ ${e.message || "network error"}`); }
    finally { setSaving(""); }
  };

  const admins = data?.admins || [];
  const reps = (data?.reps || []).filter((r) => !q.trim() || (r.name || "").toLowerCase().includes(q.toLowerCase()));
  // Assign picker: match anyone in the full roster (min 2 chars), cap the list.
  const cardedIds = new Set([...(data?.admins || []), ...(data?.trainees || []), ...(data?.reps || [])].map((c) => c.id));
  const matches = assignQ.trim().length >= 2
    ? (data?.all || []).filter((r) => (r.name || "").toLowerCase().includes(assignQ.toLowerCase())).slice(0, 8)
    : [];

  return (
    <div style={{ maxWidth: 820, margin: "0 auto", padding: "20px 16px 60px", fontFamily: FONT }}>
      <HarvestNav active="links" />
      <div style={{ fontSize: 22, fontWeight: 800, fontFamily: OSWALD, marginBottom: 4 }}>🔗 Rep Links &amp; Access</div>
      <div style={{ fontSize: 13.5, color: "#64748b", marginBottom: 16 }}>Each person opens their <b>personal link</b> to work the map. <b>Admins</b> see every pin (view-all); reps see only what their level (senior / junior) allows.</div>

      {err && <div style={{ color: "#b91c1c", fontSize: 13.5, marginBottom: 12 }}>{err}</div>}
      {note && <div style={{ color: note[0] === "✓" ? "#15803d" : "#b45309", fontSize: 13, marginBottom: 12, fontWeight: 700 }}>{note}</div>}
      {!data && !err ? <div style={{ color: "#94a3b8", fontSize: 13 }}>Loading…</div> : null}

      {data?.admin_link && (
        <div style={{ background: "#f5f3ff", border: "1px solid #ddd6fe", borderRadius: 12, padding: 14, marginBottom: 20, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <span style={{ fontSize: 11, fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.04em", background: "#7c3aed", color: "#fff", padding: "3px 10px", borderRadius: 10 }}>Office</span>
          <div style={{ fontSize: 14, fontWeight: 700, color: "#4c1d95" }}>Your view — every pin</div>
          <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
            <a href={data.admin_link} target="_blank" rel="noreferrer" style={{ fontSize: 13, fontWeight: 700, color: "#fff", background: "#7c3aed", borderRadius: 8, padding: "7px 14px", textDecoration: "none" }}>Open map ↗</a>
            <button type="button" onClick={() => copy(data.admin_link, "admin")} style={btn}>{copied === "admin" ? "✓ Copied" : "Copy link"}</button>
          </div>
        </div>
      )}

      {/* Monthly invoice — bills $40 per person who had a map seat this month. */}
      {data && (
        <div style={{ background: "#f0fdf4", border: "1px solid #86efac", borderRadius: 12, padding: 14, marginBottom: 22 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <div>
              <div style={{ fontSize: 15, fontWeight: 800, fontFamily: OSWALD, color: "#166534" }}>💵 Monthly Invoice</div>
              <div style={{ fontSize: 12.5, color: "#15803d" }}>$40 per person with map access this month.</div>
            </div>
            <button type="button" onClick={genInvoice} disabled={invBusy}
              style={{ marginLeft: "auto", fontSize: 13.5, fontWeight: 800, color: "#fff", background: "#16a34a", border: "none", borderRadius: 10, padding: "10px 16px", cursor: "pointer", opacity: invBusy ? 0.6 : 1 }}>
              {invBusy ? "…" : invoice ? "↻ Recalculate" : "Generate invoice"}
            </button>
          </div>
          {invoice && (
            <div style={{ marginTop: 12, background: "#fff", border: "1px solid #d1fae5", borderRadius: 10, padding: "14px 16px" }}>
              <div style={{ fontSize: 12, color: "#64748b", marginBottom: 8 }}>Billing period: <b style={{ color: "#0f172a" }}>{invoice.month}</b></div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", fontSize: 14.5 }}>
                <span>Harvesting Map access — <b>{invoice.count}</b> {invoice.count === 1 ? "person" : "people"} × {money(invoice.rate)}</span>
                <span style={{ fontWeight: 800 }}>{money(invoice.total)}</span>
              </div>
              <div style={{ borderTop: "2px solid #0f172a", marginTop: 10, paddingTop: 8, display: "flex", justifyContent: "space-between", fontSize: 18, fontWeight: 800 }}>
                <span>Total due</span><span>{money(invoice.total)}</span>
              </div>
              <div style={{ marginTop: 12, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                <button type="button" onClick={printInvoice} style={{ ...btn, borderColor: "#16a34a", color: "#166534" }}>🖨 Print / Save PDF</button>
                <span style={{ fontSize: 11.5, color: "#94a3b8" }}>{invoice.count} with a seat this month — tap Print for the itemized list.</span>
              </div>
            </div>
          )}
        </div>
      )}

      {/* This week's field trainees (from the training system). One tap grants
          map access at TRAINEE level (junior pins) + texts them their link. */}
      {week && week.length > 0 && (
        <div style={{ background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 12, padding: 14, marginBottom: 22 }}>
          <div style={{ fontSize: 15, fontWeight: 800, fontFamily: OSWALD, marginBottom: 2 }}>🎓 This week's trainees ({week.length})</div>
          <div style={{ fontSize: 12.5, color: "#92400e", marginBottom: 10 }}>They knock + sign starting day 2. Tap to give them map access and <b>text them their link</b>.</div>
          <div style={{ display: "grid", gap: 6 }}>
            {week.map((t) => (
              <div key={t.phone || t.name} style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", border: "1px solid #fde68a", borderRadius: 10, padding: "9px 12px", background: "#fff" }}>
                <span style={{ fontSize: 14, fontWeight: 700 }}>{t.name}</span>
                <span style={{ fontSize: 12, color: "#94a3b8" }}>{t.phone}</span>
                <div style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
                  {t.has_access ? (
                    <>
                      <span style={{ fontSize: 11.5, fontWeight: 800, color: "#166534" }}>✓ has access</span>
                      <button type="button" onClick={() => copy(t.link, t.link)} style={btn}>{copied === t.link ? "✓ Copied" : "Copy link"}</button>
                      <button type="button" disabled={granting === t.phone} onClick={() => grantTrainee(t)} style={btn}>{granting === t.phone ? "…" : "Re-text link"}</button>
                    </>
                  ) : (
                    <button type="button" disabled={granting === t.phone || !t.phone} onClick={() => grantTrainee(t)} style={{ ...pill, background: "#d97706" }}>{granting === t.phone ? "…" : "📲 Grant access & text link"}</button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {data && (
        <>
          {/* Assign access — promote anyone to Admin (view-all) or set their level. */}
          <div style={{ background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 12, padding: 14, marginBottom: 22 }}>
            <div style={{ fontSize: 14, fontWeight: 800, fontFamily: OSWALD, marginBottom: 2 }}>➕ Give someone access</div>
            <div style={{ fontSize: 12.5, color: "#64748b", marginBottom: 10 }}>Search a name, then pick <b>Admin</b> (sees all pins on their own link), <b>Senior</b>, or <b>Junior</b>.</div>
            <input value={assignQ} onChange={(e) => setAssignQ(e.target.value)} placeholder="Type a name…" style={{ fontSize: 13.5, padding: "8px 11px", borderRadius: 8, border: "1px solid #cbd5e1", width: "100%", maxWidth: 340, boxSizing: "border-box" }} />
            {matches.length > 0 && (
              <div style={{ display: "grid", gap: 6, marginTop: 10 }}>
                {matches.map((m) => (
                  <div key={m.id} style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", border: "1px solid #e5e7eb", borderRadius: 10, padding: "8px 11px", background: "#fff" }}>
                    <span style={{ fontSize: 13.5, fontWeight: 700 }}>{m.name}</span>
                    {cardedIds.has(m.id) && <span style={{ fontSize: 11, color: "#94a3b8" }}>(already listed{m.override ? ` · ${m.override}` : ""})</span>}
                    <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
                      <button type="button" disabled={saving === m.id} onClick={() => setLevel(m.id, "admin", m.name)} style={{ ...pill, background: "#7c3aed" }}>{saving === m.id ? "…" : "Admin"}</button>
                      <button type="button" disabled={saving === m.id} onClick={() => setLevel(m.id, "senior", m.name)} style={{ ...pill, background: "#16a34a" }}>Senior</button>
                      <button type="button" disabled={saving === m.id} onClick={() => setLevel(m.id, "junior", m.name)} style={{ ...pill, background: "#334155" }}>Junior</button>
                      <button type="button" disabled={saving === m.id} onClick={() => setLevel(m.id, "trainee", m.name)} style={{ ...pill, background: "#d97706" }}>Trainee</button>
                    </div>
                  </div>
                ))}
              </div>
            )}
            {assignQ.trim().length >= 2 && matches.length === 0 && <div style={{ fontSize: 12.5, color: "#94a3b8", marginTop: 8 }}>No match.</div>}
          </div>

          {/* Admins — view-all links. */}
          {admins.length > 0 && (
            <div style={{ marginBottom: 22 }}>
              <div style={{ fontSize: 16, fontWeight: 800, fontFamily: OSWALD, marginBottom: 8 }}>👑 Admins — view all ({admins.length})</div>
              <div style={{ display: "grid", gap: 6 }}>
                {admins.map((r) => (
                  <div key={r.id} style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", border: "1px solid #ddd6fe", borderRadius: 10, padding: "9px 12px", background: "#faf5ff" }}>
                    <span style={{ fontSize: 10.5, fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.04em", background: "#7c3aed", color: "#fff", padding: "2px 8px", borderRadius: 10 }}>admin</span>
                    <span style={{ fontSize: 14, fontWeight: 700 }}>{r.name}</span>
                    <div style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
                      <LevelSelect card={r} disabled={saving === r.id} onPick={(lv) => setLevel(r.id, lv, r.name)} />
                      <a href={spot(r.link)} target="_blank" rel="noreferrer" style={{ fontSize: 12.5, fontWeight: 700, color: "#7c3aed", textDecoration: "none" }}>Open ↗</a>
                      <button type="button" onClick={() => copy(r.link, r.link)} style={btn}>{copied === r.link ? "✓ Copied" : "Copy link"}</button>
                      {sendCell(r)}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Trainees — junior-visibility links, tagged distinctly. */}
          {(data.trainees || []).length > 0 && (
            <div style={{ marginBottom: 22 }}>
              <div style={{ fontSize: 16, fontWeight: 800, fontFamily: OSWALD, marginBottom: 8 }}>🎓 Trainees ({data.trainees.length})</div>
              <div style={{ display: "grid", gap: 6 }}>
                {data.trainees.map((r) => (
                  <div key={r.id} style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", border: "1px solid #fde68a", borderRadius: 10, padding: "9px 12px", background: "#fffbeb" }}>
                    <span style={{ fontSize: 10.5, fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.04em", background: "#d97706", color: "#fff", padding: "2px 8px", borderRadius: 10 }}>trainee</span>
                    <span style={{ fontSize: 14, fontWeight: 700 }}>{r.name}</span>
                    <div style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
                      <LevelSelect card={r} disabled={saving === r.id} onPick={(lv) => setLevel(r.id, lv, r.name)} />
                      <a href={spot(r.link)} target="_blank" rel="noreferrer" style={{ fontSize: 12.5, fontWeight: 700, color: "#b45309", textDecoration: "none" }}>Open ↗</a>
                      <button type="button" onClick={() => copy(r.link, r.link)} style={btn}>{copied === r.link ? "✓ Copied" : "Copy link"}</button>
                      {sendCell(r)}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Reps — level links, grouped by region. */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 10, marginBottom: 8 }}>
            <div style={{ fontSize: 16, fontWeight: 800, fontFamily: OSWALD }}>Reps ({data.reps.length})</div>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search reps…" style={{ fontSize: 13, padding: "7px 10px", borderRadius: 8, border: "1px solid #cbd5e1", minWidth: 180 }} />
          </div>
          <div style={{ display: "grid", gap: 6 }}>
            {reps.map((r, i) => {
              const showRegion = i === 0 || r.region !== reps[i - 1].region;
              return (
              <React.Fragment key={r.id}>
                {showRegion && <div style={{ fontSize: 13, fontWeight: 800, fontFamily: OSWALD, color: "#0f172a", margin: i === 0 ? "0 0 2px" : "12px 0 2px" }}>📍 {r.region || "No region"}</div>}
                <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", border: "1px solid #e5e7eb", borderRadius: 10, padding: "9px 12px", background: "#fff" }}>
                <span style={{ fontSize: 10.5, fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.04em", background: r.level === "senior" ? "#16a34a" : "#334155", color: "#fff", padding: "2px 8px", borderRadius: 10 }}>{r.level}{r.override ? " ·set" : ""}</span>
                <span style={{ fontSize: 14, fontWeight: 700 }}>{r.name}</span>
                <div style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
                  <LevelSelect card={r} disabled={saving === r.id} onPick={(lv) => setLevel(r.id, lv, r.name)} />
                  <a href={spot(r.link)} target="_blank" rel="noreferrer" style={{ fontSize: 12.5, fontWeight: 700, color: "#0e7490", textDecoration: "none" }}>Open ↗</a>
                  <button type="button" onClick={() => copy(r.link, r.link)} style={btn}>{copied === r.link ? "✓ Copied" : "Copy link"}</button>
                      {sendCell(r)}
                </div>
              </div>
              </React.Fragment>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

// Per-person level dropdown. Value reflects the explicit office override; picking
// "Default" clears it (rep falls back to their rep-zones level).
function LevelSelect({ card, disabled, onPick }) {
  return (
    <select
      value={card.override || ""}
      disabled={disabled}
      onChange={(e) => onPick(e.target.value)}
      title="Set access level"
      style={{ fontSize: 12, fontWeight: 700, color: "#334155", background: "#fff", border: "1px solid #cbd5e1", borderRadius: 8, padding: "5px 7px", cursor: "pointer" }}
    >
      <option value="">Default{card.region ? " (zone)" : ""}</option>
      <option value="admin">Admin · view all</option>
      <option value="senior">Senior</option>
      <option value="junior">Junior</option>
      <option value="trainee">Trainee</option>
    </select>
  );
}

const btn = { fontSize: 12.5, fontWeight: 700, color: "#334155", background: "#fff", border: "1px solid #cbd5e1", borderRadius: 8, padding: "6px 12px", cursor: "pointer" };
// "Jul 17" for the ✓ Sent flag.
function fmtSent(iso) {
  try { return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" }); } catch { return ""; }
}
const pill = { fontSize: 12, fontWeight: 800, color: "#fff", border: "none", borderRadius: 8, padding: "6px 12px", cursor: "pointer" };
