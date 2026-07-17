import { useEffect, useMemo, useState } from "react";
import { supabase } from "./lib/supabase";
import InspectionPhotosModal from "./InspectionPhotosModal";
import RepCalendar from "./RepCalendar";
import { DamagePanel, NoDamagePanel, RetailPanel } from "./VisitActions";

// Public rep landing: "Who are you?" → 4 choices → (per outcome) pick a
// homeowner (their deals, nearest-first) → view photos → take the action.
// Self-contained early-return page. CCG uses INLINE STYLES (no Tailwind).

const FN = "/.netlify/functions";
const NAVY = "#1a2e5a";
const TYPE_LABEL = { damage: "Damage", no_damage: "No Damage", retail: "Retail" };

// "Go back" label for a review_availability ("Wed · 5 PM", "Mon, Tue, Wed, Thu,
// Fri · 5 PM", "Any day · 2 PM"). When the homeowner is open to MULTIPLE days,
// collapse to the FIRST AVAILABLE upcoming day at that hour (ET) — same rule the
// JN go-back task uses. A single preferred day is left exactly as entered.
// What to show for "when": the actual SCHEDULED go-back time if one's booked
// (result_task_at — distinct per deal), else the homeowner's first-available
// preference. Fixes two deals showing the same resolved availability day.
function goBackDisplay(d) {
  if (d && d.result_task_at) {
    try {
      const dt = new Date(d.result_task_at);
      const day = dt.toLocaleDateString("en-US", { timeZone: "America/New_York", weekday: "short", month: "numeric", day: "numeric" });
      const time = dt.toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric", hour12: true });
      return `${day} · ${time}`;
    } catch { /* fall through */ }
  }
  return firstAvailableGoBack(d && d.review_availability);
}
function firstAvailableGoBack(s) {
  if (!s) return s;
  const [daysPart, timePart] = String(s).split(" · ").map((x) => (x || "").trim());
  if (!timePart) return s;
  const tm = timePart.match(/(\d+)\s*(am|pm)/i);
  if (!tm) return s;
  let hour = parseInt(tm[1], 10) % 12; if (/pm/i.test(tm[2])) hour += 12;
  const WMAP = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
  const days = /any/i.test(daysPart)
    ? [0, 1, 2, 3, 4, 5, 6]
    : daysPart.split(",").map((d) => WMAP[d.trim().slice(0, 3).toLowerCase()]).filter((x) => x != null);
  if (days.length <= 1) return s; // single preferred day → keep as-is
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", month: "numeric", day: "numeric", hour: "numeric", hour12: false });
  const now = Date.now();
  for (let d = 0; d < 14; d++) {
    const p = {}; for (const x of fmt.formatToParts(new Date(now + d * 864e5))) p[x.type] = x.value;
    const wd = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[p.weekday];
    if (!days.includes(wd)) continue;
    if (d === 0 && Number(p.hour) >= hour) continue; // today's slot already passed
    const h12 = (hour % 12) || 12, ap = hour >= 12 ? "PM" : "AM";
    return `${p.weekday} ${p.month}/${p.day} · ${h12} ${ap}`;
  }
  return s;
}

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
  const [counts, setCounts] = useState(null); // { damage, no_damage, retail } for the hub badges
  const [visitType, setVisitType] = useState(null);
  const [geo, setGeo] = useState(null);
  const [deals, setDeals] = useState(null);
  const [deal, setDeal] = useState(null);
  const [referrals, setReferrals] = useState(null);
  const [photosFor, setPhotosFor] = useState(null);
  const [appts, setAppts] = useState(null);   // upcoming PA appointments this rep booked
  const [issues, setIssues] = useState(null); // this rep's cancelled / correction-needed deals
  const [pay, setPay] = useState(null);       // William's pay report (weekly signups + cancels)
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
  // Upcoming adjuster (PA) appointments for THIS rep's homeowners — future only.
  // Matches by the deal's sales rep (JobNimbus id, name fallback), so an appt the
  // PA (or the company) booked still surfaces here — it's still the rep's homeowner.
  // Also includes anything the rep booked directly.
  // Loads this rep's upcoming PA appointment rows (their homeowners, or ones they
  // booked) — shared by the Adjuster-appts view and the hub count badge. A
  // reassigned deal belongs to the CURRENT sales rep, not the original signer.
  const loadApptRows = async () => {
    const nowIso = new Date().toISOString();
    const SEL = "id,sales_rep_id,sales_rep_name,original_sales_rep_id,original_sales_rep_name";
    const rowsById = new Map();
    if (rep.jobnimbus_id) {
      const { data } = await supabase.from("inspections").select(SEL).or(`sales_rep_id.eq.${rep.jobnimbus_id},original_sales_rep_id.eq.${rep.jobnimbus_id}`);
      for (const r of (data || [])) rowsById.set(r.id, r);
    }
    if (rep.name) {
      try { const { data } = await supabase.from("inspections").select(SEL).or(`sales_rep_name.eq.${rep.name},original_sales_rep_name.eq.${rep.name}`); for (const r of (data || [])) rowsById.set(r.id, r); } catch { /* odd name */ }
    }
    const repInspIds = new Set();
    for (const r of rowsById.values()) {
      const isCurrent = (!!rep.jobnimbus_id && r.sales_rep_id === rep.jobnimbus_id) || (!!rep.name && r.sales_rep_name === rep.name);
      const isOriginal = (!!rep.jobnimbus_id && r.original_sales_rep_id === rep.jobnimbus_id) || (!!rep.name && r.original_sales_rep_name === rep.name);
      const hasCurrent = !!(r.sales_rep_id || r.sales_rep_name);
      if (isCurrent || (!hasCurrent && isOriginal)) repInspIds.add(r.id);
    }
    const { data: all, error } = await supabase.from("pa_appointments")
      .select("id,homeowner_name,homeowner_phone,address,start_at,pa_id,inspection_id,booked_by")
      .eq("status", "scheduled").gte("start_at", nowIso).order("start_at", { ascending: true });
    if (error) throw error;
    return (all || []).filter((a) => (a.inspection_id && repInspIds.has(a.inspection_id)) || (a.booked_by && a.booked_by === rep.name));
  };
  const startApptsBooked = async () => {
    setAppts(null); setErr(""); setStage("appts");
    try {
      const rows = await loadApptRows();
      const ids = [...new Set(rows.map((r) => r.pa_id).filter(Boolean))];
      const nameById = {};
      if (ids.length) { const { data: pas } = await supabase.from("pas").select("id,name").in("id", ids); for (const p of (pas || [])) nameById[p.id] = p.name; }
      setAppts(rows.map((r) => ({ ...r, pa_name: nameById[r.pa_id] || "Adjuster" })));
    } catch (e) { setErr(e.message); setAppts([]); }
  };
  // This rep's deals that were CANCELLED (Marked Lost) or flagged "correction
  // needed", with the reason/note — so the rep can see what went Lost and why,
  // or what needs fixing. Same rep-matching as appts (current or original signer,
  // JobNimbus id with name fallback) so reassigned/handed-off deals still show.
  const startIssues = async () => {
    setIssues(null); setErr(""); setStage("issues");
    try {
      const SEL = "id,client_name,address,city,state,signed_at,sales_rep_id,sales_rep_name,original_sales_rep_id,original_sales_rep_name,cancelled_at,cancel_reason,lost_reason,correction_needed,correction_note";
      const rowsById = new Map();
      if (rep.jobnimbus_id) {
        const { data } = await supabase.from("inspections").select(SEL)
          .or(`sales_rep_id.eq.${rep.jobnimbus_id},original_sales_rep_id.eq.${rep.jobnimbus_id}`);
        for (const r of (data || [])) rowsById.set(r.id, r);
      }
      if (rep.name) {
        try {
          const { data } = await supabase.from("inspections").select(SEL)
            .or(`sales_rep_name.eq.${rep.name},original_sales_rep_name.eq.${rep.name}`);
          for (const r of (data || [])) rowsById.set(r.id, r);
        } catch { /* odd name → id match still applies */ }
      }
      const list = [...rowsById.values()].filter((r) => r.cancelled_at || r.correction_needed);
      list.sort((a, b) => new Date(b.cancelled_at || b.signed_at || 0) - new Date(a.cancelled_at || a.signed_at || 0));
      setIssues(list);
    } catch (e) { setErr(e.message); setIssues([]); }
  };
  // William's pay report: this-week active signups ($150 each) + his cancels
  // (any time, so a misunderstanding can be put back on the inspection list).
  const startPay = async () => {
    setPay(null); setErr(""); setStage("pay");
    try {
      const SEL = "id,client_name,address,city,state,signed_at,cancelled_at,cancel_reason,lost_reason,correction_note,pa_notes_log,result,inspector_name";
      const rowsById = new Map();
      if (rep.jobnimbus_id) {
        const { data } = await supabase.from("inspections").select(SEL)
          .or(`sales_rep_id.eq.${rep.jobnimbus_id},original_sales_rep_id.eq.${rep.jobnimbus_id}`);
        for (const r of (data || [])) rowsById.set(r.id, r);
      }
      if (rep.name) {
        try {
          const { data } = await supabase.from("inspections").select(SEL)
            .or(`sales_rep_name.eq.${rep.name},original_sales_rep_name.eq.${rep.name}`);
          for (const r of (data || [])) rowsById.set(r.id, r);
        } catch { /* id match still applies */ }
      }
      const all = [...rowsById.values()];
      // Once a deal has been INSPECTED (result = damage/no_damage/retail), the
      // $150 is locked — a later "No Sale / Lost" by the rep doesn't claw it
      // back (not William's fault). So a cancelled-BUT-inspected deal still
      // counts as a paid signup; only a cancel that was NEVER inspected reduces
      // his pay (and shows in the cancels list for review/reinstate).
      const inspected = (r) => ["damage", "no_damage", "retail"].includes(r.result);
      const signed = all.filter((r) => r.signed_at && (!r.cancelled_at || inspected(r))).sort((a, b) => new Date(b.signed_at) - new Date(a.signed_at));
      const cancels = all.filter((r) => r.cancelled_at && !inspected(r)).sort((a, b) => new Date(b.cancelled_at || 0) - new Date(a.cancelled_at || 0));
      setPay({ signed, cancels });
    } catch (e) { setErr(e.message); setPay({ signups: [], cancels: [] }); }
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
    if (!r.ok || !o.ok) { const err = new Error(o.error || "Request failed"); err.body = o; throw err; }
    return o;
  };
  // Counts for the hub badges — so a rep sees how many Damage/No-Damage/Retail
  // deals they have without opening each. Refreshed whenever they land on choose.
  useEffect(() => {
    if (!rep || !token || stage !== "choose") return;
    let live = true;
    Promise.all([
      ...["damage", "no_damage", "retail"].map((t) =>
        api("visit-deal-list", { result: t, rep_jobnimbus_id: rep.jobnimbus_id, rep_name: rep.name }).then((o) => (o.deals || []).length).catch(() => null)),
      api("referral-list", { rep_name: rep.name }).then((o) => (o.referrals || []).length).catch(() => null),
      loadApptRows().then((r) => r.length).catch(() => null),
    ]).then(([damage, no_damage, retail, referrals, appts]) => { if (live) setCounts({ damage, no_damage, retail, referrals, appts }); });
    return () => { live = false; };
  }, [rep, token, stage]); // eslint-disable-line react-hooks/exhaustive-deps

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
        }} onType={startType} onReferrals={startReferrals} onApptsBooked={startApptsBooked} onIssues={startIssues} onPay={startPay} onCalendar={() => setStage("calendar")} counts={counts} />}
        {stage === "calendar" && rep && <RepCalendar rep={rep} token={token} onClose={() => setStage("choose")} />}
        {stage === "referrals" && <ReferralsView referrals={referrals} rep={rep} onBack={() => setStage("choose")} api={api} />}
        {stage === "appts" && <ApptsBookedView appts={appts} rep={rep} onBack={() => setStage("choose")} />}
        {stage === "issues" && <IssuesView issues={issues} onBack={() => setStage("choose")} />}
        {stage === "pay" && <PayReport pay={pay} rep={rep} api={api} onBack={() => setStage("choose")} onReload={startPay} />}
        {stage === "list" && <DealList type={visitType} deals={deals} onBack={() => setStage("choose")} onPick={(d) => { setDeal(d); setStage("panel"); }} />}
        {stage === "panel" && deal && (
          <Panel type={visitType} deal={deal} rep={rep} api={api} onBack={() => setStage("list")} onPhotos={() => openPhotos(deal)} />
        )}
        {/* Manager access — goes to the Manager Console (PIN-gated). Reps ignore it. */}
        <div style={{ textAlign: "center", marginTop: 22 }}>
          <button type="button" onClick={() => { window.location.href = "/?mode=manager"; }}
            style={{ background: "transparent", border: "1px solid #d1d5db", borderRadius: 10, padding: "6px 14px", fontSize: 12, fontFamily: "'Oswald', sans-serif", fontWeight: 600, letterSpacing: "0.04em", color: "#6b7280", cursor: "pointer", textTransform: "uppercase" }}>
            ⚙️ Manager
          </button>
        </div>
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

