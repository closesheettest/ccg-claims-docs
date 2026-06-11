// Public Adjuster (PA) portal — two views in one file, modeled on the
// inspector portal (InspectorViews.jsx):
//
//   <PAAdminPanel />  — manager-side. Sync PAs from JobNimbus, activate
//     (auto-texts/emails the private ?mode=pa link), edit contact info,
//     resend link, delete. Lives inside the manager view in App.jsx.
//
//   <PAMobileApp />   — PA-side. Mobile-first. The PA picks their name,
//     sees the pool of unclaimed DAMAGE deals, claims the ones they want,
//     and on each claim fills in the 8 "Insurance" milestone date fields
//     (PA filed, INS approved, ISS uploaded, correction needed, install
//     paperwork, move back to retail, advanced, second advance). Each
//     save pushes straight to the JobNimbus job via pa-save-field. The
//     Inspection / Inspected Date / Inspected By fields are shown as
//     read-only context (already set by the inspector flow).
//
// Data model (run docs/sql/2026-06-03-public-adjusters.sql first):
//   pas(id, name, jn_user_id, email, phone, active, registration_token,
//       info_updated_at, app_link_sent_at, notes, created_at)
//   inspections gets: pa_id uuid (null = in the pool), pa_claimed_at,
//                     pa_fields jsonb (local cache of pushed values).

import React, { useEffect, useMemo, useState } from "react";
import { supabase } from "./lib/supabase";

// Haversine distance in miles between two lat/lng pairs. Mirrors the
// inspector portal's milesBetween so PA distances match inspector ones.
function milesBetween(lat1, lng1, lat2, lng2) {
  if (
    typeof lat1 !== "number" || typeof lng1 !== "number" ||
    typeof lat2 !== "number" || typeof lng2 !== "number"
  ) {
    return null;
  }
  const R = 3958.7613;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// ── Local styles (self-contained; mirror InspectorViews) ───────────────
const inputStyle = {
  padding: "8px 10px",
  border: "1px solid #d1d5db",
  borderRadius: 8,
  fontSize: 14,
  fontFamily: "'Nunito', sans-serif",
  width: "100%",
  boxSizing: "border-box",
};
const primaryBtn = {
  padding: "8px 14px",
  background: "#13294b",
  color: "#fff",
  border: "none",
  borderRadius: 8,
  fontWeight: 700,
  fontSize: 13,
  cursor: "pointer",
  fontFamily: "'Oswald', sans-serif",
};
const secondaryBtn = {
  padding: "6px 10px",
  background: "#fff",
  color: "#374151",
  border: "1px solid #d1d5db",
  borderRadius: 8,
  fontSize: 12,
  cursor: "pointer",
};
const dangerBtn = {
  padding: "6px 10px",
  background: "#fff",
  color: "#991b1b",
  border: "1px solid #fca5a5",
  borderRadius: 8,
  fontSize: 12,
  cursor: "pointer",
};

// PA sign-up status — the PA's FIRST action after claiming a deal: they
// talk to the homeowner, who either signs up with them or refuses. Maps
// to JN's "Intro to Customer" dropdown. These strings must match the JN
// dropdown options EXACTLY (see pa-save-field.js PA_SIGNUP_CF note) —
// when that dropdown ships it must include "Need Signature" (renamed
// from the old "Pending"). "Refused to Sign" is NOT a plain save: it
// reverts the deal to retail and texts the field (see refuseToSign).
const PA_SIGNUP_OPTIONS = ["Need Signature", "Signed", "Refused to Sign"];
// Treat the legacy "Pending" value as the same un-decided state so deals
// saved before the rename still read correctly.
function isNeedSignature(v) { return !v || v === "Need Signature" || v === "Pending"; }
function signupColor(opt) {
  if (opt === "Signed") return "#047857";
  if (opt === "Refused to Sign") return "#991b1b";
  return "#92400e"; // Need Signature
}
function signupBg(opt) {
  if (opt === "Signed") return "#ecfdf5";
  if (opt === "Refused to Sign") return "#fef2f2";
  return "#fffbeb"; // Need Signature
}

// The PA-editable milestone fields shown in the portal's Insurance
// section. Order matches the JN "Insurance" section. (Correction Needed,
// Install Paperwork, Move Back to Retail, Advanced, and Second Advance
// were removed from the portal at Neal's request — the JN fields still
// exist, they're just not surfaced here.)
const PA_FIELDS = [
  { key: "pa_filed",            label: "PA - Filed" },
  { key: "ins_approved",        label: "INS - Approved" },
  { key: "iss_uploaded",        label: "ISS Uploaded" },
];

// ── Date helpers. JN custom dates are unix epoch SECONDS. We anchor the
//    day to NOON UTC so converting to/from a <input type=date> never
//    shifts a day across US timezones. ───────────────────────────────
function epochToDateInput(epoch) {
  if (!epoch) return "";
  const d = new Date(epoch * 1000);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function dateInputToEpoch(s) {
  if (!s) return null;
  const [y, m, d] = s.split("-").map(Number);
  if (!y || !m || !d) return null;
  return Math.floor(Date.UTC(y, m - 1, d, 12, 0, 0) / 1000);
}
function epochToDisplay(epoch) {
  if (!epoch) return "—";
  return new Date(epoch * 1000).toLocaleDateString("en-US", {
    month: "short", day: "numeric", year: "numeric", timeZone: "UTC",
  });
}

// ═════════════════════════════════════════════════════════════════════
// ADMIN PANEL — manager-only.
// ═════════════════════════════════════════════════════════════════════
// Shared PA activate/deactivate. Used by BOTH the PA admin panel and the
// unified Team Roles roster so the side effects stay in one place:
//   • activate   → auto-send the portal link (SMS/email)
//   • deactivate → park the PA's live claims in "PA Decision Needed" so a
//                  manager decides where each one goes (instead of dumping
//                  them back into the open pool)
// Returns { ok, text }. The caller reloads its own lists + shows the message.
export async function setPaActive(pa, makeActive) {
  const { error } = await supabase.from("pas").update({ active: makeActive }).eq("id", pa.id);
  if (error) return { ok: false, text: error.message };

  // Deactivation: park active claims for a manager decision. Keep pa_id so
  // the queue can show who had it. Only touch live (not cancelled/parked).
  if (!makeActive) {
    const { data: parked } = await supabase
      .from("inspections")
      .update({
        pa_decision_needed: true,
        pa_decision_reason: `PA ${pa.name} deactivated`,
        pa_decision_at: new Date().toISOString(),
      })
      .eq("pa_id", pa.id)
      .is("cancelled_at", null)
      .eq("pa_decision_needed", false)
      .select("id");
    const n = parked?.length || 0;
    return {
      ok: true,
      text: n > 0
        ? `Deactivated ${pa.name}. Moved ${n} deal${n === 1 ? "" : "s"} to "PA Decision Needed" to reassign.`
        : `Deactivated ${pa.name}.`,
    };
  }

  // Activation: auto-send the portal link.
  if (!pa.email && !pa.phone) {
    return { ok: true, text: `Activated ${pa.name}. No email/phone on file — add one via Edit, then Resend link.` };
  }
  try {
    const res = await fetch("/.netlify/functions/send-pa-app-invite", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paId: pa.id, channel: "auto" }),
    });
    const body = await res.json().catch(() => ({}));
    if (!body.ok) {
      return { ok: false, text: `Activated, but link send failed: ${body.error || `status ${res.status}`}` };
    }
    const dest = body.channel_used === "sms" ? `📱 SMS to ${body.phone}` : `📧 email to ${body.email}`;
    return { ok: true, text: `Activated ${pa.name} — portal link sent (${dest}).` };
  } catch (e) {
    return { ok: false, text: `Activated, but link send failed: ${e.message || "Network error"}` };
  }
}

