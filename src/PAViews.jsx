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

  useEffect(() => { loadPas(); loadDecisions(); }, []);

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
            busy={busyId === pa.id}
            onToggle={() => toggleActive(pa)}
            onResend={() => resendLink(pa)}
            onUpdate={(patch) => updatePa(pa, patch)}
            onDelete={() => deletePa(pa)}
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
            onClick={() => window.open("/?mode=pa", "_blank")}
            style={{ ...secondaryBtn, padding: "6px 12px", fontSize: 11, whiteSpace: "nowrap" }}
            title="Opens the PA portal in a new tab for QA."
          >
            👁 Preview as PA
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

function PARow({ pa, busy, onToggle, onResend, onUpdate, onDelete }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({ name: pa.name, email: pa.email ?? "", phone: pa.phone ?? "" });
  const hasContact = !!(pa.phone || pa.email);
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
          <div style={{ fontSize: 11, color: "#6b7280", marginTop: -2 }}>
            Add the adjuster's <b>mobile number</b> (or email), then Save and click <b>Activate</b>.
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <button type="button" style={primaryBtn} onClick={() => {
              onUpdate({ name: draft.name.trim(), email: draft.email.trim() || null, phone: draft.phone.trim() || null });
              setEditing(false);
            }}>Save</button>
            <button type="button" style={secondaryBtn} onClick={() => setEditing(false)}>Cancel</button>
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
          {me && <button type="button" onClick={signOut} style={{ ...secondaryBtn, fontSize: 11 }}>Switch user</button>}
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
        <PAPipelineDetail me={me} wide={wide} jobId={stage.jobId} onBack={() => setStage("list")} />
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
  const [pool, setPool] = useState([]);
  const [mine, setMine] = useState([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState("mine"); // mine | pool
  // Within My claims, split into two lists so the PA keeps the deals he's
  // still chasing a signature on separate from the ones already signed
  // (where he's just updating milestone dates). needs | signed
  const [mineView, setMineView] = useState("needs");
  const [claimingId, setClaimingId] = useState(null);
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
    const [poolRes, mineRes] = await Promise.all([
      supabase.from("inspections")
        .select("id, client_name, address, city, state, zip, county, signed_at, jn_job_id, result, pa_id, latitude, longitude")
        .eq("result", "damage").is("pa_id", null).not("jn_job_id", "is", null)
        // Keep Lost/cancelled deals and anything parked for a US Shingle
        // decision OUT of the claimable pool.
        .is("cancelled_at", null).eq("pa_decision_needed", false)
        // Available is sorted alphabetically by county (deals without a
        // county yet fall to the bottom), then newest first within a county.
        .order("county", { ascending: true, nullsFirst: false })
        .order("signed_at", { ascending: false }).limit(200),
      supabase.from("inspections")
        .select("id, client_name, address, city, state, zip, county, signed_at, jn_job_id, result, pa_id, pa_claimed_at, pa_fields, pa_assignment_note, mobile, latitude, longitude")
        // A claimed deal that later goes Lost or gets pulled for a decision
        // (pa_decision_needed) drops out of the PA's claims automatically.
        .eq("pa_id", me.id).is("cancelled_at", null).eq("pa_decision_needed", false)
        .order("pa_claimed_at", { ascending: false }).limit(200),
    ]);
    setPool(poolRes.data || []);
    setMine(mineRes.data || []);
    setLoading(false);
    if (poolRes.error) setMsg({ kind: "error", text: poolRes.error.message });
    if (mineRes.error) setMsg({ kind: "error", text: mineRes.error.message });
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [me.id]);

  async function claim(job) {
    setClaimingId(job.id);
    setMsg(null);
    const { data, error } = await supabase
      .from("inspections")
      .update({ pa_id: me.id, pa_claimed_at: new Date().toISOString() })
      .eq("id", job.id)
      .is("pa_id", null)
      .select("id");
    setClaimingId(null);
    if (error) { setMsg({ kind: "error", text: error.message }); return; }
    if (!data || data.length === 0) {
      setMsg({ kind: "error", text: "Someone else just claimed that one. Refreshing…" });
      load();
      return;
    }
    onOpenJob(job.id);
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
  const { poolList, mineNeeds, mineSigned } = useMemo(() => {
    const withDist = (arr) =>
      arr.map((j) => ({
        ...j,
        _dist:
          paCoords && typeof j.latitude === "number" && typeof j.longitude === "number"
            ? milesBetween(paCoords.lat, paCoords.lng, j.latitude, j.longitude)
            : null,
      }));
    const byNearest = (a, b) => {
      if (a._dist == null && b._dist == null) return 0;
      if (a._dist == null) return 1;
      if (b._dist == null) return -1;
      return a._dist - b._dist;
    };
    const poolE = withDist(pool);
    const mineE = withDist(mine);
    if (paCoords) { poolE.sort(byNearest); mineE.sort(byNearest); }
    return {
      poolList: poolE,
      mineNeeds: mineE.filter((j) => isNeedSignature(j.pa_fields?.pa_signup)),
      mineSigned: mineE.filter((j) => j.pa_fields?.pa_signup === "Signed"),
    };
  }, [pool, mine, paCoords]);
  const list = tab === "pool" ? poolList : (mineView === "signed" ? mineSigned : mineNeeds);

  return (
    <div>
      <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
        <button type="button" onClick={() => setTab("mine")}
          style={{ ...secondaryBtn, flex: 1, padding: "10px", fontSize: 13, fontWeight: 700,
            background: tab === "mine" ? "#13294b" : "#fff", color: tab === "mine" ? "#fff" : "#374151",
            borderColor: tab === "mine" ? "#13294b" : "#d1d5db" }}>
          📂 My claims ({mine.length})
        </button>
        <button type="button" onClick={() => setTab("pool")}
          style={{ ...secondaryBtn, flex: 1, padding: "10px", fontSize: 13, fontWeight: 700,
            background: tab === "pool" ? "#13294b" : "#fff", color: tab === "pool" ? "#fff" : "#374151",
            borderColor: tab === "pool" ? "#13294b" : "#d1d5db" }}>
          📥 Available ({pool.length})
        </button>
      </div>

      {/* Geo bar — like the inspector portal. Once the PA grants GPS, both
          Available and My-claims sort nearest-first and show miles per card. */}
      <div style={{ padding: 10, background: "#fff", border: "1px solid #e5e7eb", borderRadius: 10, marginBottom: 12, display: "grid", gap: 6 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
          <div
            onClick={() => { if (!paCoords && !geoBusy) useMyLocation(); }}
            style={{ fontSize: 12, color: "#374151", cursor: paCoords ? "default" : "pointer", textDecoration: paCoords ? "none" : "underline", textDecorationColor: "#94a3b8" }}>
            {paCoords
              ? <>🧭 Sorted by distance from <strong style={{ color: "#0e7490" }}>your location</strong></>
              : <>🧭 Tap to see the closest deals first</>}
          </div>
          <button type="button" onClick={useMyLocation} disabled={geoBusy}
            style={{ ...secondaryBtn, fontSize: 12, padding: "8px 12px", fontWeight: 700, whiteSpace: "nowrap",
              background: paCoords ? "#ecfeff" : "#fff", borderColor: paCoords ? "#0e7490" : "#d1d5db",
              color: paCoords ? "#0e7490" : "#374151", cursor: geoBusy ? "default" : "pointer" }}>
            {geoBusy ? "📍 Locating…" : paCoords ? "📍 Sorting by nearest ✓" : "📍 Use my location"}
          </button>
        </div>
        {geoError && <div style={{ fontSize: 11, color: "#dc2626" }}>{geoError}</div>}
      </div>

      {/* My-claims sub-lists: still chasing a signature vs. already signed. */}
      {tab === "mine" && (
        <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
          <button type="button" onClick={() => setMineView("needs")}
            style={{ ...secondaryBtn, flex: 1, padding: "9px", fontSize: 13, fontWeight: 700,
              background: mineView === "needs" ? "#92400e" : "#fff", color: mineView === "needs" ? "#fff" : "#92400e",
              borderColor: "#f59e0b" }}>
            ✍️ Needs signature ({mineNeeds.length})
          </button>
          <button type="button" onClick={() => setMineView("signed")}
            style={{ ...secondaryBtn, flex: 1, padding: "9px", fontSize: 13, fontWeight: 700,
              background: mineView === "signed" ? "#047857" : "#fff", color: mineView === "signed" ? "#fff" : "#047857",
              borderColor: "#34d399" }}>
            ✅ Signed ({mineSigned.length})
          </button>
        </div>
      )}

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
          {tab !== "mine"
            ? "No unclaimed damage deals right now."
            : mine.length === 0
              ? "You haven't claimed any deals yet. Check the Available tab."
              : mineView === "signed"
                ? "No signed customers yet. Once you mark a deal “Signed” it moves here."
                : "Nothing waiting on a signature — everything you've claimed is signed. 🎉"}
        </div>
      ) : tab === "pool" && !paCoords ? (
        // Available, no GPS yet — grouped under a sticky county header (list
        // is already sorted by county server-side, so consecutive grouping
        // works). Once the PA taps "Use my location" we switch to the flat
        // nearest-first list below instead.
        <div style={{ display: "grid", gap: 16 }}>
          {groupByCounty(list).map((g) => (
            <div key={g.county}>
              <div style={{ position: "sticky", top: 0, zIndex: 1, display: "flex", alignItems: "center", gap: 8, padding: "7px 12px", marginBottom: 8, background: "#ecfeff", border: "1px solid #a5f3fc", borderRadius: 8, fontWeight: 800, fontSize: 14, color: "#0e7490", fontFamily: "'Oswald', sans-serif" }}>
                📍 {g.county}
                <span style={{ fontSize: 12, fontWeight: 700, color: "#0891b2" }}>({g.jobs.length})</span>
              </div>
              <div style={{ display: "grid", gap: 8, gridTemplateColumns: wide ? "repeat(auto-fill, minmax(300px, 1fr))" : "1fr" }}>
                {g.jobs.map((job) => (
                  <PAJobCard key={job.id} job={job} mine={false} hideCounty
                    claiming={claimingId === job.id}
                    onClaim={() => claim(job)} onOpen={() => onOpenJob(job.id)} />
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div style={{ display: "grid", gap: 8, gridTemplateColumns: wide ? "repeat(auto-fill, minmax(300px, 1fr))" : "1fr" }}>
          {list.map((job) => (
            <PAJobCard
              key={job.id}
              job={job}
              mine={tab === "mine"}
              claiming={claimingId === job.id}
              signupBusy={signupBusyId === job.id}
              onClaim={() => claim(job)}
              onOpen={() => onOpenJob(job.id)}
              onSignup={saveSignup}
              onRefuse={refuse}
              onSendRetail={sendToRetail}
            />
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

function PAJobCard({ job, mine, claiming, onClaim, onOpen, hideCounty, signupBusy, onSignup, onRefuse, onSendRetail }) {
  const addr = [job.address, job.city, job.state, job.zip].filter(Boolean).join(", ");
  const progress = mine ? milestoneProgress(job.pa_fields) : null;
  const dist = typeof job._dist === "number" ? job._dist : null;
  const signupValue = job.pa_fields?.pa_signup;
  const signupCurrent = isNeedSignature(signupValue) ? "Need Signature" : signupValue;
  const signupPending = isNeedSignature(signupValue);
  return (
    <div style={{ padding: 12, background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 700, fontSize: 15 }}>{job.client_name || "(no name)"}</div>
          <div style={{ fontSize: 12, color: "#6b7280", marginTop: 2 }}>{addr || "—"}</div>
          {dist != null && (
            <span style={{ display: "inline-block", marginTop: 4, fontSize: 11, fontWeight: 800, color: "#0e7490", background: "#ecfeff", border: "1px solid #a5f3fc", borderRadius: 999, padding: "1px 8px" }}>
              📍 {dist < 10 ? dist.toFixed(1) : Math.round(dist)} mi away
            </span>
          )}
          {addr && <MapLinks address={addr} />}
          {mine && job.mobile && (
            <a href={`tel:${job.mobile}`} style={{ display: "inline-block", marginTop: 6, fontSize: 13, fontWeight: 700, color: "#1d4ed8", textDecoration: "none" }}>
              📞 {job.mobile}
            </a>
          )}
          {!hideCounty && job.county && (
            <div style={{ display: "inline-block", marginTop: 4, fontSize: 11, fontWeight: 700, color: "#0e7490", background: "#ecfeff", border: "1px solid #a5f3fc", borderRadius: 999, padding: "1px 8px" }}>
              📍 {job.county}
            </div>
          )}
          {mine && (
            <div style={{ fontSize: 11, color: "#0e7490", marginTop: 6, fontWeight: 700 }}>
              {progress} of {PA_FIELDS.length} milestones filled
            </div>
          )}
        </div>
        <span style={{ fontSize: 10, padding: "3px 8px", background: "#fef2f2", color: "#991b1b", borderRadius: 999, fontWeight: 700, whiteSpace: "nowrap" }}>
          DAMAGE
        </span>
      </div>
      <div style={{ marginTop: 10 }}>
        {mine ? (
          <>
            {/* Sign-up answer, right on the card — the PA's first action.
                While still "Need Signature" the block glows amber. */}
            <div style={{
              marginBottom: 8, padding: 10, borderRadius: 10,
              background: signupPending ? "#fffbeb" : "#f8fafc",
              border: signupPending ? "2px solid #f59e0b" : "1px solid #e5e7eb",
            }}>
              <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6, color: signupPending ? "#b45309" : "#475569" }}>
                {signupPending ? "⚠ Did the homeowner sign up with you?" : `Sign-up: ${signupCurrent}`}
              </div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {PA_SIGNUP_OPTIONS.map((opt) => {
                  const active = signupCurrent === opt;
                  return (
                    <button key={opt} type="button" disabled={signupBusy}
                      onClick={() => {
                        if (signupBusy) return;
                        if (opt === "Refused to Sign") { onRefuse(job); return; }
                        onSignup(job, opt);
                      }}
                      style={{
                        flex: "1 1 90px", padding: "10px 8px", borderRadius: 9, fontSize: 13, fontWeight: 700,
                        cursor: signupBusy ? "default" : "pointer",
                        border: active ? "2px solid" : "1px solid #cbd5e1",
                        borderColor: active ? signupColor(opt) : "#cbd5e1",
                        background: active ? signupBg(opt) : "#fff",
                        color: active ? signupColor(opt) : "#334155",
                      }}>
                      {opt}
                    </button>
                  );
                })}
              </div>
              {signupBusy && <div style={{ fontSize: 11, color: "#64748b", marginTop: 6, fontWeight: 700 }}>Saving…</div>}
            </div>
            {/* Send the deal back to retail with a typed reason — reverts
                in the app + JobNimbus and texts the rep + their manager. */}
            <button type="button" disabled={signupBusy}
              onClick={() => { if (!signupBusy) onSendRetail(job); }}
              style={{ width: "100%", marginBottom: 8, padding: "9px", borderRadius: 9, fontSize: 13, fontWeight: 700,
                border: "1px solid #b45309", background: "#fff7ed", color: "#b45309",
                cursor: signupBusy ? "default" : "pointer" }}>
              ↩️ Send back to retail
            </button>
            <button type="button" onClick={onOpen} style={{ ...primaryBtn, width: "100%", padding: "10px", fontSize: 14 }}>
              Open pipeline →
            </button>
          </>
        ) : (
          <button type="button" onClick={onClaim} disabled={claiming}
            style={{ ...primaryBtn, width: "100%", padding: "10px", fontSize: 14, background: claiming ? "#94a3b8" : "#047857" }}>
            {claiming ? "Claiming…" : "✋ Claim this deal"}
          </button>
        )}
      </div>
    </div>
  );
}

// Group an already-county-sorted list into [{ county, jobs[] }]. Deals
// with no county (sorted last) collect under "Other / no county".
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
function PAPipelineDetail({ me, jobId, onBack, wide }) {
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
        .select("id, client_name, address, city, state, zip, signed_at, jn_job_id, result, sales_rep_name, mobile, email, pa_id, pa_fields, pa_assignment_note")
        .eq("id", jobId).maybeSingle();
      if (cancelled) return;
      if (error || !row) { setLoadErr(error?.message || "Claim not found."); setLoading(false); return; }
      setJob(row);
      // Pull current JN field values + photos.
      try {
        const res = await fetch("/.netlify/functions/pa-load-claim", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ inspectionId: jobId }),
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

      <button type="button" onClick={release} disabled={releasing} style={{ ...dangerBtn, width: "100%", padding: "10px", fontSize: 13 }}>
        {releasing ? "Releasing…" : "Release this deal back to the pool"}
      </button>
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
