import { useEffect, useMemo, useState } from "react";
import { supabase } from "./lib/supabase";
import InspectionPhotosModal from "./InspectionPhotosModal";

// Public rep landing: "Who are you?" → 4 choices → (per outcome) pick a
// homeowner (their deals, nearest-first) → view photos → take the action.
// Self-contained early-return page. CCG uses INLINE STYLES (no Tailwind).

const FN = "/.netlify/functions";
const NAVY = "#1a2e5a";
const RETAIL_HOURS = { 1: [11, 14, 17, 19], 2: [11, 14, 17, 19], 3: [11, 14, 17, 19], 4: [11, 14, 17, 19], 5: [9, 12, 15], 6: [9, 12] };
const TYPE_LABEL = { damage: "Damage", no_damage: "No Damage", retail: "Retail" };

const S = {
  wrap: { minHeight: "100vh", background: "#f3f4f6", padding: "18px 16px 64px", fontFamily: "system-ui, -apple-system, sans-serif", color: "#111827" },
  container: { maxWidth: 480, margin: "0 auto" },
  card: { background: "#fff", border: "1px solid #e5e7eb", borderRadius: 14, boxShadow: "0 1px 3px rgba(0,0,0,.06)", padding: 16 },
  h1: { fontFamily: "'Oswald', sans-serif", fontSize: 22, fontWeight: 800, color: NAVY, margin: 0 },
  input: { width: "100%", boxSizing: "border-box", height: 46, padding: "0 12px", borderRadius: 12, border: "1px solid #d1d5db", fontSize: 16, background: "#fff" },
  repBtn: { display: "block", width: "100%", textAlign: "left", padding: "13px 14px", borderRadius: 12, border: "1px solid #e5e7eb", background: "#fff", fontSize: 16, fontWeight: 600, marginBottom: 8, cursor: "pointer", color: "#111827" },
  err: { background: "#fef2f2", color: "#b91c1c", padding: "10px 12px", borderRadius: 12, fontSize: 14, marginBottom: 12 },
  back: { background: "none", border: "none", color: "#6b7280", fontSize: 14, cursor: "pointer", padding: 0 },
  done: { background: "#ecfdf5", border: "1px solid #a7f3d0", color: "#065f46", borderRadius: 14, padding: "20px 16px", textAlign: "center", fontSize: 15, fontWeight: 700 },
};