function Choose({ rep, onNew, onType, onReferrals, onApptsBooked, onIssues, onPay, onCalendar, counts }) {
  const Btn = ({ color, emoji, label, sub, onClick, count }) => (
    <button onClick={onClick} style={{ display: "flex", alignItems: "center", gap: 14, width: "100%", textAlign: "left", color: "#fff", background: color, border: "none", borderRadius: 14, padding: "16px 16px", marginBottom: 12, cursor: "pointer", boxShadow: "0 1px 3px rgba(0,0,0,.12)" }}>
      <span style={{ fontSize: 26 }}>{emoji}</span>
      <span style={{ flex: 1 }}><span style={{ display: "block", fontSize: 17, fontWeight: 800 }}>{label}</span><span style={{ display: "block", fontSize: 12.5, opacity: 0.92 }}>{sub}</span></span>
      {count != null && (
        <span style={{ flexShrink: 0, minWidth: 30, height: 30, padding: "0 8px", borderRadius: 999, background: count > 0 ? "rgba(255,255,255,.92)" : "rgba(255,255,255,.22)", color: count > 0 ? color : "#fff", fontWeight: 800, fontSize: 15, display: "flex", alignItems: "center", justifyContent: "center" }}>{count}</span>
      )}
    </button>
  );
  // William is the inspector — he signs inspections + tracks pay, but doesn't
  // run the visit/adjuster flows, so those buttons are hidden for him.
  const isWilliam = (rep.name || "").trim().toLowerCase() === "william hernandez";
  return (
    <div>
      <p style={{ fontSize: 14, color: "#6b7280", margin: "0 0 14px" }}>Hi {rep.name.split(" ")[0]} — what are you here to do?</p>
      {!isWilliam && <Btn color="#0e7490" emoji="📅" label="My calendar" sub="Your appointments + set when you're available" onClick={onCalendar} />}
      <Btn color={NAVY} emoji="📝" label="New inspection" sub="Sign a new free roof inspection" onClick={onNew} />
      {!isWilliam && <Btn color="#b8324f" emoji="🏚️" label="Damage visit" sub="Set the PA appointment to start their claim" onClick={() => onType("damage")} count={counts?.damage} />}
      {!isWilliam && <Btn color="#16a34a" emoji="✅" label="No-Damage visit" sub="Get referrals + send their certificate" onClick={() => onType("no_damage")} count={counts?.no_damage} />}
      {!isWilliam && <Btn color="#d97706" emoji="🏠" label="Retail visit" sub="Schedule a retail options appointment" onClick={() => onType("retail")} count={counts?.retail} />}
      <Btn color="#6d28d9" emoji="🤝" label="Referrals" sub="People you were referred to — who to sign up" onClick={onReferrals} count={counts?.referrals} />
      {!isWilliam && <Btn color="#0e7490" emoji="📅" label="Adjuster appts booked" sub="Upcoming PA appointments you've set" onClick={onApptsBooked} count={counts?.appts} />}
      <Btn color="#6b7280" emoji="⚠️" label="Cancelled / Needs correction" sub="Deals marked Lost or flagged to fix — see why" onClick={onIssues} />
      {/* William's pay report — only for him. */}
      {isWilliam && (
        <Btn color="#047857" emoji="💵" label="Pay Report" sub="This week's inspection signups ($150 each) + cancels" onClick={onPay} />
      )}
    </div>
  );
}

