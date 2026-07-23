import { useEffect, useState } from "react";
import { supabase } from "./lib/supabase";

// Appointment-Setter Portal (?mode=setter) — for inbound-call setters (Viviana
// + more later). Flow: who are you → type the homeowner's address (Google
// validated) → if they're already in JobNimbus pick them, else create a new
// account → pick a QUALIFIED rep (their zone, within 50 mi) + an open time →
// lead source → books the JN contact/job/Appointment task. Out-of-range appts
// are booked under the setter for a manager to assign.
//
// `Address` is the app's AddressAutocomplete component, passed in from App.jsx
// (it returns { address, city, state, zip, county, lat, lng }).
const FN = "/.netlify/functions";
const SETTERS = ["Viviana De Toro", "Hannah Davidson", "Dustin Hunt", "David Macella"];
// Retail lead sources (the 3 insurance ones — NEED, INS, Raw Insurance — are
// excluded; so are auto/internal values like Inspection & Foreman-*).
// "Instant Quote" = IQ, the default.
const SOURCES = ["Instant Quote", "Facebook", "AI Bot", "Harvesting", "Self Generated", "IHFB", "Referral", "Yard Sign", "Web Search"];

const C = {
  card: { background: "#fff", borderRadius: 14, padding: 18, boxShadow: "0 1px 3px rgba(0,0,0,.08)", marginBottom: 14 },
  h: { fontWeight: 800, fontSize: 16, color: "#1a2e5a", marginBottom: 10 },
  btn: { border: "none", borderRadius: 10, padding: "11px 16px", fontWeight: 800, fontSize: 15, cursor: "pointer" },
  input: { width: "100%", padding: "11px 12px", borderRadius: 10, border: "1px solid #cbd5e1", fontSize: 15, boxSizing: "border-box" },
  pill: (on) => ({ border: `1.5px solid ${on ? "#1a2e5a" : "#cbd5e1"}`, background: on ? "#1a2e5a" : "#fff", color: on ? "#fff" : "#334155", borderRadius: 999, padding: "7px 14px", fontWeight: 800, fontSize: 13, cursor: "pointer" }),
};

