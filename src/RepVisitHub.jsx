import { useEffect, useMemo, useState } from "react";
import { supabase } from "./lib/supabase";
import InspectionPhotosModal from "./InspectionPhotosModal";

// Public rep landing: "Who are you?" → 4 choices → (per outcome) pick a
// homeowner (their deals, nearest-first) → view photos → take the action:
//   New inspection → existing signing flow (?intake=1, rep prefilled)
//   Damage   → book a PA appointment (nearest PA) — PA notified by SMS+email
//   No Damage→ send the no-damage cert + Google review link; capture referrals
//   Retail   → pick a fixed slot → creates a JN "Appointment" task on the job
// Self-contained early-return page (mirrors ?mode=pa / ?dialer= pages).

const FN = "/.netlify/functions";
// Retail fixed grid (ET): weekday 0=Sun..6=Sat → start hours (24h).
const RETAIL_HOURS = { 1: [11, 14, 17, 19], 2: [11, 14, 17, 19], 3: [11, 14, 17, 19], 4: [11, 14, 17, 19], 5: [9, 12, 15], 6: [9, 12] };
const TYPE_LABEL = { damage: "Damage", no_damage: "No Damage", retail: "Retail" };

export default function RepVisitHub() {
  const [reps, setReps] = useState([]);
  const [token, setToken] = useState("");
  const [rep, setRep] = useState(() => { try { return JSON.parse(localStorage.getItem("visit_rep") || "null"); } catch { return null; } });
  const [stage, setStage] = useState(rep ? "choose" : "pick-rep");
  const [visitType, setVisitType] = useState(null);
  const [geo, setGeo] = useState(null);
  const [deals, setDeals] = useState(null);
  const [deal, setDeal] = useState(null);
  const [photosFor, setPhotosFor] = useState(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    supabase.from("sales_reps").select("id,name,email,jobnimbus_id,active").eq("active", true).order("name")
      .then(({ data }) => setReps(data || []));
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
  const api = async (fn, payload) => {
    const r = await fetch(`${FN}/${fn}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token, ...payload }) });
    const o = await r.json().catch(() => ({}));
    if (!r.ok || !o.ok) throw new Error(o.error || "Request failed");
    return o;
  };

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <div className="mx-auto max-w-md px-4 py-6">
        <div className="mb-4 flex items-center justify-between">
          <h1 className="text-lg font-extrabold text-[#1a2e5a]">U.S. Shingle — Field Visit</h1>
          {rep && stage !== "pick-rep" && (
            <button onClick={() => { setStage("pick-rep"); }} className="text-xs text-slate-500 underline">{rep.name} ✎</button>
          )}
        </div>

        {err && <div className="mb-3 rounded bg-red-50 px-3 py-2 text-sm text-red-700">{err}</div>}

        {stage === "pick-rep" && <PickRep reps={reps} onPick={pickRep} />}
        {stage === "choose" && <Choose rep={rep} onNew={() => {
          window.location.href = `/?intake=1&rep=${encodeURIComponent(rep.jobnimbus_id || "")}&repName=${encodeURIComponent(rep.name || "")}&repEmail=${encodeURIComponent(rep.email || "")}`;
        }} onType={startType} />}
        {stage === "list" && <DealList type={visitType} deals={deals} onBack={() => setStage("choose")} onPick={(d) => { setDeal(d); setStage("panel"); }} />}
        {stage === "panel" && deal && (
          <Panel type={visitType} deal={deal} rep={rep} api={api}
            onBack={() => setStage("list")} onPhotos={() => setPhotosFor(deal.inspection_id)} />
        )}
      </div>
      {photosFor && <InspectionPhotosModal inspectionId={photosFor} onClose={() => setPhotosFor(null)} />}
    </div>
  );
}

function PickRep({ reps, onPick }) {
  const [q, setQ] = useState("");
  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    return s ? reps.filter((r) => (r.name || "").toLowerCase().includes(s)) : reps;
  }, [q, reps]);
  return (
    <div>
      <p className="mb-2 text-sm font-semibold text-slate-600">Who are you?</p>
      <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search your name…"
        className="mb-3 w-full rounded-lg border border-slate-300 px-3 py-2.5 text-base" />
      <div className="max-h-[60vh] space-y-1 overflow-y-auto">
        {filtered.map((r) => (
          <button key={r.id} onClick={() => onPick(r)}
            className="block w-full rounded-lg border border-slate-200 bg-white px-3 py-3 text-left font-medium hover:bg-slate-50">{r.name}</button>
        ))}
        {!filtered.length && <p className="px-1 py-4 text-sm text-slate-400">No matches.</p>}
      </div>
    </div>
  );
}

function Choose({ rep, onNew, onType }) {
  const Btn = ({ color, emoji, label, sub, onClick }) => (
    <button onClick={onClick} className="flex w-full items-center gap-3 rounded-xl px-4 py-4 text-left text-white shadow" style={{ background: color }}>
      <span className="text-2xl">{emoji}</span>
      <span><span className="block text-base font-bold">{label}</span><span className="block text-xs opacity-90">{sub}</span></span>
    </button>
  );
  return (
    <div className="space-y-3">
      <p className="text-sm text-slate-500">Hi {rep.name.split(" ")[0]} — what are you here to do?</p>
      <Btn color="#1a2e5a" emoji="📝" label="New inspection" sub="Sign a new free roof inspection" onClick={onNew} />
      <Btn color="#b8324f" emoji="🏚️" label="Damage visit" sub="Set the PA appointment to start their claim" onClick={() => onType("damage")} />
      <Btn color="#16a34a" emoji="✅" label="No-Damage visit" sub="Get referrals + send their certificate" onClick={() => onType("no_damage")} />
      <Btn color="#d97706" emoji="🏠" label="Retail visit" sub="Schedule a retail options appointment" onClick={() => onType("retail")} />
    </div>
  );
}

function DealList({ type, deals, onBack, onPick }) {
  return (
    <div>
      <BackBar onBack={onBack} title={`${TYPE_LABEL[type]} — your deals`} />
      {deals === null ? <p className="py-6 text-center text-sm text-slate-400">Loading nearest first…</p>
        : !deals.length ? <p className="py-6 text-center text-sm text-slate-500">No {TYPE_LABEL[type]} deals found for you.</p>
        : <div className="space-y-1">
            {deals.map((d) => (
              <button key={d.inspection_id} onClick={() => onPick(d)} className="block w-full rounded-lg border border-slate-200 bg-white px-3 py-3 text-left hover:bg-slate-50">
                <span className="block font-semibold">{d.client_name}</span>
                <span className="block text-xs text-slate-500">{[d.address, d.city].filter(Boolean).join(", ")}</span>
                <span className="block text-[11px] font-semibold text-slate-400">{d.distance_mi != null ? `${d.distance_mi} mi away` : "distance unknown"}</span>
              </button>
            ))}
          </div>}
    </div>
  );
}

function Panel({ type, deal, rep, api, onBack, onPhotos }) {
  return (
    <div>
      <BackBar onBack={onBack} title={deal.client_name} />
      <div className="mb-3 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-500">
        {[deal.address, deal.city, deal.state].filter(Boolean).join(", ")}
      </div>
      <button onClick={onPhotos} className="mb-4 w-full rounded-lg border border-[#1a2e5a] px-3 py-2.5 font-semibold text-[#1a2e5a]">📷 View inspection photos</button>
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
      await api("pa-schedule-api", { action: "book", pa_id: s.pa_id, start_at: s.start_at, inspection_id: deal.inspection_id,
        homeowner_name: deal.client_name, homeowner_phone: deal.mobile, address: deal.address, booked_by: rep.name });
      setDone(`Booked with ${s.pa_name} — ${s.label}. The PA was notified.`);
    } catch (e) { setErr(e.message); }
    setBooking("");
  };
  if (done) return <Done msg={done} />;
  return (
    <div>
      <p className="mb-2 text-sm font-semibold text-slate-600">Pick a time for the PA to come out:</p>
      {err && <div className="mb-2 text-sm text-red-600">{err}</div>}
      {slots === null ? <p className="py-4 text-center text-sm text-slate-400">Loading availability…</p>
        : !slots.length ? <p className="py-4 text-center text-sm text-slate-500">No open slots nearby.</p>
        : <div className="max-h-[55vh] space-y-1 overflow-y-auto">
            {slots.map((s) => (
              <button key={s.start_at + s.pa_id} disabled={!!booking} onClick={() => book(s)}
                className="flex w-full items-center justify-between rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-left disabled:opacity-50">
                <span><span className="block text-sm font-semibold">{s.label}</span><span className="block text-xs text-slate-500">{s.pa_name}{s.distance_mi != null ? ` · ${s.distance_mi} mi` : ""}</span></span>
                <span className="text-xs font-bold text-[#16a34a]">{booking === s.start_at + s.pa_id ? "…" : "Book"}</span>
              </button>
            ))}
          </div>}
    </div>
  );
}

function NoDamagePanel({ deal, rep, api }) {
  const [rows, setRows] = useState([{ name: "", phone: "" }]);
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
  if (done) return <Done msg={done} />;
  return (
    <div className="space-y-3">
      <div>
        <p className="mb-1 text-sm font-semibold text-slate-600">Ask for referrals</p>
        {rows.map((r, i) => (
          <div key={i} className="mb-1 flex gap-2">
            <input value={r.name} onChange={(e) => set(i, "name", e.target.value)} placeholder="Name" className="w-1/2 rounded border border-slate-300 px-2 py-2 text-sm" />
            <input value={r.phone} onChange={(e) => set(i, "phone", e.target.value)} placeholder="Phone" className="w-1/2 rounded border border-slate-300 px-2 py-2 text-sm" />
          </div>
        ))}
        <button onClick={() => setRows((rs) => [...rs, { name: "", phone: "" }])} className="text-xs font-semibold text-[#1a2e5a]">+ add another</button>
      </div>
      {err && <div className="text-sm text-red-600">{err}</div>}
      <button onClick={send} disabled={sending} className="w-full rounded-lg bg-[#16a34a] px-4 py-3 font-bold text-white disabled:opacity-50">
        {sending ? "Sending…" : "Send certificate + review link to homeowner"}
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
  if (done) return <Done msg={done} />;
  return (
    <div>
      <p className="mb-2 text-sm font-semibold text-slate-600">Pick a retail appointment time:</p>
      {err && <div className="mb-2 text-sm text-red-600">{err}</div>}
      <div className="max-h-[55vh] space-y-3 overflow-y-auto">
        {days.map((day) => (
          <div key={day.key}>
            <p className="mb-1 text-xs font-bold uppercase text-slate-400">{day.label}</p>
            <div className="flex flex-wrap gap-2">
              {day.slots.map((s) => (
                <button key={s.iso} disabled={!!picking} onClick={() => pick(s)}
                  className="rounded-lg border border-[#d97706] px-3 py-2 text-sm font-semibold text-[#d97706] disabled:opacity-50">
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

// ── helpers ──
function BackBar({ onBack, title }) {
  return <div className="mb-3 flex items-center gap-2"><button onClick={onBack} className="text-sm text-slate-500">‹ Back</button><span className="font-bold">{title}</span></div>;
}
function Done({ msg }) {
  return <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-4 text-center text-sm font-semibold text-emerald-700">✓ {msg}</div>;
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
    const slots = hours.map((h) => ({
      iso: etToISO(y, mo, day, h),
      time: `${((h + 11) % 12) + 1}${h < 12 ? "am" : "pm"}`,
      label: `${wname} ${mo}/${day} ${((h + 11) % 12) + 1}${h < 12 ? "am" : "pm"}`,
    })).filter((s) => Date.parse(s.iso) > now);
    if (slots.length) out.push({ key: `${y}-${mo}-${day}`, label: `${wname}, ${mo}/${day}`, slots });
  }
  return out;
}