function ReferralsView({ referrals, rep, onBack, api }) {
  // Each referral: who to sign up (name/phone/address), who referred them, a free
  // "look up roof permit" web search, and "Sign them up" → the New Inspection
  // intake prefilled with their info (then the normal signing flow runs).
  // Resolve buttons drop a referral off the list once handled (signed / not interested).
  const [resolvedIds, setResolvedIds] = useState(() => new Set());
  const [busy, setBusy] = useState("");
  const resolve = async (r, outcome) => {
    setBusy(r.id + outcome);
    try { await api("referral-resolve", { referral_id: r.id, outcome, rep_name: rep?.name }); setResolvedIds((s) => new Set(s).add(r.id)); } catch { /* leave on list */ }
    setBusy("");
  };
  const permitUrl = (addr) => `https://www.google.com/search?q=${encodeURIComponent(`roof permit ${addr}`)}`;
  const signUp = (r, addr) => {
    const u = new URLSearchParams({ intake: "1" });
    if (rep?.jobnimbus_id) u.set("rep", rep.jobnimbus_id);
    if (rep?.name) u.set("repName", rep.name);
    if (rep?.email) u.set("repEmail", rep.email);
    if (r.referral_name) u.set("name", r.referral_name);
    if (r.referral_phone) u.set("phone", r.referral_phone);
    if (addr) u.set("address", addr);
    window.location.href = `/?${u.toString()}`;
  };
  return (
    <div>
      <BackBar onBack={onBack} title="Your referrals" />
      {referrals === null ? <p style={{ textAlign: "center", color: "#9ca3af", fontSize: 14, padding: "24px 0" }}>Loading…</p>
        : (() => {
          const visible = referrals.filter((r) => !resolvedIds.has(r.id));
          if (!visible.length) return <p style={{ textAlign: "center", color: "#6b7280", fontSize: 14, padding: "24px 0" }}>No referrals to work right now. Collect them on a No-Damage visit.</p>;
          return <div>{visible.map((r) => {
            const addr = [r.referral_address].filter(Boolean).join(", ");
            const rbtn = (color) => ({ border: `1px solid ${color}`, color, background: "#fff", borderRadius: 10, padding: "8px 12px", fontSize: 13, fontWeight: 800, cursor: "pointer" });
            return (
              <div key={r.id} style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12, padding: "12px 14px", marginBottom: 10 }}>
                <div style={{ fontSize: 16, fontWeight: 800, color: "#111827" }}>{r.referral_name || "(no name)"}</div>
                {r.referral_phone && <a href={`tel:${r.referral_phone}`} style={{ display: "block", fontSize: 14, color: "#2563eb", fontWeight: 700, textDecoration: "none", marginTop: 2 }}>📞 {r.referral_phone}</a>}
                {addr && <div style={{ fontSize: 13, color: "#6b7280", marginTop: 2 }}>📍 {addr}</div>}
                {r.referred_by_name && <div style={{ fontSize: 12.5, color: "#9ca3af", marginTop: 6 }}>Referred by <b style={{ color: "#6b7280" }}>{r.referred_by_name}</b></div>}
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 10 }}>
                  <button type="button" onClick={() => signUp(r, addr)}
                    style={{ border: "none", color: "#fff", background: "#16a34a", borderRadius: 10, padding: "9px 14px", fontSize: 13.5, fontWeight: 800, cursor: "pointer" }}>
                    ✍️ Sign them up
                  </button>
                  {addr && (
                    <a href={permitUrl(addr)} target="_blank" rel="noopener noreferrer"
                      style={{ border: "1px solid #6d28d9", color: "#6d28d9", background: "#fff", borderRadius: 10, padding: "8px 12px", fontSize: 13, fontWeight: 700, textDecoration: "none" }}>
                      🔍 Look up roof permit
                    </a>
                  )}
                  <button type="button" disabled={!!busy} onClick={() => resolve(r, "signed")} style={rbtn("#047857")}>{busy === r.id + "signed" ? "…" : "✅ Signed — remove"}</button>
                  <button type="button" disabled={!!busy} onClick={() => resolve(r, "not_interested")} style={rbtn("#dc2626")}>{busy === r.id + "not_interested" ? "…" : "🚫 Not interested"}</button>
                </div>
              </div>
            );
          })}</div>;
        })()}
    </div>
  );
}