export default function RepVisitHub() {
  const [reps, setReps] = useState([]);
  const [token, setToken] = useState("");
  const [rep, setRep] = useState(() => { try { return JSON.parse(localStorage.getItem("visit_rep") || "null"); } catch { return null; } });
  const [stage, setStage] = useState(rep ? "choose" : "pick-rep");
  const [visitType, setVisitType] = useState(null);
  const [geo, setGeo] = useState(null);
  const [deals, setDeals] = useState(null);
  const [deal, setDeal] = useState(null);
  const [referrals, setReferrals] = useState(null);
  const [photosFor, setPhotosFor] = useState(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    loadReps().then(setReps);
    supabase.from("app_settings").select("value").eq("key", "visit_token").maybeSingle()
      .then(({ data }) => setToken(data?.value || ""));
    if (navigator.geolocation) navigator.geolocation.getCurrentPosition(
      (p) => setGeo({ lat: p.coords.latitude, lng: p.coords.longitude }), () => {}, { timeout: 8000 });
  }, []);

  const pickRep = (r) => { setRep(r); localStorage.setItem("visit_rep", JSON.stringify(r)); setStage("choose"); };
  const startType = async (t) => {
    setVisitType(t); setDeal(null); setDeals(null); setErr(""); setStage("list");
    try {
      const o = await api("visit-deal-list", { result: t, rep_jobnimbus_id: rep.jobnimbus_id, rep_name: rep.name, lat: geo?.lat, lng: geo?.lng });
      setDeals(o.deals || []);
    } catch (e) { setErr(e.message); setDeals([]); }
  };
  const startReferrals = async () => {
    setReferrals(null); setErr(""); setStage("referrals");
    try {
      const o = await api("referral-list", { rep_name: rep.name });
      setReferrals(o.referrals || []);
    } catch (e) { setErr(e.message); setReferrals([]); }
  };
  // Open photos — first pull any JN-only photos into Supabase (idempotent;
  // no-op if they're already app-side), so deals whose photos live only in
  // JobNimbus still show.
  const openPhotos = async (d) => {
    try { await fetch(`${FN}/pull-jn-photos-to-app`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ inspectionId: d.inspection_id }) }) } catch { /* best-effort */ }
    setPhotosFor(d.inspection_id)
  }
  const api = async (fn, payload) => {
    const r = await fetch(`${FN}/${fn}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token, ...payload }) });
    const o = await r.json().catch(() => ({}));
    if (!r.ok || !o.ok) throw new Error(o.error || "Request failed");
    return o;
  };

  return (
    <div style={S.wrap}>
      <div style={S.container}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
          <h1 style={S.h1}>U.S. Shingle — Field Visit</h1>
          {rep && stage !== "pick-rep" && (
            <button onClick={() => setStage("pick-rep")} style={{ ...S.back, color: NAVY, fontWeight: 700 }}>{rep.name} ✎</button>
          )}
        </div>
        {err && <div style={S.err}>{err}</div>}
        {stage === "pick-rep" && <PickRep reps={reps} onPick={pickRep} />}
        {stage === "choose" && <Choose rep={rep} onNew={() => {
          window.location.href = `/?intake=1&rep=${encodeURIComponent(rep.jobnimbus_id || "")}&repName=${encodeURIComponent(rep.name || "")}&repEmail=${encodeURIComponent(rep.email || "")}`;
        }} onType={startType} onReferrals={startReferrals} />}
        {stage === "referrals" && <ReferralsView referrals={referrals} onBack={() => setStage("choose")} />}
        {stage === "list" && <DealList type={visitType} deals={deals} onBack={() => setStage("choose")} onPick={(d) => { setDeal(d); setStage("panel"); }} />}
        {stage === "panel" && deal && (
          <Panel type={visitType} deal={deal} rep={rep} api={api} onBack={() => setStage("list")} onPhotos={() => openPhotos(deal)} />
        )}
      </div>
      {photosFor && <InspectionPhotosModal inspectionId={photosFor} onClose={() => setPhotosFor(null)} />}
    </div>
  );
}

// Live from JobNimbus (same source as the intake), fall back to sales_reps.
async function loadReps() {
  try {
    const res = await fetch(`${FN}/jobnimbus-users`);
    if (res.ok) {
      const j = await res.json();
      if (j.members && j.members.length) {
        return j.members
          .filter((m) => m.name && !m.name.toLowerCase().includes("test"))
          .map((m) => ({ id: m.jobnimbus_id, name: m.name, email: m.email || "", jobnimbus_id: m.jobnimbus_id }))
          .sort((a, b) => a.name.localeCompare(b.name));
      }
    }
  } catch { /* fall through */ }
  const { data } = await supabase.from("sales_reps").select("id,name,email,jobnimbus_id,active").eq("active", true).order("name");
  return data || [];
}

function PickRep({ reps, onPick }) {
  const [q, setQ] = useState("");
  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    return s ? reps.filter((r) => (r.name || "").toLowerCase().includes(s)) : reps;
  }, [q, reps]);
  return (
    <div style={S.card}>
      <p style={{ margin: "0 0 10px", fontSize: 15, fontWeight: 700, color: "#374151" }}>Who are you?</p>
      <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search your name…" style={{ ...S.input, marginBottom: 12 }} />
      <div style={{ maxHeight: "60vh", overflowY: "auto" }}>
        {filtered.map((r) => <button key={r.id} onClick={() => onPick(r)} style={S.repBtn}>{r.name}</button>)}
        {!filtered.length && <p style={{ color: "#9ca3af", fontSize: 14, padding: "12px 2px" }}>No matches.</p>}
      </div>
    </div>
  );
}

function Choose({ rep, onNew, onType, onReferrals }) {
  const Btn = ({ color, emoji, label, sub, onClick }) => (
    <button onClick={onClick} style={{ display: "flex", alignItems: "center", gap: 14, width: "100%", textAlign: "left", color: "#fff", background: color, border: "none", borderRadius: 14, padding: "16px 16px", marginBottom: 12, cursor: "pointer", boxShadow: "0 1px 3px rgba(0,0,0,.12)" }}>
      <span style={{ fontSize: 26 }}>{emoji}</span>
      <span><span style={{ display: "block", fontSize: 17, fontWeight: 800 }}>{label}</span><span style={{ display: "block", fontSize: 12.5, opacity: 0.92 }}>{sub}</span></span>
    </button>
  );
  return (
    <div>
      <p style={{ fontSize: 14, color: "#6b7280", margin: "0 0 14px" }}>Hi {rep.name.split(" ")[0]} — what are you here to do?</p>
      <Btn color={NAVY} emoji="📝" label="New inspection" sub="Sign a new free roof inspection" onClick={onNew} />
      <Btn color="#b8324f" emoji="🏚️" label="Damage visit" sub="Set the PA appointment to start their claim" onClick={() => onType("damage")} />
      <Btn color="#16a34a" emoji="✅" label="No-Damage visit" sub="Get referrals + send their certificate" onClick={() => onType("no_damage")} />
      <Btn color="#d97706" emoji="🏠" label="Retail visit" sub="Schedule a retail options appointment" onClick={() => onType("retail")} />
      <Btn color="#6d28d9" emoji="🤝" label="Referrals" sub="People you were referred to — who to sign up" onClick={onReferrals} />
    </div>
  );
}

function ReferralsView({ referrals, onBack }) {
  // View-only. Each referral: who to sign up (name/phone/address), who referred
  // them, and a free anywhere-in-FL "look up roof permit" web search.
  const permitUrl = (addr) => `https://www.google.com/search?q=${encodeURIComponent(`roof permit ${addr}`)}`;
  return (
    <div>
      <BackBar onBack={onBack} title="Your referrals" />
      {referrals === null ? <p style={{ textAlign: "center", color: "#9ca3af", fontSize: 14, padding: "24px 0" }}>Loading…</p>
        : !referrals.length ? <p style={{ textAlign: "center", color: "#6b7280", fontSize: 14, padding: "24px 0" }}>No referrals captured yet. Collect them on a No-Damage visit.</p>
        : <div>{referrals.map((r) => {
            const addr = [r.referral_address].filter(Boolean).join(", ");
            return (
              <div key={r.id} style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12, padding: "12px 14px", marginBottom: 10 }}>
                <div style={{ fontSize: 16, fontWeight: 800, color: "#111827" }}>{r.referral_name || "(no name)"}</div>
                {r.referral_phone && <a href={`tel:${r.referral_phone}`} style={{ display: "block", fontSize: 14, color: "#2563eb", fontWeight: 700, textDecoration: "none", marginTop: 2 }}>📞 {r.referral_phone}</a>}
                {addr && <div style={{ fontSize: 13, color: "#6b7280", marginTop: 2 }}>📍 {addr}</div>}
                {r.referred_by_name && <div style={{ fontSize: 12.5, color: "#9ca3af", marginTop: 6 }}>Referred by <b style={{ color: "#6b7280" }}>{r.referred_by_name}</b></div>}
                {addr && (
                  <a href={permitUrl(addr)} target="_blank" rel="noopener noreferrer"
                    style={{ display: "inline-block", marginTop: 10, border: "1px solid #6d28d9", color: "#6d28d9", background: "#fff", borderRadius: 10, padding: "8px 12px", fontSize: 13, fontWeight: 700, textDecoration: "none" }}>
                    🔍 Look up roof permit
                  </a>
                )}
              </div>
            );
          })}</div>}
    </div>
  );
}