export function PAAdminPanel() {
  const [pas, setPas] = useState([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState(null);
  const [syncing, setSyncing] = useState(false);
  const [busyId, setBusyId] = useState(null);
  const [backfill, setBackfill] = useState(null); // {running, done, total, copied, failed}
  const [decisions, setDecisions] = useState([]);
  const [decisionsLoading, setDecisionsLoading] = useState(true);
  const [reconciling, setReconciling] = useState(false);
  // Auto-assign + oversight
  const [autoAssign, setAutoAssign] = useState(true);
  const [overview, setOverview] = useState({ byPa: {}, unassignedList: [], dead: [] });
  const [needsGps, setNeedsGps] = useState(null);   // {lat,lng} → sort Needs-assigning by distance from me
  const [allDeals, setAllDeals] = useState([]);
  const [selected, setSelected] = useState(() => new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [report, setReport] = useState(null);   // { rows, totals } | null (hidden)
  const [reportBusy, setReportBusy] = useState(false);
  const [companies, setCompanies] = useState([]);
  const [companyBusy, setCompanyBusy] = useState(false);
  const [geocodingPas, setGeocodingPas] = useState(false);

  useEffect(() => { loadPas(); loadDecisions(); loadOverview(); loadAllDeals(); loadCompanies(); }, []);

  // ── PA Companies (multi-tenant) ───────────────────────────────────────
  async function loadCompanies() {
    const { data } = await supabase.from("pa_companies").select("*").order("name", { ascending: true });
    setCompanies(data || []);
  }
  function makeToken() {
    // URL-safe random token for the company admin's personal link.
    const a = new Uint8Array(16);
    (crypto || window.crypto).getRandomValues(a);
    return Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("");
  }
  async function createCompany(name) {
    const nm = (name || "").trim();
    if (!nm) return null;
    setCompanyBusy(true);
    const { data, error } = await supabase.from("pa_companies")
      .insert({ name: nm, token: makeToken(), active: true })
      .select().single();
    setCompanyBusy(false);
    if (error) { setMessage({ kind: "error", text: error.message }); return null; }
    await loadCompanies();
    return data;
  }
  async function updateCompany(id, patch) {
    setCompanyBusy(true);
    const { error } = await supabase.from("pa_companies")
      .update({ ...patch, updated_at: new Date().toISOString() }).eq("id", id);
    setCompanyBusy(false);
    if (error) { setMessage({ kind: "error", text: error.message }); return; }
    loadCompanies();
  }
  // Assign a PA to a company (companyId="" → independent). Accepts a company
  // NAME to create-on-the-fly when it doesn't exist yet.
  async function setPaCompany(pa, companyIdOrNull) {
    const { error } = await supabase.from("pas")
      .update({ pa_company_id: companyIdOrNull || null }).eq("id", pa.id);
    if (error) { setMessage({ kind: "error", text: error.message }); return; }
    loadPas();
  }

  // Bulk-geocode adjusters: every PA with a home_address but no coords yet
  // gets run through geocode-place → lat/lng saved (for distance assigning).
  async function geocodeAdjusters() {
    setGeocodingPas(true); setMessage(null);
    const { data } = await supabase.from("pas").select("id,name,home_address,latitude").not("home_address", "is", null);
    const todo = (data || []).filter((p) => p.home_address && p.latitude == null);
    if (!todo.length) {
      setGeocodingPas(false);
      setMessage({ kind: "success", text: "All adjusters with a home address are already geocoded. 👍" });
      return;
    }
    let ok = 0, fail = 0;
    for (const p of todo) {
      try {
        const r = await fetch("/.netlify/functions/geocode-place", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query: p.home_address }),
        });
        const g = await r.json().catch(() => ({}));
        if (g.ok && typeof g.lat === "number") {
          const { error } = await supabase.from("pas").update({ latitude: g.lat, longitude: g.lng }).eq("id", p.id);
          error ? fail++ : ok++;
        } else fail++;
      } catch { fail++; }
    }
    setGeocodingPas(false);
    setMessage({ kind: fail ? "error" : "success", text: `Geocoded ${ok} adjuster${ok === 1 ? "" : "s"}${fail ? ` · ${fail} couldn't be found (check the address)` : ""}.` });
    loadPas();
  }

  // Auto-assign toggle state + per-PA open load + unassigned pool + dead deals.
  async function loadOverview() {
    try {
      const { data: cfg } = await supabase.from("auto_sms").select("enabled").eq("key", "pa_auto_assign").maybeSingle();
      setAutoAssign(!cfg || cfg.enabled !== false);
      const { data: openRows } = await supabase.from("inspections")
        .select("pa_id").not("pa_id", "is", null).is("cancelled_at", null)
        .or("pa_stage.is.null,pa_stage.neq.dead");
      const byPa = {};
      (openRows || []).forEach((r) => { byPa[r.pa_id] = (byPa[r.pa_id] || 0) + 1; });
      const { data: unassignedList } = await supabase.from("inspections")
        .select("id, client_name, signed_at, address, city, state, zip, county, latitude, longitude")
        .eq("result", "damage").is("pa_id", null).is("pa_company_id", null).not("jn_job_id", "is", null)
        .is("cancelled_at", null).eq("pa_decision_needed", false).not("signed_at", "is", null)
        .order("signed_at", { ascending: false }).limit(200);
      const { data: dead } = await supabase.from("inspections")
        .select("id, client_name, pa_id, pa_stage_at, pa_notes_log")
        .eq("pa_stage", "dead").order("pa_stage_at", { ascending: false }).limit(100);
      setOverview({ byPa, unassignedList: unassignedList || [], dead: dead || [] });
    } catch { /* non-fatal */ }
  }

  // Per-PA scorecard. One pull of EVERY damage deal that bears a pa_id
  // (incl. cancelled/dead) → per PA: assigned (open) · working · avg days to
  // signed · sign% · lost% · taken-away%. Percentages are over everything the
  // PA ever handled (open + lost + dead + taken-away). Toggle hides/shows.
  async function loadProgressReport() {
    if (report) { setReport(null); return; } // toggle off
    setReportBusy(true);
    try {
      const { data, error } = await supabase.from("inspections")
        .select("id, pa_id, pa_stage, pa_opened_at, pa_notes_log, pa_fields, signed_at, cancelled_at, pa_claimed_at, pa_signed_at")
        .eq("result", "damage").not("pa_id", "is", null)
        .limit(5000);
      if (error) throw error;
      const blank = () => ({ open: 0, working: 0, signed: 0, lost: 0, dead: 0, handled: 0, _days: [] });
      const byPa = {};
      for (const r of data || []) {
        const b = (byPa[r.pa_id] = byPa[r.pa_id] || blank());
        b.handled++;
        if (r.cancelled_at) { b.lost++; continue; }
        if (r.pa_stage === "dead") { b.dead++; continue; }
        b.open++;
        const signed = r.pa_fields?.pa_signup === "Signed";
        const working = !!r.pa_opened_at || (Array.isArray(r.pa_notes_log) && r.pa_notes_log.length > 0);
        if (signed) {
          b.signed++;
          if (r.pa_claimed_at && r.pa_signed_at) {
            const d = (new Date(r.pa_signed_at).getTime() - new Date(r.pa_claimed_at).getTime()) / 86400000;
            if (Number.isFinite(d) && d >= 0) b._days.push(d);
          }
        } else if (working) b.working++;
      }
      const pct = (n, d) => (d > 0 ? Math.round((n / d) * 100) : 0);
      const rows = (pas || []).filter((p) => p.active).map((p) => {
        const b = byPa[p.id] || blank();
        const taken = p.pa_takeaways || 0;
        const denom = b.handled + taken;               // everything ever given to them
        const avgDaysToSign = b._days.length ? Math.round(b._days.reduce((s, n) => s + n, 0) / b._days.length) : null;
        const comp = companies.find((c) => c.id === p.pa_company_id);
        return {
          id: p.id, name: p.name,
          company_id: p.pa_company_id || null,
          company_name: comp?.name || "Independent",
          assigned: b.open, working: b.working, signed: b.signed, lost: b.lost, dead: b.dead,
          taken, denom, avgDaysToSign,
          signPct: pct(b.signed, denom), lostPct: pct(b.lost, denom), takenPct: pct(taken, denom),
        };
      }).sort((a, b) => a.company_name.localeCompare(b.company_name) || (b.assigned - a.assigned) || a.name.localeCompare(b.name));
      const T = rows.reduce((t, r) => {
        ["assigned", "working", "signed", "lost", "dead", "taken", "denom"].forEach((k) => t[k] += r[k]);
        if (r.avgDaysToSign != null) { t._daysSum += r.avgDaysToSign * r.signed; t._daysN += r.signed; }
        return t;
      }, { assigned: 0, working: 0, signed: 0, lost: 0, dead: 0, taken: 0, denom: 0, _daysSum: 0, _daysN: 0 });
      T.signPct = pct(T.signed, T.denom); T.lostPct = pct(T.lost, T.denom); T.takenPct = pct(T.taken, T.denom);
      T.avgDaysToSign = T._daysN ? Math.round(T._daysSum / T._daysN) : null;
      setReport({ rows, totals: T });
    } catch (e) {
      setMessage({ kind: "error", text: e.message || "Couldn't build the report." });
    }
    setReportBusy(false);
  }

  // Flip the auto-assign cron on/off via the auto_sms registry row.
  async function toggleAuto() {
    const next = !autoAssign;
    setAutoAssign(next);
    const { error } = await supabase.from("auto_sms").upsert({
      key: "pa_auto_assign",
      name: "PA auto-assign",
      description: "Auto-assign damage deals to active PAs (round-robin). Off = pause.",
      enabled: next,
      updated_at: new Date().toISOString(),
    }, { onConflict: "key" });
    if (error) { setAutoAssign(!next); setMessage({ kind: "error", text: error.message }); return; }
    setMessage({ kind: "success", text: next
      ? "Auto-assign ON — new damage deals route to PAs automatically."
      : "Auto-assign PAUSED — new deals wait unassigned until you turn it back on or assign below." });
  }

  // Manager override: assign a specific unassigned deal to a chosen PA.
  async function assignTo(dealId, paId) {
    if (!paId) return;
    setBusyId(dealId);
    const nowIso = new Date().toISOString();
    const { error } = await supabase.from("inspections")
      .update({ pa_id: paId, pa_claimed_at: nowIso, pa_stage: "active", pa_stage_at: nowIso })
      .eq("id", dealId);
    setBusyId(null);
    if (error) { setMessage({ kind: "error", text: error.message }); return; }
    setMessage({ kind: "success", text: "Assigned." });
    loadOverview();
  }

  // Full list of every live damage deal (assigned + unassigned, excl. dead)
  // for the bulk reassign tool.
  // Only deals with NO PA activity — never opened (pa_opened_at null) AND no
  // notes. These are the safe ones to reassign / move to a company pool; deals
  // a PA is actively working are intentionally hidden so they're not yanked.
  async function loadAllDeals() {
    const { data } = await supabase.from("inspections")
      .select("id, client_name, signed_at, pa_id, pa_stage, pa_opened_at, pa_notes_log")
      .eq("result", "damage").is("cancelled_at", null).is("pa_opened_at", null)
      .or("pa_stage.is.null,pa_stage.neq.dead")
      .order("signed_at", { ascending: false }).limit(1000);
    const untouched = (data || []).filter((d) => !Array.isArray(d.pa_notes_log) || d.pa_notes_log.length === 0);
    setAllDeals(untouched);
  }
  function toggleSel(id) {
    setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }
  function setManySel(ids, on) {
    setSelected((s) => { const n = new Set(s); ids.forEach((id) => on ? n.add(id) : n.delete(id)); return n; });
  }
  // paId="" → unassign the selected deals; else assign/move them to that PA.
  // target: "" → unassign · "company:<id>" → drop into a company POOL (pa_id
  // cleared, company admin assigns) · else a PA id → assign directly.
  // Assign a single unassigned deal to a company pool ("company:<id>") or a
  // PA ("<paId>") — same patch shape as bulkApply, for the county-grouped
  // "Needs assigning" list below.
  async function assignOne(dealId, target) {
    if (!target) return;
    setBulkBusy(true);
    const nowIso = new Date().toISOString();
    let patch, who;
    if (target.startsWith("company:")) {
      const cid = target.slice("company:".length);
      patch = { pa_company_id: cid, pa_company_at: nowIso, pa_id: null, pa_claimed_at: null, pa_stage: null, pa_stage_at: nowIso, pa_opened_at: null };
      who = `${companies.find((c) => c.id === cid)?.name || "company"} pool`;
    } else {
      patch = { pa_id: target, pa_company_id: null, pa_claimed_at: nowIso, pa_stage: "active", pa_stage_at: nowIso };
      who = pas.find((p) => p.id === target)?.name || "PA";
    }
    const { error } = await supabase.from("inspections").update(patch).eq("id", dealId);
    setBulkBusy(false);
    if (error) { setMessage({ kind: "error", text: error.message }); return; }
    setMessage({ kind: "success", text: `Assigned to ${who}.` });
    loadOverview(); loadAllDeals(); loadPas();
  }

  async function bulkApply(target) {
    const ids = [...selected];
    if (!ids.length) { setMessage({ kind: "error", text: "Select at least one deal first." }); return; }
    setBulkBusy(true);
    const nowIso = new Date().toISOString();
    let patch, who;
    if (target && target.startsWith("company:")) {
      const cid = target.slice("company:".length);
      // Into the company pool: clear the PA + working state, stamp pool entry.
      patch = { pa_company_id: cid, pa_company_at: nowIso, pa_id: null, pa_claimed_at: null, pa_stage: null, pa_stage_at: nowIso, pa_opened_at: null };
      who = `${companies.find((c) => c.id === cid)?.name || "company"} pool`;
    } else if (target) {
      patch = { pa_id: target, pa_company_id: null, pa_claimed_at: nowIso, pa_stage: "active", pa_stage_at: nowIso };
      who = pas.find((p) => p.id === target)?.name || "PA";
    } else {
      patch = { pa_id: null, pa_company_id: null, pa_claimed_at: null, pa_stage: null, pa_stage_at: nowIso };
      who = "nobody (unassigned)";
    }
    // Count takeaways: deals being moved OFF a PA (had a pa_id, new target
    // isn't that same PA) — bumps each old PA's scorecard "taken away" tally.
    const movedOff = {};
    if (!(target && !target.startsWith("company:"))) {
      // company-pool move or unassign → any current pa_id is a takeaway
      for (const id of ids) { const d = allDeals.find((x) => x.id === id); if (d?.pa_id) movedOff[d.pa_id] = (movedOff[d.pa_id] || 0) + 1; }
    } else {
      // reassign to a PA → takeaway only from a DIFFERENT prior PA
      for (const id of ids) { const d = allDeals.find((x) => x.id === id); if (d?.pa_id && d.pa_id !== target) movedOff[d.pa_id] = (movedOff[d.pa_id] || 0) + 1; }
    }
    const { error } = await supabase.from("inspections").update(patch).in("id", ids);
    setBulkBusy(false);
    if (error) { setMessage({ kind: "error", text: error.message }); return; }
    await bumpTakeaways(movedOff);
    setMessage({ kind: "success", text: `Moved ${ids.length} deal${ids.length === 1 ? "" : "s"} to ${who}.` });
    setSelected(new Set());
    loadAllDeals(); loadOverview(); loadPas();
  }

  // Increment pas.pa_takeaways by n for each {paId: n}. Read-then-write (admin
  // is single-user, so racing isn't a concern).
  async function bumpTakeaways(counts) {
    for (const [paId, n] of Object.entries(counts || {})) {
      if (!n) continue;
      const { data } = await supabase.from("pas").select("pa_takeaways").eq("id", paId).maybeSingle();
      const cur = data?.pa_takeaways || 0;
      await supabase.from("pas").update({ pa_takeaways: cur + n }).eq("id", paId);
    }
  }

  // Deals parked in the "PA Decision Needed" queue — claimed-then-Lost,
  // Sit Sold PA (old PA), Ops-Hub refused, or a deactivated PA's deals.
  async function loadDecisions() {
    setDecisionsLoading(true);
    const { data, error } = await supabase
      .from("inspections")
      .select("id, client_name, address, city, state, zip, county, signed_at, jn_job_id, result, pa_id, pa_decision_reason, pa_decision_at, jn_status, pa_status")
      .eq("pa_decision_needed", true)
      .order("pa_decision_at", { ascending: false })
      .limit(300);
    if (!error) setDecisions(data || []);
    setDecisionsLoading(false);
  }

  // Pull live JN status for PA-relevant damage deals so old deals that
  // quietly went Lost (outside the 15-min cron's update window) get pulled
  // into this queue now instead of lingering as claimable.
  async function refreshFromJn() {
    setReconciling(true);
    try {
      const res = await fetch("/.netlify/functions/reconcile-pa-jn-status", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
      });
      const body = await res.json().catch(() => ({}));
      if (!body.ok) {
        setMessage({ kind: "error", text: body.error || `Refresh failed (status ${res.status})` });
      } else {
        const moved = (body.parked_lost || 0) + (body.parked_sit_sold || 0);
        const ss = body.sit_sold_scanned || 0;
        setMessage({
          kind: "success",
          text: `Checked ${body.examined} live deal${body.examined === 1 ? "" : "s"} + scanned ${ss} Sit Sold PA job${ss === 1 ? "" : "s"} in JobNimbus — ${moved} newly parked for a decision, ${body.lost_cancelled || 0} Lost deal${body.lost_cancelled === 1 ? "" : "s"} cleared from the pool.`,
        });
        await loadDecisions();
      }
    } catch (e) {
      setMessage({ kind: "error", text: e.message || "Network error" });
    }
    setReconciling(false);
  }

  // Put a parked deal into the PA pool: reactivate it (clear the Lost/
  // cancelled + decision flags) and leave pa_id null so it shows in the
  // open, claimable pool for ANY active adjuster — instead of routing it
  // to one specific PA. An optional note rides along and shows to whoever
  // claims it. pa_decision_resolved_at guards the JN reconcile/Lost cron
  // from immediately re-pulling it.
  async function releaseToPool(deal, note) {
    setBusyId(deal.id);
    const nowIso = new Date().toISOString();
    const { error } = await supabase
      .from("inspections")
      .update({
        pa_id: null,
        pa_claimed_at: null,
        cancelled_at: null,
        cancel_reason: null,
        pa_decision_needed: false,
        pa_decision_reason: null,
        pa_decision_at: null,
        pa_decision_resolved_at: nowIso,
        pa_assignment_note: (note || "").trim() || null,
      })
      .eq("id", deal.id);
    setBusyId(null);
    if (error) { setMessage({ kind: "error", text: error.message }); return; }
    setMessage({ kind: "success", text: `Put ${deal.client_name || "deal"} into the PA pool. Any active adjuster can now claim it.` });
    await loadDecisions();
  }

  // Dismiss without assigning — clears it from the queue (keeps it cancelled
  // if it was Lost). Use when a deal genuinely shouldn't go to any PA.
  async function dismissDeal(deal) {
    if (!confirm(`Remove "${deal.client_name || "this deal"}" from the decision queue without assigning it to a PA?`)) return;
    setBusyId(deal.id);
    const { error } = await supabase
      .from("inspections")
      .update({
        pa_decision_needed: false,
        pa_decision_reason: null,
        pa_decision_resolved_at: new Date().toISOString(),
      })
      .eq("id", deal.id);
    setBusyId(null);
    if (error) { setMessage({ kind: "error", text: error.message }); return; }
    setMessage({ kind: "success", text: `Removed ${deal.client_name || "deal"} from the decision queue.` });
    await loadDecisions();
  }

  // One-off: copy JN-only inspection photos into our own storage for every
  // historical DAMAGE deal that doesn't have app-side photos yet. Self-
  // limiting — new inspections capture app-side, so this set only shrinks.
  // Fans out to pull-jn-photos-to-app per record (small concurrency) to
  // avoid any single-function timeout.
  async function runPhotoBackfill() {
    if (!confirm(
      "Copy JobNimbus photos into the app for all older DAMAGE deals that " +
      "don't have app-side photos yet?\n\nThis is safe to run repeatedly — " +
      "deals that already have app photos are skipped.",
    )) return;

    setBackfill({ running: true, done: 0, total: 0, copied: 0, failed: 0 });
    // Find damage deals with a JN job but no app-side photos. inspection_photos
    // is jsonb; fetch the candidates and filter client-side (null OR empty).
    const { data, error } = await supabase
      .from("inspections")
      .select("id, inspection_photos")
      .eq("result", "damage")
      .not("jn_job_id", "is", null)
      .limit(2000);
    if (error) { setBackfill(null); setMessage({ kind: "error", text: error.message }); return; }
    const targets = (data || []).filter(
      (r) => !Array.isArray(r.inspection_photos) || r.inspection_photos.length === 0,
    );
    if (targets.length === 0) {
      setBackfill(null);
      setMessage({ kind: "success", text: "Nothing to backfill — every damage deal already has app-side photos." });
      return;
    }

    setBackfill({ running: true, done: 0, total: targets.length, copied: 0, failed: 0 });
    let done = 0, copied = 0, failed = 0;
    const CONCURRENCY = 4;
    let idx = 0;
    async function worker() {
      while (idx < targets.length) {
        const t = targets[idx++];
        try {
          const res = await fetch("/.netlify/functions/pull-jn-photos-to-app", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ inspectionId: t.id }),
          });
          const body = await res.json().catch(() => ({}));
          if (body.ok) copied += body.copied || 0; else failed++;
        } catch { failed++; }
        done++;
        setBackfill({ running: true, done, total: targets.length, copied, failed });
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, targets.length) }, worker));
    setBackfill(null);
    setMessage({
      kind: failed > 0 ? "error" : "success",
      text: `Photo backfill done — processed ${done} deal${done === 1 ? "" : "s"}, copied ${copied} photo${copied === 1 ? "" : "s"}${failed > 0 ? `, ${failed} failed` : ""}.`,
    });
  }

  async function loadPas() {
    setLoading(true);
    const { data, error } = await supabase.from("pas").select("*").order("name", { ascending: true });
    if (error) { setMessage({ kind: "error", text: error.message }); setLoading(false); return; }
    setPas(data || []);
    setLoading(false);
  }

  async function syncFromJn() {
    if (!confirm(
      "Pull the user list from JobNimbus?\n\nNew JN users get added as " +
      "INACTIVE public adjusters (you choose who to activate). Existing " +
      "rows have their name + email refreshed without touching their " +
      "active status or phone.",
    )) return;
    setSyncing(true);
    try {
      const res = await fetch("/.netlify/functions/sync-pas-from-jn", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}),
      });
      const body = await res.json().catch(() => ({}));
      if (!body.ok) {
        setMessage({ kind: "error", text: body.error || `Sync failed (status ${res.status})` });
      } else {
        setMessage({
          kind: "success",
          text: `Synced ${body.total_jn_users} JN users — ${body.inserted} new (inactive), ${body.updated} refreshed${body.skipped ? `, ${body.skipped} skipped` : ""}.`,
        });
        await loadPas();
      }
    } catch (e) {
      setMessage({ kind: "error", text: e.message || "Network error" });
    }
    setSyncing(false);
  }

  async function toggleActive(pa) {
    // Shared with the Team Roles roster — see setPaActive above.
    setBusyId(pa.id);
    const result = await setPaActive(pa, !pa.active);
    await loadPas();
    await loadDecisions();
    setBusyId(null);
    setMessage({ kind: result.ok ? "success" : "error", text: result.text });
  }

  async function resendLink(pa) {
    if (!pa.email && !pa.phone) {
      return setMessage({ kind: "error", text: `${pa.name} has no email or phone on file. Add one via Edit first.` });
    }
    setBusyId(pa.id);
    try {
      const res = await fetch("/.netlify/functions/send-pa-app-invite", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paId: pa.id, channel: "auto" }),
      });
      const body = await res.json().catch(() => ({}));
      if (!body.ok) {
        setMessage({ kind: "error", text: body.error || `Send failed (status ${res.status})` });
      } else {
        const dest = body.channel_used === "sms" ? `📱 SMS to ${body.phone}` : `📧 email to ${body.email}`;
        setMessage({ kind: "success", text: `Portal link sent (${dest}).` });
        await loadPas();
      }
    } catch (e) {
      setMessage({ kind: "error", text: e.message || "Network error" });
    }
    setBusyId(null);
  }

  async function updatePa(pa, patch) {
    const { error } = await supabase.from("pas").update(patch).eq("id", pa.id);
    if (error) return setMessage({ kind: "error", text: error.message });
    loadPas();
  }

  async function deletePa(pa) {
    if (!confirm(`Delete public adjuster "${pa.name}"? Any deals they've claimed will be released back to the pool.`)) return;
    await supabase.from("inspections").update({ pa_id: null, pa_claimed_at: null }).eq("pa_id", pa.id);
    const { error } = await supabase.from("pas").delete().eq("id", pa.id);
    if (error) return setMessage({ kind: "error", text: error.message });
    setMessage({ kind: "success", text: `Removed ${pa.name}.` });
    loadPas();
  }

  const active = pas.filter((p) => p.active);
  const inactive = pas.filter((p) => !p.active);

  const renderGroup = (label, color, list, hint) => (
    <section key={label} style={{ border: "1px solid #e5e7eb", borderRadius: 12, padding: 16, background: "#fff", marginBottom: 12 }}>
      <div style={{ fontSize: 14, fontWeight: 700, color, marginBottom: hint ? 4 : 10 }}>
        {label} ({list.length})
      </div>
      {hint && <div style={{ fontSize: 11, color: "#6b7280", marginBottom: 10 }}>{hint}</div>}
      <div style={{ display: "grid", gap: 8 }}>
        {list.map((pa) => (
          <PARow
            key={pa.id}
            pa={pa}
            companies={companies}
            busy={busyId === pa.id}
            onToggle={() => toggleActive(pa)}
            onResend={() => resendLink(pa)}
            onUpdate={(patch) => updatePa(pa, patch)}
            onDelete={() => deletePa(pa)}
            onSetCompany={(cid) => setPaCompany(pa, cid)}
            onCreateCompany={createCompany}
          />
        ))}
      </div>
    </section>
  );

  return (
    <div style={{ display: "grid", gap: 18 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 18, fontWeight: 700, fontFamily: "'Oswald', sans-serif" }}>🧑‍⚖️ Public Adjusters</div>
          <div style={{ fontSize: 12, color: "#6b7280", marginTop: 4 }}>
            Pull adjusters from JobNimbus, then activate the ones you want. Activating
            texts/emails them a private portal link where they claim the damage deals
            they want and fill in each insurance milestone — which writes straight to JobNimbus.
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6, alignItems: "flex-end" }}>
          <button type="button" onClick={syncFromJn} disabled={syncing} style={{ ...primaryBtn, padding: "8px 16px", fontSize: 13, whiteSpace: "nowrap" }}>
            {syncing ? "Syncing…" : "🔄 Sync from JN"}
          </button>
          <button
            type="button"
            onClick={() => window.open("/?mode=pa&admin=1", "_blank")}
            style={{ ...secondaryBtn, padding: "6px 12px", fontSize: 11, whiteSpace: "nowrap" }}
            title="Opens the PA portal in a new tab for QA."
          >
            👁 Preview as PA
          </button>
          <button
            type="button"
            onClick={geocodeAdjusters}
            disabled={geocodingPas}
            style={{ ...secondaryBtn, padding: "6px 12px", fontSize: 11, whiteSpace: "nowrap" }}
            title="Geocode any adjuster that has a home address but no coordinates yet (for distance assigning)."
          >
            {geocodingPas ? "🌐 Geocoding…" : "🌐 Geocode adjusters"}
          </button>
          <button
            type="button"
            onClick={runPhotoBackfill}
            disabled={!!backfill?.running}
            style={{ ...secondaryBtn, padding: "6px 12px", fontSize: 11, whiteSpace: "nowrap" }}
            title="Copy JobNimbus photos into the app for older damage deals that don't have app-side photos yet."
          >
            {backfill?.running
              ? `⬇ Saving ${backfill.done}/${backfill.total}…`
              : "⬇ Backfill JN photos"}
          </button>
        </div>
      </div>

      {backfill?.running && (
        <div style={{ padding: "10px 14px", borderRadius: 10, fontSize: 13, background: "#eff6ff", border: "1px solid #bfdbfe", color: "#1e3a8a" }}>
          Copying JobNimbus photos into the app… {backfill.done} of {backfill.total} deals done
          {backfill.copied > 0 ? ` · ${backfill.copied} photos saved` : ""}
          {backfill.failed > 0 ? ` · ${backfill.failed} failed` : ""}. Keep this tab open.
        </div>
      )}

      {message && (
        <div style={{
          padding: "10px 14px", borderRadius: 10, fontSize: 13,
          background: message.kind === "success" ? "#ecfdf5" : "#fef2f2",
          border: `1px solid ${message.kind === "success" ? "#86efac" : "#fca5a5"}`,
          color: message.kind === "success" ? "#065f46" : "#991b1b",
        }}>
          {message.text}
        </div>
      )}

      {/* ── PA Companies (multi-tenant) — kept near the top so it's easy to find. */}
      <PACompaniesPanel companies={companies} pas={pas} busy={companyBusy}
        onUpdate={updateCompany} onCreate={createCompany} />

      {/* ── Auto-assign & oversight ─────────────────────────────────── */}
      <section style={{ border: "1px solid #c7d2fe", borderRadius: 12, padding: 16, background: "#eef2ff" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <div style={{ flex: 1, minWidth: 220 }}>
            <div style={{ fontSize: 15, fontWeight: 800, color: "#3730a3", fontFamily: "'Oswald', sans-serif" }}>🔁 Auto-assign</div>
            <div style={{ fontSize: 12, color: "#4338ca", marginTop: 2 }}>
              Damage deals route to active PAs automatically (round-robin; each PA works newest signings first). PAs no longer self-claim.
            </div>
          </div>
          <button type="button" onClick={toggleAuto}
            style={{ ...secondaryBtn, fontWeight: 800, fontSize: 13, padding: "10px 16px", whiteSpace: "nowrap",
              background: autoAssign ? "#16a34a" : "#fff", color: autoAssign ? "#fff" : "#991b1b",
              borderColor: autoAssign ? "#16a34a" : "#fca5a5" }}>
            {autoAssign ? "✓ Auto-assign ON" : "⏸ Auto-assign OFF"}
          </button>
        </div>

        {/* Per-PA open load + unassigned count */}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12 }}>
          {active.map((pa) => (
            <span key={pa.id} style={{ fontSize: 12, fontWeight: 700, color: "#3730a3", background: "#fff", border: "1px solid #c7d2fe", borderRadius: 999, padding: "4px 10px" }}>
              {pa.name}: {overview.byPa[pa.id] || 0}
            </span>
          ))}
          <span style={{ fontSize: 12, fontWeight: 700, color: overview.unassignedList.length ? "#b45309" : "#6b7280", background: "#fff", border: `1px solid ${overview.unassignedList.length ? "#fcd34d" : "#e5e7eb"}`, borderRadius: 999, padding: "4px 10px" }}>
            Unassigned: {overview.unassignedList.length}
          </span>
        </div>

        {/* Progress report — per-PA breakdown across the pipeline buckets. */}
        <div style={{ marginTop: 12 }}>
          <button type="button" onClick={loadProgressReport} disabled={reportBusy}
            style={{ ...secondaryBtn, fontWeight: 800, fontSize: 13, padding: "9px 14px",
              background: report ? "#3730a3" : "#fff", color: report ? "#fff" : "#3730a3", borderColor: "#a5b4fc" }}>
            {reportBusy ? "Building…" : report ? "📊 Hide PA report card" : "📊 PA report card"}
          </button>
        </div>

        {report && <PAProgressReport report={report} />}

        {/* Needs assigning — unassigned damage deals, grouped by county;
            within a county, nearest-first when GPS distance is on, else
            newest-signed. Assign each to a company pool or straight to a PA. */}
        {overview.unassignedList.length > 0 && (() => {
          const items = overview.unassignedList.map((d) => ({
            ...d,
            _dist: needsGps && typeof d.latitude === "number" && typeof d.longitude === "number"
              ? milesBetween(needsGps.lat, needsGps.lng, d.latitude, d.longitude) : null,
          }));
          const groups = {};
          for (const d of items) { const c = d.county || "Other / no county"; (groups[c] = groups[c] || []).push(d); }
          for (const c of Object.keys(groups)) groups[c].sort((a, b) => needsGps ? (a._dist ?? 1e9) - (b._dist ?? 1e9) : new Date(b.signed_at || 0) - new Date(a.signed_at || 0));
          const ordered = Object.keys(groups).sort((a, b) => a === "Other / no county" ? 1 : b === "Other / no county" ? -1 : a.localeCompare(b)).map((c) => ({ county: c, jobs: groups[c] }));
          return (
            <div style={{ marginTop: 14, border: "1px solid #fcd34d", borderRadius: 12, background: "#fffbeb", padding: 14 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
                <div style={{ fontSize: 14, fontWeight: 800, color: "#92400e" }}>🆕 Needs assigning ({overview.unassignedList.length}) — by county{needsGps ? ", nearest first" : ""}</div>
                <button type="button" onClick={() => {
                  if (needsGps) { setNeedsGps(null); return; }
                  if (!navigator.geolocation) { setMessage({ kind: "error", text: "No GPS on this device." }); return; }
                  navigator.geolocation.getCurrentPosition(
                    (p) => setNeedsGps({ lat: p.coords.latitude, lng: p.coords.longitude }),
                    () => setMessage({ kind: "error", text: "Couldn't get your location." }),
                    { enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 });
                }} style={{ ...secondaryBtn, fontSize: 12, borderColor: "#fcd34d", color: "#92400e" }}>
                  {needsGps ? "📍 Distance ON — tap to turn off" : "📍 Sort by distance from me"}
                </button>
              </div>
              <div style={{ display: "grid", gap: 12 }}>
                {ordered.map((g) => (
                  <div key={g.county}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 10px", marginBottom: 6, background: "#ecfeff", border: "1px solid #a5f3fc", borderRadius: 8, fontWeight: 800, fontSize: 13.5, color: "#0e7490" }}>
                      📍 {g.county} <span style={{ fontSize: 11, fontWeight: 700, color: "#0891b2" }}>({g.jobs.length})</span>
                    </div>
                    <div style={{ display: "grid", gap: 6 }}>
                      {g.jobs.map((d) => (
                        <div key={d.id} style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 8, alignItems: "center", background: "#fff", border: "1px solid #e5e7eb", borderRadius: 8, padding: "8px 10px" }}>
                          <div style={{ minWidth: 0 }}>
                            <div style={{ fontWeight: 700, fontSize: 13.5 }}>{d.client_name || "(no name)"}{d._dist != null && <span style={{ fontSize: 11, fontWeight: 700, color: "#0369a1", marginLeft: 6 }}>📍 {d._dist.toFixed(1)} mi</span>}</div>
                            <div style={{ fontSize: 11.5, color: "#6b7280" }}>{[d.address, d.city, d.state, d.zip].filter(Boolean).join(", ")}{d.signed_at ? ` · signed ${new Date(d.signed_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}` : ""}</div>
                          </div>
                          <select disabled={bulkBusy} defaultValue="" onChange={(e) => { const v = e.target.value; if (v) assignOne(d.id, v); e.target.value = ""; }}
                            style={{ fontSize: 12.5, padding: "7px 9px", borderRadius: 8, border: "1px solid #f59e0b", background: "#fffbeb", maxWidth: 180 }}>
                            <option value="">— Assign to —</option>
                            {companies.filter((c) => c.active).length > 0 && (
                              <optgroup label="Company pool">{companies.filter((c) => c.active).map((c) => <option key={c.id} value={`company:${c.id}`}>{c.name} (pool)</option>)}</optgroup>
                            )}
                            {pas.filter((p) => p.active).length > 0 && (
                              <optgroup label="Direct to PA">{pas.filter((p) => p.active).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</optgroup>
                            )}
                          </select>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          );
        })()}

        {/* Reassign / take away — full checklist. Select any number of deals
            and bulk-move them to a PA, or "— Unassign —" to pull them off.
            Built for onboarding a new PA: check a batch, move them over. */}
        <div style={{ marginTop: 14, paddingTop: 14, borderTop: "1px solid #c7d2fe" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
            <div style={{ fontSize: 13, fontWeight: 800, color: "#3730a3" }}>🔀 Reassign / take away — no activity yet ({allDeals.length})</div>
            <button type="button" onClick={() => setManySel(allDeals.map((d) => d.id), selected.size < allDeals.length)}
              style={{ ...secondaryBtn, fontSize: 11, padding: "5px 10px" }}>
              {selected.size < allDeals.length ? "Select all" : "Clear all"}
            </button>
          </div>

          {/* Bulk action bar */}
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 8, padding: "8px 10px", background: "#fff", border: "1px solid #c7d2fe", borderRadius: 8 }}>
            <span style={{ fontSize: 12, fontWeight: 700, color: "#3730a3" }}>{selected.size} selected</span>
            <select disabled={bulkBusy || selected.size === 0} value=""
              onChange={(e) => { const v = e.target.value; if (v === "__unassign__") bulkApply(""); else if (v) bulkApply(v); e.target.value = ""; }}
              style={{ fontSize: 12, padding: "6px 8px", borderRadius: 8, border: "1px solid #cbd5e1" }}>
              <option value="">Move selected to…</option>
              {active.length > 0 && (
                <optgroup label="Assign directly to a PA">
                  {active.map((pa) => (<option key={pa.id} value={pa.id}>{pa.name}</option>))}
                </optgroup>
              )}
              {companies.length > 0 && (
                <optgroup label="Into a company pool (their admin assigns)">
                  {companies.filter((c) => c.active).map((c) => (<option key={c.id} value={`company:${c.id}`}>🏢 {c.name} pool</option>))}
                </optgroup>
              )}
              <option value="__unassign__">— Unassign —</option>
            </select>
            {bulkBusy && <span style={{ fontSize: 12, color: "#64748b" }}>Saving…</span>}
          </div>

          {/* The list, grouped by current PA (unassigned first) */}
          <div style={{ display: "grid", gap: 10, maxHeight: 460, overflowY: "auto" }}>
            {allDeals.length === 0 ? (
              <div style={{ fontSize: 12, color: "#6b7280" }}>No deals.</div>
            ) : groupDealsByPa(allDeals, pas).map((g) => {
              const allOn = g.deals.every((d) => selected.has(d.id));
              return (
                <div key={g.key}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, padding: "4px 2px" }}>
                    <div style={{ fontSize: 12.5, fontWeight: 800, color: g.key === "__none__" ? "#b45309" : "#3730a3" }}>
                      {g.label} ({g.deals.length})
                    </div>
                    <button type="button" onClick={() => setManySel(g.deals.map((d) => d.id), !allOn)}
                      style={{ ...secondaryBtn, fontSize: 10.5, padding: "3px 8px" }}>
                      {allOn ? "Clear" : "Select all"}
                    </button>
                  </div>
                  <div style={{ display: "grid", gap: 4 }}>
                    {g.deals.map((d) => {
                      const on = selected.has(d.id);
                      const signed = d.signed_at ? new Date(d.signed_at).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "—";
                      return (
                        <label key={d.id} style={{ display: "flex", alignItems: "center", gap: 8, background: on ? "#eef2ff" : "#fff", border: `1px solid ${on ? "#a5b4fc" : "#e5e7eb"}`, borderRadius: 8, padding: "7px 10px", cursor: "pointer" }}>
                          <input type="checkbox" checked={on} onChange={() => toggleSel(d.id)} />
                          <span style={{ fontSize: 13, fontWeight: 700, flex: 1 }}>{d.client_name || "(no name)"}</span>
                          <span style={{ fontSize: 11, color: "#94a3b8", whiteSpace: "nowrap" }}>🖊 {signed}{d.pa_stage === "no_contact" ? " · 📵" : ""}</span>
                        </label>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>

          <div style={{ fontSize: 11, color: "#6b7280", marginTop: 6 }}>
            Only deals with <strong>no PA activity</strong> show here (never opened, no notes) — so you only move untouched ones. Deals a PA is actively working are hidden on purpose.
            {autoAssign && " With auto-assign ON, unassigned deals re-route within ~5 min — turn it off to park deals with nobody."}
          </div>
        </div>

        {/* Dead deals report */}
        <div style={{ marginTop: 14 }}>
          <div style={{ fontSize: 13, fontWeight: 800, color: "#7f1d1d", marginBottom: 6 }}>💀 Dead deals ({overview.dead.length})</div>
          {overview.dead.length === 0 ? (
            <div style={{ fontSize: 12, color: "#6b7280" }}>None.</div>
          ) : (
            <div style={{ display: "grid", gap: 6, maxHeight: 240, overflowY: "auto" }}>
              {overview.dead.map((d) => {
                const log = Array.isArray(d.pa_notes_log) ? d.pa_notes_log : [];
                const last = log.length ? log[log.length - 1] : null;
                return (
                  <div key={d.id} style={{ background: "#fff", border: "1px solid #fca5a5", borderRadius: 8, padding: "8px 10px" }}>
                    <div style={{ fontSize: 13, fontWeight: 700 }}>
                      {d.client_name || "(no name)"}
                      <span style={{ fontWeight: 400, color: "#6b7280", fontSize: 12 }}> · {pas.find((p) => p.id === d.pa_id)?.name || "—"}</span>
                    </div>
                    {last && <div style={{ fontSize: 12, color: "#374151", marginTop: 2 }}>{last.text}</div>}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </section>

      {/* ── PA Decision Needed ──────────────────────────────────────── */}
      <section style={{ border: "1px solid #fcd34d", borderRadius: 12, padding: 16, background: "#fffbeb" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, marginBottom: 6 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 15, fontWeight: 800, color: "#92400e", fontFamily: "'Oswald', sans-serif" }}>
              ⚖️ PA Decision Needed ({decisions.length})
            </div>
            <div style={{ fontSize: 12, color: "#92400e", marginTop: 4 }}>
              Deals pulled off the PA portal for a U.S. Shingle decision — went Lost in JN while assigned,
              old Sit Sold PA records, PA Ops Hub refusals, or a deactivated PA's deals. Put each into the
              PA pool (with an optional note) so any active adjuster can claim it — or dismiss it.
            </div>
          </div>
          <button type="button" onClick={refreshFromJn} disabled={reconciling}
            style={{ ...secondaryBtn, fontSize: 11, whiteSpace: "nowrap" }}
            title="Check live JobNimbus status for PA deals and pull any newly-Lost ones into this queue.">
            {reconciling ? "Checking JN…" : "🔄 Refresh from JN"}
          </button>
        </div>

        {decisionsLoading ? (
          <div style={{ fontSize: 13, color: "#92400e" }}>Loading…</div>
        ) : decisions.length === 0 ? (
          <div style={{ fontSize: 13, color: "#92400e" }}>Nothing waiting on a decision right now.</div>
        ) : (
          <div style={{ display: "grid", gap: 8, marginTop: 8 }}>
            {decisions.map((deal) => (
              <PADecisionRow
                key={deal.id}
                deal={deal}
                priorPaName={deal.pa_id ? (pas.find((p) => p.id === deal.pa_id)?.name || null) : null}
                busy={busyId === deal.id}
                onPool={(note) => releaseToPool(deal, note)}
                onDismiss={() => dismissDeal(deal)}
              />
            ))}
          </div>
        )}
      </section>

      <section style={{ border: "1px solid #bfdbfe", borderRadius: 12, padding: 16, background: "#eff6ff" }}>
        <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 6, color: "#1e3a8a" }}>➕ Don't see an adjuster below?</div>
        <ol style={{ margin: 0, paddingLeft: 20, fontSize: 13, color: "#1e3a8a", lineHeight: 1.6 }}>
          <li>Add them as a user in <strong>JobNimbus</strong> first (with their email).</li>
          <li>Come back here and click <strong>🔄 Sync from JN</strong>.</li>
          <li>Open <strong>Edit</strong> on their row, add their mobile number, save.</li>
          <li>Click <strong>Activate</strong> — they get the portal link by text/email automatically.</li>
        </ol>
      </section>

      {loading ? (
        <section style={{ border: "1px solid #e5e7eb", borderRadius: 12, padding: 16, background: "#fff" }}>
          <div style={{ fontSize: 13, color: "#6b7280" }}>Loading…</div>
        </section>
      ) : pas.length === 0 ? (
        <section style={{ border: "1px solid #e5e7eb", borderRadius: 12, padding: 16, background: "#fff" }}>
          <div style={{ fontSize: 13, color: "#6b7280" }}>No public adjusters yet — sync from JN above.</div>
        </section>
      ) : (
        <>
          {active.length > 0 && renderGroup("⭐ Active adjusters", "#047857", active, "Live. These can claim damage deals in the portal.")}
          {inactive.length > 0 && renderGroup("💤 Inactive", "#475569", inactive, "Not live yet. Add a phone via Edit, then Activate to send them their link.")}
        </>
      )}

    </div>
  );
}

// Master-admin management of PA companies: admin name/phone, the company
// admin's personal link (…/?pa_company=<token>), active toggle, and a count
// of member PAs. Each company's admin uses their link to assign pooled deals.
function PACompaniesPanel({ companies, pas, busy, onUpdate, onCreate }) {
  const [copiedId, setCopiedId] = useState(null);
  const base = typeof window !== "undefined" ? window.location.origin : "";
  const paCount = (cid) => pas.filter((p) => p.pa_company_id === cid).length;
  const activePaCount = (cid) => pas.filter((p) => p.pa_company_id === cid && p.active).length;

  return (
    <section style={{ border: "1px solid #c7d2fe", borderRadius: 12, padding: 16, background: "#f5f3ff" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 4 }}>
        <div style={{ fontSize: 15, fontWeight: 800, color: "#5b21b6", fontFamily: "'Oswald', sans-serif" }}>🏢 PA Companies ({companies.length})</div>
        <button type="button" disabled={busy} onClick={async () => { const n = window.prompt("New PA company name:"); if (n && n.trim()) await onCreate(n.trim()); }}
          style={{ ...secondaryBtn, fontSize: 12, borderColor: "#c4b5fd", color: "#5b21b6" }}>+ Add company</button>
      </div>
      <div style={{ fontSize: 11, color: "#6b7280", marginBottom: 10 }}>
        Deals auto-route into a company's pool; the company admin assigns them to their PAs via their personal link.
      </div>
      {companies.length === 0 ? (
        <div style={{ fontSize: 12, color: "#6b7280" }}>No companies yet. Add one, then assign PAs to it from the list above.</div>
      ) : (
        <div style={{ display: "grid", gap: 10 }}>
          {companies.map((c) => {
            const link = c.token ? `${base}/?pa_company=${c.token}` : "(no link — save to generate)";
            return (
              <div key={c.id} style={{ padding: 12, background: "#fff", border: "1px solid #e5e7eb", borderRadius: 8, opacity: c.active ? 1 : 0.7 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <div style={{ fontWeight: 800, color: "#1e1b4b" }}>
                    {c.name} {!c.active && <span style={{ fontSize: 10, color: "#6b7280" }}>(inactive)</span>}
                    <span style={{ fontSize: 11, fontWeight: 600, color: "#6b7280", marginLeft: 8 }}>{activePaCount(c.id)}/{paCount(c.id)} active PAs</span>
                  </div>
                  <button type="button" disabled={busy} onClick={() => onUpdate(c.id, { active: !c.active })} style={{ ...secondaryBtn, fontSize: 11 }}>
                    {c.active ? "Deactivate" : "Activate"}
                  </button>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, marginTop: 8 }}>
                  <input defaultValue={c.admin_name || ""} placeholder="Admin name" style={inputStyle}
                    onBlur={(e) => { const v = e.target.value.trim(); if (v !== (c.admin_name || "")) onUpdate(c.id, { admin_name: v || null }); }} />
                  <input defaultValue={c.admin_phone || ""} placeholder="Admin phone (+1…)" style={inputStyle}
                    onBlur={(e) => { const v = e.target.value.trim(); if (v !== (c.admin_phone || "")) onUpdate(c.id, { admin_phone: v || null }); }} />
                  <input defaultValue={c.email || ""} placeholder="Company email" style={inputStyle}
                    onBlur={(e) => { const v = e.target.value.trim(); if (v !== (c.email || "")) onUpdate(c.id, { email: v || null }); }} />
                  <input defaultValue={c.address || ""} placeholder="Office address (for distance)" style={inputStyle}
                    onBlur={async (e) => {
                      const v = e.target.value.trim();
                      if (v === (c.address || "")) return;
                      if (!v) { onUpdate(c.id, { address: null, latitude: null, longitude: null }); return; }
                      const patch = { address: v };
                      try {
                        const r = await fetch("/.netlify/functions/geocode-place", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query: v }) });
                        const g = await r.json().catch(() => ({}));
                        if (g.ok && typeof g.lat === "number") { patch.latitude = g.lat; patch.longitude = g.lng; }
                        else { patch.latitude = null; patch.longitude = null; }
                      } catch { patch.latitude = null; patch.longitude = null; }
                      onUpdate(c.id, patch);
                    }} />
                </div>
                {c.address && (
                  <div style={{ fontSize: 11, marginTop: 4, color: c.latitude != null ? "#16a34a" : "#b45309" }}>
                    {c.latitude != null ? "📍 Office geocoded — the company admin can sort homeowners from “🏢 My office.”" : "⚠ Office address not geocoded yet — re-enter the address to retry."}
                  </div>
                )}
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
                  <code style={{ fontSize: 11, background: "#f1f5f9", padding: "4px 8px", borderRadius: 6, color: "#334155", wordBreak: "break-all", flex: 1, minWidth: 200 }}>{link}</code>
                  {c.token && (
                    <button type="button" onClick={() => { navigator.clipboard?.writeText(link); setCopiedId(c.id); setTimeout(() => setCopiedId(null), 1500); }}
                      style={{ ...secondaryBtn, fontSize: 11 }}>{copiedId === c.id ? "✓ Copied" : "Copy link"}</button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function PARow({ pa, companies = [], busy, onToggle, onResend, onUpdate, onDelete, onSetCompany, onCreateCompany }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({ name: pa.name, email: pa.email ?? "", phone: pa.phone ?? "", home_address: pa.home_address ?? "" });
  const [saving, setSaving] = useState(false);
  const hasContact = !!(pa.phone || pa.email);
  const hasCoords = pa.latitude != null && pa.longitude != null;

  // Save edits. If the home address changed (and is non-empty), geocode it to
  // lat/lng so the company admin can sort homeowners by distance from this PA.
  async function saveEdit() {
    setSaving(true);
    const addr = draft.home_address.trim();
    const patch = {
      name: draft.name.trim(),
      email: draft.email.trim() || null,
      phone: draft.phone.trim() || null,
      home_address: addr || null,
    };
    if (!addr) { patch.latitude = null; patch.longitude = null; }
    else if (addr !== (pa.home_address || "")) {
      try {
        const r = await fetch("/.netlify/functions/geocode-place", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query: addr }),
        });
        const g = await r.json().catch(() => ({}));
        if (g.ok && typeof g.lat === "number") { patch.latitude = g.lat; patch.longitude = g.lng; }
      } catch { /* leave coords as-is if geocode fails */ }
    }
    await onUpdate(patch);
    setSaving(false);
    setEditing(false);
  }
  const companyName = companies.find((c) => c.id === pa.pa_company_id)?.name || null;
  // Company picker: choose an existing company, "Independent", or create one.
  const onCompanyChange = async (e) => {
    const v = e.target.value;
    if (v === "__new__") {
      const nm = window.prompt("New PA company name:");
      if (!nm || !nm.trim()) return;
      const created = onCreateCompany ? await onCreateCompany(nm.trim()) : null;
      if (created) onSetCompany && onSetCompany(created.id);
      return;
    }
    onSetCompany && onSetCompany(v || "");
  };
  return (
    <div style={{ padding: 10, background: pa.active ? "#fff" : "#f3f4f6", border: "1px solid #e5e7eb", borderRadius: 8, opacity: pa.active ? 1 : 0.75 }}>
      {!editing ? (
        <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 8, alignItems: "center" }}>
          <div>
            <div style={{ fontWeight: 700, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <span>{pa.name}</span>
              {!pa.active && <span style={{ fontSize: 10, color: "#6b7280" }}>(inactive)</span>}
              {pa.app_link_sent_at && (
                <span style={{ fontSize: 10, padding: "2px 8px", background: "#dbeafe", color: "#1e40af", borderRadius: 999, fontWeight: 700 }}>
                  🔗 link sent
                </span>
              )}
            </div>
            <div style={{ fontSize: 11, color: "#6b7280" }}>
              {pa.email && <>📧 {pa.email} · </>}
              {pa.phone ? <>📱 {pa.phone}</> : "no phone on file"}
            </div>
            <div style={{ fontSize: 11, color: pa.home_address ? "#6b7280" : "#b45309", marginTop: 2 }}>
              {pa.home_address
                ? <>🏠 {pa.home_address} {hasCoords ? <span style={{ color: "#16a34a" }}>· 📍 geocoded</span> : <span style={{ color: "#b45309" }}>· ⚠ not geocoded</span>}</>
                : "🏠 no home address — add one (Edit) for distance assigning"}
            </div>
            <div style={{ fontSize: 11, color: "#6b7280", marginTop: 4, display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
              <span>🏢</span>
              <select value={pa.pa_company_id || ""} onChange={onCompanyChange}
                style={{ fontSize: 11, padding: "3px 6px", borderRadius: 6, border: "1px solid #cbd5e1", maxWidth: 200 }}>
                <option value="">Independent (own company)</option>
                {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                <option value="__new__">+ New company…</option>
              </select>
              {companyName && <span style={{ fontWeight: 700, color: "#3730a3" }}>{companyName}</span>}
            </div>
          </div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", justifyContent: "flex-end" }}>
            {pa.active && (
              <button type="button" onClick={onResend} disabled={busy || !hasContact}
                style={{ ...secondaryBtn, fontSize: 11, opacity: !hasContact ? 0.55 : 1, cursor: !hasContact ? "not-allowed" : "pointer" }}
                title={!hasContact ? "Add a phone or email via Edit first" : "Re-send the portal link"}>
                {busy ? "…" : "🔗 Resend link"}
              </button>
            )}
            <button type="button" onClick={onToggle} disabled={busy}
              style={{ ...secondaryBtn, fontSize: 11 }}
              title={pa.active ? "Deactivate — their link stops working and claims return to the pool" : "Activate and text/email the portal link"}>
              {busy ? "…" : pa.active ? "Deactivate" : "Activate"}
            </button>
            <button type="button" onClick={() => setEditing(true)} style={{ ...secondaryBtn, fontSize: 11 }}>Edit</button>
            <button type="button" onClick={onDelete} style={{ ...dangerBtn, fontSize: 11 }}>Delete</button>
          </div>
        </div>
      ) : (
        <div style={{ display: "grid", gap: 6 }}>
          <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} style={inputStyle} placeholder="Name" />
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
            <input type="email" value={draft.email} onChange={(e) => setDraft({ ...draft, email: e.target.value })} style={inputStyle} placeholder="Email" />
            <input type="tel" value={draft.phone} onChange={(e) => setDraft({ ...draft, phone: e.target.value })} style={inputStyle} placeholder="Phone (e.g. +18135551234)" />
          </div>
          <input value={draft.home_address} onChange={(e) => setDraft({ ...draft, home_address: e.target.value })} style={inputStyle} placeholder="Home address (street, city, state, zip) — for distance routing" />
          <div style={{ fontSize: 11, color: "#6b7280", marginTop: -2 }}>
            Add the adjuster's <b>mobile number</b> and <b>home address</b> (we geocode it for distance-based assigning), then Save and click <b>Activate</b>.
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <button type="button" style={{ ...primaryBtn, opacity: saving ? 0.6 : 1 }} disabled={saving} onClick={saveEdit}>{saving ? "Saving…" : "Save"}</button>
            <button type="button" style={secondaryBtn} disabled={saving} onClick={() => setEditing(false)}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}

// One row in the PA Decision Needed queue — shows why it's here + who had
// it, and lets the manager put it into the PA pool (with an optional note)
// or dismiss it.
function PADecisionRow({ deal, priorPaName, busy, onPool, onDismiss }) {
  const [note, setNote] = useState("");
  // Dates that help the reassignment decision. undefined = still loading,
  // null = not recorded, number = epoch seconds (from JN).
  const [filedDate, setFiledDate] = useState(undefined);      // PA-filed (cf_date_20)
  const [inspectedDate, setInspectedDate] = useState(undefined); // inspected (cf_date_22)
  // Photos load lazily on the button tap (keeps the queue fast with many
  // cards). null = not loaded yet.
  const [photosOpen, setPhotosOpen] = useState(false);
  const [photos, setPhotos] = useState(null);
  const [photosLoading, setPhotosLoading] = useState(false);
  const [photosErr, setPhotosErr] = useState(null);
  const addr = [deal.address, deal.city, deal.state, deal.zip].filter(Boolean).join(", ");
  const fmtIso = (iso) => { if (!iso) return null; const d = new Date(iso); return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString("en-US"); };
  const signedDisp = fmtIso(deal.signed_at);
  const resultLabel = { damage: "Damage", no_damage: "No Damage", retail: "Retail", lost: "Lost" }[deal.result] || (deal.result || "—");
  const resultColor = deal.result === "damage" ? "#991b1b" : deal.result === "retail" ? "#1e40af" : "#475569";
  const resultBg = deal.result === "damage" ? "#fef2f2" : deal.result === "retail" ? "#eff6ff" : "#f1f5f9";
  const resultBorder = deal.result === "damage" ? "#fca5a5" : deal.result === "retail" ? "#bfdbfe" : "#e2e8f0";
  const dateChip = (epoch) => epoch === undefined ? "…" : epoch ? epochToDisplay(epoch) : "not recorded";

  // Auto-load the PA-filed + inspected dates so the manager can see how far
  // the prior PA got before deciding where it goes. skipPhotos keeps it light.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/.netlify/functions/pa-load-claim", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ inspectionId: deal.id, skipPhotos: true }),
        });
        const b = await res.json().catch(() => ({}));
        if (!cancelled) {
          setFiledDate(b.ok ? (b.fields?.pa_filed ?? null) : null);
          setInspectedDate(b.ok ? (b.fields?.inspected_date ?? null) : null);
        }
      } catch { if (!cancelled) { setFiledDate(null); setInspectedDate(null); } }
    })();
    return () => { cancelled = true; };
  }, [deal.id]);

  async function togglePhotos() {
    if (photosOpen) { setPhotosOpen(false); return; }
    setPhotosOpen(true);
    if (photos === null && !photosLoading) {
      setPhotosLoading(true); setPhotosErr(null);
      try {
        const res = await fetch("/.netlify/functions/pa-load-claim", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ inspectionId: deal.id }),
        });
        const b = await res.json().catch(() => ({}));
        if (b.ok) setPhotos(b.photos || []);
        else { setPhotos([]); setPhotosErr(b.error || "Couldn't load photos"); }
      } catch (e) { setPhotos([]); setPhotosErr(e.message || "Network error"); }
      setPhotosLoading(false);
    }
  }

  return (
    <div style={{ padding: 12, background: "#fff", border: "1px solid #fde68a", borderRadius: 10 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
        <div style={{ flex: 1, minWidth: 200 }}>
          <div style={{ fontWeight: 700, fontSize: 15 }}>{deal.client_name || "(no name)"}</div>
          <div style={{ fontSize: 12, color: "#6b7280", marginTop: 2 }}>{addr || "—"}</div>
          <div style={{ marginTop: 6, display: "flex", gap: 6, flexWrap: "wrap" }}>
            <span style={{ fontSize: 11, fontWeight: 700, color: "#92400e", background: "#fffbeb", border: "1px solid #fcd34d", borderRadius: 999, padding: "2px 8px" }}>
              {deal.pa_decision_reason || "Needs decision"}
            </span>
            {priorPaName && (
              <span style={{ fontSize: 11, fontWeight: 700, color: "#475569", background: "#f1f5f9", border: "1px solid #e2e8f0", borderRadius: 999, padding: "2px 8px" }}>
                was: {priorPaName}
              </span>
            )}
            <span style={{ fontSize: 11, fontWeight: 700, color: resultColor, background: resultBg, border: `1px solid ${resultBorder}`, borderRadius: 999, padding: "2px 8px" }}>
              🏠 {resultLabel}
            </span>
            <span style={{ fontSize: 11, fontWeight: 700, color: "#475569", background: "#f1f5f9", border: "1px solid #e2e8f0", borderRadius: 999, padding: "2px 8px" }}>
              🔍 Inspected: {dateChip(inspectedDate)}
            </span>
            <span style={{ fontSize: 11, fontWeight: 700, color: "#475569", background: "#f1f5f9", border: "1px solid #e2e8f0", borderRadius: 999, padding: "2px 8px" }}>
              🖊 Signed: {signedDisp || "—"}
            </span>
            <span style={{ fontSize: 11, fontWeight: 700, color: filedDate ? "#065f46" : "#64748b", background: filedDate ? "#ecfdf5" : "#f1f5f9", border: `1px solid ${filedDate ? "#86efac" : "#e2e8f0"}`, borderRadius: 999, padding: "2px 8px" }}>
              📋 PA filed: {dateChip(filedDate)}
            </span>
          </div>
        </div>
      </div>
      <div style={{ display: "grid", gap: 6, marginTop: 10 }}>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <button type="button" disabled={busy} onClick={() => onPool(note)}
            style={{ ...primaryBtn, whiteSpace: "nowrap" }}>
            {busy ? "…" : "↪ Put in PA pool"}
          </button>
          <button type="button" onClick={togglePhotos} style={{ ...secondaryBtn, fontSize: 12, whiteSpace: "nowrap" }}>
            {photosOpen ? "Hide photos" : `📷 Photos${photos ? ` (${photos.length})` : ""}`}
          </button>
          <button type="button" disabled={busy} onClick={onDismiss} style={{ ...secondaryBtn, fontSize: 12, whiteSpace: "nowrap" }}>
            Dismiss
          </button>
        </div>

        {photosOpen && (
          <div style={{ padding: 8, background: "#fafaf9", border: "1px solid #f3f4f6", borderRadius: 8 }}>
            {photosLoading ? (
              <div style={{ fontSize: 12, color: "#94a3b8" }}>Loading photos…</div>
            ) : photosErr ? (
              <div style={{ fontSize: 12, color: "#991b1b" }}>{photosErr}</div>
            ) : (photos && photos.length === 0) ? (
              <div style={{ fontSize: 12, color: "#94a3b8" }}>No photos found for this inspection.</div>
            ) : (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(110px, 1fr))", gap: 6 }}>
                {(photos || []).map((src, i) => (
                  <a key={i} href={src} target="_blank" rel="noreferrer" style={{ display: "block" }}>
                    <img src={src} alt={`Inspection photo ${i + 1}`} style={{ width: "100%", borderRadius: 6, border: "1px solid #e5e7eb", display: "block" }} />
                  </a>
                ))}
              </div>
            )}
          </div>
        )}

        <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2}
          placeholder="Optional note (shows to whoever claims it from the pool) — e.g. context on the deal"
          style={{ ...inputStyle, resize: "vertical", fontFamily: "'Nunito', sans-serif" }} />
      </div>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════
// PA MOBILE APP — ?mode=pa
// ═════════════════════════════════════════════════════════════════════
export function PAMobileApp() {
  // Admin context: the PA portal launched from the Admin hub carries
  // ?admin=1, which unlocks manager-only actions (e.g. releasing a deal
  // back to the pool). Field PAs open a plain ?mode=pa link and never see
  // those. (The release itself is still PIN-gated as defense-in-depth.)
  const adminView = typeof window !== "undefined" &&
    new URLSearchParams(window.location.search).get("admin") === "1";
  const [stage, setStage] = useState("pick"); // pick | list | detail | inactive
  const [pas, setPas] = useState([]);
  const [me, setMe] = useState(null);
  const [inactiveName, setInactiveName] = useState("");
  // Dual-role support: if this signed-in PA is ALSO an active inspector
  // (same JobNimbus id, setup complete), show a "My inspections" button
  // to hop straight over without re-picking their name.
  const [inspCounterpart, setInspCounterpart] = useState(null);
  // Mobile (phone-width) vs Desktop (wide) layout. Persists per device.
  const [viewMode, setViewMode] = useState(
    () => (typeof localStorage !== "undefined" && localStorage.getItem("ccg_pa_view") === "desktop" ? "desktop" : "mobile"),
  );
  const wide = viewMode === "desktop";
  function toggleView() {
    const next = wide ? "mobile" : "desktop";
    setViewMode(next);
    try { localStorage.setItem("ccg_pa_view", next); } catch { /* ignore */ }
  }

  useEffect(() => {
    supabase.from("pas").select("*").eq("active", true).order("name").then(async ({ data }) => {
      const list = data || [];
      setPas(list);
      // A personal invite link carries ?pa=<id>. It WINS over any session
      // left on this device — so a PA's link always opens THEIR portal, never
      // whoever logged in last (fixes "the link showed Chad's portal"). We
      // pin it to this device + strip the param so the URL stays clean.
      let linkId = null;
      try { linkId = new URLSearchParams(window.location.search).get("pa"); } catch { /* ignore */ }
      if (linkId) {
        const me = list.find((p) => p.id === linkId);
        try {
          const url = new URL(window.location.href);
          url.searchParams.delete("pa");
          window.history.replaceState({}, "", url.toString());
        } catch { /* ignore */ }
        if (me) { localStorage.setItem("ccg_pa_id", me.id); setMe(me); setStage("list"); return; }
        // Link points at an inactive/unknown PA → show the inactive screen.
        const { data: raw } = await supabase.from("pas").select("id,name").eq("id", linkId).maybeSingle();
        localStorage.removeItem("ccg_pa_id");
        if (raw) { setInactiveName(raw.name || ""); setStage("inactive"); } else { setStage("pick"); }
        return;
      }
      const stored = localStorage.getItem("ccg_pa_id");
      if (!stored) return;
      const found = list.find((p) => p.id === stored);
      if (found) { setMe(found); setStage("list"); return; }
      const { data: raw } = await supabase.from("pas").select("id,name,active").eq("id", stored).maybeSingle();
      if (raw) { setInactiveName(raw.name || ""); setStage("inactive"); }
    });
  }, []);

  // Look up whether the signed-in PA is also an active, setup-complete
  // inspector. We require info_updated_at (home base saved) because the
  // inspector portal won't let them sign in without it — no point showing
  // a button that dead-ends on the "account not active" screen.
  useEffect(() => {
    if (!me || !me.jn_user_id) { setInspCounterpart(null); return; }
    let cancelled = false;
    supabase
      .from("inspectors")
      .select("id,name,active,info_updated_at,jn_user_id")
      .eq("jn_user_id", me.jn_user_id)
      .eq("active", true)
      .not("info_updated_at", "is", null)
      .maybeSingle()
      .then(({ data }) => { if (!cancelled) setInspCounterpart(data || null); });
    return () => { cancelled = true; };
  }, [me]);

  function pickMe(pa) { setMe(pa); localStorage.setItem("ccg_pa_id", pa.id); setStage("list"); }
  function signOut() { localStorage.removeItem("ccg_pa_id"); setMe(null); setInactiveName(""); setStage("pick"); }

  // Hop to the inspector portal as the same person — hand off identity
  // via localStorage so they land signed-in (no name re-pick).
  function goToInspectorPortal() {
    if (!inspCounterpart) return;
    try { localStorage.setItem("ccg_inspector_id", inspCounterpart.id); } catch { /* ignore */ }
    window.location.href = window.location.origin + "/?mode=inspector";
  }

  return (
    <div style={{ maxWidth: wide ? 1100 : 480, margin: "0 auto", padding: 16, fontFamily: "'Nunito', sans-serif", minHeight: "100vh", background: "#f9fafb", transition: "max-width 0.15s ease" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16, gap: 8 }}>
        <div style={{ fontSize: 22, fontWeight: 700, fontFamily: "'Oswald', sans-serif" }}>🧑‍⚖️ Adjuster</div>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <button type="button" onClick={toggleView} title="Switch layout"
            style={{ ...secondaryBtn, fontSize: 11 }}>
            {wide ? "📱 Mobile view" : "🖥 Desktop view"}
          </button>
          {me && inspCounterpart && (
            <button type="button" onClick={goToInspectorPortal}
              style={{ ...secondaryBtn, fontSize: 11, borderColor: "#7dd3fc", color: "#0369a1" }}>
              🔍 My inspections
            </button>
          )}
          {/* "Switch user" is admin-only: shown only when the portal was
              opened from the Admin hub (?admin=1). Field PAs never see it,
              so they can't re-pick into another adjuster's account. */}
          {me && adminView && <button type="button" onClick={signOut} style={{ ...secondaryBtn, fontSize: 11 }}>Switch user</button>}
        </div>
      </div>

      {stage === "inactive" && (
        <div style={{ padding: 24, background: "#fff", border: "1px solid #fca5a5", borderRadius: 12, textAlign: "center" }}>
          <div style={{ fontSize: 32, marginBottom: 8 }}>🚫</div>
          <div style={{ fontSize: 16, fontWeight: 700, color: "#991b1b", marginBottom: 6 }}>
            {inactiveName ? `Hi ${inactiveName} —` : "Hi —"} your adjuster account is not active.
          </div>
          <div style={{ fontSize: 13, color: "#64748b", marginBottom: 16 }}>
            Your U.S. Shingle contact has deactivated this account. Reach out to get reactivated.
          </div>
          <button type="button" onClick={signOut} style={{ ...secondaryBtn, fontSize: 12 }}>Sign out</button>
        </div>
      )}

      {stage === "pick" && <PAPickName pas={pas} onPick={pickMe} />}

      {stage === "list" && me && (
        <PAJobList me={me} wide={wide} onOpenJob={(jobId) => setStage({ kind: "detail", jobId })} />
      )}

      {stage && stage.kind === "detail" && me && (
        <PAPipelineDetail me={me} wide={wide} adminView={adminView} jobId={stage.jobId} onBack={() => setStage("list")} />
      )}
    </div>
  );
}

function PAPickName({ pas, onPick }) {
  if (pas.length === 0) {
    return <div style={{ padding: 24, textAlign: "center", color: "#6b7280" }}>No adjusters set up yet. Ask your U.S. Shingle contact to add you.</div>;
  }
  return (
    <div>
      <div style={{ fontSize: 14, color: "#6b7280", marginBottom: 12 }}>Tap your name to continue.</div>
      <div style={{ display: "grid", gap: 8 }}>
        {pas.map((p) => (
          <button key={p.id} type="button" onClick={() => onPick(p)}
            style={{ padding: 16, fontSize: 16, fontWeight: 700, background: "#fff", border: "2px solid #e5e7eb", borderRadius: 12, textAlign: "left", cursor: "pointer" }}>
            🧑‍⚖️ {p.name}
          </button>
        ))}
      </div>
    </div>
  );
}

function PAJobList({ me, onOpenJob, wide }) {
  const [mine, setMine] = useState([]);
  const [loading, setLoading] = useState(true);
  // Company assigns deals now (no self-claim / no pool). The PA's deals
  // split into three views: still chasing a signature, signed, and "can't
  // get ahold of them" (no_contact stage). Dead deals drop off entirely.
  const [mineView, setMineView] = useState("needs"); // needs | signed | no_contact
  const [signupBusyId, setSignupBusyId] = useState(null);
  const [msg, setMsg] = useState(null);
  // Geo-location (like the inspector portal). PAs have no fixed home base,
  // so distances are measured from the PA's live GPS once they grant it.
  // When set, Available + My-claims sort nearest-first and show miles.
  const [paCoords, setPaCoords] = useState(null);
  const [geoError, setGeoError] = useState(null);
  const [geoBusy, setGeoBusy] = useState(false);

  function useMyLocation() {
    setGeoError(null);
    if (!("geolocation" in navigator)) { setGeoError("This browser doesn't support GPS."); return; }
    setGeoBusy(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => { setPaCoords({ lat: pos.coords.latitude, lng: pos.coords.longitude }); setGeoBusy(false); },
      (err) => { setGeoError(err.message || "Couldn't get your location."); setGeoBusy(false); },
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 },
    );
  }

  async function load() {
    setLoading(true);
    const { data, error } = await supabase.from("inspections")
      .select("id, client_name, address, city, state, zip, county, signed_at, jn_job_id, result, pa_id, pa_claimed_at, pa_stage, pa_opened_at, pa_notes_log, pa_fields, pa_assignment_note, mobile, latitude, longitude, correction_needed")
      // Only the deals the company assigned to this PA. A deal that later
      // goes Lost/cancelled or gets pulled for a decision drops out
      // automatically; dead deals are filtered out too.
      .eq("pa_id", me.id).is("cancelled_at", null).eq("pa_decision_needed", false)
      .or("pa_stage.is.null,pa_stage.neq.dead")
      // Newest signing first — work the fresh leads, don't waste them.
      .order("signed_at", { ascending: false }).limit(300);
    setMine(data || []);
    setLoading(false);
    if (error) setMsg({ kind: "error", text: error.message });
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [me.id]);

  // Post a note (and optional stage change) → saves to pa_notes_log AND
  // pushes the note into the JobNimbus job. Powers Add note / Can't reach /
  // Dead deal / Back to active.
  async function postNote(job, { text, stage }) {
    setSignupBusyId(job.id);
    setMsg(null);
    try {
      const res = await fetch("/.netlify/functions/pa-add-note", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ inspectionId: job.id, paId: me.id, text: text || "", stage: stage || undefined }),
      });
      const body = await res.json().catch(() => ({}));
      if (!body.ok) { setMsg({ kind: "error", text: body.error || `status ${res.status}` }); setSignupBusyId(null); return; }
      const jn = body.jn_note_added ? "✓ added to JobNimbus" : "saved";
      if (stage === "dead") {
        setMine((l) => l.filter((j) => j.id !== job.id));
        setMsg({ kind: "success", text: `Marked dead — ${jn}.` });
      } else {
        setMine((l) => l.map((j) => j.id === job.id ? {
          ...j,
          pa_stage: stage || j.pa_stage,
          pa_notes_log: text ? [ ...(j.pa_notes_log || []), { at: new Date().toISOString(), text, stage: stage || null } ] : j.pa_notes_log,
        } : j));
        setMsg({ kind: "success", text: stage === "no_contact" ? `Moved to “Can't get ahold of them” — ${jn}.` : stage === "active" ? "Back in your active list." : `Note ${jn}.` });
      }
    } catch (e) { setMsg({ kind: "error", text: e.message || "Network error" }); }
    setSignupBusyId(null);
  }
  function addNote(job) {
    const t = window.prompt(`Add a note for ${job.client_name || "this customer"}.\nIt's saved here and posted to the JobNimbus job.`);
    if (t == null) return; const text = t.trim(); if (!text) return;
    postNote(job, { text });
  }
  function cantReach(job) {
    const t = window.prompt(`Move ${job.client_name || "this customer"} to “Can't get ahold of them.”\nAdd a quick note (optional):`);
    if (t == null) return; // cancelled
    postNote(job, { text: t.trim() || "Marked can't-reach", stage: "no_contact" });
  }
  function backToActive(job) { postNote(job, { text: "Reached — back to active", stage: "active" }); }
  function deadDeal(job) {
    const who = job.client_name || "this customer";
    const t = window.prompt(`Mark "${who}" as a DEAD DEAL?\nThis removes it from your list and logs it. Reason (required):`);
    if (t == null) return; const reason = t.trim();
    if (!reason) { setMsg({ kind: "error", text: "A reason is required to mark a deal dead." }); return; }
    postNote(job, { text: reason, stage: "dead" });
  }

  // Record the homeowner's answer to "did they sign up with you?" right
  // from the My-claims card, without opening the deal. "Need Signature"
  // and "Signed" are plain saves; "Refused to Sign" is handled by refuse().
  async function saveSignup(job, opt) {
    setSignupBusyId(job.id);
    setMsg(null);
    try {
      const res = await fetch("/.netlify/functions/pa-save-field", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ inspectionId: job.id, paId: me.id, field: "pa_signup", value: opt }),
      });
      const body = await res.json().catch(() => ({}));
      if (!body.ok) {
        setMsg({ kind: "error", text: body.error || `Couldn't save (status ${res.status})` });
      } else {
        setMine((l) => l.map((j) => (j.id === job.id ? { ...j, pa_fields: { ...(j.pa_fields || {}), pa_signup: opt } } : j)));
      }
    } catch (e) {
      setMsg({ kind: "error", text: e.message || "Network error" });
    }
    setSignupBusyId(null);
  }

  // "Refused to Sign" — reverts the deal to retail and texts the rep +
  // their manager. One-way door, so confirm hard. On success the deal
  // leaves My claims (it's no longer a PA insurance deal).
  async function refuse(job) {
    const who = job.client_name || "this homeowner";
    if (!window.confirm(
      `Mark "Refused to Sign" for ${who}?\n\n` +
      `This tells us the homeowner does NOT want to go through insurance. ` +
      `The deal moves back to RETAIL and leaves your claims, and we text ` +
      `the sales rep and their manager to go set up a retail appointment.\n\n` +
      `This can't be undone from here.`
    )) return;
    setSignupBusyId(job.id);
    setMsg(null);
    try {
      const res = await fetch("/.netlify/functions/pa-refused-to-sign", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ inspectionId: job.id, paId: me.id }),
      });
      const body = await res.json().catch(() => ({}));
      if (!body.ok) {
        setSignupBusyId(null);
        setMsg({ kind: "error", text: body.error || `status ${res.status}` });
        return;
      }
      const repOk = body?.notified?.rep?.ok;
      const mgrOk = body?.notified?.manager?.ok;
      setMsg({ kind: "success", text: `Moved ${who} to retail. ${repOk ? "✓ Rep texted" : "⚠ Rep not texted"} · ${mgrOk ? "✓ Manager texted" : "⚠ Manager not texted (no zone manager)"}` });
      setMine((l) => l.filter((j) => j.id !== job.id));
    } catch (e) {
      setMsg({ kind: "error", text: e.message || "Network error" });
    }
    setSignupBusyId(null);
  }

  // "Send back to retail" — like Refused to Sign, but the PA types a
  // free-text reason first. Reverts the deal to retail (app + JobNimbus)
  // and texts the rep + their manager with the reason. Leaves My claims.
  async function sendToRetail(job) {
    const who = job.client_name || "this homeowner";
    const reason = window.prompt(
      `Send "${who}" back to RETAIL?\n\n` +
      `This moves the deal out of insurance and back to retail — in the app AND in JobNimbus — ` +
      `and texts the sales rep + their manager.\n\n` +
      `Why is it going back to retail? (required)`,
    );
    if (reason == null) return; // cancelled
    const why = reason.trim();
    if (!why) { setMsg({ kind: "error", text: "A reason is required to send a deal back to retail." }); return; }
    setSignupBusyId(job.id);
    setMsg(null);
    try {
      const res = await fetch("/.netlify/functions/pa-refused-to-sign", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ inspectionId: job.id, paId: me.id, mode: "retail", reason: why }),
      });
      const body = await res.json().catch(() => ({}));
      if (!body.ok) {
        setSignupBusyId(null);
        setMsg({ kind: "error", text: body.error || `status ${res.status}` });
        return;
      }
      const repOk = body?.notified?.rep?.ok;
      const mgrOk = body?.notified?.manager?.ok;
      setMsg({ kind: "success", text: `Sent ${who} back to retail. ${repOk ? "✓ Rep texted" : "⚠ Rep not texted"} · ${mgrOk ? "✓ Manager texted" : "⚠ Manager not texted (no zone manager)"}` });
      setMine((l) => l.filter((j) => j.id !== job.id));
    } catch (e) {
      setMsg({ kind: "error", text: e.message || "Network error" });
    }
    setSignupBusyId(null);
  }

  // Split My claims into "needs signature" vs "signed". Legacy/blank
  // values count as needs-signature (isNeedSignature). Refused-to-Sign
  // deals already left the list (reverted to retail). When the PA has
  // granted GPS, every list is enriched with _dist (miles) and sorted
  // nearest-first — same idea as the inspector portal.
  // Lists stay sorted by newest signing date (from the query). GPS just
  // adds a distance badge per card — it no longer re-sorts (signing date
  // wins, so fresh leads always surface first).
  const { mineNeeds, mineWorking, mineSigned, mineNoContact, mineWaiting } = useMemo(() => {
    const withDist = (arr) =>
      arr.map((j) => ({
        ...j,
        _dist:
          paCoords && typeof j.latitude === "number" && typeof j.longitude === "number"
            ? milesBetween(paCoords.lat, paCoords.lng, j.latitude, j.longitude)
            : null,
      }));
    const all = withDist(mine);
    // Group by county, newest-signed first WITHIN each county. Sort county
    // asc (no-county last), then signed_at desc — groupByCounty then groups
    // the already-adjacent counties.
    const sorted = (arr) => [...arr].sort((a, b) => {
      const ca = a.county || "￿", cb = b.county || "￿";
      if (ca !== cb) return ca < cb ? -1 : 1;
      return new Date(b.signed_at || 0) - new Date(a.signed_at || 0);
    });
    const active = all.filter((j) => j.pa_stage !== "no_contact" && j.pa_stage !== "waiting_docs");
    // Pre-signature deals split into "New files" (untouched) and "Working"
    // (the PA has opened the pipeline OR left a note). Signed deals always
    // go to Signed regardless.
    const preSign = active.filter((j) => isNeedSignature(j.pa_fields?.pa_signup));
    const isWorking = (j) => !!j.pa_opened_at || (Array.isArray(j.pa_notes_log) && j.pa_notes_log.length > 0);
    return {
      mineNeeds: sorted(preSign.filter((j) => !isWorking(j))),
      mineWorking: sorted(preSign.filter((j) => isWorking(j))),
      mineSigned: sorted(active.filter((j) => j.pa_fields?.pa_signup === "Signed")),
      mineNoContact: sorted(all.filter((j) => j.pa_stage === "no_contact")),
      mineWaiting: sorted(all.filter((j) => j.pa_stage === "waiting_docs")),
    };
  }, [mine, paCoords]);
  const list = mineView === "working" ? mineWorking : mineView === "signed" ? mineSigned : mineView === "no_contact" ? mineNoContact : mineView === "waiting_docs" ? mineWaiting : mineNeeds;

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, marginBottom: 12 }}>
        <div style={{ fontSize: 13, color: "#374151", fontWeight: 700 }}>
          🧑‍⚖️ Your assigned customers ({mine.length}) — grouped by county, newest signed first
        </div>
        <a href="/whats-new/?for=pa" target="_blank" rel="noreferrer"
          style={{ fontSize: 12, fontWeight: 700, color: "#3730a3", border: "1px solid #c7d2fe", background: "#eef2ff", borderRadius: 999, padding: "5px 11px", textDecoration: "none", whiteSpace: "nowrap" }}>
          🆕 What's new
        </a>
      </div>


      {/* Four views: brand-new files · being worked · signed · can't reach.
          A deal moves from New files → Working the moment the PA opens its
          pipeline or leaves a note. */}
      <div style={{ display: "flex", gap: 6, marginBottom: 12, flexWrap: "wrap" }}>
        <button type="button" onClick={() => setMineView("needs")}
          style={{ ...secondaryBtn, flex: "1 1 46%", padding: "9px 6px", fontSize: 12.5, fontWeight: 700,
            background: mineView === "needs" ? "#1d4ed8" : "#fff", color: mineView === "needs" ? "#fff" : "#1d4ed8",
            borderColor: "#93c5fd" }}>
          🆕 New files ({mineNeeds.length})
        </button>
        <button type="button" onClick={() => setMineView("working")}
          style={{ ...secondaryBtn, flex: "1 1 46%", padding: "9px 6px", fontSize: 12.5, fontWeight: 700,
            background: mineView === "working" ? "#92400e" : "#fff", color: mineView === "working" ? "#fff" : "#92400e",
            borderColor: "#f59e0b" }}>
          🛠 Working ({mineWorking.length})
        </button>
        <button type="button" onClick={() => setMineView("signed")}
          style={{ ...secondaryBtn, flex: "1 1 46%", padding: "9px 6px", fontSize: 12.5, fontWeight: 700,
            background: mineView === "signed" ? "#047857" : "#fff", color: mineView === "signed" ? "#fff" : "#047857",
            borderColor: "#34d399" }}>
          ✅ Signed ({mineSigned.length})
        </button>
        <button type="button" onClick={() => setMineView("no_contact")}
          style={{ ...secondaryBtn, flex: "1 1 46%", padding: "9px 6px", fontSize: 12.5, fontWeight: 700,
            background: mineView === "no_contact" ? "#475569" : "#fff", color: mineView === "no_contact" ? "#fff" : "#475569",
            borderColor: "#94a3b8" }}>
          📵 Can't reach ({mineNoContact.length})
        </button>
        <button type="button" onClick={() => setMineView("waiting_docs")}
          style={{ ...secondaryBtn, flex: "1 1 46%", padding: "9px 6px", fontSize: 12.5, fontWeight: 700,
            background: mineView === "waiting_docs" ? "#3730a3" : "#fff", color: mineView === "waiting_docs" ? "#fff" : "#3730a3",
            borderColor: "#c7d2fe" }}>
          📄 Waiting on docs ({mineWaiting.length})
        </button>
      </div>

      {msg && (
        <div style={{ padding: "8px 12px", borderRadius: 8, fontSize: 12, marginBottom: 10,
          background: msg.kind === "success" ? "#ecfdf5" : "#fef2f2",
          border: `1px solid ${msg.kind === "success" ? "#86efac" : "#fca5a5"}`,
          color: msg.kind === "success" ? "#065f46" : "#991b1b" }}>
          {msg.text}
        </div>
      )}

      {loading ? (
        <div style={{ padding: 24, textAlign: "center", color: "#6b7280" }}>Loading…</div>
      ) : list.length === 0 ? (
        <div style={{ padding: 24, textAlign: "center", color: "#6b7280", background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12 }}>
          {mineView === "waiting_docs"
            ? "Nothing waiting on documents. 👍 When you're blocked on a homeowner's insurance declaration page, tap “📄 Waiting on documents” inside a deal and it moves here."
            : mineView === "no_contact"
            ? "No “can't get ahold of them” customers. 👍"
            : mineView === "signed"
              ? "No signed customers yet. Once you mark a deal “Signed” it moves here."
              : mineView === "working"
                ? "Nothing in progress yet. Open a new file or add a note and it moves here."
                : mine.length === 0
                  ? "No customers assigned to you yet. New ones show up here automatically."
                  : "No brand-new files — everything's been opened or worked. 🎉"}
        </div>
      ) : (
        // Grouped by county (sticky header), newest-signed first within each.
        <div style={{ display: "grid", gap: 16 }}>
          {groupByCounty(list).map((g) => (
            <div key={g.county}>
              <div style={{ position: "sticky", top: 0, zIndex: 1, display: "flex", alignItems: "center", gap: 8, padding: "7px 12px", marginBottom: 8, background: "#ecfeff", border: "1px solid #a5f3fc", borderRadius: 8, fontWeight: 800, fontSize: 14, color: "#0e7490", fontFamily: "'Oswald', sans-serif" }}>
                📍 {g.county}
                <span style={{ fontSize: 12, fontWeight: 700, color: "#0891b2" }}>({g.jobs.length})</span>
              </div>
              <div style={{ display: "grid", gap: 8, gridTemplateColumns: wide ? "repeat(auto-fill, minmax(320px, 1fr))" : "1fr" }}>
                {g.jobs.map((job) => (
                  <PAJobCard key={job.id} job={job} onOpen={() => onOpenJob(job.id)} />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// Two side-by-side directions buttons — Apple Maps + Google Maps — so a
// PA can open the address in whichever app they use. Prefers geocoded
// lat/lng when present, else hands Maps the full address string.
function MapLinks({ address, lat, lng, size = "sm" }) {
  const hasGeo = lat != null && lng != null;
  if (!address && !hasGeo) return null;
  const q = hasGeo ? `${lat},${lng}` : encodeURIComponent(address);
  const apple = `https://maps.apple.com/?daddr=${q}&dirflg=d`;
  const google = `https://www.google.com/maps/dir/?api=1&destination=${q}`;
  const big = size === "lg";
  const btn = {
    display: "inline-flex", alignItems: "center", gap: 4,
    padding: big ? "8px 14px" : "6px 10px", borderRadius: 9,
    fontSize: big ? 14 : 12, fontWeight: 700, textDecoration: "none",
    border: "1px solid #d1d5db", whiteSpace: "nowrap",
  };
  return (
    <div style={{ display: "flex", gap: 6, marginTop: 6, flexWrap: "wrap" }}>
      <a href={apple} target="_blank" rel="noreferrer" style={{ ...btn, background: "#0a84ff", color: "#fff", borderColor: "#0a84ff" }}>🍎 Apple Maps</a>
      <a href={google} target="_blank" rel="noreferrer" style={{ ...btn, background: "#fff", color: "#1d4ed8", borderColor: "#1d4ed8" }}>🗺️ Google Maps</a>
    </div>
  );
}

// Minimal list card: just name + signed date + Open pipeline. Everything
// else (signup, notes, can't-reach, dead, milestones) lives in the pipeline
// detail view so the list stays a clean, scannable queue.
function PAJobCard({ job, onOpen }) {
  const signed = job.signed_at
    ? new Date(job.signed_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
    : "—";
  return (
    <div style={{ padding: 12, background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
      <div style={{ minWidth: 150 }}>
        <div style={{ fontWeight: 700, fontSize: 16 }}>
          {job.client_name || "(no name)"}
          {job.correction_needed && (
            <span style={{ marginLeft: 8, fontSize: 11, fontWeight: 700, color: "#92400e", background: "#fffbeb", border: "1px solid #fcd34d", borderRadius: 999, padding: "1px 8px", verticalAlign: "middle" }}>
              ⏳ awaiting rep
            </span>
          )}
        </div>
        <div style={{ fontSize: 12.5, color: "#6b7280", marginTop: 2 }}>🖊 Signed {signed}</div>
      </div>
      <button type="button" onClick={onOpen} style={{ ...primaryBtn, padding: "10px 16px", fontSize: 14, whiteSpace: "nowrap" }}>
        Open pipeline →
      </button>
    </div>
  );
}

// Group an already-county-sorted list into [{ county, jobs[] }]. Deals
// with no county (sorted last) collect under "Other / no county".
// Group deals by their current PA for the bulk reassign list. Unassigned
// first, then PAs alphabetically. Returns [{ key, label, deals }].
// Per-PA progress breakdown table (rendered inside PAAdminPanel). Columns
// mirror the buckets a PA sees in their portal, plus staleness signals so a
// manager can spot who's sitting on fresh leads.
function PAProgressReport({ report }) {
  const { rows, totals } = report;
  const th = { padding: "7px 8px", fontSize: 11, fontWeight: 800, color: "#3730a3", textAlign: "center", whiteSpace: "nowrap", position: "sticky", top: 0, background: "#eef2ff" };
  const td = { padding: "7px 8px", fontSize: 13, textAlign: "center", borderTop: "1px solid #e0e7ff" };
  const num = (n) => <span style={{ fontWeight: n ? 700 : 400, color: n ? "#1e293b" : "#cbd5e1" }}>{n}</span>;
  const days = (d) => (d == null ? <span style={{ color: "#cbd5e1" }}>—</span> : <span style={{ fontWeight: 700, color: d > 7 ? "#b45309" : "#1e293b" }}>{d}d</span>);
  const pctCell = (p, denom, good) => denom === 0
    ? <span style={{ color: "#cbd5e1" }}>—</span>
    : <span style={{ fontWeight: 800, color: good ? (p >= 50 ? "#047857" : "#475569") : (p >= 25 ? "#b91c1c" : "#475569") }}>{p}%</span>;

  // Group rows by company (Independent last). Each group gets a header + a
  // subtotal so the admin sees per-company performance at a glance.
  const groupsMap = new Map();
  for (const r of rows) { if (!groupsMap.has(r.company_name)) groupsMap.set(r.company_name, []); groupsMap.get(r.company_name).push(r); }
  const groupNames = [...groupsMap.keys()].sort((a, b) => (a === "Independent" ? 1 : b === "Independent" ? -1 : a.localeCompare(b)));
  const subtotal = (rs) => {
    const t = { assigned: 0, working: 0, signed: 0, lost: 0, dead: 0, taken: 0, denom: 0, _ds: 0, _dn: 0 };
    for (const r of rs) { ["assigned", "working", "signed", "lost", "dead", "taken", "denom"].forEach((k) => t[k] += r[k]); if (r.avgDaysToSign != null) { t._ds += r.avgDaysToSign * r.signed; t._dn += r.signed; } }
    const pct = (n, d) => (d > 0 ? Math.round((n / d) * 100) : 0);
    return { ...t, signPct: pct(t.signed, t.denom), lostPct: pct(t.lost, t.denom), takenPct: pct(t.taken, t.denom), avgDaysToSign: t._dn ? Math.round(t._ds / t._dn) : null };
  };
  const paCells = (r) => (
    <>
      <td style={{ ...td, fontWeight: 800 }}>{num(r.assigned)}</td>
      <td style={td}>{num(r.working)}</td>
      <td style={td}>{days(r.avgDaysToSign)}</td>
      <td style={td}>{pctCell(r.signPct, r.denom, true)}</td>
      <td style={td}>{pctCell(r.lostPct, r.denom, false)}</td>
      <td style={td}>{pctCell(r.takenPct, r.denom, false)}</td>
    </>
  );
  const body = [];
  for (const gn of groupNames) {
    const rs = groupsMap.get(gn);
    body.push(
      <tr key={`h-${gn}`} style={{ background: "#eef2ff" }}>
        <td colSpan={7} style={{ ...td, textAlign: "left", fontWeight: 800, color: "#3730a3" }}>🏢 {gn} ({rs.length})</td>
      </tr>,
    );
    for (const r of rs) {
      body.push(
        <tr key={r.id}>
          <td style={{ ...td, textAlign: "left", fontWeight: 700, color: "#0f172a", whiteSpace: "nowrap", paddingLeft: 18 }}>{r.name}</td>
          {paCells(r)}
        </tr>,
      );
    }
    if (rs.length > 1) {
      const s = subtotal(rs);
      body.push(
        <tr key={`s-${gn}`} style={{ background: "#f8fafc" }}>
          <td style={{ ...td, textAlign: "left", fontWeight: 700, color: "#64748b", fontStyle: "italic" }}>{gn} subtotal</td>
          {paCells(s)}
        </tr>,
      );
    }
  }
  const exportCsv = () => {
    const q = (s) => `"${String(s ?? "").replace(/"/g, '""')}"`;
    const head = ["Company", "Adjuster", "Assigned", "Working", "Avg days to sign", "Sign %", "Lost %", "Taken %"];
    const lines = [head.join(",")];
    for (const gn of groupNames) {
      for (const r of groupsMap.get(gn)) {
        lines.push([q(gn), q(r.name), r.assigned, r.working,
          r.avgDaysToSign == null ? "" : r.avgDaysToSign,
          r.denom ? r.signPct : "", r.denom ? r.lostPct : "", r.denom ? r.takenPct : ""].join(","));
      }
    }
    lines.push(["", q("ALL"), totals.assigned, totals.working,
      totals.avgDaysToSign == null ? "" : totals.avgDaysToSign,
      totals.denom ? totals.signPct : "", totals.denom ? totals.lostPct : "", totals.denom ? totals.takenPct : ""].join(","));
    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `pa-report-card-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
  };
  return (
    <div style={{ marginTop: 12, border: "1px solid #c7d2fe", borderRadius: 10, background: "#fff", overflowX: "auto" }}>
      <div style={{ display: "flex", justifyContent: "flex-end", padding: "8px 10px", borderBottom: "1px solid #e0e7ff" }}>
        <button type="button" onClick={exportCsv} style={{ ...secondaryBtn, fontSize: 12, padding: "5px 12px" }}>⬇ Export CSV</button>
      </div>
      <table style={{ borderCollapse: "collapse", width: "100%", minWidth: 720 }}>
        <thead>
          <tr>
            <th style={{ ...th, textAlign: "left" }}>Public adjuster</th>
            <th style={th} title="Active deals currently assigned (excludes lost/dead)">Assigned</th>
            <th style={th} title="Of assigned, ones they've opened or left a note on">Working</th>
            <th style={th} title="Average days from assignment to getting the homeowner signed">Avg days→sign</th>
            <th style={th} title="Signed ÷ everything ever given to them (incl. lost & taken away)">Sign %</th>
            <th style={th} title="Lost/cancelled ÷ everything ever given to them">Lost %</th>
            <th style={th} title="Deals the admin pulled off them ÷ everything ever given to them">Taken %</th>
          </tr>
        </thead>
        <tbody>
          {body}
          {rows.length === 0 && (
            <tr><td colSpan={7} style={{ ...td, color: "#6b7280" }}>No active adjusters.</td></tr>
          )}
        </tbody>
        {rows.length > 0 && (
          <tfoot>
            <tr style={{ background: "#f5f3ff" }}>
              <td style={{ ...td, textAlign: "left", fontWeight: 800, color: "#3730a3" }}>All ({rows.length})</td>
              <td style={{ ...td, fontWeight: 800 }}>{totals.assigned}</td>
              <td style={{ ...td, fontWeight: 800 }}>{totals.working}</td>
              <td style={{ ...td, fontWeight: 800 }}>{totals.avgDaysToSign == null ? "—" : `${totals.avgDaysToSign}d`}</td>
              <td style={{ ...td, fontWeight: 800, color: "#3730a3" }}>{totals.denom ? `${totals.signPct}%` : "—"}</td>
              <td style={{ ...td, fontWeight: 800, color: "#3730a3" }}>{totals.denom ? `${totals.lostPct}%` : "—"}</td>
              <td style={{ ...td, fontWeight: 800, color: "#3730a3" }}>{totals.denom ? `${totals.takenPct}%` : "—"}</td>
            </tr>
          </tfoot>
        )}
      </table>
      <div style={{ fontSize: 11, color: "#6b7280", padding: "8px 10px", borderTop: "1px solid #e0e7ff" }}>
        Percentages are over <strong>everything ever given to the PA</strong> (assigned + lost + dead + taken away). <strong>Avg days→sign</strong> &amp; <strong>Taken %</strong> only count activity from when scorecard tracking went live, so they'll fill in over time.
      </div>
    </div>
  );
}

function groupDealsByPa(deals, pas) {
  const nameById = {};
  for (const p of pas || []) nameById[p.id] = p.name;
  const byKey = new Map();
  for (const d of deals || []) {
    const key = d.pa_id || "__none__";
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(d);
  }
  const groups = [];
  if (byKey.has("__none__")) groups.push({ key: "__none__", label: "Unassigned", deals: byKey.get("__none__") });
  [...byKey.keys()].filter((k) => k !== "__none__")
    .sort((a, b) => (nameById[a] || "").localeCompare(nameById[b] || ""))
    .forEach((k) => groups.push({ key: k, label: nameById[k] || "Unknown PA", deals: byKey.get(k) }));
  return groups;
}

function groupByCounty(items) {
  const groups = [];
  let cur = null;
  for (const job of items) {
    const c = job.county || "Other / no county";
    if (!cur || cur.county !== c) { cur = { county: c, jobs: [] }; groups.push(cur); }
    cur.jobs.push(job);
  }
  return groups;
}

function milestoneProgress(paFields) {
  if (!paFields) return 0;
  return PA_FIELDS.filter((f) => paFields[f.key]).length;
}

// ── Pipeline detail: one claimed deal. Photos + context + the 8 editable
//    milestone date fields with per-field autosave to JN. ─────────────
function PAPipelineDetail({ me, jobId, onBack, wide, adminView }) {
  const [job, setJob] = useState(null);
  const [fields, setFields] = useState({});      // epoch seconds | string | null
  const [photos, setPhotos] = useState([]);
  const [photoSource, setPhotoSource] = useState(null);
  // True when this deal's photos are already copied into our storage, so
  // the "Save these photos to the app" button is hidden (nothing to do).
  const [photosInApp, setPhotosInApp] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadErr, setLoadErr] = useState(null);
  const [savingKey, setSavingKey] = useState(null);
  const [savedKey, setSavedKey] = useState(null);
  const [fieldErr, setFieldErr] = useState(null);
  const [releasing, setReleasing] = useState(false);
  const [refusing, setRefusing] = useState(false);
  const [noteBusy, setNoteBusy] = useState(false);
  const [noteText, setNoteText] = useState("");
  const [correctionBusy, setCorrectionBusy] = useState(false);
  const [backfilling, setBackfilling] = useState(false);
  const [backfillMsg, setBackfillMsg] = useState(null);
  // Photos start collapsed so the long grid doesn't bury the
  // milestone fields below it — the PA sees a "Show photos" button
  // and immediately knows there's more to scroll to.
  const [photosShown, setPhotosShown] = useState(false);

  // Copy this deal's JN-only photos into our own storage so it looks like
  // a modern app-captured inspection. Only offered when the photos we're
  // showing came live from JobNimbus (photoSource === "jobnimbus").
  async function backfillPhotos() {
    setBackfilling(true);
    setBackfillMsg(null);
    try {
      const res = await fetch("/.netlify/functions/pull-jn-photos-to-app", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ inspectionId: jobId }),
      });
      const body = await res.json().catch(() => ({}));
      if (!body.ok) {
        setBackfillMsg({ kind: "error", text: body.error || `Failed (status ${res.status})` });
      } else if (body.copied > 0) {
        setBackfillMsg({ kind: "success", text: `Saved ${body.copied} photo${body.copied === 1 ? "" : "s"} to the app. They'll now load instantly.` });
        setPhotoSource("app");
        setPhotosInApp(true);
      } else {
        setBackfillMsg({ kind: "success", text: body.skipped_reason === "no_jn_photos" ? "No JobNimbus photos to copy." : "Already saved app-side." });
        // Already in the app — hide the now-pointless save button.
        if (body.skipped_reason !== "no_jn_photos") setPhotosInApp(true);
      }
    } catch (e) {
      setBackfillMsg({ kind: "error", text: e.message || "Network error" });
    }
    setBackfilling(false);
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setLoadErr(null);
      const { data: row, error } = await supabase
        .from("inspections")
        .select("id, client_name, address, city, state, zip, signed_at, jn_job_id, result, sales_rep_name, mobile, email, pa_id, pa_fields, pa_assignment_note, pa_stage, pa_notes_log, correction_needed, correction_note, correction_requested_at, correction_resolved_at")
        .eq("id", jobId).maybeSingle();
      if (cancelled) return;
      if (error || !row) { setLoadErr(error?.message || "Claim not found."); setLoading(false); return; }
      setJob(row);
      // Pull current JN field values + photos.
      try {
        const res = await fetch("/.netlify/functions/pa-load-claim", {
          method: "POST", headers: { "Content-Type": "application/json" },
          // markOpened stamps pa_opened_at (first open) → moves the deal
          // into the "Working" bucket in the list.
          body: JSON.stringify({ inspectionId: jobId, paId: me.id, markOpened: true }),
        });
        const body = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (body.ok) {
          setFields(body.fields || {});
          setPhotos(body.photos || []);
          setPhotoSource(body.photo_source || null);
          setPhotosInApp(!!body.photos_in_app);
        } else {
          // Fall back to local cache if JN read failed.
          setFields(row.pa_fields || {});
          setLoadErr(body.error || "Couldn't read live JobNimbus values — showing last saved.");
        }
      } catch (e) {
        if (!cancelled) { setFields(row.pa_fields || {}); setLoadErr("Network error reading JobNimbus — showing last saved."); }
      }
      if (!cancelled) setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [jobId]);

  async function saveField(key, epochOrNull) {
    setSavingKey(key);
    setSavedKey(null);
    setFieldErr(null);
    // optimistic
    setFields((f) => ({ ...f, [key]: epochOrNull }));
    try {
      const res = await fetch("/.netlify/functions/pa-save-field", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ inspectionId: jobId, paId: me.id, field: key, value: epochOrNull }),
      });
      const body = await res.json().catch(() => ({}));
      if (!body.ok) {
        setFieldErr(`Couldn't save ${PA_FIELDS.find((f) => f.key === key)?.label || key}: ${body.error || res.status}`);
      } else {
        setSavedKey(key);
        setTimeout(() => setSavedKey((k) => (k === key ? null : k)), 1800);
      }
    } catch (e) {
      setFieldErr(e.message || "Network error");
    }
    setSavingKey(null);
  }

  async function release() {
    // Password gate — releasing a deal back to the pool is a manager-
    // controlled action, so require the 4-digit release PIN (stored
    // server-side, changeable in the manager Settings). Verified by a
    // Netlify function so the PIN itself never reaches the browser.
    const pin = window.prompt("Enter the 4-digit release PIN to send this deal back to the pool:");
    if (pin === null) return; // cancelled
    setReleasing(true);
    try {
      const vr = await fetch("/.netlify/functions/pa-release-pin", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "verify", pin: String(pin).trim() }),
      });
      const vb = await vr.json().catch(() => ({}));
      if (!vb.ok || !vb.valid) {
        setReleasing(false);
        alert("Incorrect PIN — the deal was NOT released.");
        return;
      }
    } catch (e) {
      setReleasing(false);
      alert("Couldn't verify the PIN: " + (e.message || "network error"));
      return;
    }
    if (!confirm("PIN accepted. Release this deal back to the pool? Your milestone entries stay in JobNimbus, but the deal returns to the Available list for any adjuster to claim.")) {
      setReleasing(false);
      return;
    }
    const { error } = await supabase
      .from("inspections")
      .update({ pa_id: null, pa_claimed_at: null })
      .eq("id", jobId).eq("pa_id", me.id);
    setReleasing(false);
    if (error) { setFieldErr(error.message); return; }
    onBack();
  }

  // "Refused to Sign" — the homeowner doesn't want to go through
  // insurance. This is a one-way door: it reverts the deal to retail
  // (record_type PA→Lead, moved to the retail location in JN) and texts
  // the sales rep + that rep's regional manager to go set up a retail
  // appointment. The deal then leaves the PA portal, so we confirm hard.
  async function refuseToSign() {
    const who = job?.client_name || "this homeowner";
    if (!window.confirm(
      `Mark "Refused to Sign" for ${who}?\n\n` +
      `This tells us the homeowner does NOT want to go through insurance. ` +
      `The deal moves back to RETAIL and leaves your claims, and we text ` +
      `the sales rep and their manager to go set up a retail appointment.\n\n` +
      `This can't be undone from here.`
    )) return;
    setRefusing(true);
    setFieldErr(null);
    try {
      const res = await fetch("/.netlify/functions/pa-refused-to-sign", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ inspectionId: jobId, paId: me.id }),
      });
      const body = await res.json().catch(() => ({}));
      if (!body.ok) {
        setRefusing(false);
        setFieldErr(`Couldn't complete that: ${body.error || res.status}`);
        return;
      }
      const repOk = body?.notified?.rep?.ok;
      const mgrOk = body?.notified?.manager?.ok;
      const noteBits = [];
      noteBits.push(repOk ? "✓ Sales rep texted" : "⚠ Sales rep not texted (no number on file)");
      noteBits.push(mgrOk ? "✓ Manager texted" : "⚠ Manager not texted (couldn't resolve their zone manager)");
      window.alert(`Done — moved to retail.\n\n${noteBits.join("\n")}`);
      onBack(); // deal is no longer a PA claim; the list reloads without it
    } catch (e) {
      setRefusing(false);
      setFieldErr(e.message || "Network error");
    }
  }

  // "Send back to retail" — same one-way revert as Refused to Sign, but
  // the PA types a free-text reason first (e.g. claim denied, no real
  // damage). Reverts in the app + JobNimbus and texts the rep + manager
  // with the reason, then the deal leaves the PA portal.
  async function sendToRetail() {
    const who = job?.client_name || "this homeowner";
    const reason = window.prompt(
      `Send "${who}" back to RETAIL?\n\n` +
      `This moves the deal out of insurance and back to retail — in the app AND in JobNimbus — ` +
      `and texts the sales rep + their manager.\n\n` +
      `Why is it going back to retail? (required)`,
    );
    if (reason == null) return; // cancelled
    const why = reason.trim();
    if (!why) { setFieldErr("A reason is required to send a deal back to retail."); return; }
    setRefusing(true);
    setFieldErr(null);
    try {
      const res = await fetch("/.netlify/functions/pa-refused-to-sign", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ inspectionId: jobId, paId: me.id, mode: "retail", reason: why }),
      });
      const body = await res.json().catch(() => ({}));
      if (!body.ok) {
        setRefusing(false);
        setFieldErr(`Couldn't complete that: ${body.error || res.status}`);
        return;
      }
      const repOk = body?.notified?.rep?.ok;
      const mgrOk = body?.notified?.manager?.ok;
      const noteBits = [];
      noteBits.push(repOk ? "✓ Sales rep texted" : "⚠ Sales rep not texted (no number on file)");
      noteBits.push(mgrOk ? "✓ Manager texted" : "⚠ Manager not texted (couldn't resolve their zone manager)");
      window.alert(`Done — sent back to retail.\n\n${noteBits.join("\n")}`);
      onBack();
    } catch (e) {
      setRefusing(false);
      setFieldErr(e.message || "Network error");
    }
  }

  // Add a note (running log) and/or change stage; posts to JobNimbus too.
  async function postNote({ text, stage }) {
    setNoteBusy(true);
    setFieldErr(null);
    try {
      const res = await fetch("/.netlify/functions/pa-add-note", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ inspectionId: jobId, paId: me.id, text: text || "", stage: stage || undefined }),
      });
      const b = await res.json().catch(() => ({}));
      if (!b.ok) { setFieldErr(b.error || `status ${res.status}`); setNoteBusy(false); return; }
      // Dead / can't-reach / waiting-on-docs move the deal off the active
      // list (into their own bucket) — go back to the list.
      if (stage === "dead" || stage === "no_contact" || stage === "waiting_docs") { onBack(); return; }
      setJob((j) => j ? {
        ...j,
        pa_stage: stage || j.pa_stage,
        pa_notes_log: text ? [ ...(j.pa_notes_log || []), { at: new Date().toISOString(), text, stage: stage || null } ] : j.pa_notes_log,
      } : j);
      setNoteText("");
    } catch (e) { setFieldErr(e.message || "Network error"); }
    setNoteBusy(false);
  }
  function deadDeal() {
    const t = window.prompt("Mark this DEAD DEAL? It leaves your list and is logged. Reason (required):");
    if (t == null) return; const r = t.trim();
    if (!r) { setFieldErr("A reason is required to mark a deal dead."); return; }
    postNote({ text: r, stage: "dead" });
  }
  function cantReach() {
    const t = window.prompt("Move to “Can't get ahold of them.” Add a note (optional):");
    if (t == null) return;
    postNote({ text: t.trim() || "Marked can't-reach", stage: "no_contact" });
  }
  // PA is blocked until the homeowner sends their insurance declaration page
  // (can't have them sign anything without it). Parks the deal in its own
  // "Waiting on docs" bucket; PA taps "Docs received" to bring it back.
  function waitingDocs() {
    const t = window.prompt("Move to “Waiting on documents” (e.g. the homeowner's insurance declaration page). Add a note (optional):");
    if (t == null) return;
    postNote({ text: t.trim() || "Waiting on homeowner's insurance declaration page", stage: "waiting_docs" });
  }
  // "Correction needed" — flags wrong/missing key info. Texts the originating
  // sales rep + their regional manager a link to fix it (CorrectionPage), and
  // posts the request to JobNimbus. When they save, JN updates + the PA gets a
  // text that it's corrected (submit-correction handles that side).
  async function requestCorrection(kind = "correction") {
    const isQuestion = kind === "question";
    const t = window.prompt(
      isQuestion
        ? "Question / request for the sales rep — what do you need?\n(e.g. \"Did the homeowner mention a second roof?\" or \"Can you confirm the insurance carrier?\")"
        : "Correction needed — what's wrong or what does the sales rep need to follow up on?\n(e.g. \"No phone number for the homeowner\" or \"Wrong address — verify with homeowner\")"
    );
    if (t == null) return;
    const note = t.trim();
    if (!note) { setFieldErr(isQuestion ? "Please type your question or request." : "Please describe what needs to be corrected."); return; }
    setCorrectionBusy(true); setFieldErr(null);
    try {
      const res = await fetch("/.netlify/functions/pa-request-correction", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ inspectionId: jobId, paId: me.id, note, kind }),
      });
      const b = await res.json().catch(() => ({}));
      if (!b.ok) { setFieldErr(b.error || `status ${res.status}`); setCorrectionBusy(false); return; }
      const repOk = b.notified?.rep?.ok;
      const mgrOk = b.notified?.manager?.ok;
      const who = [repOk ? "the sales rep" : null, mgrOk ? "their manager" : null].filter(Boolean).join(" + ");
      const logPrefix = isQuestion ? "Question for rep" : "Correction requested";
      setJob((j) => j ? {
        ...j,
        correction_needed: true,
        correction_note: note,
        correction_requested_at: new Date().toISOString(),
        correction_resolved_at: null,
        pa_notes_log: [ ...(j.pa_notes_log || []), { at: new Date().toISOString(), text: `${logPrefix}: ${note}`, stage: null } ],
      } : j);
      window.alert(who ? `Sent. ${who} got a text with a link to reply.` : "Sent. (Couldn't reach the rep/manager by text — check their phone numbers on file.)");
    } catch (e) { setFieldErr(e.message || "Network error"); }
    setCorrectionBusy(false);
  }

  if (loading) return <div style={{ padding: 24, textAlign: "center", color: "#6b7280" }}>Loading claim…</div>;
  if (loadErr && !job) {
    return (
      <div>
        <button type="button" onClick={onBack} style={{ ...secondaryBtn, marginBottom: 12 }}>← Back</button>
        <div style={{ padding: 16, background: "#fef2f2", border: "1px solid #fca5a5", borderRadius: 12, color: "#991b1b" }}>{loadErr}</div>
      </div>
    );
  }

  const addr = [job.address, job.city, job.state, job.zip].filter(Boolean).join(", ");

  return (
    <div>
      <button type="button" onClick={onBack} style={{ ...secondaryBtn, marginBottom: 12 }}>← Back to my claims</button>

      {/* Note from US Shingle — set when a manager assigned this deal to
          you out of the decision queue (e.g. reassigned from another PA). */}
      {job.pa_assignment_note && (
        <div style={{ padding: 14, background: "#eff6ff", border: "1px solid #bfdbfe", borderRadius: 12, marginBottom: 12 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: "#1e3a8a", marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.04em" }}>
            📌 Note from U.S. Shingle
          </div>
          <div style={{ fontSize: 14, color: "#1e3a8a", whiteSpace: "pre-wrap" }}>{job.pa_assignment_note}</div>
        </div>
      )}

      {/* Correction status banner. While a correction is pending the deal is
          waiting on the originating rep/manager; once they save the fix it
          flips to "corrected" (and the homeowner info above refreshes). */}
      {job.correction_needed ? (
        <div style={{ padding: 14, background: "#fffbeb", border: "1px solid #fcd34d", borderRadius: 12, marginBottom: 12 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: "#92400e", marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.04em" }}>
            ⏳ Sent to the rep — waiting on a reply
          </div>
          {job.correction_note && <div style={{ fontSize: 14, color: "#78350f" }}>{job.correction_note}</div>}
          <div style={{ fontSize: 12, color: "#a16207", marginTop: 4 }}>The sales rep + their manager were texted a link to reply. You'll get a text back, and the reply shows in your notes below.</div>
        </div>
      ) : job.correction_resolved_at ? (
        <div style={{ padding: 12, background: "#ecfdf5", border: "1px solid #a7f3d0", borderRadius: 12, marginBottom: 12, fontSize: 13, color: "#065f46", fontWeight: 700 }}>
          ✅ The rep replied — see your notes below (and any updated info above).
        </div>
      ) : null}

      {/* Job info */}
      <div style={{ padding: 14, background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12, marginBottom: 12 }}>
        <div style={{ fontWeight: 700, fontSize: 17, fontFamily: "'Oswald', sans-serif" }}>{job.client_name || "(no name)"}</div>
        {addr && <div style={{ fontSize: 13, color: "#374151", marginTop: 4 }}>{addr}</div>}
        {addr && <MapLinks address={addr} size="lg" />}
        {job.mobile && (
          <a href={`tel:${job.mobile}`} style={{ display: "inline-block", marginTop: 8, fontSize: 14, fontWeight: 700, color: "#1d4ed8", textDecoration: "none" }}>
            📞 {job.mobile}
          </a>
        )}
        <div style={{ fontSize: 12, color: "#6b7280", marginTop: 8 }}>
          {job.sales_rep_name && <>Rep: {job.sales_rep_name} · </>}
          <span style={{ color: "#991b1b", fontWeight: 700 }}>DAMAGE</span>
        </div>
      </div>

      {/* Context (auto-set by inspector) */}
      <div style={{ padding: 14, background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 12, marginBottom: 12 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: "#475569", marginBottom: 8, textTransform: "uppercase", letterSpacing: "0.04em" }}>From the inspection</div>
        <ContextRow label="Inspection" value={fields.inspection || "Damage"} />
        <ContextRow label="Inspected Date" value={epochToDisplay(fields.inspected_date)} />
        <ContextRow label="Inspected By" value={fields.inspected_by || "—"} />
      </div>

      {/* PA sign-up — the PA's first action: did the homeowner sign with you?
          Made deliberately loud: while the answer is still "Pending" the whole
          card glows amber with a pulsing "ACTION NEEDED" banner so a PA opening
          a deal cannot miss the one thing we need from them. Once they answer
          it calms down to the chosen state's color. */}
      {(() => {
        const current = isNeedSignature(fields.pa_signup) ? "Need Signature" : fields.pa_signup;
        const isPending = isNeedSignature(fields.pa_signup);
        const isSaving = savingKey === "pa_signup" || refusing;
        return (
          <div style={{
            padding: 20,
            background: isPending ? "#fffbeb" : "#fff",
            border: isPending ? "3px solid #f59e0b" : "2px solid #e5e7eb",
            borderRadius: 14,
            marginBottom: 16,
            boxShadow: isPending ? "0 0 0 4px rgba(245,158,11,0.15)" : "none",
          }}>
            {isPending && (
              <div style={{
                display: "inline-block", marginBottom: 10, padding: "4px 12px",
                background: "#f59e0b", color: "#fff", borderRadius: 999,
                fontSize: 12, fontWeight: 800, letterSpacing: "0.08em", textTransform: "uppercase",
                fontFamily: "'Oswald', sans-serif",
              }}>
                ⚠ Action needed
              </div>
            )}
            <div style={{ fontSize: 22, fontWeight: 800, color: "#0f172a", fontFamily: "'Oswald', sans-serif", lineHeight: 1.15, marginBottom: 4 }}>
              Did the homeowner sign up with you?
            </div>
            <div style={{ fontSize: 13, color: "#64748b", marginBottom: 16 }}>
              Tap your answer below — this is the first thing we need from you on this deal.
            </div>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              {PA_SIGNUP_OPTIONS.map((opt) => {
                const active = current === opt;
                return (
                  <button key={opt} type="button" disabled={isSaving}
                    onClick={() => {
                      if (isSaving) return;
                      if (opt === "Refused to Sign") { refuseToSign(); return; }
                      saveField("pa_signup", opt);
                    }}
                    style={{
                      flex: "1 1 120px", padding: "18px 12px", borderRadius: 12, fontSize: 16, fontWeight: 800,
                      cursor: isSaving ? "default" : "pointer",
                      fontFamily: "'Oswald', sans-serif", letterSpacing: "0.02em",
                      border: active ? "3px solid" : "2px solid #cbd5e1",
                      borderColor: active ? signupColor(opt) : "#cbd5e1",
                      background: active ? signupBg(opt) : "#fff",
                      color: active ? signupColor(opt) : "#334155",
                      boxShadow: active ? "0 2px 8px rgba(0,0,0,0.08)" : "none",
                      transition: "all 0.12s ease",
                    }}>
                    {opt}
                  </button>
                );
              })}
            </div>
            <div style={{ fontSize: 13, marginTop: 12, fontWeight: 700, color: savedKey === "pa_signup" ? "#047857" : isPending ? "#b45309" : "#64748b" }}>
              {refusing ? "Reverting to retail & texting the team…" : savingKey === "pa_signup" ? "Saving…" : savedKey === "pa_signup" ? "✓ Saved" : `Current answer: ${current}`}
            </div>
            {/* Send back to retail with a typed reason — reverts the deal
                in the app + JobNimbus and texts the rep + their manager. */}
            <button type="button" disabled={isSaving}
              onClick={() => { if (!isSaving) sendToRetail(); }}
              style={{ width: "100%", marginTop: 14, padding: "12px", borderRadius: 10, fontSize: 14, fontWeight: 800,
                fontFamily: "'Oswald', sans-serif", letterSpacing: "0.02em",
                border: "2px solid #b45309", background: "#fff7ed", color: "#b45309",
                cursor: isSaving ? "default" : "pointer" }}>
              ↩️ Send back to retail
            </button>
          </div>
        );
      })()}

      {/* Photos — collapsed by default. The grid is long enough to hide
          the milestone fields below it, so we keep it folded and let the
          PA expand it on demand. The toggle row doubles as a signpost
          that there's more content underneath. */}
      <div style={{ padding: 14, background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12, marginBottom: 12 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: "#475569", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: photos.length > 0 ? 10 : 0 }}>
          Inspection photos ({photos.length})
          {photoSource === "app" && (
            <span style={{ marginLeft: 8, fontSize: 10, fontWeight: 700, color: "#0e7490", textTransform: "none", letterSpacing: 0 }}>
              · from inspection app
            </span>
          )}
          {photoSource === "jobnimbus" && (
            <span style={{ marginLeft: 8, fontSize: 10, fontWeight: 700, color: "#92400e", textTransform: "none", letterSpacing: 0 }}>
              · from JobNimbus
            </span>
          )}
        </div>
        {photos.length > 0 && (
          <button type="button"
            onClick={() => setPhotosShown((v) => !v)}
            style={{
              width: "100%", display: "flex", alignItems: "center", justifyContent: "center",
              gap: 8, padding: "16px 18px", borderRadius: 12,
              background: photosShown ? "#eff6ff" : "#1d4ed8",
              border: photosShown ? "2px solid #1d4ed8" : "none",
              color: photosShown ? "#1d4ed8" : "#fff",
              cursor: "pointer", fontFamily: "'Oswald', sans-serif",
              fontSize: 18, fontWeight: 800, letterSpacing: "0.03em",
            }}>
            {photosShown ? `Hide Pictures ▲` : `📷 Show Pictures (${photos.length}) ▼`}
          </button>
        )}

        {photos.length === 0 ? (
          <div style={{ fontSize: 12, color: "#94a3b8", marginTop: 8 }}>No photos found for this inspection yet.</div>
        ) : !photosShown ? (
          <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 8 }}>
            Tap “Show” to view all {photos.length} photos. Scroll down for the insurance milestone fields.
          </div>
        ) : (
          <div style={{ marginTop: 10 }}>
            {/* Backfill: this deal's photos live only in JobNimbus (an older
                inspection done before in-app capture). Offer a one-tap copy
                into our storage so they load instantly from then on. */}
            {photoSource === "jobnimbus" && photos.length > 0 && !photosInApp && (
              <div style={{ marginBottom: 10 }}>
                <button type="button" onClick={backfillPhotos} disabled={backfilling}
                  style={{ ...secondaryBtn, fontSize: 12, fontWeight: 700, padding: "8px 12px" }}>
                  {backfilling ? "Saving photos…" : "⬇ Save these photos to the app"}
                </button>
                <div style={{ fontSize: 10, color: "#94a3b8", marginTop: 4 }}>
                  Older inspection — photos currently live in JobNimbus. Save a copy so they load instantly here.
                </div>
              </div>
            )}
            {backfillMsg && (
              <div style={{ padding: "8px 12px", borderRadius: 8, fontSize: 12, marginBottom: 10,
                background: backfillMsg.kind === "success" ? "#ecfdf5" : "#fef2f2",
                border: `1px solid ${backfillMsg.kind === "success" ? "#86efac" : "#fca5a5"}`,
                color: backfillMsg.kind === "success" ? "#065f46" : "#991b1b" }}>
                {backfillMsg.text}
              </div>
            )}
            <div style={{ display: "grid", gridTemplateColumns: wide ? "repeat(auto-fill, minmax(200px, 1fr))" : "1fr 1fr", gap: 6 }}>
              {photos.map((src, i) => (
                <a key={i} href={src} target="_blank" rel="noreferrer" style={{ display: "block" }}>
                  <img src={src} alt={`Inspection photo ${i + 1}`} style={{ width: "100%", borderRadius: 8, border: "1px solid #e5e7eb", display: "block" }} />
                </a>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Editable milestones */}
      <div style={{ padding: 14, background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12, marginBottom: 12 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: "#475569", marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.04em" }}>
          Insurance milestones
        </div>
        <div style={{ fontSize: 11, color: "#6b7280", marginBottom: 12 }}>
          Set the date each milestone happens. Every change saves straight to JobNimbus.
        </div>
        {loadErr && (
          <div style={{ padding: "8px 12px", borderRadius: 8, fontSize: 12, marginBottom: 10, background: "#fffbeb", border: "1px solid #fcd34d", color: "#92400e" }}>
            {loadErr}
          </div>
        )}
        {fieldErr && (
          <div style={{ padding: "8px 12px", borderRadius: 8, fontSize: 12, marginBottom: 10, background: "#fef2f2", border: "1px solid #fca5a5", color: "#991b1b" }}>
            {fieldErr}
          </div>
        )}
        <div style={{ display: "grid", gap: 10 }}>
          {PA_FIELDS.map((f) => (
            <div key={f.key} style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 8, alignItems: "center" }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 700 }}>{f.label}</div>
                <div style={{ fontSize: 11, color: savedKey === f.key ? "#047857" : "#94a3b8" }}>
                  {savingKey === f.key ? "Saving…" : savedKey === f.key ? "✓ Saved to JobNimbus" : fields[f.key] ? epochToDisplay(fields[f.key]) : "Not set"}
                </div>
              </div>
              <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                <input
                  type="date"
                  value={epochToDateInput(fields[f.key])}
                  disabled={savingKey === f.key}
                  onChange={(e) => saveField(f.key, dateInputToEpoch(e.target.value))}
                  style={{ ...inputStyle, width: 160, fontSize: 14 }}
                />
                {fields[f.key] && (
                  <button type="button" title="Clear" disabled={savingKey === f.key}
                    onClick={() => saveField(f.key, null)}
                    style={{ ...secondaryBtn, padding: "6px 8px", fontSize: 12 }}>
                    ✕
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Notes — running log; each note also posts to the JobNimbus job. */}
      <div style={{ padding: 14, background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12, marginBottom: 12 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: "#475569", marginBottom: 8, textTransform: "uppercase", letterSpacing: "0.04em" }}>
          Notes {job.pa_stage === "no_contact" && <span style={{ color: "#475569", background: "#f1f5f9", border: "1px solid #cbd5e1", borderRadius: 999, padding: "1px 8px", fontSize: 10, marginLeft: 6 }}>📵 Can't reach</span>}
        </div>
        {(job.pa_notes_log || []).length === 0 ? (
          <div style={{ fontSize: 12, color: "#94a3b8", marginBottom: 10 }}>No notes yet.</div>
        ) : (
          <div style={{ display: "grid", gap: 6, marginBottom: 10, maxHeight: 220, overflowY: "auto" }}>
            {[...(job.pa_notes_log || [])].reverse().map((n, i) => (
              <div key={i} style={{ fontSize: 13, color: "#334155", background: "#f8fafc", border: "1px solid #e5e7eb", borderRadius: 8, padding: "6px 10px" }}>
                <span style={{ color: "#94a3b8", fontSize: 11 }}>{(() => { try { return new Date(n.at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }); } catch { return ""; } })()}{n.stage ? ` · ${n.stage}` : ""}</span>
                <div>{n.text}</div>
              </div>
            ))}
          </div>
        )}
        <textarea value={noteText} onChange={(e) => setNoteText(e.target.value)} placeholder="Add a note… (also posts to JobNimbus)" rows={2}
          style={{ ...inputStyle, width: "100%", resize: "vertical", fontSize: 14, marginBottom: 8 }} />
        <button type="button" disabled={noteBusy || !noteText.trim()} onClick={() => postNote({ text: noteText.trim() })}
          style={{ ...primaryBtn, width: "100%", padding: "10px", fontSize: 14, opacity: (noteBusy || !noteText.trim()) ? 0.6 : 1 }}>
          {noteBusy ? "Saving…" : "📝 Add note"}
        </button>
      </div>

      {/* Can't reach / Dead deal / (Reached → back to active) */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
        {job.pa_stage === "no_contact" ? (
          <button type="button" disabled={noteBusy} onClick={() => postNote({ text: "Reached — back to active", stage: "active" })}
            style={{ flex: "1 1 45%", padding: "11px", borderRadius: 10, fontWeight: 700, fontSize: 13, border: "1px solid #a7f3d0", background: "#ecfdf5", color: "#047857", cursor: noteBusy ? "default" : "pointer" }}>
            ✅ Reached — back to active
          </button>
        ) : job.pa_stage === "waiting_docs" ? (
          <button type="button" disabled={noteBusy} onClick={() => postNote({ text: "Documents received — back to active", stage: "active" })}
            style={{ flex: "1 1 45%", padding: "11px", borderRadius: 10, fontWeight: 700, fontSize: 13, border: "1px solid #a7f3d0", background: "#ecfdf5", color: "#047857", cursor: noteBusy ? "default" : "pointer" }}>
            ✅ Docs received — back to active
          </button>
        ) : (
          <>
            <button type="button" disabled={noteBusy} onClick={cantReach}
              style={{ flex: "1 1 45%", padding: "11px", borderRadius: 10, fontWeight: 700, fontSize: 13, border: "1px solid #cbd5e1", background: "#f1f5f9", color: "#475569", cursor: noteBusy ? "default" : "pointer" }}>
              📵 Can't get ahold of them
            </button>
            <button type="button" disabled={noteBusy} onClick={waitingDocs}
              style={{ flex: "1 1 45%", padding: "11px", borderRadius: 10, fontWeight: 700, fontSize: 13, border: "1px solid #c7d2fe", background: "#eef2ff", color: "#3730a3", cursor: noteBusy ? "default" : "pointer" }}>
              📄 Waiting on documents
            </button>
          </>
        )}
        <button type="button" disabled={noteBusy} onClick={deadDeal}
          style={{ flex: "1 1 45%", padding: "11px", borderRadius: 10, fontWeight: 700, fontSize: 13, border: "1px solid #fca5a5", background: "#fef2f2", color: "#991b1b", cursor: noteBusy ? "default" : "pointer" }}>
          💀 Dead deal
        </button>
        <button type="button" disabled={correctionBusy} onClick={() => requestCorrection("correction")}
          style={{ flex: "1 1 45%", padding: "11px", borderRadius: 10, fontWeight: 700, fontSize: 13, border: "1px solid #fcd34d", background: "#fffbeb", color: "#92400e", cursor: correctionBusy ? "default" : "pointer", opacity: correctionBusy ? 0.6 : 1 }}>
          {correctionBusy ? "Sending…" : "✏️ Correction needed"}
        </button>
        <button type="button" disabled={correctionBusy} onClick={() => requestCorrection("question")}
          style={{ flex: "1 1 45%", padding: "11px", borderRadius: 10, fontWeight: 700, fontSize: 13, border: "1px solid #bfdbfe", background: "#eff6ff", color: "#1e40af", cursor: correctionBusy ? "default" : "pointer", opacity: correctionBusy ? 0.6 : 1 }}>
          {correctionBusy ? "Sending…" : "❓ Question / request for rep"}
        </button>
      </div>

      {/* Release back to the pool is an ADMIN-only action now — only shown
          when the portal was opened from the Admin hub (?admin=1). Field
          PAs never see it; deals are company-assigned. */}
      {adminView && (
        <button type="button" onClick={release} disabled={releasing} style={{ ...dangerBtn, width: "100%", padding: "10px", fontSize: 13 }}>
          {releasing ? "Releasing…" : "🛠 Admin: release this deal back to the pool"}
        </button>
      )}
    </div>
  );
}

function ContextRow({ label, value }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "4px 0", fontSize: 13 }}>
      <span style={{ color: "#64748b" }}>{label}</span>
      <span style={{ fontWeight: 700, color: "#0f172a", textAlign: "right" }}>{value}</span>
    </div>
  );
}