// Read-only list of this rep's CANCELLED / correction-needed deals + the note,
// so they understand what happened (e.g. a signing that later went Lost, or a
// record an admin flagged to fix).
function IssuesView({ issues, onBack }) {
  return (
    <div>
      <BackBar onBack={onBack} title="Cancelled / Needs correction" />
      {issues === null ? <p style={{ textAlign: "center", color: "#9ca3af", fontSize: 14, padding: "24px 0" }}>Loading…</p>
        : !issues.length ? <p style={{ textAlign: "center", color: "#6b7280", fontSize: 14, padding: "24px 0" }}>Nothing cancelled or needing correction right now. 🎉</p>
        : <div>{issues.map((r) => {
            const cancelled = !!r.cancelled_at;
            const correction = !!r.correction_needed;
            const note = correction ? r.correction_note : (r.lost_reason || r.cancel_reason);
            return (
              <div key={r.id} style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12, padding: "12px 14px", marginBottom: 10 }}>
                <div style={{ fontSize: 16, fontWeight: 800, color: "#111827" }}>{r.client_name || "(no name)"}</div>
                <div style={{ fontSize: 13, color: "#6b7280", marginTop: 2 }}>📍 {[r.address, r.city, r.state].filter(Boolean).join(", ") || "—"}</div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
                  {cancelled && <span style={{ fontSize: 11, fontWeight: 800, color: "#fff", background: "#dc2626", borderRadius: 999, padding: "2px 9px", letterSpacing: "0.03em" }}>CANCELLED</span>}
                  {correction && <span style={{ fontSize: 11, fontWeight: 800, color: "#92400e", background: "#fffbeb", border: "1px solid #fcd34d", borderRadius: 999, padding: "2px 9px" }}>⏳ CORRECTION NEEDED</span>}
                </div>
                {note ? <div style={{ fontSize: 13.5, color: "#374151", marginTop: 8, background: "#f9fafb", border: "1px solid #f0f0f0", borderRadius: 8, padding: "8px 10px", fontStyle: "italic" }}>“{note}”</div>
                      : <div style={{ fontSize: 12.5, color: "#9ca3af", marginTop: 8 }}>No note provided.</div>}
              </div>
            );
          })}</div>}
    </div>
  );
}