function DealList({ type, deals, onBack, onPick }) {
  return (
    <div>
      <BackBar onBack={onBack} title={`${TYPE_LABEL[type]} — your deals`} />
      {deals === null ? <p style={{ textAlign: "center", color: "#9ca3af", fontSize: 14, padding: "24px 0" }}>Loading nearest first…</p>
        : !deals.length ? <p style={{ textAlign: "center", color: "#6b7280", fontSize: 14, padding: "24px 0" }}>No {TYPE_LABEL[type]} deals found for you.</p>
        : <div>{deals.map((d) => (
            <button key={d.inspection_id} onClick={() => onPick(d)} style={{ ...S.repBtn, paddingTop: 11, paddingBottom: 11 }}>
              <span style={{ display: "block", fontWeight: 700 }}>{d.client_name}</span>
              <span style={{ display: "block", fontSize: 12.5, color: "#6b7280", fontWeight: 400 }}>{[d.address, d.city].filter(Boolean).join(", ")}</span>
              <span style={{ display: "block", fontSize: 11.5, color: "#9ca3af", fontWeight: 700 }}>{d.distance_mi != null ? `${d.distance_mi} mi away` : "distance unknown"}{d.review_availability ? ` · 🏠 ${d.review_availability}` : ""}</span>
            </button>
          ))}</div>}
    </div>
  );
}