export default function SetterPortal({ Address }) {
  // Rep handoff (?as=<rep name>) — the rep dashboard's "Schedule a retail appt"
  // button opens this portal with the rep's identity carried along: the
  // who-are-you screen is skipped and the booking is credited to them. Doesn't
  // touch the saved setter_name, so a real setter's device keeps its identity.
  const fromRep = (() => { try { return new URLSearchParams(window.location.search).get("as") || ""; } catch { return ""; } })();
  const [token, setToken] = useState("");
  const [setter, setSetter] = useState(() => fromRep || localStorage.getItem("setter_name") || "");
  const [stage, setStage] = useState("search"); // search | schedule | done
  const [picked, setPicked] = useState(null);    // the Google-validated address
  const [matches, setMatches] = useState(null);   // JN search results (null=not run)
  const [searching, setSearching] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [form, setForm] = useState({ first: "", last: "", mobile: "", email: "" });
  const [client, setClient] = useState(null);     // chosen homeowner (existing or new)
  const [avail, setAvail] = useState(null);
  const [loadingAvail, setLoadingAvail] = useState(false);
  const [source, setSource] = useState("Instant Quote");
  const [chosen, setChosen] = useState(null);     // { iso, when }
  const [weekIdx, setWeekIdx] = useState(0);
  const [booking, setBooking] = useState(false);
  const [result, setResult] = useState(null);
  const [err, setErr] = useState("");
  const [todayOpen, setTodayOpen] = useState(false);
  const [today, setToday] = useState(null);
  const [pushing, setPushing] = useState(null);   // setter_appointment id being re-pushed to JN
  const [spanishOnly, setSpanishOnly] = useState(false);
  const [confirmDouble, setConfirmDouble] = useState(null); // {existing_iso,new_iso} when the homeowner already has an appt

  async function loadToday() {
    setToday(null);
    try {
      const r = await fetch(`${FN}/setter-appointments-list`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token, setter_name: setter }) });
      const o = await r.json();
      setToday(o.appointments || []);
    } catch { setToday([]); }
  }
  function openToday() { setTodayOpen(true); loadToday(); }

  // Re-push a booking whose JobNimbus sync failed (⚠ not synced to JN).
  async function pushToJn(id) {
    if (!id) return;
    setPushing(id);
    try {
      const r = await fetch(`${FN}/setter-book-appointment`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token, action: "resync", id }) });
      const o = await r.json().catch(() => ({}));
      if (!r.ok || !o.ok) alert(o.error || "Couldn't push to JobNimbus — try again in a moment.");
      await loadToday();
    } catch { alert("Network error — please try again."); }
    setPushing(null);
  }

  // Universal back — always a way out, one step at a time.
  function goBack() {
    if (todayOpen) { setTodayOpen(false); return; }
    if (stage === "schedule") { setStage("search"); setChosen(null); setErr(""); return; }
    if (stage === "done") { reset(); return; }
    setSetter(""); reset(); // from the search screen → change who you are
  }

  useEffect(() => { supabase.from("app_settings").select("value").eq("key", "visit_token").maybeSingle().then(({ data }) => setToken(data?.value || "")); }, []);
  useEffect(() => { if (setter && !fromRep) localStorage.setItem("setter_name", setter); }, [setter, fromRep]);

  function reset() { setStage("search"); setPicked(null); setMatches(null); setShowNew(false); setForm({ first: "", last: "", mobile: "", email: "" }); setClient(null); setAvail(null); setChosen(null); setResult(null); setErr(""); setConfirmDouble(null); }

  // Address picked from Google → search JobNimbus for an existing homeowner.
  async function onPick(p) {
    setPicked(p); setMatches(null); setShowNew(false); setClient(null); setErr("");
    if (!p?.address) return;
    setSearching(true);
    try {
      const r = await fetch(`${FN}/noc-api`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "search", q: p.address }) });
      const o = await r.json();
      setMatches(o.results || []);
    } catch { setMatches([]); }
    setSearching(false);
  }

  async function loadAvail(p) {
    setStage("schedule"); setLoadingAvail(true); setAvail(null); setChosen(null); setWeekIdx(0);
    try {
      const r = await fetch(`${FN}/setter-availability`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token, lat: p.lat, lng: p.lng, county: p.county, days: 14 }) });
      setAvail(await r.json());
    } catch { setAvail({ ok: false, error: "Could not load availability" }); }
    setLoadingAvail(false);
  }

  function useExisting(m) {
    setClient({ contact_id: m.contact_id, name: m.name || "Homeowner" });
    loadAvail(picked);
  }
  function useNew() {
    if (!form.first.trim() || !form.last.trim() || !form.mobile.trim()) { setErr("First name, last name and mobile are required."); return; }
    setErr("");
    setClient({ name: `${form.first} ${form.last}`.trim(), contact: { first_name: form.first.trim(), last_name: form.last.trim(), mobile: form.mobile.trim(), email: form.email.trim(), address: picked.address, city: picked.city, state: picked.state, zip: picked.zip } });
    loadAvail(picked);
  }

  async function book(confirm) {
    if (!chosen) { setErr("Pick a time first."); return; }
    setBooking(true); setErr("");
    const payload = { token, setter_name: setter, appt_iso: chosen.iso, source, spanish_only: spanishOnly, lat: picked.lat, lng: picked.lng, county: picked.county, homeowner_name: client.name, address: picked.formatted || [picked.address, picked.city, picked.state, picked.zip].filter(Boolean).join(", "), phone: client.contact?.mobile || undefined };
    if (client.contact_id) payload.contact_id = client.contact_id; else payload.contact = client.contact;
    if (confirm) payload.confirm = confirm;
    try {
      const r = await fetch(`${FN}/setter-book-appointment`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const o = await r.json();
      // This homeowner already has an appointment → let the setter decide.
      if (o.needs_confirm) { setConfirmDouble({ existing_iso: o.existing_iso, new_iso: o.new_iso }); setBooking(false); return; }
      if (o.kept) { setConfirmDouble(null); setResult({ ...o, kept: true }); setStage("done"); setBooking(false); return; }
      if (!o.ok) { setErr(o.error || "Booking failed."); setBooking(false); return; }
      setConfirmDouble(null); setResult(o); setStage("done");
    } catch { setErr("Network error."); }
    setBooking(false);
  }
  const fmtEt = (iso) => { try { return new Date(iso).toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }); } catch { return iso; } };

  const wrap = { maxWidth: 560, margin: "0 auto", padding: "18px 14px 60px" };
  const header = (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        {setter && <button onClick={goBack} title="Back" style={{ ...C.btn, background: "#2563eb", color: "#fff", padding: "6px 14px", fontSize: 15, boxShadow: "0 1px 3px rgba(37,99,235,.4)" }}>← Back</button>}
        <div style={{ fontWeight: 900, fontSize: 20, color: "#1a2e5a" }}>📞 Appointment Setter</div>
      </div>
      {setter && (
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={openToday} style={{ ...C.btn, background: "#eef2ff", color: "#1a2e5a", padding: "6px 12px", fontSize: 13 }}>📋 Today</button>
          <button onClick={() => { setSetter(""); reset(); }} style={{ ...C.btn, background: "#f1f5f9", color: "#334155", padding: "6px 12px", fontSize: 13 }}>{setter} ▾</button>
        </div>
      )}
    </div>
  );

  // ── Pick who you are ──────────────────────────────────────────────────────
  if (!setter) return (
    <div style={wrap}>
      <div style={{ fontWeight: 900, fontSize: 20, color: "#1a2e5a", marginBottom: 14 }}>📞 Appointment Setter</div>
      <div style={C.card}>
        <div style={C.h}>Who are you?</div>
        {SETTERS.map((s) => (
          <button key={s} onClick={() => setSetter(s)} style={{ ...C.btn, width: "100%", background: "#1a2e5a", color: "#fff", marginBottom: 8 }}>{s}</button>
        ))}
      </div>
    </div>
  );

  // ── Today's booked appointments ───────────────────────────────────────────
  if (todayOpen) return (
    <div style={wrap}>
      {header}
      <div style={C.card}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
          <div style={C.h}>📋 Booked today{today ? ` (${today.length})` : ""}</div>
          <button onClick={() => setTodayOpen(false)} style={{ ...C.btn, background: "#1a2e5a", color: "#fff", padding: "6px 12px", fontSize: 13 }}>+ New appointment</button>
        </div>
        {today === null && <div style={{ color: "#64748b" }}>Loading…</div>}
        {today && today.length === 0 && <div style={{ color: "#64748b" }}>No appointments booked today yet.</div>}
        {today && today.map((a, i) => (
          <div key={i} style={{ border: "1px solid #e2e8f0", borderRadius: 10, padding: 10, marginBottom: 8 }}>
            <div style={{ fontWeight: 800, fontSize: 14, color: "#1a2e5a" }}>{a.when} · {a.homeowner_name}</div>
            {a.address && <div style={{ fontSize: 12, color: "#64748b" }}>{a.address}</div>}
            <div style={{ fontSize: 12, color: "#475569", marginTop: 4 }}>
              {a.source && <span style={{ marginRight: 8 }}>{a.source === "Instant Quote" ? "IQ" : a.source}</span>}
              <span style={{ color: a.out_of_range ? "#92400e" : "#166534", fontWeight: 700 }}>{a.status}</span>
              {!a.jn_synced && (
                <span style={{ marginLeft: 8, display: "inline-flex", alignItems: "center", gap: 8 }}>
                  <span style={{ color: "#b91c1c", fontWeight: 800 }}>⚠ not synced to JN</span>
                  {a.id && <button type="button" disabled={pushing === a.id} onClick={() => pushToJn(a.id)}
                    style={{ ...C.btn, background: "#b91c1c", color: "#fff", padding: "3px 10px", fontSize: 12, fontWeight: 800 }}>
                    {pushing === a.id ? "Pushing…" : "🔄 Push to JN"}
                  </button>}
                </span>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );

  // ── Done ──────────────────────────────────────────────────────────────────
  if (stage === "done" && result) return (
    <div style={wrap}>
      {header}
      <div style={{ ...C.card, textAlign: "center" }}>
        <div style={{ fontSize: 40 }}>{result.kept ? "👍" : "✅"}</div>
        <div style={{ fontWeight: 900, fontSize: 18, color: "#166534", margin: "8px 0" }}>{result.kept ? "Kept their existing appointment" : "Appointment booked!"}</div>
        <div style={{ fontSize: 14, color: "#334155" }}>{client?.name} — {result.kept ? fmtEt(result.existing_iso) : chosen?.when}</div>
        {result.reset && <div style={{ fontSize: 13, color: "#1d4ed8", marginTop: 6, fontWeight: 700 }}>↻ Reschedule — booked as a Reset Appointment (this was a No-Sit lead).</div>}
        {result.out_of_range && <div style={{ fontSize: 13, color: "#92400e", marginTop: 6 }}>⚠️ Outside rep range — a manager will assign a rep.</div>}
        {result.jn_ok === false && <div style={{ fontSize: 13, color: "#b91c1c", marginTop: 6, fontWeight: 700 }}>⚠️ Saved here, but the JobNimbus sync failed — it's in your "Today" list for a manager to repair.</div>}
        <button onClick={reset} style={{ ...C.btn, background: "#1a2e5a", color: "#fff", marginTop: 16 }}>Set another appointment</button>
        <button onClick={openToday} style={{ ...C.btn, background: "#eef2ff", color: "#1a2e5a", marginTop: 8 }}>📋 View today's appointments</button>
      </div>
    </div>
  );

  // ── Schedule ──────────────────────────────────────────────────────────────
  if (stage === "schedule") {
    const oor = avail?.out_of_radius;
    const allDays = oor ? (avail?.generic_days || []) : (avail?.days || []);
    const weeks = groupWeeks(allDays);
    const week = weeks[Math.min(weekIdx, Math.max(0, weeks.length - 1))];
    return (
      <div style={wrap}>
        {header}
        <div style={C.card}>
          <div style={{ fontSize: 13, color: "#64748b" }}>Homeowner</div>
          <div style={{ fontWeight: 800, fontSize: 16, color: "#1a2e5a" }}>{client?.name}</div>
          <div style={{ fontSize: 13, color: "#64748b" }}>{picked?.formatted || picked?.address}</div>
          <button onClick={() => setStage("search")} style={{ ...C.btn, background: "#f1f5f9", color: "#334155", padding: "6px 12px", fontSize: 13, marginTop: 8 }}>← change</button>
        </div>

        {/* Lead source */}
        <div style={C.card}>
          <div style={C.h}>Lead source</div>
          <div style={{ display: "flex", gap: 8 }}>
            {SOURCES.map((s) => <button key={s} onClick={() => setSource(s)} style={C.pill(source === s)}>{s === "Instant Quote" ? "IQ (Instant Quote)" : s}</button>)}
          </div>
        </div>

        {/* Spanish only — adds "Spanish only" to the JN job name so the rep knows */}
        <div style={C.card}>
          <div style={C.h}>Language</div>
          <button onClick={() => setSpanishOnly((v) => !v)} style={C.pill(spanishOnly)}>
            {spanishOnly ? "✓ Spanish only" : "🗣️ Spanish only"}
          </button>
        </div>

        {/* Times — a week at a time, slots only (a free rep is assigned for you) */}
        <div style={C.card}>
          <div style={C.h}>Pick a time</div>
          {loadingAvail && <div style={{ color: "#64748b" }}>Finding open times…</div>}
          {!loadingAvail && avail && !avail.ok && <div style={{ color: "#dc2626" }}>{avail.error}</div>}

          {!loadingAvail && oor && (
            <div style={{ background: "#fef3c7", border: "1px solid #fcd34d", borderRadius: 10, padding: 10, fontSize: 13, color: "#92400e", marginBottom: 10 }}>
              ⚠️ No qualified rep within 50 miles. You can still book — it'll go under <b>{setter}</b> for a manager to assign a rep.
            </div>
          )}

          {!loadingAvail && avail?.ok && (
            <>
              {weeks.length > 1 && (
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                  <button onClick={() => setWeekIdx((i) => Math.max(0, i - 1))} disabled={weekIdx <= 0} style={navBtn(weekIdx <= 0)}>← Earlier</button>
                  <div style={{ fontWeight: 800, fontSize: 13, color: "#475569" }}>{week?.label}</div>
                  <button onClick={() => setWeekIdx((i) => Math.min(weeks.length - 1, i + 1))} disabled={weekIdx >= weeks.length - 1} style={navBtn(weekIdx >= weeks.length - 1)}>Next week →</button>
                </div>
              )}
              {week ? week.days.map((d) => (
                <DayRow key={d.date} d={d} chosen={chosen} onPick={(slot) => setChosen({ iso: slot.iso, when: `${d.label} · ${slot.label}` })} />
              )) : <div style={{ color: "#64748b" }}>No open times available.</div>}
            </>
          )}
        </div>

        {err && <div style={{ color: "#dc2626", fontSize: 14, marginBottom: 10 }}>{err}</div>}
        <button onClick={() => book()} disabled={!chosen || booking}
          style={{ ...C.btn, width: "100%", background: chosen ? "#16a34a" : "#94a3b8", color: "#fff", cursor: chosen ? "pointer" : "not-allowed" }}>
          {booking ? "Booking…" : chosen ? `Book — ${chosen.when}` : "Pick a time"}
        </button>

        {/* Already has an appointment → change it or keep it. */}
        {confirmDouble && (
          <div style={{ position: "fixed", inset: 0, background: "rgba(15,23,42,.55)", zIndex: 4000, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }} onClick={() => !booking && setConfirmDouble(null)}>
            <div onClick={(e) => e.stopPropagation()} style={{ background: "#fff", borderRadius: 16, padding: "20px 20px 18px", maxWidth: 420, width: "100%", boxShadow: "0 10px 40px rgba(0,0,0,.3)" }}>
              <div style={{ fontWeight: 900, fontSize: 17, color: "#b45309", marginBottom: 6 }}>⚠️ Already has an appointment</div>
              <div style={{ fontSize: 14, color: "#334155", lineHeight: 1.5, marginBottom: 14 }}>
                <b>{client?.name || "This homeowner"}</b> already has an appointment:
                <div style={{ margin: "8px 0", padding: "8px 12px", background: "#fffbeb", border: "1px solid #fcd34d", borderRadius: 10, fontWeight: 800, color: "#92400e" }}>📅 {fmtEt(confirmDouble.existing_iso)}</div>
                Change it to the new time, or keep the one they have?
                <div style={{ margin: "8px 0 0", padding: "8px 12px", background: "#ecfdf5", border: "1px solid #86efac", borderRadius: 10, fontWeight: 800, color: "#065f46" }}>🆕 {fmtEt(confirmDouble.new_iso)}</div>
              </div>
              <div style={{ display: "flex", gap: 10 }}>
                <button onClick={() => book("reschedule")} disabled={booking} style={{ ...C.btn, flex: 1, background: "#16a34a", color: "#fff" }}>{booking ? "…" : "Change to new time"}</button>
                <button onClick={() => book("keep")} disabled={booking} style={{ ...C.btn, flex: 1, background: "#f1f5f9", color: "#334155" }}>Keep existing</button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  // ── Search / new account ──────────────────────────────────────────────────
  return (
    <div style={wrap}>
      {header}
      <div style={C.card}>
        <div style={C.h}>Homeowner address</div>
        <div style={{ fontSize: 13, color: "#64748b", marginBottom: 8 }}>Start typing the address — we'll check JobNimbus for an existing account.</div>
        <Address value={picked?.formatted || ""} onPlaceSelected={onPick} placeholder="123 Main St, City, FL" />
      </div>

      {searching && <div style={{ color: "#64748b", padding: "0 4px" }}>Searching JobNimbus…</div>}

      {picked && matches !== null && !searching && (
        <div style={C.card}>
          {matches.length > 0 && !showNew && (
            <>
              <div style={C.h}>Found in JobNimbus</div>
              {matches.map((m) => (
                <button key={m.contact_id} onClick={() => useExisting(m)}
                  style={{ ...C.btn, width: "100%", textAlign: "left", background: "#f8fafc", color: "#1a2e5a", border: "1px solid #e2e8f0", marginBottom: 8 }}>
                  <div style={{ fontWeight: 800 }}>{m.name || "(no name)"}</div>
                  <div style={{ fontSize: 12, color: "#64748b", fontWeight: 600 }}>{[m.address, m.city, m.state, m.zip].filter(Boolean).join(", ")}</div>
                </button>
              ))}
              <button onClick={() => setShowNew(true)} style={{ ...C.btn, width: "100%", background: "#fff", color: "#1a2e5a", border: "1.5px dashed #94a3b8" }}>+ None of these — create new account</button>
            </>
          )}
          {(matches.length === 0 || showNew) && (
            <>
              <div style={C.h}>{matches.length === 0 ? "Not in JobNimbus — create new account" : "New account"}</div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 8 }}>
                <input style={C.input} placeholder="First name *" value={form.first} onChange={(e) => setForm({ ...form, first: e.target.value })} />
                <input style={C.input} placeholder="Last name *" value={form.last} onChange={(e) => setForm({ ...form, last: e.target.value })} />
              </div>
              <input style={{ ...C.input, marginBottom: 8 }} placeholder="Mobile phone *" value={form.mobile} onChange={(e) => setForm({ ...form, mobile: e.target.value })} />
              <input style={{ ...C.input, marginBottom: 8 }} placeholder="Email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
              <div style={{ fontSize: 12, color: "#64748b", marginBottom: 10 }}>📍 {picked.formatted || [picked.address, picked.city, picked.state, picked.zip].filter(Boolean).join(", ")}</div>
              {err && <div style={{ color: "#dc2626", fontSize: 13, marginBottom: 8 }}>{err}</div>}
              <button onClick={useNew} style={{ ...C.btn, width: "100%", background: "#1a2e5a", color: "#fff" }}>Continue →</button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// Group day-rows into calendar weeks (Mon-started) so the setter sees one week
// at a time — they're booking tomorrow / this week anyway.
function mondayKey(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() - ((dt.getDay() + 6) % 7));
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
}
function groupWeeks(days) {
  const m = new Map();
  for (const d of days) { const k = mondayKey(d.date); if (!m.has(k)) m.set(k, []); m.get(k).push(d); }
  return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]))
    .map(([, ds]) => ({ days: ds, label: ds.length ? `${ds[0].label} – ${ds[ds.length - 1].label}` : "" }));
}
const navBtn = (disabled) => ({ border: "1px solid #cbd5e1", background: disabled ? "#f1f5f9" : "#fff", color: disabled ? "#94a3b8" : "#1a2e5a", borderRadius: 8, padding: "6px 11px", fontWeight: 800, fontSize: 12, cursor: disabled ? "default" : "pointer" });

function DayRow({ d, chosen, onPick }) {
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ fontSize: 12, fontWeight: 800, color: "#475569", marginBottom: 4 }}>{d.label}</div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {d.slots.map((s) => {
          const on = chosen?.iso === s.iso;
          return <button key={s.iso} onClick={() => onPick(s)}
            style={{ border: `1.5px solid ${on ? "#16a34a" : "#cbd5e1"}`, background: on ? "#dcfce7" : "#fff", color: on ? "#166534" : "#334155", borderRadius: 10, padding: "7px 12px", fontSize: 13, fontWeight: 800, cursor: "pointer" }}>{s.label}{on ? " ✓" : ""}</button>;
        })}
      </div>
    </div>
  );
}