// William's pay report: this-week signups ($150 each) + his cancels (tap one to
// read the notes and, if it was a misunderstanding, put it back on the
// inspection list with a required note).
function PayReport({ pay, rep, api, onBack, onReload }) {
  const [openId, setOpenId] = useState(null);
  const [noteFor, setNoteFor] = useState({});
  const [busyId, setBusyId] = useState(null);
  const [err, setErr] = useState("");
  const [doneMsg, setDoneMsg] = useState("");
  const [weekOffset, setWeekOffset] = useState(0);   // 0 = this week, -1 = last week, …
  const RATE = 150;
  const wk = weekRange(weekOffset);
  const signups = (pay?.signed || []).filter((r) => r.signed_at >= wk.startIso && r.signed_at < wk.endIso);
  // Cancels are scoped to the SAME pay week (by the SIGN date) — a cancel only
  // affects the pay for the week the deal signed in. Pay lags a week, so ◀ to
  // last week shows the cancels behind the check he just got.
  const cancels = (pay?.cancels || []).filter((r) => (r.signed_at || "") >= wk.startIso && (r.signed_at || "") < wk.endIso);
  const total = signups.length * RATE;
  const fmtDay = (iso) => new Date(iso).toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" });
  const notesOf = (r) => [r.cancel_reason, r.lost_reason, r.correction_note, ...(Array.isArray(r.pa_notes_log) ? r.pa_notes_log.map((n) => n.text || n) : [])].filter(Boolean);
  const reinstate = async (r) => {
    const note = (noteFor[r.id] || "").trim();
    if (!note) { setErr("Add a note explaining why before putting it back."); return; }
    setBusyId(r.id); setErr("");
    try {
      await api("reinstate-inspection", { inspection_id: r.id, note, rep_name: rep.name });
      setDoneMsg(`${r.client_name || "Deal"} put back on the inspection list.`);
      setOpenId(null);
      await onReload();
    } catch (e) { setErr(e.message); }
    setBusyId(null);
  };
  return (
    <div>
      <BackBar onBack={onBack} title="Pay Report" />
      {pay === null ? <p style={{ textAlign: "center", color: "#9ca3af", fontSize: 14, padding: "24px 0" }}>Loading…</p> : (
        <>
          {doneMsg && <div style={{ background: "#ecfdf5", border: "1px solid #a7f3d0", color: "#065f46", borderRadius: 12, padding: "10px 12px", fontSize: 14, fontWeight: 700, marginBottom: 12 }}>✓ {doneMsg}</div>}
          {err && <div style={S.err}>{err}</div>}
          <div style={{ background: "#047857", color: "#fff", borderRadius: 14, padding: "14px 18px", marginBottom: 14 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 8 }}>
              <button onClick={() => setWeekOffset((o) => o - 1)} aria-label="Previous week"
                style={{ background: "rgba(255,255,255,.18)", border: "none", color: "#fff", borderRadius: 8, width: 34, height: 34, fontSize: 16, fontWeight: 800, cursor: "pointer" }}>◀</button>
              <div style={{ textAlign: "center" }}>
                <div style={{ fontSize: 13.5, fontWeight: 800, letterSpacing: ".02em" }}>{weekOffset === 0 ? "This week" : weekOffset === -1 ? "Last week" : "Week of"}</div>
                <div style={{ fontSize: 11.5, fontWeight: 500, opacity: 0.9 }}>{wk.label}</div>
              </div>
              <button onClick={() => setWeekOffset((o) => Math.min(0, o + 1))} disabled={weekOffset >= 0} aria-label="Next week"
                style={{ background: "rgba(255,255,255,.18)", border: "none", color: "#fff", borderRadius: 8, width: 34, height: 34, fontSize: 16, fontWeight: 800, cursor: weekOffset >= 0 ? "default" : "pointer", opacity: weekOffset >= 0 ? 0.4 : 1 }}>▶</button>
            </div>
            <div style={{ fontSize: 30, fontWeight: 800, fontFamily: "'Oswald',sans-serif", textAlign: "center" }}>${total.toLocaleString()}</div>
            <div style={{ fontSize: 12.5, opacity: 0.9, textAlign: "center" }}>{signups.length} signup{signups.length === 1 ? "" : "s"} × $150</div>
          </div>
          {signups.length ? signups.map((r) => (
            <div key={r.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12, padding: "11px 14px", marginBottom: 8 }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 700, fontSize: 14.5 }}>{r.client_name || "(no name)"}{r.cancelled_at ? <span style={{ marginLeft: 6, fontSize: 10, fontWeight: 800, color: "#047857", background: "#ecfdf5", border: "1px solid #a7f3d0", borderRadius: 999, padding: "1px 7px", whiteSpace: "nowrap" }}>✓ inspected — still counts</span> : null}</div>
                <div style={{ fontSize: 12.5, color: "#6b7280" }}>{[r.address, r.city].filter(Boolean).join(", ")}{r.signed_at ? ` · ${fmtDay(r.signed_at)}` : ""}</div>
              </div>
              <div style={{ fontWeight: 800, color: "#047857", fontSize: 15 }}>$150</div>
            </div>
          )) : <p style={{ fontSize: 13.5, color: "#6b7280", padding: "4px 2px 12px" }}>No signups in this week.</p>}

          <div style={{ fontSize: 13, fontWeight: 800, textTransform: "uppercase", letterSpacing: ".03em", color: "#9ca3af", margin: "16px 0 4px" }}>Cancelled this week ({cancels.length}) — these reduce this week's pay</div>
          <div style={{ fontSize: 11.5, color: "#9ca3af", margin: "0 0 8px" }}>You're paid the Friday after each week. Use ◀ to check a week you've already been paid for. Tap a cancel to see why / put it back.</div>
          {!cancels.length ? <p style={{ fontSize: 13.5, color: "#6b7280" }}>No cancels this week. 🎉</p> : cancels.map((r) => {
            const open = openId === r.id;
            const notes = notesOf(r);
            return (
              <div key={r.id} style={{ background: "#fff", border: "1px solid #fecaca", borderRadius: 12, padding: "11px 14px", marginBottom: 8 }}>
                <button onClick={() => setOpenId(open ? null : r.id)} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", width: "100%", textAlign: "left", background: "none", border: "none", cursor: "pointer", padding: 0 }}>
                  <span style={{ minWidth: 0 }}>
                    <span style={{ display: "block", fontWeight: 700, fontSize: 14.5, color: "#111827" }}>{r.client_name || "(no name)"}</span>
                    <span style={{ display: "block", fontSize: 12.5, color: "#6b7280" }}>{[r.address, r.city].filter(Boolean).join(", ")}{r.cancelled_at ? ` · cancelled ${fmtDay(r.cancelled_at)}` : ""}</span>
                  </span>
                  <span style={{ color: "#9ca3af", flexShrink: 0, marginLeft: 8 }}>{open ? "▾" : "▸"}</span>
                </button>
                {open && (
                  <div style={{ marginTop: 10 }}>
                    {r.inspector_name && <div style={{ fontSize: 12.5, fontWeight: 700, color: "#b45309", marginBottom: 6 }}>🛠 Marked lost by: {r.inspector_name}</div>}
                    {notes.length ? notes.map((n, i) => <div key={i} style={{ fontSize: 13, color: "#374151", background: "#f9fafb", border: "1px solid #f0f0f0", borderRadius: 8, padding: "8px 10px", marginBottom: 6 }}>{n}</div>) : <div style={{ fontSize: 12.5, color: "#9ca3af", marginBottom: 6 }}>No notes on file.</div>}
                    <div style={{ fontSize: 12.5, fontWeight: 700, color: "#374151", margin: "8px 0 4px" }}>Put back on the inspection list? A note is required:</div>
                    <textarea value={noteFor[r.id] || ""} onChange={(e) => setNoteFor((m) => ({ ...m, [r.id]: e.target.value }))} rows={2} placeholder="e.g. Homeowner confirmed they still want it — cancelled by mistake."
                      style={{ width: "100%", boxSizing: "border-box", borderRadius: 10, border: "1px solid #d1d5db", padding: "8px 10px", fontSize: 14, fontFamily: "inherit", marginBottom: 8 }} />
                    <button onClick={() => reinstate(r)} disabled={busyId === r.id}
                      style={{ width: "100%", background: NAVY, color: "#fff", border: "none", borderRadius: 10, padding: "11px 0", fontSize: 14.5, fontWeight: 800, cursor: "pointer", opacity: busyId === r.id ? 0.6 : 1 }}>
                      {busyId === r.id ? "Putting back…" : "↩️ Put back on inspection list"}
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </>
      )}
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
              <span style={{ display: "block", fontSize: 11.5, color: "#9ca3af", fontWeight: 700 }}>{d.distance_mi != null ? `${d.distance_mi} mi away` : "distance unknown"}{(d.result_task_at || d.review_availability) ? ` · 🏠 ${goBackDisplay(d)}` : ""}</span>
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
        {(deal.result_task_at || deal.review_availability) && <span style={{ display: "block", marginTop: 4, color: "#166534", fontWeight: 700 }}>🏠 {deal.result_task_at ? "Scheduled" : "Best time to come by"}: {goBackDisplay(deal)}</span>}
        {(() => {
          const log = Array.isArray(deal.pa_notes_log) ? deal.pa_notes_log : [];
          const last = log.length ? (log[log.length - 1].text || log[log.length - 1]) : null;
          return last ? <span style={{ display: "block", marginTop: 6, color: "#b45309", fontWeight: 700, fontStyle: "normal" }}>📝 {last}</span> : null;
        })()}
      </div>
      <button onClick={viewPhotos} disabled={loadingPhotos} style={{ width: "100%", border: `1px solid ${NAVY}`, color: NAVY, background: "#fff", borderRadius: 12, padding: "11px 0", fontSize: 15, fontWeight: 700, marginBottom: 16, cursor: "pointer", opacity: loadingPhotos ? 0.6 : 1 }}>{loadingPhotos ? "Loading photos…" : "📷 View inspection photos"}</button>
      {type === "damage" && <DamagePanel deal={deal} rep={rep} api={api} />}
      {type === "no_damage" && <NoDamagePanel deal={deal} rep={rep} api={api} />}
      {type === "retail" && <RetailPanel deal={deal} rep={rep} api={api} />}
    </div>
  );
}

function BackBar({ onBack, title }) {
  return <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}><button onClick={onBack} style={S.back}>‹ Back</button><span style={{ fontWeight: 800, fontSize: 17 }}>{title}</span></div>;
}

// Upcoming adjuster appointments the rep has booked (future only).
function ApptsBookedView({ appts, rep, onBack }) {
  const fmt = (iso) => { try { return new Date(iso).toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }); } catch { return iso; } };
  return (
    <div>
      <BackBar onBack={onBack} title="Adjuster appointments booked" />
      {appts === null ? <p style={{ textAlign: "center", color: "#9ca3af", fontSize: 14, padding: "24px 0" }}>Loading…</p>
        : !appts.length ? <p style={{ textAlign: "center", color: "#6b7280", fontSize: 14, padding: "24px 0" }}>No upcoming adjuster appointments for your homeowners. Book one on a Damage visit — or the adjuster can set it themselves.</p>
        : <div>{appts.map((a) => (
            <div key={a.id} style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12, padding: "12px 14px", marginBottom: 10 }}>
              <div style={{ fontWeight: 800, fontSize: 15 }}>{a.homeowner_name || "Homeowner"}</div>
              <div style={{ color: "#15803d", fontWeight: 700, fontSize: 13.5, marginTop: 2 }}>🗓 {fmt(a.start_at)}</div>
              <div style={{ fontSize: 13, color: "#475569", marginTop: 2 }}>🧑‍⚖️ {a.pa_name}{a.booked_by && a.booked_by !== rep.name ? <span style={{ color: "#94a3b8" }}> · set by {a.booked_by}</span> : null}</div>
              {a.address && <div style={{ fontSize: 13, color: "#475569", marginTop: 2 }}>📍 {a.address}</div>}
              {a.homeowner_phone && <div style={{ fontSize: 13, marginTop: 2 }}><a href={`tel:${a.homeowner_phone}`} style={{ color: "#0369a1" }}>📞 {a.homeowner_phone}</a></div>}
            </div>
          ))}</div>}
    </div>
  );
}
// Monday 00:00 ET (start of the current pay week) as a UTC ISO string.
function mondayEtIso() {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", weekday: "short" });
  const p = {}; for (const x of f.formatToParts(new Date())) p[x.type] = x.value;
  const wmap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const back = (wmap[p.weekday] + 6) % 7;   // days since Monday
  const guess = Date.UTC(+p.year, +p.month - 1, +p.day - back, 0, 0);
  const asEt = new Date(new Date(guess).toLocaleString("en-US", { timeZone: "America/New_York" }));
  return new Date(guess + (guess - asEt.getTime())).toISOString();
}
// Mon–Sun ET window for a given week offset (0 = this week, -1 = last, …).
// Returns ISO bounds [startIso, endIso) + a "Jun 22 – Jun 28" label.
function weekRange(offset) {
  const monMs = Date.parse(mondayEtIso());
  const startMs = monMs + offset * 7 * 864e5;
  const endMs = startMs + 7 * 864e5;
  const f = (ms) => new Date(ms).toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" });
  return { startIso: new Date(startMs).toISOString(), endIso: new Date(endMs).toISOString(), label: `${f(startMs)} – ${f(endMs - 864e5)}` };
}