function Panel({ type, deal, rep, api, onBack, onPhotos }) {
  const [loadingPhotos, setLoadingPhotos] = useState(false)
  const viewPhotos = async () => { setLoadingPhotos(true); try { await onPhotos() } finally { setLoadingPhotos(false) } }
  return (
    <div>
      <BackBar onBack={onBack} title={deal.client_name} />
      <div style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12, padding: "10px 12px", fontSize: 12.5, color: "#6b7280", marginBottom: 12 }}>
        {[deal.address, deal.city, deal.state].filter(Boolean).join(", ")}
        {deal.review_availability && <span style={{ display: "block", marginTop: 4, color: "#166534", fontWeight: 700 }}>🏠 Best time to come by: {deal.review_availability}</span>}
      </div>
      <button onClick={viewPhotos} disabled={loadingPhotos} style={{ width: "100%", border: `1px solid ${NAVY}`, color: NAVY, background: "#fff", borderRadius: 12, padding: "11px 0", fontSize: 15, fontWeight: 700, marginBottom: 16, cursor: "pointer", opacity: loadingPhotos ? 0.6 : 1 }}>{loadingPhotos ? "Loading photos…" : "📷 View inspection photos"}</button>
      {type === "damage" && <DamagePanel deal={deal} rep={rep} api={api} />}
      {type === "no_damage" && <NoDamagePanel deal={deal} rep={rep} api={api} />}
      {type === "retail" && <RetailPanel deal={deal} rep={rep} api={api} />}
    </div>
  );
}

function DamagePanel({ deal, rep, api }) {
  const [slots, setSlots] = useState(null);
  const [err, setErr] = useState("");
  const [booking, setBooking] = useState("");
  const [done, setDone] = useState(null);
  useEffect(() => {
    api("pa-schedule-api", { action: "slots", inspection_id: deal.inspection_id, lat: deal.latitude, lng: deal.longitude })
      .then((o) => setSlots(o.slots || [])).catch((e) => { setErr(e.message); setSlots([]); });
  }, []);
  const book = async (s) => {
    setBooking(s.start_at + s.pa_id); setErr("");
    try {
      await api("pa-schedule-api", { action: "book", pa_id: s.pa_id, start_at: s.start_at, inspection_id: deal.inspection_id, homeowner_name: deal.client_name, homeowner_phone: deal.mobile, address: deal.address, booked_by: rep.name });
      setDone(`Booked with ${s.pa_name} — ${s.label}. The PA was notified.`);
    } catch (e) { setErr(e.message); }
    setBooking("");
  };
  if (done) return <div style={S.done}>✓ {done}</div>;
  if (slots === null) return <p style={{ textAlign: "center", color: "#9ca3af", padding: "16px 0", fontSize: 14 }}>Loading availability…</p>;

  // Calendar view: group by ET day, today highlighted (not bookable — just for
  // orientation), bookable days show start-time chips only.
  const todayKey = ymdET();
  const byDay = {};
  for (const s of slots) {
    const k = ymdET(new Date(s.start_at));
    if (k === todayKey) continue;                 // today shown for reference, not bookable
    (byDay[k] = byDay[k] || []).push(s);
  }
  const dayKeys = [...new Set([todayKey, ...Object.keys(byDay)])].sort();
  return (
    <div>
      <p style={{ fontSize: 14, fontWeight: 700, color: "#374151", margin: "0 0 8px" }}>Pick a day & time for the PA to come out:</p>
      {err && <div style={{ color: "#b91c1c", fontSize: 14, marginBottom: 8 }}>{err}</div>}
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
    </div>
  );
}

function NoDamagePanel({ deal, rep, api }) {
  const [rows, setRows] = useState([{ name: "", phone: "", address: "" }]);
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState("");
  const [done, setDone] = useState(null);
  const set = (i, k, v) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, [k]: v } : r)));
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
    </div>
  );
}

function RetailPanel({ deal, rep, api }) {
  const [picking, setPicking] = useState("");
  const [err, setErr] = useState("");
  const [done, setDone] = useState(null);
  const days = useMemo(() => buildRetailDays(14), []);
  const pick = async (slot) => {
    setPicking(slot.iso); setErr("");
    try {
      await api("retail-task-create", { inspection_id: deal.inspection_id, start_at_iso: slot.iso, rep_jobnimbus_id: rep.jobnimbus_id, booked_by: rep.name });
      setDone(`Retail appointment set for ${slot.label}. Added to JobNimbus.`);
    } catch (e) { setErr(e.message); }
    setPicking("");
  };
  if (done) return <div style={S.done}>✓ {done}</div>;
  return (
    <div>
      <p style={{ fontSize: 14, fontWeight: 700, color: "#374151", margin: "0 0 8px" }}>Pick a retail appointment time:</p>
      {err && <div style={{ color: "#b91c1c", fontSize: 14, marginBottom: 8 }}>{err}</div>}
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
    </div>
  );
}

function BackBar({ onBack, title }) {
  return <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}><button onClick={onBack} style={S.back}>‹ Back</button><span style={{ fontWeight: 800, fontSize: 17 }}>{title}</span></div>;
}
function ymdET(d = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}
function dayLabel(key) {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" });
}
function hourLabel(iso) {
  return new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric" }).format(new Date(iso)); // "9 AM"
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
function buildRetailDays(n) {
  const now = Date.now(), out = [];
  for (let d = 0; d < n; d++) {
    const ms = now + d * 864e5;
    const { y, mo, day, weekday, wname } = etParts(ms);
    const hours = RETAIL_HOURS[weekday] || [];
    if (!hours.length) continue;
    const slots = hours.map((h) => ({ iso: etToISO(y, mo, day, h), time: `${((h + 11) % 12) + 1}${h < 12 ? "am" : "pm"}`, label: `${wname} ${mo}/${day} ${((h + 11) % 12) + 1}${h < 12 ? "am" : "pm"}` }))
      .filter((s) => Date.parse(s.iso) > now);
    if (slots.length) out.push({ key: `${y}-${mo}-${day}`, label: `${wname}, ${mo}/${day}`, slots });
  }
  return out;
}
