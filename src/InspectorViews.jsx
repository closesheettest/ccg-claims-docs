// Inspector feature — two views in one file:
//
//   <InspectorsAdminPanel /> — manager-side. List/add/edit/delete
//     inspectors, set their home-base lat/lng + optional max-mile cap,
//     and override-assign any in-progress inspection to a different
//     inspector. Lives inside the manager view in App.jsx.
//
//   <InspectorMobileApp />   — inspector-side. Mobile-first. Inspector
//     picks their name, sees "Available near me" (auto-sorted by
//     haversine distance from their home base, capped by their
//     max_distance_miles if set), and "In progress" (jobs they've
//     claimed). Claim → photos → result → submit. Submit hands off
//     to /.netlify/functions/inspector-submit-result for JN + PA fan-out.
//
// Data model (run the Phase 1 SQL first):
//   inspectors(id, name, latitude, longitude, active, jn_user_id,
//              max_distance_miles, notes, created_at)
//   inspections gets new columns:
//     inspector_id uuid       -- null = unclaimed, available to anyone
//     inspection_photos jsonb -- [{ path, bucket, captured_at, ... }]
//     latitude / longitude double precision -- for distance routing

import React, { useEffect, useMemo, useState, useRef } from "react";
import { supabase } from "./lib/supabase";
import { AddressAutocomplete } from "./lib/AddressAutocomplete";

const SIGNED_BUCKET = "signed-documents";
const PHOTO_PATH_PREFIX = "inspection-photos";

// Public setup page for new inspectors. The manager clicks "Sync from
// JN" + "Send setup email", which emails the inspector a link to
// ?inspector_setup=<token>. App.jsx detects the URL param and mounts
// <InspectorSetupPage token={...} /> at full-screen instead of the
// regular signing flow. Inspector fills in their home address →
// we geocode + save lat/lng + info_updated_at, then they can be
// activated by the manager and start receiving jobs.
export function InspectorSetupPage({ token, onDone }) {
  const [insp, setInsp] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [address, setAddress] = useState("");
  const [city, setCity] = useState("");
  const [state, setStateField] = useState("");
  const [zip, setZip] = useState("");
  const [placeCoords, setPlaceCoords] = useState(null); // { lat, lng } from Google Places pick
  const [phone, setPhone] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (!token) {
      setError("No setup token in URL.");
      setLoading(false);
      return;
    }
    supabase
      .from("inspectors")
      .select("*")
      .eq("registration_token", token)
      .maybeSingle()
      .then(({ data, error: err }) => {
        if (err || !data) {
          setError(err?.message || "Setup link not found — ask your manager to re-send.");
          setLoading(false);
          return;
        }
        setInsp(data);
        setAddress(data.address || "");
        setPhone(data.phone || "");
        setLoading(false);
      });
  }, [token]);

  async function submit(e) {
    e?.preventDefault?.();
    if (!address.trim()) {
      setError("Pick your home address from the dropdown first.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      // Prefer the lat/lng Google handed back when the inspector picked
      // from the autocomplete dropdown (no second API call needed).
      // Fall back to server-side geocode if for some reason we don't
      // have coords yet (e.g. user typed but didn't pick).
      let lat = placeCoords?.lat;
      let lng = placeCoords?.lng;
      if (lat == null || lng == null) {
        const fullQuery = [address, city, state, zip].filter(Boolean).join(", ") || address;
        const geoRes = await fetch("/.netlify/functions/geocode-place", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query: fullQuery }),
        });
        const geo = await geoRes.json().catch(() => ({}));
        if (!geo.ok) {
          setError(`Couldn't find that address: ${geo.error || "unknown"}`);
          setSubmitting(false);
          return;
        }
        lat = geo.lat;
        lng = geo.lng;
      }
      // Save full structured address back to the inspector row.
      const fullAddress = [address, city, state, zip].filter(Boolean).join(", ") || address;
      const { error: updErr } = await supabase
        .from("inspectors")
        .update({
          address: fullAddress,
          phone: phone.trim() || null,
          latitude: lat,
          longitude: lng,
          info_updated_at: new Date().toISOString(),
        })
        .eq("id", insp.id);
      if (updErr) {
        setError(updErr.message);
        setSubmitting(false);
        return;
      }
      setDone(true);
    } catch (e) {
      setError(e.message || "Network error");
    }
    setSubmitting(false);
  }

  if (loading) {
    return <div style={{ padding: 40, textAlign: "center", color: "#6b7280" }}>Loading…</div>;
  }
  if (error && !insp) {
    return (
      <div style={{ maxWidth: 480, margin: "60px auto", padding: 24, fontFamily: "'Nunito', sans-serif" }}>
        <div style={{ padding: 16, background: "#fef2f2", border: "1px solid #fca5a5", borderRadius: 12, color: "#991b1b" }}>
          {error}
        </div>
      </div>
    );
  }
  if (done) {
    return (
      <div style={{ maxWidth: 480, margin: "60px auto", padding: 24, textAlign: "center", fontFamily: "'Nunito', sans-serif" }}>
        <div style={{ fontSize: 56, marginBottom: 16 }}>✅</div>
        <div style={{ fontSize: 22, fontWeight: 700, marginBottom: 8, fontFamily: "'Oswald', sans-serif" }}>
          You're all set, {insp.name}!
        </div>
        <p style={{ color: "#475569", marginBottom: 20 }}>
          Your home base is saved. Once your manager activates your account,
          you'll start receiving inspection jobs in the app.
        </p>
        {onDone && (
          <button
            type="button"
            onClick={onDone}
            style={{ ...primaryBtn, padding: "12px 24px", fontSize: 14 }}
          >
            ← Back to app
          </button>
        )}
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 480, margin: "40px auto", padding: 24, fontFamily: "'Nunito', sans-serif" }}>
      <div style={{ fontSize: 24, fontWeight: 700, fontFamily: "'Oswald', sans-serif", marginBottom: 6 }}>
        👷 Welcome, {insp.name}
      </div>
      <p style={{ color: "#475569", marginBottom: 24, fontSize: 14 }}>
        You've been added as an inspector. Please confirm your home base
        address so the system can route inspections to the closest
        inspector. {insp.info_updated_at && (
          <span style={{ color: "#0e7490" }}>
            (You've already set this once — this will update it.)
          </span>
        )}
      </p>
      <form onSubmit={submit} style={{ display: "grid", gap: 14 }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 4 }}>
            Home address <span style={{ color: "#dc2626" }}>*</span>
          </div>
          <AddressAutocomplete
            value={address}
            onChange={(v) => setAddress(v)}
            onPlaceSelected={({ address: street, city: c, state: s, zip: z, lat, lng }) => {
              setAddress(street);
              setCity(c);
              setStateField(s);
              setZip(z);
              if (typeof lat === "number" && typeof lng === "number") {
                setPlaceCoords({ lat, lng });
              }
            }}
            placeholder="Start typing your home address…"
          />
          {city && (
            <div style={{ fontSize: 12, color: "#475569", marginTop: 6 }}>
              {city}, {state} {zip}
            </div>
          )}
        </div>
        <label>
          <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 4 }}>
            Mobile phone <span style={{ color: "#94a3b8", fontWeight: 400 }}>(optional, for future SMS notifications)</span>
          </div>
          <input
            type="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="(555) 123-4567"
            style={{ ...inputStyle, fontSize: 16, padding: "12px 14px" }}
          />
        </label>
        {error && (
          <div style={{ padding: "10px 14px", background: "#fef2f2", border: "1px solid #fca5a5", borderRadius: 8, color: "#991b1b", fontSize: 13 }}>
            {error}
          </div>
        )}
        <button
          type="submit"
          disabled={submitting || !address.trim()}
          style={{
            padding: "14px 18px",
            background: submitting ? "#94a3b8" : "#0e7490",
            color: "#fff",
            border: "none",
            borderRadius: 10,
            fontSize: 16,
            fontWeight: 700,
            fontFamily: "'Oswald', sans-serif",
            cursor: submitting ? "wait" : "pointer",
          }}
        >
          {submitting ? "Saving…" : "Save & continue →"}
        </button>
      </form>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Haversine distance in miles between two lat/lng pairs.
// ─────────────────────────────────────────────────────────────────────
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

// ═════════════════════════════════════════════════════════════════════
// ADMIN PANEL — manager-only. Mounted inside the manager view.
// ═════════════════════════════════════════════════════════════════════

export function InspectorsAdminPanel() {
  const [inspectors, setInspectors] = useState([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState(null);
  // JN sync state
  const [syncing, setSyncing] = useState(false);
  // Per-row "send setup email" state
  const [sendingEmailId, setSendingEmailId] = useState(null);
  // Bulk-geocode state (for the one-time "give every old inspection
  // lat/lng" backfill — needed before mile distances appear).
  const [geocoding, setGeocoding] = useState(false);

  useEffect(() => {
    loadInspectors();
  }, []);

  async function syncFromJn() {
    if (!confirm(
      "Pull the inspector list from JobNimbus?\n\nNew JN users get added " +
      "as inactive inspectors (you choose who to activate). Existing rows " +
      "have their name + email refreshed without touching their address " +
      "or active status.",
    )) return;
    setSyncing(true);
    try {
      const res = await fetch("/.netlify/functions/sync-inspectors-from-jn", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const body = await res.json().catch(() => ({}));
      if (!body.ok) {
        setMessage({ kind: "error", text: body.error || `Sync failed (status ${res.status})` });
      } else {
        setMessage({
          kind: "success",
          text:
            `Synced ${body.total_jn_users} JN users — ${body.inserted} new inspectors added (inactive), ` +
            `${body.updated} refreshed${body.skipped ? `, ${body.skipped} skipped` : ""}.`,
        });
        await loadInspectors();
      }
    } catch (e) {
      setMessage({ kind: "error", text: e.message || "Network error" });
    }
    setSyncing(false);
  }

  async function geocodeAllInspections() {
    if (!confirm(
      "Geocode every inspection that has an address but no lat/lng yet?\n\n" +
      "This is a one-time backfill so distance routing in the Inspector app " +
      "works for older rows. Takes about 1 second per row. Safe to re-run — " +
      "rows already geocoded are skipped.",
    )) return;
    setGeocoding(true);
    try {
      const res = await fetch("/.netlify/functions/bulk-geocode-inspections", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body.error) {
        setMessage({ kind: "error", text: body.error || `Geocode failed (${res.status})` });
      } else {
        const errs = body.errors?.length || 0;
        setMessage({
          kind: errs === 0 ? "success" : "error",
          text:
            `Geocoded ${body.geocoded} of ${body.matched} inspections` +
            (body.skipped ? `, skipped ${body.skipped} already done` : "") +
            (errs ? ` — ${errs} errored (usually a typo or PO box)` : "") +
            ". Distance routing should now work in the Inspector app.",
        });
      }
    } catch (e) {
      setMessage({ kind: "error", text: e.message || "Network error" });
    }
    setGeocoding(false);
  }

  async function sendUpdateLink(insp) {
    if (!insp.email && !insp.phone) {
      setMessage({ kind: "error", text: `${insp.name} has no email or phone on file. Sync from JN first or add manually.` });
      return;
    }
    setSendingEmailId(insp.id);
    try {
      const res = await fetch("/.netlify/functions/send-inspector-update-link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ inspectorId: insp.id, channel: "auto" }),
      });
      const body = await res.json().catch(() => ({}));
      if (!body.ok) {
        setMessage({ kind: "error", text: body.error || `Send failed (status ${res.status})` });
      } else {
        const dest = body.channel_used === "sms" ? `📱 SMS to ${body.phone}` : `📧 email to ${body.email}`;
        setMessage({ kind: "success", text: `Link sent (${dest}).` });
      }
    } catch (e) {
      setMessage({ kind: "error", text: e.message || "Network error" });
    }
    setSendingEmailId(null);
  }

  // Send the field-guide link (/inspector-guide/) to one active
  // inspector on demand. Same SMS-or-email channel auto-pick as the
  // other inspector messaging. Confirm before firing because it
  // texts a real human and they'll see the message on their phone.
  async function sendGuide(insp) {
    if (!insp.active) {
      setMessage({ kind: "error", text: `${insp.name} isn't active. Activate them first.` });
      return;
    }
    if (!insp.email && !insp.phone) {
      setMessage({ kind: "error", text: `${insp.name} has no email or phone on file.` });
      return;
    }
    const dest = insp.phone ? `📱 SMS to ${insp.phone}` : `📧 email to ${insp.email}`;
    if (!confirm(`Send the field guide to ${insp.name}? (${dest})`)) return;
    setSendingEmailId(insp.id);
    try {
      const res = await fetch("/.netlify/functions/send-inspector-guide", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ inspectorId: insp.id, channel: "auto" }),
      });
      const body = await res.json().catch(() => ({}));
      if (!body.ok) {
        setMessage({ kind: "error", text: body.error || `Send failed (status ${res.status})` });
      } else {
        const destSent = body.channel_used === "sms" ? `📱 SMS to ${body.phone}` : `📧 email to ${body.email}`;
        setMessage({ kind: "success", text: `Field guide sent to ${insp.name} (${destSent}).` });
      }
    } catch (e) {
      setMessage({ kind: "error", text: e.message || "Network error" });
    }
    setSendingEmailId(null);
  }

  async function loadInspectors() {
    setLoading(true);
    const { data, error } = await supabase
      .from("inspectors")
      .select("*")
      .order("name", { ascending: true });
    if (error) {
      setMessage({ kind: "error", text: error.message });
      setLoading(false);
      return;
    }
    const all = data || [];
    setInspectors(all);
    setLoading(false);

    // Self-heal: release pending claims that point to an INACTIVE
    // inspector. Catches orphans left behind from older deactivations
    // (or any other path that bypassed the toggleActive cleanup).
    const inactiveIds = all.filter((i) => !i.active).map((i) => i.id);
    if (inactiveIds.length === 0) return;
    const idList = inactiveIds.join(",");
    const { data: released } = await supabase
      .from("inspections")
      .update({ inspector_id: null, claimed_at: null })
      .in("inspector_id", inactiveIds)
      .is("result", null)
      .select("id");
    const n = released?.length || 0;
    if (n > 0) {
      setMessage({
        kind: "success",
        text: `Released ${n} orphaned pending claim${n === 1 ? "" : "s"} (assigned to inactive inspector${inactiveIds.length === 1 ? "" : "s"}).`,
      });
    }
    // Suppress lint complaint about unused idList var.
    void idList;
  }

  async function toggleActive(insp) {
    const wasActive = !!insp.active;
    const { error } = await supabase
      .from("inspectors")
      .update({ active: !insp.active })
      .eq("id", insp.id);
    if (error) return setMessage({ kind: "error", text: error.message });

    // On deactivation (true → false): release every PENDING claim
    // back to the pool. Completed inspections (result IS NOT NULL)
    // stay attached so historical reports keep showing who did what.
    if (wasActive) {
      const { data: released, error: releaseErr } = await supabase
        .from("inspections")
        .update({ inspector_id: null, claimed_at: null })
        .eq("inspector_id", insp.id)
        .is("result", null)
        .select("id");
      loadInspectors();
      if (releaseErr) {
        setMessage({
          kind: "error",
          text: `Deactivated, but couldn't release their pending claims: ${releaseErr.message}`,
        });
        return;
      }
      const n = released?.length || 0;
      setMessage({
        kind: "success",
        text: n > 0
          ? `Deactivated ${insp.name}. Released ${n} pending claim${n === 1 ? "" : "s"} back to the available pool.`
          : `Deactivated ${insp.name}. No pending claims to release.`,
      });
      return;
    }

    loadInspectors();

    // On activation (false → true) auto-fire the app-link invite to
    // the inspector's phone (SMS) or email — saves the manager an
    // extra click and gets the app onto their home screen quickly.
    if (!wasActive) {
      if (!insp.email && !insp.phone) {
        setMessage({
          kind: "success",
          text: `Activated ${insp.name}. No email/phone on file — couldn't auto-send the app link.`,
        });
        return;
      }
      try {
        const res = await fetch("/.netlify/functions/send-inspector-app-invite", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ inspectorId: insp.id, channel: "auto" }),
        });
        const body = await res.json().catch(() => ({}));
        if (!body.ok) {
          setMessage({
            kind: "error",
            text: `Activated, but invite send failed: ${body.error || `status ${res.status}`}`,
          });
        } else {
          const dest = body.channel_used === "sms" ? `📱 SMS to ${body.phone}` : `📧 email to ${body.email}`;
          setMessage({
            kind: "success",
            text: `Activated ${insp.name} — app link sent (${dest}).`,
          });
        }
      } catch (e) {
        setMessage({ kind: "error", text: `Activated, but invite send failed: ${e.message || "Network error"}` });
      }
    }
  }

  async function updateInspector(insp, patch) {
    const { error } = await supabase
      .from("inspectors")
      .update(patch)
      .eq("id", insp.id);
    if (error) return setMessage({ kind: "error", text: error.message });
    loadInspectors();
  }

  async function deleteInspector(insp) {
    if (!confirm(
      `Delete inspector "${insp.name}"? Any inspections currently assigned to ` +
      `them will be un-assigned (inspector_id set to NULL) and re-appear on ` +
      `other inspectors' "Available near me" lists.`,
    )) return;
    // Un-assign their jobs first so the FK doesn't block deletion.
    await supabase
      .from("inspections")
      .update({ inspector_id: null, claimed_at: null })
      .eq("inspector_id", insp.id);
    const { error } = await supabase.from("inspectors").delete().eq("id", insp.id);
    if (error) return setMessage({ kind: "error", text: error.message });
    setMessage({ kind: "success", text: `Removed ${insp.name}.` });
    loadInspectors();
  }

  return (
    <div style={{ display: "grid", gap: 18 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 18, fontWeight: 700, fontFamily: "'Oswald', sans-serif" }}>
            🔍 Inspectors
          </div>
          <div style={{ fontSize: 12, color: "#6b7280", marginTop: 4 }}>
            Pull the list from JobNimbus (single source of truth for names + emails),
            then email each one a setup link so they confirm their home address.
            Inspectors stay inactive until you flip them on AND they've completed setup.
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6, alignItems: "flex-end" }}>
          <button
            type="button"
            onClick={syncFromJn}
            disabled={syncing}
            style={{ ...primaryBtn, padding: "8px 16px", fontSize: 13, whiteSpace: "nowrap" }}
          >
            {syncing ? "Syncing…" : "🔄 Sync from JN"}
          </button>
          <button
            type="button"
            onClick={geocodeAllInspections}
            disabled={geocoding}
            style={{ ...secondaryBtn, padding: "6px 12px", fontSize: 11, whiteSpace: "nowrap" }}
            title="One-time backfill: give every inspection lat/lng so distance routing works. Safe to re-run."
          >
            {geocoding ? "Geocoding…" : "🌐 Geocode all inspections"}
          </button>
          <button
            type="button"
            onClick={() => window.open("/?mode=inspector", "_blank")}
            style={{ ...secondaryBtn, padding: "6px 12px", fontSize: 11, whiteSpace: "nowrap" }}
            title="Opens the inspector mobile view in a new tab. Useful for QA-ing the inspector experience."
          >
            👁 Preview as inspector
          </button>
        </div>
      </div>

      {message && (
        <div
          style={{
            padding: "10px 14px",
            borderRadius: 10,
            fontSize: 13,
            background: message.kind === "success" ? "#ecfdf5" : "#fef2f2",
            border: `1px solid ${message.kind === "success" ? "#86efac" : "#fca5a5"}`,
            color: message.kind === "success" ? "#065f46" : "#991b1b",
          }}
        >
          {message.text}
        </div>
      )}

      {/* Adding inspectors — JN is the source of truth. Manual add is
          intentionally removed so we never end up with an inspector
          here that isn't in JN (which would break job assignment +
          photo upload). */}
      <section style={{ border: "1px solid #bfdbfe", borderRadius: 12, padding: 16, background: "#eff6ff" }}>
        <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 6, color: "#1e3a8a" }}>
          ➕ Don't see an inspector below?
        </div>
        <ol style={{ margin: 0, paddingLeft: 20, fontSize: 13, color: "#1e3a8a", lineHeight: 1.6 }}>
          <li>Add them as a user in <strong>JobNimbus</strong> first (with their email).</li>
          <li>Come back here and click <strong>🔄 Sync from JN</strong> at the top of this page.</li>
          <li>The new inspector shows up here as <em>Setup pending</em>.</li>
          <li>Open <strong>Edit</strong>, drop in their phone number, save.</li>
          <li>Click <strong>📧/📱 Send setup email/text</strong> — they confirm their home address from the link.</li>
          <li>Once their row says <em>✓ Setup complete</em>, click <strong>Activate</strong> and they get the app link.</li>
        </ol>
        <div style={{ marginTop: 10, fontSize: 11, color: "#475569" }}>
          We don't allow manual adds here — if an inspector isn't in JN, their job assignments and photo uploads won't sync, so JN has to come first.
        </div>
      </section>

      {/* List inspectors — grouped so the active ones are always at
          the top (you mostly come here to send guides / deactivate
          someone). Three buckets:
            • Active: in the field, currently dispatchable.
            • Ready to activate: setup done, just needs the flip.
            • Setup pending: still need to confirm their home address.
          Inside each bucket, sort by name (matches the DB query).
          Each group renders only when non-empty, so a clean state
          where everyone's active shows just one section. */}
      {(() => {
        const active = inspectors.filter((i) => i.active);
        const readyToActivate = inspectors.filter(
          (i) => !i.active && i.info_updated_at,
        );
        const setupPending = inspectors.filter(
          (i) => !i.active && !i.info_updated_at,
        );
        const renderGroup = (label, color, list, hint) => (
          <section
            key={label}
            style={{
              border: "1px solid #e5e7eb",
              borderRadius: 12,
              padding: 16,
              background: "#fff",
              marginBottom: 12,
            }}
          >
            <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 4 }}>
              <div style={{ fontSize: 14, fontWeight: 700, color }}>
                {label} ({list.length})
              </div>
            </div>
            {hint && (
              <div style={{ fontSize: 11, color: "#6b7280", marginBottom: 10 }}>{hint}</div>
            )}
            <div style={{ display: "grid", gap: 8 }}>
              {list.map((insp) => (
                <InspectorRow
                  key={insp.id}
                  insp={insp}
                  sendingEmail={sendingEmailId === insp.id}
                  onToggle={() => toggleActive(insp)}
                  onUpdate={(patch) => updateInspector(insp, patch)}
                  onDelete={() => deleteInspector(insp)}
                  onSendUpdateLink={() => sendUpdateLink(insp)}
                  onSendGuide={() => sendGuide(insp)}
                />
              ))}
            </div>
          </section>
        );
        if (loading) {
          return (
            <section style={{ border: "1px solid #e5e7eb", borderRadius: 12, padding: 16, background: "#fff" }}>
              <div style={{ fontSize: 13, color: "#6b7280" }}>Loading…</div>
            </section>
          );
        }
        if (inspectors.length === 0) {
          return (
            <section style={{ border: "1px solid #e5e7eb", borderRadius: 12, padding: 16, background: "#fff" }}>
              <div style={{ fontSize: 13, color: "#6b7280" }}>
                No inspectors yet — sync from JN above.
              </div>
            </section>
          );
        }
        return (
          <>
            {active.length > 0 && renderGroup(
              "⭐ Active inspectors",
              "#047857",
              active,
              "In the field. These show up in the inspector mobile app's picker.",
            )}
            {readyToActivate.length > 0 && renderGroup(
              "⏳ Ready to activate",
              "#92400e",
              readyToActivate,
              "Setup is complete — one click on Activate and they're live.",
            )}
            {setupPending.length > 0 && renderGroup(
              "🛠️ Setup pending",
              "#475569",
              setupPending,
              "Still need to confirm their home address. Send them the setup link to get them moving.",
            )}
          </>
        );
      })()}

      {/* Assignments moved to their own admin tile (📋 Assign
          Inspections). Keep this section as a one-line pointer so
          the manager knows where to find that flow now. */}
      <section style={{ border: "1px dashed #cbd5e1", borderRadius: 12, padding: 14, background: "#f8fafc" }}>
        <div style={{ fontSize: 13, color: "#475569" }}>
          🔁 Assigning or releasing pending inspections happens in <strong>Manager → 📋 Assign Inspections</strong>.
        </div>
      </section>
    </div>
  );
}

function InspectorRow({ insp, sendingEmail, onToggle, onUpdate, onDelete, onSendUpdateLink, onSendGuide }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({
    name: insp.name,
    email: insp.email ?? "",
    phone: insp.phone ?? "",
    latitude: insp.latitude ?? "",
    longitude: insp.longitude ?? "",
    max_distance_miles: insp.max_distance_miles ?? "",
  });
  const setupDone = !!insp.info_updated_at;
  // Phone is required to enable the setup link send — manager has to
  // add it via Edit first. Email-only isn't enough; we want the link
  // to text the inspector so it lands on their phone (which is where
  // the app will live).
  const hasContact = !!insp.phone;
  const canActivate = setupDone; // need home address confirmed before going live
  return (
    <div
      style={{
        padding: 10,
        background: insp.active ? "#fff" : "#f3f4f6",
        border: "1px solid #e5e7eb",
        borderRadius: 8,
        opacity: insp.active ? 1 : 0.7,
      }}
    >
      {!editing ? (
        <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 8, alignItems: "center" }}>
          <div>
            <div style={{ fontWeight: 700, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <span>{insp.name}</span>
              {!insp.active && <span style={{ fontSize: 10, color: "#6b7280" }}>(inactive)</span>}
              {setupDone ? (
                <span style={{ fontSize: 10, padding: "2px 8px", background: "#d1fae5", color: "#065f46", borderRadius: 999, fontWeight: 700 }}>
                  ✓ Setup complete
                </span>
              ) : (
                <span style={{ fontSize: 10, padding: "2px 8px", background: "#fef3c7", color: "#92400e", borderRadius: 999, fontWeight: 700 }}>
                  ⏳ Setup pending
                </span>
              )}
            </div>
            <div style={{ fontSize: 11, color: "#6b7280" }}>
              {insp.email && <>📧 {insp.email} · </>}
              {insp.phone && <>📱 {insp.phone} · </>}
              {insp.latitude != null && insp.longitude != null
                ? `📍 ${insp.latitude.toFixed(4)}, ${insp.longitude.toFixed(4)}`
                : "📍 No home base set"}
              {insp.max_distance_miles ? ` · max ${insp.max_distance_miles} mi` : " · no mile cap"}
            </div>
          </div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", justifyContent: "flex-end" }}>
            {onSendUpdateLink && (
              <button
                type="button"
                onClick={onSendUpdateLink}
                disabled={sendingEmail || !hasContact}
                style={{
                  ...secondaryBtn,
                  fontSize: 11,
                  background: !hasContact ? "#f3f4f6" : (setupDone ? "#fff" : "#fef3c7"),
                  borderColor: !hasContact ? "#e5e7eb" : (setupDone ? "#d1d5db" : "#fbbf24"),
                  opacity: !hasContact ? 0.55 : 1,
                  cursor: !hasContact ? "not-allowed" : "pointer",
                }}
                title={
                  !hasContact
                    ? "Add a phone number via Edit first"
                    : `Will SMS to ${insp.phone}`
                }
              >
                {sendingEmail
                  ? "Sending…"
                  : setupDone
                    ? "📧/📱 Send update email/text"
                    : "📧/📱 Send setup email/text"}
              </button>
            )}
            {/* Send field guide — only shown for active inspectors,
                disabled while another send is in flight. Re-sends the
                /inspector-guide/ link they already got at activation. */}
            {insp.active && onSendGuide && (
              <button
                type="button"
                onClick={onSendGuide}
                disabled={sendingEmail || !hasContact}
                style={{
                  ...secondaryBtn,
                  fontSize: 11,
                  background: !hasContact ? "#f3f4f6" : "#fff",
                  opacity: !hasContact ? 0.55 : 1,
                  cursor: !hasContact ? "not-allowed" : "pointer",
                }}
                title={
                  !hasContact
                    ? "Add a phone number via Edit first"
                    : `Re-send the field guide via ${insp.phone ? "SMS to " + insp.phone : "email to " + insp.email}`
                }
              >
                {sendingEmail ? "Sending…" : "📖 Send guide"}
              </button>
            )}
            <button
              type="button"
              onClick={onToggle}
              disabled={!insp.active && !canActivate}
              style={{
                ...secondaryBtn,
                fontSize: 11,
                opacity: !insp.active && !canActivate ? 0.55 : 1,
                cursor: !insp.active && !canActivate ? "not-allowed" : "pointer",
              }}
              title={
                insp.active
                  ? "Click to deactivate — the inspector's app link will stop working"
                  : !canActivate
                    ? "Inspector must confirm their home address first (Send setup email/text → they tap the link → submit address)"
                    : "Click to activate and text/email the app link"
              }
            >
              {insp.active ? "Deactivate" : "Activate"}
            </button>
            <button type="button" onClick={() => setEditing(true)} style={{ ...secondaryBtn, fontSize: 11 }}>
              Edit
            </button>
            <button type="button" onClick={onDelete} style={{ ...dangerBtn, fontSize: 11 }}>
              Delete
            </button>
          </div>
        </div>
      ) : (
        <div style={{ display: "grid", gap: 6 }}>
          <input
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            style={inputStyle}
            placeholder="Name"
          />
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
            <input
              type="email"
              value={draft.email}
              onChange={(e) => setDraft({ ...draft, email: e.target.value })}
              style={inputStyle}
              placeholder="Email"
            />
            <input
              type="tel"
              value={draft.phone}
              onChange={(e) => setDraft({ ...draft, phone: e.target.value })}
              style={inputStyle}
              placeholder="Phone (e.g. +18135551234)"
            />
          </div>
          <div style={{ fontSize: 11, color: "#6b7280", marginTop: -2 }}>
            Add the inspector's <b>phone number</b> here (email optional), then click <b>Send setup email/text</b> below. After the inspector confirms their address you'll be able to Activate them.
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6 }}>
            <input
              type="number"
              step="any"
              value={draft.latitude}
              onChange={(e) => setDraft({ ...draft, latitude: e.target.value })}
              style={inputStyle}
              placeholder="Latitude (auto-filled from setup)"
            />
            <input
              type="number"
              step="any"
              value={draft.longitude}
              onChange={(e) => setDraft({ ...draft, longitude: e.target.value })}
              style={inputStyle}
              placeholder="Longitude (auto-filled from setup)"
            />
            <input
              type="number"
              value={draft.max_distance_miles}
              onChange={(e) => setDraft({ ...draft, max_distance_miles: e.target.value })}
              style={inputStyle}
              placeholder="Max miles"
            />
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <button
              type="button"
              onClick={() => {
                const patch = {
                  name: draft.name.trim(),
                  email: draft.email.trim() || null,
                  phone: draft.phone.trim() || null,
                  latitude: draft.latitude !== "" ? parseFloat(draft.latitude) : null,
                  longitude: draft.longitude !== "" ? parseFloat(draft.longitude) : null,
                  max_distance_miles: draft.max_distance_miles !== "" ? parseInt(draft.max_distance_miles, 10) : null,
                };
                onUpdate(patch);
                setEditing(false);
              }}
              style={primaryBtn}
            >
              Save
            </button>
            <button type="button" onClick={() => setEditing(false)} style={secondaryBtn}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════
// INSPECTION ASSIGNMENTS — standalone manager tile for assigning /
// reassigning / releasing pending inspections. Lives in Manager →
// Assign Inspections. Self-contained: loads its own inspector roster
// and pending-job list so it doesn't depend on the InspectorsAdminPanel.
// ═════════════════════════════════════════════════════════════════════

export function InspectionAssignmentsPanel() {
  const [inspectors, setInspectors] = useState([]);
  const [jobs, setJobs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busyJobId, setBusyJobId] = useState(null);
  const [message, setMessage] = useState(null);

  async function loadAll() {
    setLoading(true);
    const [insRes, jobRes] = await Promise.all([
      supabase.from("inspectors").select("id, name, active").order("name"),
      // Don't select claimed_at here — the column may not exist yet
      // (the migration is per-deploy) and PostgREST 400s the whole
      // query if any column in select is missing. Reads can survive
      // without it; writes still set it (will surface in console if
      // the column is missing on the target DB).
      supabase
        .from("inspections")
        .select("id, client_name, address, city, signed_at, inspector_id, result")
        .is("result", null)
        .order("signed_at", { ascending: false })
        .limit(200),
    ]);
    if (insRes.error) setMessage({ kind: "error", text: `Loading inspectors: ${insRes.error.message}` });
    if (jobRes.error) setMessage({ kind: "error", text: `Loading pending inspections: ${jobRes.error.message}` });
    setInspectors(insRes.data || []);
    setJobs(jobRes.data || []);
    setLoading(false);
  }
  useEffect(() => { loadAll(); }, []);

  const inspectorById = useMemo(
    () => new Map(inspectors.map((i) => [i.id, i])),
    [inspectors],
  );

  async function reassign(jobId, newInspectorId) {
    setBusyJobId(jobId);
    // Try with claimed_at first (proper behavior). If the column
    // doesn't exist on this DB yet, fall back to a write that just
    // touches inspector_id so the assignment still works.
    const fullPatch = newInspectorId
      ? { inspector_id: newInspectorId, claimed_at: new Date().toISOString() }
      : { inspector_id: null, claimed_at: null };
    let { error } = await supabase
      .from("inspections")
      .update(fullPatch)
      .eq("id", jobId);
    if (error && /claimed_at/i.test(error.message || "")) {
      const minimal = { inspector_id: newInspectorId || null };
      ({ error } = await supabase
        .from("inspections")
        .update(minimal)
        .eq("id", jobId));
    }
    setBusyJobId(null);
    if (error) {
      setMessage({ kind: "error", text: error.message });
      return;
    }
    setMessage({
      kind: "success",
      text: newInspectorId
        ? `Assigned to ${inspectorById.get(newInspectorId)?.name || "inspector"}.`
        : "Released to the unassigned pool.",
    });
    loadAll();
  }

  if (loading) return <div style={{ padding: 16, color: "#6b7280" }}>Loading…</div>;

  const unassigned = jobs.filter((j) => !j.inspector_id);
  const assigned = jobs.filter((j) => j.inspector_id);

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div>
        <div style={{ fontSize: 18, fontWeight: 700, fontFamily: "'Oswald', sans-serif" }}>
          📋 Assign Inspections
        </div>
        <div style={{ fontSize: 12, color: "#6b7280", marginTop: 4, lineHeight: 1.5 }}>
          Every inspection that hasn't been completed. Use the dropdown to assign or change who has it. <strong>Release</strong> takes a job back and returns it to the unassigned pool — the next inspector with the area in range will see it on their Available list.
        </div>
      </div>

      {message && (
        <div
          style={{
            padding: "10px 14px",
            borderRadius: 10,
            fontSize: 13,
            background: message.kind === "success" ? "#ecfdf5" : "#fef2f2",
            border: `1px solid ${message.kind === "success" ? "#86efac" : "#fca5a5"}`,
            color: message.kind === "success" ? "#065f46" : "#991b1b",
          }}
        >
          {message.text}
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
        <div style={{ padding: 12, background: "#fff", border: "1px solid #e5e7eb", borderRadius: 10 }}>
          <div style={{ fontSize: 11, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.04em" }}>
            Pending total
          </div>
          <div style={{ fontSize: 24, fontWeight: 700, fontFamily: "'Oswald', sans-serif" }}>{jobs.length}</div>
        </div>
        <div style={{ padding: 12, background: "#fff", border: "1px solid #e5e7eb", borderRadius: 10 }}>
          <div style={{ fontSize: 11, color: "#92400e", textTransform: "uppercase", letterSpacing: "0.04em" }}>
            Unassigned
          </div>
          <div style={{ fontSize: 24, fontWeight: 700, fontFamily: "'Oswald', sans-serif", color: unassigned.length > 0 ? "#b45309" : "#111827" }}>
            {unassigned.length}
          </div>
        </div>
        <div style={{ padding: 12, background: "#fff", border: "1px solid #e5e7eb", borderRadius: 10 }}>
          <div style={{ fontSize: 11, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.04em" }}>
            Claimed
          </div>
          <div style={{ fontSize: 24, fontWeight: 700, fontFamily: "'Oswald', sans-serif" }}>{assigned.length}</div>
        </div>
      </div>

      {jobs.length === 0 ? (
        <div style={{ padding: 16, background: "#fff", border: "1px solid #e5e7eb", borderRadius: 10, fontSize: 13, color: "#6b7280" }}>
          No pending inspections — everything's either done or hasn't been signed up yet.
        </div>
      ) : (
        <div style={{ display: "grid", gap: 6 }}>
          {jobs.map((job) => {
            const ass = job.inspector_id ? inspectorById.get(job.inspector_id) : null;
            const isUnassigned = !job.inspector_id;
            return (
              <div
                key={job.id}
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr auto auto",
                  gap: 8,
                  alignItems: "center",
                  padding: "10px 12px",
                  background: isUnassigned ? "#fef3c7" : "#f9fafb",
                  border: isUnassigned ? "1px solid #fbbf24" : "1px solid #e5e7eb",
                  borderRadius: 8,
                  fontSize: 13,
                }}
              >
                <div>
                  <div style={{ fontWeight: 600 }}>{job.client_name || "(no name)"}</div>
                  <div style={{ fontSize: 11, color: "#6b7280" }}>
                    {job.address}, {job.city} ·{" "}
                    {isUnassigned ? (
                      <span style={{ color: "#92400e", fontWeight: 700 }}>⚠ Unassigned</span>
                    ) : (
                      <>claimed by <strong>{ass?.name || "(unknown)"}</strong></>
                    )}
                  </div>
                </div>
                <select
                  value={job.inspector_id || ""}
                  onChange={(e) => reassign(job.id, e.target.value || null)}
                  disabled={busyJobId === job.id}
                  style={{ ...inputStyle, padding: "6px 8px", fontSize: 12 }}
                >
                  <option value="">— {isUnassigned ? "Assign to…" : "Unassign"} —</option>
                  {inspectors.filter((i) => i.active).map((i) => (
                    <option key={i.id} value={i.id}>{i.name}</option>
                  ))}
                </select>
                {!isUnassigned && (
                  <button
                    type="button"
                    onClick={() => reassign(job.id, null)}
                    disabled={busyJobId === job.id}
                    style={{ ...secondaryBtn, padding: "6px 12px", fontSize: 11 }}
                  >
                    Release
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════
// MANAGER ROUTE PLANNER — pick an inspector, see their pending claims
// as a nearest-neighbor route either from their home base or from the
// manager's current GPS location. Tap-to-navigate hands the stop off
// to whatever maps app the manager has set as default.
// ═════════════════════════════════════════════════════════════════════

export function ManagerRoutePlanner() {
  const [inspectors, setInspectors] = useState([]);
  const [selectedId, setSelectedId] = useState("");
  const [jobs, setJobs] = useState([]);
  const [startMode, setStartMode] = useState("home"); // "home" | "current"
  const [currentCoords, setCurrentCoords] = useState(null);
  const [geoError, setGeoError] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      const { data } = await supabase
        .from("inspectors")
        .select("id, name, latitude, longitude, active")
        .order("name");
      if (cancelled) return;
      const list = data || [];
      setInspectors(list);
      // Auto-pick the first inspector that has any pending claims.
      // We figure that out after fetching jobs, below.
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!selectedId) {
      setJobs([]);
      return;
    }
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from("inspections")
        .select("id, client_name, address, city, state, zip, signed_at, latitude, longitude")
        .eq("inspector_id", selectedId)
        .is("result", null)
        .order("signed_at", { ascending: false })
        .limit(200);
      if (cancelled) return;
      setJobs(data || []);
    })();
    return () => { cancelled = true; };
  }, [selectedId]);

  function requestCurrentLocation() {
    setGeoError(null);
    if (!("geolocation" in navigator)) {
      setGeoError("This browser doesn't support GPS.");
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setCurrentCoords({ lat: pos.coords.latitude, lng: pos.coords.longitude });
        setStartMode("current");
      },
      (err) => setGeoError(err.message || "Couldn't get your location."),
      { enableHighAccuracy: true, timeout: 10000 },
    );
  }

  const inspector = inspectors.find((i) => i.id === selectedId) || null;

  // Resolve the start point. Falls back to home-then-null if current
  // wasn't acquired.
  let startLat = null;
  let startLng = null;
  let startLabel = "";
  if (startMode === "current" && currentCoords) {
    startLat = currentCoords.lat;
    startLng = currentCoords.lng;
    startLabel = "your current location";
  } else if (inspector && inspector.latitude != null && inspector.longitude != null) {
    startLat = inspector.latitude;
    startLng = inspector.longitude;
    startLabel = `${inspector.name}'s home base`;
  }

  const route = useMemo(() => {
    if (startLat == null || startLng == null) return jobs.map((j) => ({ ...j, _legDist: null }));
    return nearestNeighborRoute(jobs, startLat, startLng);
  }, [jobs, startLat, startLng]);

  const totalMiles = route.reduce((sum, j) => sum + (j._legDist || 0), 0);

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div>
        <div style={{ fontSize: 18, fontWeight: 700, fontFamily: "'Oswald', sans-serif" }}>
          🗺 Inspector Routes
        </div>
        <div style={{ fontSize: 12, color: "#6b7280", marginTop: 4, lineHeight: 1.5 }}>
          Pick an inspector to see their pending claims as a nearest-neighbor route. Start from the inspector's home base, or use the manager's current GPS location (handy when you're on-site with them). Tap any stop to open it in maps.
        </div>
      </div>

      {/* Inspector picker */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 8, alignItems: "center" }}>
        <select
          value={selectedId}
          onChange={(e) => setSelectedId(e.target.value)}
          style={{ ...inputStyle, padding: "8px 10px", fontSize: 13 }}
        >
          <option value="">— Pick an inspector —</option>
          {inspectors.map((i) => (
            <option key={i.id} value={i.id}>
              {i.name}{!i.active ? " (inactive)" : ""}
            </option>
          ))}
        </select>
      </div>

      {/* Start-point toggle */}
      {selectedId && (
        <div style={{
          padding: 10,
          background: "#fff",
          border: "1px solid #e5e7eb",
          borderRadius: 10,
          display: "grid",
          gap: 8,
        }}>
          <div style={{ fontSize: 12, color: "#374151" }}>
            🧭 Distances from <strong style={{ color: "#0e7490" }}>{startLabel || "(no start point — set inspector's home base or grant GPS)"}</strong>
          </div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <button
              type="button"
              onClick={() => setStartMode("home")}
              disabled={!inspector || inspector.latitude == null}
              style={{
                ...secondaryBtn,
                fontSize: 12,
                padding: "6px 12px",
                background: startMode === "home" ? "#0e7490" : "#fff",
                color: startMode === "home" ? "#fff" : "#374151",
                borderColor: startMode === "home" ? "#0e7490" : "#d1d5db",
                cursor: inspector?.latitude == null ? "not-allowed" : "pointer",
                opacity: inspector?.latitude == null ? 0.5 : 1,
              }}
              title={inspector?.latitude == null ? "Inspector has no home base set yet" : "Use the inspector's home base"}
            >
              🏠 From {inspector?.name || "inspector"}'s home
            </button>
            <button
              type="button"
              onClick={requestCurrentLocation}
              style={{
                ...secondaryBtn,
                fontSize: 12,
                padding: "6px 12px",
                background: startMode === "current" ? "#0e7490" : "#fff",
                color: startMode === "current" ? "#fff" : "#374151",
                borderColor: startMode === "current" ? "#0e7490" : "#d1d5db",
              }}
            >
              {startMode === "current" && currentCoords ? "📍 From here ✓" : "📍 Use my location"}
            </button>
          </div>
          {totalMiles > 0 && (
            <div style={{ fontSize: 11, color: "#6b7280" }}>
              ~{Math.round(totalMiles)} mi total drive · {route.length} stops
            </div>
          )}
          {geoError && (
            <div style={{ fontSize: 11, color: "#dc2626" }}>{geoError}</div>
          )}
        </div>
      )}

      {/* Route */}
      {!selectedId ? (
        <div style={{ padding: 16, background: "#fff", border: "1px solid #e5e7eb", borderRadius: 10, fontSize: 13, color: "#6b7280" }}>
          {loading ? "Loading inspectors…" : "Pick an inspector above to see their route."}
        </div>
      ) : jobs.length === 0 ? (
        <div style={{ padding: 16, background: "#fff", border: "1px solid #e5e7eb", borderRadius: 10, fontSize: 13, color: "#6b7280" }}>
          {inspector?.name || "This inspector"} has no pending claims right now.
        </div>
      ) : (
        <div style={{ display: "grid", gap: 6 }}>
          {route.map((job, i) => {
            const navHref = navigationUrl(job);
            return (
              <a
                key={job.id}
                href={navHref}
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  display: "grid",
                  gridTemplateColumns: "32px 1fr auto",
                  gap: 10,
                  alignItems: "center",
                  padding: "12px 14px",
                  background: "#fff",
                  border: "1px solid #e5e7eb",
                  borderRadius: 10,
                  textDecoration: "none",
                  color: "inherit",
                }}
              >
                <div style={{
                  width: 28,
                  height: 28,
                  borderRadius: "50%",
                  background: "#0e7490",
                  color: "#fff",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 13,
                  fontWeight: 700,
                }}>
                  {i + 1}
                </div>
                <div>
                  <div style={{ fontSize: 14, fontWeight: 600 }}>{job.client_name || "(no name)"}</div>
                  <div style={{ fontSize: 12, color: "#6b7280" }}>
                    {job.address}{job.city && `, ${job.city}`}{job.state && `, ${job.state}`} {job.zip || ""}
                  </div>
                </div>
                <div style={{ textAlign: "right" }}>
                  {job._legDist != null && (
                    <div style={{ fontSize: 12, color: "#0e7490", fontWeight: 700 }}>
                      {job._legDist.toFixed(1)} mi
                    </div>
                  )}
                  <div style={{ fontSize: 10, color: "#6b7280" }}>tap to navigate ↗</div>
                </div>
              </a>
            );
          })}
        </div>
      )}
    </div>
  );
}

// Color/label mapping for the inspection's PA workflow status pill
// shown on each row in the PA Handoff panel. Values come from the
// PA Ops Hub callback (signed/refused/pending) or null (not yet sent).
function paStatusPill(status) {
  switch ((status || "").toLowerCase()) {
    case "signed":  return { label: "✓ Signed by PA",     bg: "#d1fae5", color: "#065f46" };
    case "refused": return { label: "✗ Refused by PA",    bg: "#fee2e2", color: "#991b1b" };
    case "pending": return { label: "📤 Awaiting PA",      bg: "#fef3c7", color: "#92400e" };
    default:        return { label: "Not sent yet",        bg: "#f3f4f6", color: "#6b7280" };
  }
}

// ═════════════════════════════════════════════════════════════════════
// PA HANDOFF — manager tile for firing the PA Ops Hub submission
// against any damage inspection. Used to test the link AND as a
// manual retry / re-send path when the auto-fire on completion
// didn't go through for some reason (or for older damage records
// that pre-date the inspector flow).
// ═════════════════════════════════════════════════════════════════════
export function PAHandoffPanel() {
  const [inspections, setInspections] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState(null);
  // results: { [inspectionId]: { ok, body, ts } }
  const [results, setResults] = useState({});
  const [message, setMessage] = useState(null);
  // Inline-edit state for the row currently being patched (phone +
  // email + name + address). When editingId is set, the row swaps
  // its summary block for an editable form.
  const [editingId, setEditingId] = useState(null);
  const [editDraft, setEditDraft] = useState({});
  const [savingEdit, setSavingEdit] = useState(false);

  function startEditing(insp) {
    setEditDraft({
      client_name: insp.client_name || "",
      mobile: insp.mobile || "",
      email: insp.email || "",
      address: insp.address || "",
      city: insp.city || "",
      state: insp.state || "",
      zip: insp.zip || "",
    });
    setEditingId(insp.id);
  }

  async function saveEdit(id) {
    setSavingEdit(true);
    const patch = {
      client_name: editDraft.client_name.trim() || null,
      mobile: editDraft.mobile.trim() || null,
      email: editDraft.email.trim() || null,
      address: editDraft.address.trim() || null,
      city: editDraft.city.trim() || null,
      state: editDraft.state.trim() || null,
      zip: editDraft.zip.trim() || null,
    };
    const { error } = await supabase
      .from("inspections")
      .update(patch)
      .eq("id", id);
    setSavingEdit(false);
    if (error) {
      setMessage({ kind: "error", text: `Couldn't save: ${error.message}` });
      return;
    }
    setEditingId(null);
    setMessage({ kind: "success", text: "Saved." });
    load();
  }

  async function load() {
    setLoading(true);
    // Pull PA status fields too so each row shows where the file
    // currently is in the PA workflow. pa_status_notes carries any
    // free-text the PA's callback included with a Refused outcome.
    const { data, error } = await supabase
      .from("inspections")
      .select("id, client_name, address, city, state, zip, signed_at, result, result_at, jn_job_id, signed_pdfs, sales_rep_name, mobile, email, pa_status, pa_status_updated_at, pa_intake_sent_at, pa_status_notes")
      .eq("result", "damage")
      .order("result_at", { ascending: false, nullsFirst: false })
      .limit(200);
    if (error) {
      setMessage({ kind: "error", text: error.message });
    } else {
      setInspections(data || []);
    }
    setLoading(false);
  }
  useEffect(() => { load(); }, []);

  async function send(inspectionId) {
    setBusyId(inspectionId);
    setResults((prev) => ({ ...prev, [inspectionId]: { ok: null, body: { pending: true }, ts: new Date().toISOString() } }));
    try {
      const res = await fetch("/.netlify/functions/send-to-pa-ops-hub", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ inspectionId }),
      });
      const body = await res.json().catch(() => ({ error: "Could not parse response" }));
      const ok = res.ok && body.ok !== false;
      setResults((prev) => ({
        ...prev,
        [inspectionId]: { ok, status: res.status, body, ts: new Date().toISOString() },
      }));
      // Refresh the list so the row's PA status pill updates from
      // "Not sent" → "Awaiting PA" immediately on a successful send.
      if (ok) load();
    } catch (e) {
      setResults((prev) => ({
        ...prev,
        [inspectionId]: { ok: false, body: { error: e.message || "Network error" }, ts: new Date().toISOString() },
      }));
    }
    setBusyId(null);
  }

  if (loading) return <div style={{ padding: 16, color: "#6b7280" }}>Loading damage inspections…</div>;

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div>
        <div style={{ fontSize: 18, fontWeight: 700, fontFamily: "'Oswald', sans-serif" }}>
          📤 PA Handoff
        </div>
        <div style={{ fontSize: 12, color: "#6b7280", marginTop: 4, lineHeight: 1.5 }}>
          Every damage-result inspection. Click <strong>Send to PA</strong> to fire the PA Ops Hub submission — homeowner info + signed Free Roof Inspection PDF + every photo on the JN job. Use this to test the link, retry a failed auto-send, or hand off older damage records that pre-date the in-app inspector flow (their photos still live in JN, so the same path works).
        </div>
      </div>

      {message && (
        <div
          style={{
            padding: "10px 14px",
            borderRadius: 10,
            fontSize: 13,
            background: message.kind === "success" ? "#ecfdf5" : "#fef2f2",
            border: `1px solid ${message.kind === "success" ? "#86efac" : "#fca5a5"}`,
            color: message.kind === "success" ? "#065f46" : "#991b1b",
          }}
        >
          {message.text}
        </div>
      )}

      {inspections.length === 0 ? (
        <div style={{ padding: 16, background: "#fff", border: "1px solid #e5e7eb", borderRadius: 10, fontSize: 13, color: "#6b7280" }}>
          No damage inspections found.
        </div>
      ) : (
        <div style={{ display: "grid", gap: 8 }}>
          {inspections.map((insp) => {
            const result = results[insp.id];
            const hasPdf = !!insp.signed_pdfs?.insp;
            const hasJn = !!insp.jn_job_id;
            const hasPhone = !!(insp.mobile || insp.phone);
            // PA requires phone — without one their intake returns
            // 400 "homeowner_name, phone, and property_address are
            // required". Block the send and tell the manager.
            const canSend = hasPhone;
            const completedAt = insp.result_at ? new Date(insp.result_at).toLocaleString() : "(not stamped)";
            return (
              <div
                key={insp.id}
                style={{
                  padding: 14,
                  background: "#fff",
                  border: "1px solid #e5e7eb",
                  borderRadius: 10,
                  display: "grid",
                  gap: 8,
                }}
              >
                <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 8, alignItems: "flex-start" }}>
                  <div>
                    <div style={{ fontSize: 15, fontWeight: 700, display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                      <span>{insp.client_name || "(no name)"}</span>
                      {/* Inspection result pill — always "damage" since
                          the panel filters on that, but useful as a
                          visual confirmation. */}
                      <span style={{
                        fontSize: 10,
                        padding: "3px 8px",
                        background: "#fee2e2",
                        color: "#991b1b",
                        borderRadius: 999,
                        fontWeight: 700,
                        letterSpacing: "0.04em",
                        textTransform: "uppercase",
                      }}>
                        ⚠ {insp.result}
                      </span>
                      {/* PA workflow status pill — null / pending / signed / refused */}
                      {(() => {
                        const meta = paStatusPill(insp.pa_status);
                        return (
                          <span style={{
                            fontSize: 10,
                            padding: "3px 8px",
                            background: meta.bg,
                            color: meta.color,
                            borderRadius: 999,
                            fontWeight: 700,
                            letterSpacing: "0.04em",
                            textTransform: "uppercase",
                          }}>
                            {meta.label}
                          </span>
                        );
                      })()}
                    </div>
                    <div style={{ fontSize: 12, color: "#6b7280", marginTop: 2 }}>
                      📍 {insp.address}{insp.city && `, ${insp.city}`}{insp.state && `, ${insp.state}`} {insp.zip || ""}
                    </div>
                    {insp.mobile && (
                      <div style={{ fontSize: 12, color: "#6b7280" }}>📞 {insp.mobile}{insp.email && ` · ✉️ ${insp.email}`}</div>
                    )}
                    <div style={{ fontSize: 11, color: "#6b7280", marginTop: 4 }}>
                      Damage logged: {completedAt}{insp.sales_rep_name && ` · Rep: ${insp.sales_rep_name}`}
                    </div>
                    {/* PA workflow timeline */}
                    {(insp.pa_intake_sent_at || insp.pa_status_updated_at) && (
                      <div style={{ fontSize: 11, color: "#6b7280", marginTop: 2 }}>
                        {insp.pa_intake_sent_at && <>📤 Sent to PA: {new Date(insp.pa_intake_sent_at).toLocaleString()}</>}
                        {insp.pa_status_updated_at && (
                          <> · 🔄 PA updated: {new Date(insp.pa_status_updated_at).toLocaleString()}</>
                        )}
                        {insp.pa_status_notes && (
                          <div style={{ marginTop: 2, fontStyle: "italic" }}>PA note: "{insp.pa_status_notes}"</div>
                        )}
                      </div>
                    )}
                    <div style={{ fontSize: 11, color: "#6b7280", marginTop: 2, display: "flex", gap: 8, flexWrap: "wrap" }}>
                      <span style={{ color: hasPdf ? "#059669" : "#b45309" }}>{hasPdf ? "✓ Signed PDF" : "⚠ No signed PDF"}</span>
                      <span style={{ color: hasJn ? "#059669" : "#b45309" }}>{hasJn ? "✓ JN linked" : "⚠ No JN link"}</span>
                      <span style={{ color: hasPhone ? "#059669" : "#dc2626", fontWeight: hasPhone ? 400 : 700 }}>{hasPhone ? "✓ Phone" : "⚠ NO PHONE — PA will reject"}</span>
                    </div>
                  </div>
                  <div style={{ display: "grid", gap: 6, alignContent: "flex-start" }}>
                    <button
                      type="button"
                      onClick={() => send(insp.id)}
                      disabled={busyId === insp.id || !canSend}
                      title={!canSend ? "Can't send to PA without a phone number. Edit the record to add one, then try again." : undefined}
                      style={{
                        ...primaryBtn,
                        padding: "8px 14px",
                        fontSize: 12,
                        whiteSpace: "nowrap",
                        opacity: !canSend ? 0.5 : 1,
                        cursor: busyId === insp.id ? "wait" : (!canSend ? "not-allowed" : "pointer"),
                      }}
                    >
                      {busyId === insp.id ? "Sending…" : "📤 Send to PA"}
                    </button>
                    <button
                      type="button"
                      onClick={() => editingId === insp.id ? setEditingId(null) : startEditing(insp)}
                      style={{
                        ...secondaryBtn,
                        padding: "6px 12px",
                        fontSize: 11,
                        whiteSpace: "nowrap",
                      }}
                    >
                      {editingId === insp.id ? "Cancel edit" : "✏️ Edit"}
                    </button>
                  </div>
                </div>

                {editingId === insp.id && (
                  <div style={{
                    padding: 12,
                    background: "#f8fafc",
                    border: "1px solid #cbd5e1",
                    borderRadius: 8,
                    display: "grid",
                    gap: 8,
                  }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: "#0f172a" }}>
                      Fix any missing or wrong info, then save. Phone is required by the PA — without it the send button stays disabled.
                    </div>
                    <input
                      value={editDraft.client_name}
                      onChange={(e) => setEditDraft({ ...editDraft, client_name: e.target.value })}
                      style={inputStyle}
                      placeholder="Homeowner name"
                    />
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
                      <input
                        type="tel"
                        value={editDraft.mobile}
                        onChange={(e) => setEditDraft({ ...editDraft, mobile: e.target.value })}
                        style={{
                          ...inputStyle,
                          borderColor: !editDraft.mobile.trim() ? "#dc2626" : "#d1d5db",
                          background: !editDraft.mobile.trim() ? "#fef2f2" : "#fff",
                        }}
                        placeholder="Phone (required by PA)"
                      />
                      <input
                        type="email"
                        value={editDraft.email}
                        onChange={(e) => setEditDraft({ ...editDraft, email: e.target.value })}
                        style={inputStyle}
                        placeholder="Email (optional)"
                      />
                    </div>
                    <input
                      value={editDraft.address}
                      onChange={(e) => setEditDraft({ ...editDraft, address: e.target.value })}
                      style={inputStyle}
                      placeholder="Street address"
                    />
                    <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr", gap: 6 }}>
                      <input
                        value={editDraft.city}
                        onChange={(e) => setEditDraft({ ...editDraft, city: e.target.value })}
                        style={inputStyle}
                        placeholder="City"
                      />
                      <input
                        value={editDraft.state}
                        onChange={(e) => setEditDraft({ ...editDraft, state: e.target.value })}
                        style={inputStyle}
                        placeholder="State"
                        maxLength={2}
                      />
                      <input
                        value={editDraft.zip}
                        onChange={(e) => setEditDraft({ ...editDraft, zip: e.target.value })}
                        style={inputStyle}
                        placeholder="ZIP"
                      />
                    </div>
                    <div style={{ display: "flex", gap: 6 }}>
                      <button
                        type="button"
                        onClick={() => saveEdit(insp.id)}
                        disabled={savingEdit}
                        style={{ ...primaryBtn, padding: "8px 16px", fontSize: 12, cursor: savingEdit ? "wait" : "pointer" }}
                      >
                        {savingEdit ? "Saving…" : "Save"}
                      </button>
                      <button
                        type="button"
                        onClick={() => setEditingId(null)}
                        disabled={savingEdit}
                        style={{ ...secondaryBtn, padding: "8px 16px", fontSize: 12 }}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}

                {result && !result.body?.pending && (
                  <div style={{
                    padding: "10px 12px",
                    background: result.ok ? "#ecfdf5" : "#fef2f2",
                    border: `1px solid ${result.ok ? "#86efac" : "#fca5a5"}`,
                    borderRadius: 8,
                    fontSize: 12,
                  }}>
                    <div style={{ fontWeight: 700, color: result.ok ? "#065f46" : "#991b1b", marginBottom: 4 }}>
                      {result.ok ? "✓ Sent to PA Ops Hub" : "✗ Send failed"}
                      <span style={{ fontWeight: 400, color: "#6b7280", marginLeft: 8 }}>
                        {new Date(result.ts).toLocaleTimeString()}
                      </span>
                    </div>
                    <pre style={{
                      margin: 0,
                      whiteSpace: "pre-wrap",
                      wordBreak: "break-word",
                      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                      fontSize: 11,
                      color: result.ok ? "#065f46" : "#991b1b",
                    }}>
                      {JSON.stringify(result.body, null, 2)}
                    </pre>
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

// ═════════════════════════════════════════════════════════════════════
// MOBILE APP — inspector-side. Self-serve.
// ═════════════════════════════════════════════════════════════════════

export function InspectorMobileApp() {
  // No escape hatch to the rep main app — inspectors should only see
  // the inspector page. Any future inspector-only utilities should be
  // linked from inside this page.
  const [stage, setStage] = useState("pick"); // pick | list | detail | inactive
  const [inspectors, setInspectors] = useState([]);
  const [me, setMe] = useState(null);
  // When the inspector's stored ID points to a row that is no longer
  // active (or never completed setup), we show a friendly "account
  // not active" screen instead of dumping them to an empty picker.
  const [inactiveName, setInactiveName] = useState("");
  useEffect(() => {
    // Only show active inspectors who've completed setup (have a home
    // base lat/lng saved). Partial setups don't appear in the picker
    // so an inspector can't sign in before the manager activates them
    // AND they've confirmed their address.
    supabase
      .from("inspectors")
      .select("*")
      .eq("active", true)
      .not("info_updated_at", "is", null)
      .order("name")
      .then(async ({ data }) => {
      const list = data || [];
      setInspectors(list);
      const stored = localStorage.getItem("ccg_inspector_id");
      if (!stored) return;
      const found = list.find((i) => i.id === stored);
      if (found) {
        setMe(found);
        setStage("list");
        return;
      }
      // Stored ID is NOT in the active+setup-done list. Look up the
      // actual row to figure out why so we can tell them why their
      // link stopped working.
      const { data: raw } = await supabase
        .from("inspectors")
        .select("id,name,active,info_updated_at")
        .eq("id", stored)
        .maybeSingle();
      if (raw) {
        setInactiveName(raw.name || "");
        setStage("inactive");
      }
      // If the row was deleted entirely, fall through to the normal
      // picker — they can pick a different inspector if needed.
    });
  }, []);

  function pickMe(insp) {
    setMe(insp);
    localStorage.setItem("ccg_inspector_id", insp.id);
    setStage("list");
  }

  function signOut() {
    localStorage.removeItem("ccg_inspector_id");
    setMe(null);
    setInactiveName("");
    setStage("pick");
  }

  return (
    <div style={{
      maxWidth: 480,
      margin: "0 auto",
      padding: 16,
      fontFamily: "'Nunito', sans-serif",
      minHeight: "100vh",
      background: "#f9fafb",
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <div style={{ fontSize: 22, fontWeight: 700, fontFamily: "'Oswald', sans-serif" }}>
          🔍 Inspector
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          {me && (
            <button type="button" onClick={signOut} style={{ ...secondaryBtn, fontSize: 11 }}>
              Switch user
            </button>
          )}
        </div>
      </div>

      {stage === "inactive" && (
        <div style={{
          padding: 24,
          background: "#fff",
          border: "1px solid #fca5a5",
          borderRadius: 12,
          textAlign: "center",
        }}>
          <div style={{ fontSize: 32, marginBottom: 8 }}>🚫</div>
          <div style={{ fontSize: 16, fontWeight: 700, color: "#991b1b", marginBottom: 6 }}>
            {inactiveName ? `Hi ${inactiveName} —` : "Hi —"} your inspector account is not active.
          </div>
          <div style={{ fontSize: 13, color: "#64748b", marginBottom: 16 }}>
            Your manager has either deactivated you or your setup is incomplete.
            Contact your manager to get reactivated.
          </div>
          <button type="button" onClick={signOut} style={{ ...secondaryBtn, fontSize: 12 }}>
            Sign out
          </button>
        </div>
      )}

      {stage === "pick" && (
        <InspectorPickName inspectors={inspectors} onPick={pickMe} />
      )}

      {stage === "list" && me && (
        <InspectorJobList
          me={me}
          onOpenJob={(jobId) => setStage({ kind: "detail", jobId })}
          onOpenReports={() => setStage("reports")}
        />
      )}

      {stage && stage.kind === "detail" && me && (
        <InspectorJobDetail
          me={me}
          jobId={stage.jobId}
          onBack={() => setStage("list")}
        />
      )}

      {stage === "reports" && me && (
        <InspectorReports me={me} onBack={() => setStage("list")} />
      )}
    </div>
  );
}

function InspectorPickName({ inspectors, onPick }) {
  if (inspectors.length === 0) {
    return (
      <div style={{ padding: 24, textAlign: "center", color: "#6b7280" }}>
        No inspectors set up yet. Ask the manager to add you on the Inspectors page.
      </div>
    );
  }
  return (
    <div>
      <div style={{ fontSize: 14, color: "#6b7280", marginBottom: 12 }}>
        Tap your name to continue.
      </div>
      <div style={{ display: "grid", gap: 8 }}>
        {inspectors.map((i) => (
          <button
            key={i.id}
            type="button"
            onClick={() => onPick(i)}
            style={{
              padding: 16,
              fontSize: 16,
              fontWeight: 700,
              background: "#fff",
              border: "2px solid #e5e7eb",
              borderRadius: 12,
              textAlign: "left",
              cursor: "pointer",
            }}
          >
            👷 {i.name}
            <div style={{ fontSize: 11, color: "#6b7280", fontWeight: 400, marginTop: 2 }}>
              {i.latitude != null && i.longitude != null
                ? `Home base: ${i.latitude.toFixed(3)}, ${i.longitude.toFixed(3)}`
                : "No home base set"}
              {i.max_distance_miles ? ` · max ${i.max_distance_miles} mi` : ""}
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

// Nearest-neighbor TSP for ordering a daily route. Good enough for the
// typical 5-15 stops an inspector handles in a day — sub-second
// client-side, no external API. Within ~25% of the optimal route in
// practice, which beats a random / signed-date-ordered list every time.
//
// startLat/Lng = where the route begins (home base or current location).
// jobs = array of { latitude, longitude, ... }.
// Returns the input list re-ordered.
// Tap-to-navigate URL. Use the ADDRESS as the destination (more
// reliable than raw lat/lng — Maps couldn't always reverse-geocode
// our coords into a navigable address, leaving inspectors with a
// dropped pin and no route). Coords are kept as the fallback if
// no address is on the row at all. The official directions URL
// (maps/dir/?api=1&destination=…) opens straight into the
// directions screen on iOS Apple Maps + Android Google Maps.
function navigationUrl(job) {
  const address = [job.address, job.city, job.state, job.zip].filter(Boolean).join(", ");
  if (address) return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(address)}`;
  if (typeof job.latitude === "number" && typeof job.longitude === "number") {
    return `https://www.google.com/maps/dir/?api=1&destination=${job.latitude},${job.longitude}`;
  }
  return "https://www.google.com/maps";
}

function nearestNeighborRoute(jobs, startLat, startLng) {
  if (typeof startLat !== "number" || typeof startLng !== "number") return jobs;
  const withCoords = jobs.filter((j) => typeof j.latitude === "number" && typeof j.longitude === "number");
  const withoutCoords = jobs.filter((j) => typeof j.latitude !== "number" || typeof j.longitude !== "number");
  const remaining = [...withCoords];
  const route = [];
  let curLat = startLat;
  let curLng = startLng;
  while (remaining.length > 0) {
    let bestIdx = 0;
    let bestDist = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const j = remaining[i];
      const d = milesBetween(curLat, curLng, j.latitude, j.longitude);
      if (d != null && d < bestDist) {
        bestDist = d;
        bestIdx = i;
      }
    }
    const picked = remaining.splice(bestIdx, 1)[0];
    route.push({ ...picked, _legDist: bestDist });
    curLat = picked.latitude;
    curLng = picked.longitude;
  }
  // Stops without coordinates go to the end — admin can geocode them
  // later, they're not skippable but aren't routable yet either.
  return [...route, ...withoutCoords];
}

function InspectorJobList({ me, onOpenJob, onOpenReports }) {
  const [jobs, setJobs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [claimingId, setClaimingId] = useState(null);
  // Route view state — two independent dials:
  //   startMode = "home" | "current"   (where distances/route start)
  //   optimize  = boolean              (route-optimize claimed jobs)
  // Distances on every card are always computed from the active start
  // point. Optimization only affects the "In progress" sort order.
  const [startMode, setStartMode] = useState("home");
  const [optimize, setOptimize] = useState(false);
  const [currentCoords, setCurrentCoords] = useState(null);
  const [geoError, setGeoError] = useState(null);

  async function load() {
    setLoading(true);
    // Fetch inspections needing inspection (result IS NULL).
    // - Mine: inspector_id = me.id
    // - Available: inspector_id IS NULL (regardless of distance — we
    //   filter client-side so we can sort by distance and apply the
    //   inspector's max-miles cap).
    const { data } = await supabase
      .from("inspections")
      .select(
        "id, client_name, address, city, state, zip, signed_at, sales_rep_name, " +
          "latitude, longitude, inspector_id, result",
      )
      .is("result", null)
      .order("signed_at", { ascending: false })
      .limit(500);
    setJobs(data || []);
    setLoading(false);
  }
  useEffect(() => { load(); }, []);

  const { mine, available, totalRouteMiles, startLabel } = useMemo(() => {
    // Resolve the active start point — the GPS-or-home location every
    // distance is measured FROM. Drives both sections.
    let startLat = null;
    let startLng = null;
    let startLabel = "your home base";
    if (startMode === "current" && currentCoords) {
      startLat = currentCoords.lat;
      startLng = currentCoords.lng;
      startLabel = "your current location";
    } else if (me.latitude != null && me.longitude != null) {
      startLat = me.latitude;
      startLng = me.longitude;
    }
    const mine = [];
    const available = [];
    for (const j of jobs) {
      const dist =
        startLat != null && startLng != null &&
        typeof j.latitude === "number" && typeof j.longitude === "number"
          ? milesBetween(startLat, startLng, j.latitude, j.longitude)
          : null;
      const enriched = { ...j, _dist: dist };
      if (j.inspector_id === me.id) mine.push(enriched);
      else if (!j.inspector_id) available.push(enriched);
    }
    // Available: sort by distance from start point.
    available.sort((a, b) => {
      if (a._dist == null && b._dist == null) return 0;
      if (a._dist == null) return 1;
      if (b._dist == null) return -1;
      return a._dist - b._dist;
    });
    const cap = me.max_distance_miles;
    const availFiltered = cap
      ? available.filter((j) => j._dist == null || j._dist <= cap)
      : available;

    // Mine: optimize toggle decides between signed-date and TSP order.
    let orderedMine;
    let totalRouteMiles = null;
    if (optimize && startLat != null && startLng != null) {
      orderedMine = nearestNeighborRoute(mine, startLat, startLng);
      totalRouteMiles = orderedMine.reduce((sum, j) => sum + (j._legDist || 0), 0);
    } else {
      orderedMine = [...mine].sort((a, b) => new Date(b.signed_at) - new Date(a.signed_at));
    }
    return { mine: orderedMine, available: availFiltered, totalRouteMiles, startLabel };
  }, [jobs, me, startMode, currentCoords, optimize]);

  // Ask the browser for the inspector's current location. Cached for
  // the session; user is prompted once.
  function requestCurrentLocation() {
    setGeoError(null);
    if (!("geolocation" in navigator)) {
      setGeoError("This browser doesn't support GPS.");
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setCurrentCoords({ lat: pos.coords.latitude, lng: pos.coords.longitude });
        setStartMode("current");
      },
      (err) => {
        setGeoError(err.message || "Couldn't get your location.");
        // Fall back to home-base start.
        setStartMode("home");
      },
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 },
    );
  }

  async function claim(jobId) {
    setClaimingId(jobId);
    // claimed_at stamps when the inspector picked it up. The nightly
    // check-stale-claims cron uses this: if a claim is still pending
    // (result IS NULL) when the day ends, the inspection is auto-
    // unclaimed and the manager gets an SMS.
    //
    // The claimed_at column might not exist on every DB yet (it's
    // a per-deploy migration). If the write 400s on that column,
    // retry without it so the claim still goes through.
    let { error } = await supabase
      .from("inspections")
      .update({ inspector_id: me.id, claimed_at: new Date().toISOString() })
      .eq("id", jobId)
      .is("inspector_id", null);
    if (error && /claimed_at/i.test(error.message || "")) {
      ({ error } = await supabase
        .from("inspections")
        .update({ inspector_id: me.id })
        .eq("id", jobId)
        .is("inspector_id", null));
    }
    setClaimingId(null);
    if (error) {
      alert("Couldn't claim: " + error.message);
      return;
    }
    load();
  }

  if (loading) return <div style={{ padding: 16, color: "#6b7280" }}>Loading…</div>;

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div style={{
        padding: 12,
        background: "#fff",
        borderRadius: 10,
        border: "1px solid #e5e7eb",
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        gap: 8,
      }}>
        <div>
          <div style={{ fontSize: 14, color: "#6b7280" }}>Signed in as</div>
          <div style={{ fontSize: 18, fontWeight: 700 }}>👷 {me.name}</div>
        </div>
        {onOpenReports && (
          <button
            type="button"
            onClick={onOpenReports}
            style={{ ...secondaryBtn, fontSize: 12, padding: "8px 12px", whiteSpace: "nowrap" }}
          >
            📊 Reports
          </button>
        )}
      </div>

      {/* Shared route-mode toggle bar — affects BOTH sections.
          Distances on every card, the sort order of "Available near
          you", and (when optimize is on) the nearest-neighbor order
          in "In progress" all use whichever start point is selected. */}
      {(mine.length > 0 || available.length > 0) && (
        <div style={{
          padding: 10,
          background: "#fff",
          border: "1px solid #e5e7eb",
          borderRadius: 10,
          display: "grid",
          gap: 8,
        }}>
          <div style={{ fontSize: 12, color: "#374151" }}>
            🧭 Distances from <strong style={{ color: "#0e7490" }}>{startLabel}</strong>
          </div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <RouteBtn
              active={startMode === "home"}
              onClick={() => setStartMode("home")}
              label="🏠 From home"
              disabled={me.latitude == null}
            />
            <RouteBtn
              active={startMode === "current"}
              onClick={requestCurrentLocation}
              label={startMode === "current" && currentCoords ? "📍 From here ✓" : "📍 Use my location"}
            />
            {mine.length > 1 && (
              <RouteBtn
                active={optimize}
                onClick={() => setOptimize(!optimize)}
                label={optimize ? "✓ Route optimized" : "🧭 Optimize my route"}
              />
            )}
          </div>
          {totalRouteMiles != null && (
            <div style={{ fontSize: 11, color: "#6b7280" }}>
              Optimized order — ~{Math.round(totalRouteMiles)} mi total drive
            </div>
          )}
          {geoError && (
            <div style={{ fontSize: 11, color: "#dc2626" }}>
              {geoError}
            </div>
          )}
        </div>
      )}

      <section>
        <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8, fontFamily: "'Oswald', sans-serif" }}>
          🛠 In progress — assigned to you ({mine.length})
        </div>
        {mine.length === 0 ? (
          <div style={{ padding: 12, background: "#fff", borderRadius: 10, fontSize: 12, color: "#6b7280", border: "1px solid #e5e7eb" }}>
            No jobs claimed. Tap one below to start.
          </div>
        ) : (
          <div style={{ display: "grid", gap: 6 }}>
            {mine.map((j, i) => (
              <JobCard
                key={j.id}
                job={j}
                accent="#0ea5e9"
                onClick={() => onOpenJob(j.id)}
                cta="Open →"
                showStopNumber={optimize ? i + 1 : null}
                showNavigate
              />
            ))}
          </div>
        )}
      </section>

      <section>
        <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8, fontFamily: "'Oswald', sans-serif" }}>
          📍 Available near you ({available.length})
          {me.max_distance_miles && (
            <span style={{ fontSize: 11, color: "#6b7280", fontWeight: 400, marginLeft: 6 }}>
              (capped at {me.max_distance_miles} mi)
            </span>
          )}
        </div>
        {available.length === 0 ? (
          <div style={{ padding: 12, background: "#fff", borderRadius: 10, fontSize: 12, color: "#6b7280", border: "1px solid #e5e7eb" }}>
            No available jobs right now. New inspections will appear here automatically.
          </div>
        ) : (
          <div style={{ display: "grid", gap: 6 }}>
            {available.map((j) => (
              <JobCard
                key={j.id}
                job={j}
                accent="#059669"
                cta={claimingId === j.id ? "Claiming…" : "✋ Claim"}
                onClick={() => claim(j.id)}
                disabled={claimingId !== null}
                showNavigate
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function RouteBtn({ active, onClick, label, disabled }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        padding: "6px 10px",
        background: active ? "#0e7490" : "#fff",
        color: active ? "#fff" : "#374151",
        border: `1px solid ${active ? "#0e7490" : "#d1d5db"}`,
        borderRadius: 999,
        fontSize: 11,
        fontWeight: 700,
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.5 : 1,
      }}
    >
      {label}
    </button>
  );
}

function JobCard({ job, accent, cta, onClick, disabled, showStopNumber, showNavigate }) {
  const navUrl = navigationUrl(job);
  return (
    <div style={{
      background: "#fff",
      border: `1px solid ${accent}33`,
      borderLeft: `4px solid ${accent}`,
      borderRadius: 10,
      padding: 12,
      display: "grid",
      gridTemplateColumns: showStopNumber != null ? "auto 1fr auto" : "1fr auto",
      gap: 10,
      alignItems: "center",
    }}>
      {showStopNumber != null && (
        <div style={{
          width: 32,
          height: 32,
          borderRadius: 999,
          background: accent,
          color: "#fff",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontWeight: 700,
          fontSize: 14,
          flexShrink: 0,
        }}>
          {showStopNumber}
        </div>
      )}
      <div>
        <div style={{ fontWeight: 700, fontSize: 14 }}>{job.client_name || "(no name)"}</div>
        <div style={{ fontSize: 12, color: "#6b7280" }}>
          {job.address}{job.city ? `, ${job.city}` : ""}
        </div>
        <div style={{ fontSize: 11, color: "#9ca3af", marginTop: 2 }}>
          {job.sales_rep_name ? `Rep: ${job.sales_rep_name}` : ""}
          {job._dist != null ? ` · ${Math.round(job._dist)} mi` : ""}
          {job._legDist != null ? ` (next leg ${Math.round(job._legDist)} mi)` : ""}
          {job.signed_at ? ` · ${new Date(job.signed_at).toLocaleDateString()}` : ""}
        </div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 4, alignItems: "stretch" }}>
        <button
          type="button"
          onClick={onClick}
          disabled={disabled}
          style={{
            padding: "8px 14px",
            background: accent,
            color: "#fff",
            border: "none",
            borderRadius: 8,
            fontWeight: 700,
            fontSize: 13,
            cursor: disabled ? "not-allowed" : "pointer",
            opacity: disabled ? 0.6 : 1,
          }}
        >
          {cta}
        </button>
        {showNavigate && (
          <a
            href={navUrl}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              padding: "6px 12px",
              background: "#fff",
              color: "#374151",
              border: "1px solid #d1d5db",
              borderRadius: 8,
              fontWeight: 600,
              fontSize: 11,
              textAlign: "center",
              textDecoration: "none",
            }}
          >
            🗺️ Navigate
          </a>
        )}
      </div>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════
// REPORTS — per-inspector roll-up of their own completed inspections.
// Visible only inside the inspector mobile app (tap "📊 Reports" on
// the job list). Filters by date range and breaks down by status
// (damage / no_damage / retail) and by day.
// ═════════════════════════════════════════════════════════════════════

function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}
function startOfWeek(d) {
  // Monday-based week (work-week convention — matches the rest of the
  // codebase's report logic in App.jsx). For today's date, returns
  // Monday at local 00:00. If today IS Monday, returns today.
  const x = startOfDay(d);
  const day = x.getDay(); // 0=Sun, 1=Mon, ..., 6=Sat
  // For Mon-based: Sunday = 6 days back, Monday = 0, Tuesday = 1, etc.
  const offset = day === 0 ? 6 : day - 1;
  x.setDate(x.getDate() - offset);
  return x;
}
function dayKey(d) {
  // Local-date YYYY-MM-DD for grouping.
  const x = new Date(d);
  const y = x.getFullYear();
  const m = String(x.getMonth() + 1).padStart(2, "0");
  const day = String(x.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function fmtShort(d) {
  return new Date(d).toLocaleDateString(undefined, { weekday: "short", month: "numeric", day: "numeric" });
}

const STATUS_META = {
  damage:    { label: "Damage",    color: "#dc2626", bg: "#fee2e2", emoji: "⚠️" },
  no_damage: { label: "No Damage", color: "#16a34a", bg: "#dcfce7", emoji: "✅" },
  retail:    { label: "Retail",    color: "#b45309", bg: "#fef3c7", emoji: "🏠" },
};

function InspectorReports({ me, onBack }) {
  // range: "this_week" | "last_week" | "last_30"
  const [range, setRange] = useState("this_week");
  const [rows, setRows] = useState([]);
  const [pendingCount, setPendingCount] = useState(0);
  const [loading, setLoading] = useState(true);

  const { fromIso, toIso, label } = useMemo(() => {
    const now = new Date();
    let from, to;
    let label = "";
    if (range === "this_week") {
      from = startOfWeek(now);
      to = new Date();
      label = "This week";
    } else if (range === "last_week") {
      const thisWeekStart = startOfWeek(now);
      to = new Date(thisWeekStart);
      from = new Date(thisWeekStart);
      from.setDate(from.getDate() - 7);
      label = "Last week";
    } else {
      to = new Date();
      from = new Date();
      from.setDate(from.getDate() - 30);
      label = "Last 30 days";
    }
    return { fromIso: from.toISOString(), toIso: to.toISOString(), label };
  }, [range]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      // Completed inspections (this inspector, has a result, within range).
      const completed = await supabase
        .from("inspections")
        .select("id, client_name, address, result, result_at")
        .eq("inspector_id", me.id)
        .not("result", "is", null)
        .gte("result_at", fromIso)
        .lte("result_at", toIso)
        .order("result_at", { ascending: false })
        .limit(2000);
      // Pending (assigned but no result yet) — snapshot, independent of date range.
      const pending = await supabase
        .from("inspections")
        .select("id", { count: "exact", head: true })
        .eq("inspector_id", me.id)
        .is("result", null);
      if (cancelled) return;
      setRows(completed.data || []);
      setPendingCount(pending.count || 0);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [me.id, fromIso, toIso]);

  // Aggregate by status + by day.
  const { byStatus, byDay, total } = useMemo(() => {
    const byStatus = { damage: 0, no_damage: 0, retail: 0 };
    const byDay = new Map(); // dayKey -> { date, total, damage, no_damage, retail }
    for (const r of rows) {
      if (byStatus[r.result] != null) byStatus[r.result]++;
      const k = dayKey(r.result_at);
      const existing = byDay.get(k) || { date: r.result_at, total: 0, damage: 0, no_damage: 0, retail: 0 };
      existing.total++;
      if (existing[r.result] != null) existing[r.result]++;
      byDay.set(k, existing);
    }
    const dayList = Array.from(byDay.values()).sort(
      (a, b) => new Date(b.date) - new Date(a.date),
    );
    return { byStatus, byDay: dayList, total: rows.length };
  }, [rows]);

  const maxDayTotal = Math.max(1, ...byDay.map((d) => d.total));

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
        <button type="button" onClick={onBack} style={{ ...secondaryBtn, fontSize: 12 }}>
          ← Back to jobs
        </button>
        <div style={{ fontSize: 18, fontWeight: 700, fontFamily: "'Oswald', sans-serif" }}>
          📊 Reports
        </div>
      </div>

      {/* Date range picker */}
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {[
          { key: "this_week", label: "This week" },
          { key: "last_week", label: "Last week" },
          { key: "last_30",   label: "Last 30 days" },
        ].map((r) => (
          <button
            key={r.key}
            type="button"
            onClick={() => setRange(r.key)}
            style={{
              ...secondaryBtn,
              fontSize: 12,
              padding: "6px 12px",
              background: range === r.key ? "#0e7490" : "#fff",
              color: range === r.key ? "#fff" : "#374151",
              borderColor: range === r.key ? "#0e7490" : "#d1d5db",
            }}
          >
            {r.label}
          </button>
        ))}
      </div>

      {loading ? (
        <div style={{ padding: 16, color: "#6b7280" }}>Loading…</div>
      ) : (
        <>
          {/* Totals */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            <div style={{ padding: 14, background: "#fff", border: "1px solid #e5e7eb", borderRadius: 10 }}>
              <div style={{ fontSize: 11, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.04em" }}>
                Completed
              </div>
              <div style={{ fontSize: 28, fontWeight: 700, fontFamily: "'Oswald', sans-serif" }}>
                {total}
              </div>
              <div style={{ fontSize: 11, color: "#6b7280" }}>{label}</div>
            </div>
            <div style={{ padding: 14, background: "#fff", border: "1px solid #e5e7eb", borderRadius: 10 }}>
              <div style={{ fontSize: 11, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.04em" }}>
                Pending now
              </div>
              <div style={{ fontSize: 28, fontWeight: 700, fontFamily: "'Oswald', sans-serif", color: pendingCount > 0 ? "#b45309" : "#111827" }}>
                {pendingCount}
              </div>
              <div style={{ fontSize: 11, color: "#6b7280" }}>Assigned, no result yet</div>
            </div>
          </div>

          {/* By status */}
          <section style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 10, padding: 14 }}>
            <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 10, fontFamily: "'Oswald', sans-serif" }}>
              By result
            </div>
            <div style={{ display: "grid", gap: 8 }}>
              {["damage", "no_damage", "retail"].map((status) => {
                const meta = STATUS_META[status];
                const count = byStatus[status];
                const pct = total > 0 ? Math.round((count / total) * 100) : 0;
                return (
                  <div key={status} style={{ display: "grid", gridTemplateColumns: "auto 1fr auto", gap: 10, alignItems: "center" }}>
                    <div style={{
                      fontSize: 12,
                      fontWeight: 700,
                      color: meta.color,
                      background: meta.bg,
                      padding: "4px 10px",
                      borderRadius: 999,
                      whiteSpace: "nowrap",
                    }}>
                      {meta.emoji} {meta.label}
                    </div>
                    <div style={{ height: 8, background: "#f3f4f6", borderRadius: 999, overflow: "hidden" }}>
                      <div style={{ width: `${pct}%`, height: "100%", background: meta.color, transition: "width 0.3s" }} />
                    </div>
                    <div style={{ fontSize: 12, color: "#374151", minWidth: 56, textAlign: "right" }}>
                      {count} · {pct}%
                    </div>
                  </div>
                );
              })}
            </div>
            {total === 0 && (
              <div style={{ fontSize: 12, color: "#6b7280", marginTop: 8 }}>
                No completed inspections in this range.
              </div>
            )}
          </section>

          {/* By day */}
          <section style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 10, padding: 14 }}>
            <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 10, fontFamily: "'Oswald', sans-serif" }}>
              By day
            </div>
            {byDay.length === 0 ? (
              <div style={{ fontSize: 12, color: "#6b7280" }}>
                No completed inspections in this range.
              </div>
            ) : (
              <div style={{ display: "grid", gap: 6 }}>
                {byDay.map((d) => {
                  const pct = Math.round((d.total / maxDayTotal) * 100);
                  return (
                    <div key={d.date} style={{ display: "grid", gridTemplateColumns: "90px 1fr auto", gap: 10, alignItems: "center" }}>
                      <div style={{ fontSize: 12, color: "#374151", fontWeight: 600 }}>
                        {fmtShort(d.date)}
                      </div>
                      <div style={{ height: 18, background: "#f3f4f6", borderRadius: 4, overflow: "hidden", display: "flex" }}>
                        {d.damage > 0 && (
                          <div style={{
                            width: `${(d.damage / maxDayTotal) * 100}%`,
                            background: STATUS_META.damage.color,
                          }} title={`Damage: ${d.damage}`} />
                        )}
                        {d.no_damage > 0 && (
                          <div style={{
                            width: `${(d.no_damage / maxDayTotal) * 100}%`,
                            background: STATUS_META.no_damage.color,
                          }} title={`No damage: ${d.no_damage}`} />
                        )}
                        {d.retail > 0 && (
                          <div style={{
                            width: `${(d.retail / maxDayTotal) * 100}%`,
                            background: STATUS_META.retail.color,
                          }} title={`Retail: ${d.retail}`} />
                        )}
                      </div>
                      <div style={{ fontSize: 12, color: "#374151", minWidth: 24, textAlign: "right" }}>
                        {d.total}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
            <div style={{ fontSize: 10, color: "#6b7280", marginTop: 10, display: "flex", gap: 12 }}>
              <span><span style={{ display: "inline-block", width: 10, height: 10, background: STATUS_META.damage.color, borderRadius: 2, marginRight: 4 }}></span>Damage</span>
              <span><span style={{ display: "inline-block", width: 10, height: 10, background: STATUS_META.no_damage.color, borderRadius: 2, marginRight: 4 }}></span>No damage</span>
              <span><span style={{ display: "inline-block", width: 10, height: 10, background: STATUS_META.retail.color, borderRadius: 2, marginRight: 4 }}></span>Retail</span>
            </div>
          </section>

          {/* Detail list — every inspection that makes up the totals.
              Sorted newest-first by result_at. Lets admin verify the
              report is counting the records they expect. */}
          <section style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 10, padding: 14 }}>
            <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 10, fontFamily: "'Oswald', sans-serif" }}>
              Inspections ({rows.length})
            </div>
            {rows.length === 0 ? (
              <div style={{ fontSize: 12, color: "#6b7280" }}>
                No inspections in this range.
              </div>
            ) : (
              <div style={{ display: "grid", gap: 6 }}>
                {rows.map((r) => {
                  const meta = STATUS_META[r.result] || { label: r.result, color: "#6b7280", bg: "#f3f4f6", emoji: "•" };
                  return (
                    <div key={r.id} style={{ display: "grid", gridTemplateColumns: "auto 1fr auto auto", gap: 10, alignItems: "center", padding: "8px 10px", background: "#f9fafb", border: "1px solid #e5e7eb", borderRadius: 8 }}>
                      <div style={{ fontSize: 16, lineHeight: 1 }} aria-hidden="true">{meta.emoji}</div>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: 13, fontWeight: 600, color: "#111827", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {r.client_name || "—"}
                        </div>
                        <div style={{ fontSize: 11, color: "#6b7280", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {r.address || ""}
                        </div>
                      </div>
                      <div style={{ background: meta.bg, color: meta.color, fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 12, textTransform: "uppercase", letterSpacing: "0.04em" }}>
                        {meta.label}
                      </div>
                      <div style={{ fontSize: 11, color: "#6b7280", whiteSpace: "nowrap" }}>
                        {fmtShort(r.result_at)}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════
// MANAGER REPORTS — aggregate across all inspectors. Lives in the
// Manager → Inspector Reports tile. Shares range/status helpers with
// the per-inspector InspectorReports above.
// ═════════════════════════════════════════════════════════════════════
export function ManagerInspectorReports() {
  const [range, setRange] = useState("this_week");
  const [filterInspectorId, setFilterInspectorId] = useState(""); // "" = all
  const [rows, setRows] = useState([]);
  const [pendingRows, setPendingRows] = useState([]);
  const [inspectorList, setInspectorList] = useState([]);
  const [loading, setLoading] = useState(true);

  const { fromIso, toIso, label } = useMemo(() => {
    const now = new Date();
    let from, to, label;
    if (range === "this_week") {
      from = startOfWeek(now);
      to = new Date();
      label = "This week";
    } else if (range === "last_week") {
      const thisWeekStart = startOfWeek(now);
      to = new Date(thisWeekStart);
      from = new Date(thisWeekStart);
      from.setDate(from.getDate() - 7);
      label = "Last week";
    } else {
      to = new Date();
      from = new Date();
      from.setDate(from.getDate() - 30);
      label = "Last 30 days";
    }
    return { fromIso: from.toISOString(), toIso: to.toISOString(), label };
  }, [range]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      // Completed in range (every inspector, optional inspector filter).
      let completedQ = supabase
        .from("inspections")
        .select("id, client_name, address, result, result_at, inspector_id")
        .not("result", "is", null)
        .not("inspector_id", "is", null)
        .gte("result_at", fromIso)
        .lte("result_at", toIso)
        .order("result_at", { ascending: false })
        .limit(5000);
      if (filterInspectorId) completedQ = completedQ.eq("inspector_id", filterInspectorId);

      // Pending (assigned, no result) — independent of range.
      let pendingQ = supabase
        .from("inspections")
        .select("id, inspector_id")
        .is("result", null)
        .not("inspector_id", "is", null)
        .limit(5000);
      if (filterInspectorId) pendingQ = pendingQ.eq("inspector_id", filterInspectorId);

      const insQ = supabase
        .from("inspectors")
        .select("id, name, active")
        .order("name");

      const [completed, pending, insList] = await Promise.all([completedQ, pendingQ, insQ]);
      if (cancelled) return;
      setRows(completed.data || []);
      setPendingRows(pending.data || []);
      setInspectorList(insList.data || []);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [fromIso, toIso, filterInspectorId]);

  const nameById = useMemo(() => {
    const m = new Map();
    for (const i of inspectorList) m.set(i.id, i.name);
    return m;
  }, [inspectorList]);

  const { byStatus, byDay, byInspector, total } = useMemo(() => {
    const byStatus = { damage: 0, no_damage: 0, retail: 0 };
    const byDay = new Map();
    const byInspector = new Map(); // inspector_id -> { name, total, damage, no_damage, retail, pending }
    for (const r of rows) {
      if (byStatus[r.result] != null) byStatus[r.result]++;
      const k = dayKey(r.result_at);
      const dayEntry = byDay.get(k) || { date: r.result_at, total: 0, damage: 0, no_damage: 0, retail: 0 };
      dayEntry.total++;
      if (dayEntry[r.result] != null) dayEntry[r.result]++;
      byDay.set(k, dayEntry);

      const insEntry = byInspector.get(r.inspector_id) || {
        name: nameById.get(r.inspector_id) || "(removed inspector)",
        total: 0, damage: 0, no_damage: 0, retail: 0, pending: 0,
      };
      insEntry.total++;
      if (insEntry[r.result] != null) insEntry[r.result]++;
      byInspector.set(r.inspector_id, insEntry);
    }
    for (const p of pendingRows) {
      const insEntry = byInspector.get(p.inspector_id) || {
        name: nameById.get(p.inspector_id) || "(removed inspector)",
        total: 0, damage: 0, no_damage: 0, retail: 0, pending: 0,
      };
      insEntry.pending++;
      byInspector.set(p.inspector_id, insEntry);
    }
    const dayList = Array.from(byDay.values()).sort(
      (a, b) => new Date(b.date) - new Date(a.date),
    );
    const inspectorList = Array.from(byInspector.entries())
      .map(([id, v]) => ({ id, ...v }))
      .sort((a, b) => b.total - a.total);
    return { byStatus, byDay: dayList, byInspector: inspectorList, total: rows.length };
  }, [rows, pendingRows, nameById]);

  const maxDayTotal = Math.max(1, ...byDay.map((d) => d.total));

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div style={{ fontSize: 18, fontWeight: 700, fontFamily: "'Oswald', sans-serif" }}>
        📊 Inspector Reports
      </div>

      {/* Range + inspector filter */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        {[
          { key: "this_week", label: "This week" },
          { key: "last_week", label: "Last week" },
          { key: "last_30",   label: "Last 30 days" },
        ].map((r) => (
          <button
            key={r.key}
            type="button"
            onClick={() => setRange(r.key)}
            style={{
              ...secondaryBtn,
              fontSize: 12,
              padding: "6px 12px",
              background: range === r.key ? "#0e7490" : "#fff",
              color: range === r.key ? "#fff" : "#374151",
              borderColor: range === r.key ? "#0e7490" : "#d1d5db",
            }}
          >
            {r.label}
          </button>
        ))}
        <select
          value={filterInspectorId}
          onChange={(e) => setFilterInspectorId(e.target.value)}
          style={{ ...inputStyle, fontSize: 12, padding: "6px 10px", minWidth: 180 }}
        >
          <option value="">All inspectors</option>
          {inspectorList.map((i) => (
            <option key={i.id} value={i.id}>
              {i.name}{!i.active ? " (inactive)" : ""}
            </option>
          ))}
        </select>
      </div>

      {loading ? (
        <div style={{ padding: 16, color: "#6b7280" }}>Loading…</div>
      ) : (
        <>
          {/* Totals */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
            <div style={{ padding: 14, background: "#fff", border: "1px solid #e5e7eb", borderRadius: 10 }}>
              <div style={{ fontSize: 11, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.04em" }}>
                Completed
              </div>
              <div style={{ fontSize: 28, fontWeight: 700, fontFamily: "'Oswald', sans-serif" }}>{total}</div>
              <div style={{ fontSize: 11, color: "#6b7280" }}>{label}</div>
            </div>
            <div style={{ padding: 14, background: "#fff", border: "1px solid #e5e7eb", borderRadius: 10 }}>
              <div style={{ fontSize: 11, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.04em" }}>
                Pending now
              </div>
              <div style={{ fontSize: 28, fontWeight: 700, fontFamily: "'Oswald', sans-serif", color: pendingRows.length > 0 ? "#b45309" : "#111827" }}>
                {pendingRows.length}
              </div>
              <div style={{ fontSize: 11, color: "#6b7280" }}>Assigned, no result yet</div>
            </div>
            <div style={{ padding: 14, background: "#fff", border: "1px solid #e5e7eb", borderRadius: 10 }}>
              <div style={{ fontSize: 11, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.04em" }}>
                Inspectors active in range
              </div>
              <div style={{ fontSize: 28, fontWeight: 700, fontFamily: "'Oswald', sans-serif" }}>
                {byInspector.filter((i) => i.total > 0).length}
              </div>
              <div style={{ fontSize: 11, color: "#6b7280" }}>Logged a result in this range</div>
            </div>
          </div>

          {/* By status — overall */}
          <section style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 10, padding: 14 }}>
            <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 10, fontFamily: "'Oswald', sans-serif" }}>
              By result
            </div>
            <div style={{ display: "grid", gap: 8 }}>
              {["damage", "no_damage", "retail"].map((status) => {
                const meta = STATUS_META[status];
                const count = byStatus[status];
                const pct = total > 0 ? Math.round((count / total) * 100) : 0;
                return (
                  <div key={status} style={{ display: "grid", gridTemplateColumns: "auto 1fr auto", gap: 10, alignItems: "center" }}>
                    <div style={{
                      fontSize: 12,
                      fontWeight: 700,
                      color: meta.color,
                      background: meta.bg,
                      padding: "4px 10px",
                      borderRadius: 999,
                      whiteSpace: "nowrap",
                    }}>
                      {meta.emoji} {meta.label}
                    </div>
                    <div style={{ height: 8, background: "#f3f4f6", borderRadius: 999, overflow: "hidden" }}>
                      <div style={{ width: `${pct}%`, height: "100%", background: meta.color, transition: "width 0.3s" }} />
                    </div>
                    <div style={{ fontSize: 12, color: "#374151", minWidth: 56, textAlign: "right" }}>
                      {count} · {pct}%
                    </div>
                  </div>
                );
              })}
            </div>
            {total === 0 && (
              <div style={{ fontSize: 12, color: "#6b7280", marginTop: 8 }}>
                No completed inspections in this range.
              </div>
            )}
          </section>

          {/* Per-inspector breakdown */}
          <section style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 10, padding: 14 }}>
            <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 10, fontFamily: "'Oswald', sans-serif" }}>
              By inspector
            </div>
            {byInspector.length === 0 ? (
              <div style={{ fontSize: 12, color: "#6b7280" }}>
                No activity from any inspector in this range.
              </div>
            ) : (
              <div style={{ overflow: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                  <thead>
                    <tr style={{ textAlign: "left", color: "#6b7280", borderBottom: "1px solid #e5e7eb" }}>
                      <th style={{ padding: "6px 8px" }}>Inspector</th>
                      <th style={{ padding: "6px 8px", textAlign: "right" }}>Total</th>
                      <th style={{ padding: "6px 8px", textAlign: "right", color: STATUS_META.damage.color }}>⚠️ Damage</th>
                      <th style={{ padding: "6px 8px", textAlign: "right", color: STATUS_META.no_damage.color }}>✅ No dmg</th>
                      <th style={{ padding: "6px 8px", textAlign: "right", color: STATUS_META.retail.color }}>🏠 Retail</th>
                      <th style={{ padding: "6px 8px", textAlign: "right" }}>Pending</th>
                    </tr>
                  </thead>
                  <tbody>
                    {byInspector.map((row) => (
                      <tr key={row.id} style={{ borderBottom: "1px solid #f3f4f6" }}>
                        <td style={{ padding: "6px 8px", fontWeight: 600 }}>{row.name}</td>
                        <td style={{ padding: "6px 8px", textAlign: "right" }}>{row.total}</td>
                        <td style={{ padding: "6px 8px", textAlign: "right" }}>{row.damage}</td>
                        <td style={{ padding: "6px 8px", textAlign: "right" }}>{row.no_damage}</td>
                        <td style={{ padding: "6px 8px", textAlign: "right" }}>{row.retail}</td>
                        <td style={{ padding: "6px 8px", textAlign: "right", color: row.pending > 0 ? "#b45309" : "#6b7280", fontWeight: row.pending > 0 ? 700 : 400 }}>
                          {row.pending}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {/* By day */}
          <section style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 10, padding: 14 }}>
            <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 10, fontFamily: "'Oswald', sans-serif" }}>
              By day
            </div>
            {byDay.length === 0 ? (
              <div style={{ fontSize: 12, color: "#6b7280" }}>
                No completed inspections in this range.
              </div>
            ) : (
              <div style={{ display: "grid", gap: 6 }}>
                {byDay.map((d) => (
                  <div key={d.date} style={{ display: "grid", gridTemplateColumns: "100px 1fr auto", gap: 10, alignItems: "center" }}>
                    <div style={{ fontSize: 12, color: "#374151", fontWeight: 600 }}>
                      {fmtShort(d.date)}
                    </div>
                    <div style={{ height: 18, background: "#f3f4f6", borderRadius: 4, overflow: "hidden", display: "flex" }}>
                      {d.damage > 0 && (
                        <div style={{ width: `${(d.damage / maxDayTotal) * 100}%`, background: STATUS_META.damage.color }} title={`Damage: ${d.damage}`} />
                      )}
                      {d.no_damage > 0 && (
                        <div style={{ width: `${(d.no_damage / maxDayTotal) * 100}%`, background: STATUS_META.no_damage.color }} title={`No damage: ${d.no_damage}`} />
                      )}
                      {d.retail > 0 && (
                        <div style={{ width: `${(d.retail / maxDayTotal) * 100}%`, background: STATUS_META.retail.color }} title={`Retail: ${d.retail}`} />
                      )}
                    </div>
                    <div style={{ fontSize: 12, color: "#374151", minWidth: 24, textAlign: "right" }}>
                      {d.total}
                    </div>
                  </div>
                ))}
              </div>
            )}
            <div style={{ fontSize: 10, color: "#6b7280", marginTop: 10, display: "flex", gap: 12 }}>
              <span><span style={{ display: "inline-block", width: 10, height: 10, background: STATUS_META.damage.color, borderRadius: 2, marginRight: 4 }}></span>Damage</span>
              <span><span style={{ display: "inline-block", width: 10, height: 10, background: STATUS_META.no_damage.color, borderRadius: 2, marginRight: 4 }}></span>No damage</span>
              <span><span style={{ display: "inline-block", width: 10, height: 10, background: STATUS_META.retail.color, borderRadius: 2, marginRight: 4 }}></span>Retail</span>
            </div>
          </section>

          {/* Detail list — every inspection counted in the totals.
              Manager view shows the inspector name alongside each row
              so admin can verify which inspector did each one without
              scrolling back to the "By inspector" table. */}
          <section style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 10, padding: 14 }}>
            <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 10, fontFamily: "'Oswald', sans-serif" }}>
              Inspections ({rows.length})
            </div>
            {rows.length === 0 ? (
              <div style={{ fontSize: 12, color: "#6b7280" }}>
                No inspections in this range.
              </div>
            ) : (
              <div style={{ display: "grid", gap: 6 }}>
                {rows.map((r) => {
                  const meta = STATUS_META[r.result] || { label: r.result, color: "#6b7280", bg: "#f3f4f6", emoji: "•" };
                  const inspName = nameById.get(r.inspector_id) || "(removed inspector)";
                  return (
                    <div key={r.id} style={{ display: "grid", gridTemplateColumns: "auto 1fr auto auto", gap: 10, alignItems: "center", padding: "8px 10px", background: "#f9fafb", border: "1px solid #e5e7eb", borderRadius: 8 }}>
                      <div style={{ fontSize: 16, lineHeight: 1 }} aria-hidden="true">{meta.emoji}</div>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: 13, fontWeight: 600, color: "#111827", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {r.client_name || "—"}
                          <span style={{ fontSize: 11, fontWeight: 500, color: "#6b7280", marginLeft: 8 }}>
                            · {inspName}
                          </span>
                        </div>
                        <div style={{ fontSize: 11, color: "#6b7280", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {r.address || ""}
                        </div>
                      </div>
                      <div style={{ background: meta.bg, color: meta.color, fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 12, textTransform: "uppercase", letterSpacing: "0.04em" }}>
                        {meta.label}
                      </div>
                      <div style={{ fontSize: 11, color: "#6b7280", whiteSpace: "nowrap" }}>
                        {fmtShort(r.result_at)}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}

// Guided inspector photo wizard — multi-step interview rather than a
// single dump-it-all-here photo picker. Sequence:
//
//   1. House number photo (confirms the right address)
//   2. Front of house photo
//   3. Pick story count (1 or 2)
//   4. For each story (story 1 first, then story 2 if 2-story):
//      a. Roof overview — wide shot from the LEFT edge of the roof
//         capturing as much of the roof as possible
//      b. For each side in CLOCKWISE order starting LEFT
//         (left → front → right → rear):
//           i.   Ask how many slopes on this side (0–4)
//           ii.  For each slope on the side, back-to-back:
//                  - Overview photo (1 wide shot of that slope)
//                  - Detail photos (close-ups of any damage/wear)
//      c. After all 4 sides on story 1 → "Story 1 complete" card
//         (only when 2-story).
//   5. Result picker (damage / retail / no_damage)
//   6. If retail: 10 worst-condition photos
//   7. Submit
//
// Photo labels follow the inspector's mental model. Slopes are
// numbered sequentially per story across all 4 sides — so for a
// 1-story house with left=2, front=1, right=2, rear=1 slopes the
// labels go "1st slope overview, 1st slope detail, 2nd slope
// overview, 2nd slope detail, … 6th slope overview, 6th slope
// detail". For 2-story homes the floor is appended in parens:
// "1st slope overview (1st floor)".
// Clockwise from LEFT (looking down at the house from above):
// left → front → right → rear → back to left. Inspector walks the
// house in this order, one side at a time.
const SIDES = ["left", "front", "right", "rear"];
const SIDE_LABELS = {
  left: "LEFT-facing",
  front: "FRONT-facing",
  right: "RIGHT-facing",
  rear: "REAR-facing",
};

function InspectorJobDetail({ me, jobId, onBack }) {
  const [job, setJob] = useState(null);
  const [loading, setLoading] = useState(true);
  // Guided wizard state.
  // stage shapes:
  //   { kind: "house_number" }
  //   { kind: "front_house" }
  //   { kind: "story_pick" }
  //   { kind: "roof_overview", story } — wide shot from LEFT edge
  //                                       of the roof, once per story
  //   { kind: "side_count",    side, story }
  //   { kind: "side_overview", side, story, slopeIndex }
  //   { kind: "side_damage",   side, story, slopeIndex }
  //   { kind: "story_transition" } — only when storyCount === 2,
  //                                   between story 1 and story 2
  //   { kind: "result" }
  //   { kind: "retail_worst" }
  const [stage, setStage] = useState({ kind: "house_number" });
  // How many stories — 1 or 2. Set by the story_pick step.
  const [storyCount, setStoryCount] = useState(0);
  // Slope counts keyed by `${story}_${side}` — each story+side can
  // have its own slope count. e.g. "1_left", "2_left" etc.
  const [slopeCounts, setSlopeCounts] = useState({});
  // Flat array of all photos. Each carries metadata so we can group
  // them in the UI + write descriptive filenames at upload.
  // Shape: { file, previewUrl, category, side?, story?, slopeIndex?,
  //         label, uploaded, path }
  const [photos, setPhotos] = useState([]);
  const [resultChoice, setResultChoice] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitMsg, setSubmitMsg] = useState(null);
  // Live progress shown to the inspector during submit. Without
  // this the button just said "Submitting…" the whole time and on
  // a slow phone connection inspectors thought the app was frozen.
  // Shape: { stage: "starting" | "uploading" | "saving", uploaded, total }
  const [submitProgress, setSubmitProgress] = useState(null);
  // Counts how many addPhotos() calls are still resizing photos in
  // the background. When > 0, photos have been CAPTURED by the
  // inspector but the resize-then-setPhotos chain hasn't finished
  // updating React state yet. If Submit fires while this > 0, the
  // submit's `photos` snapshot is stale and we lose the just-captured
  // shots. Tracked with a ref so reads are synchronous and don't
  // require a re-render to be accurate. Submit waits on this counter
  // to drain before proceeding.
  const pendingAddsRef = useRef(0);
  // Bumped each time pendingAddsRef changes so the Submit button
  // disables in the UI while resizes are still in flight (defense
  // in depth — even if the inspector taps Submit, the click is a
  // no-op until the state settles).
  const [pendingAdds, setPendingAdds] = useState(0);

  const slopeCountKey = (story, side) => `${story}_${side}`;
  const getSlopeCount = (story, side) => slopeCounts[slopeCountKey(story, side)] || 0;
  const setSlopeCount = (story, side, n) =>
    setSlopeCounts((prev) => ({ ...prev, [slopeCountKey(story, side)]: n }));

  async function load() {
    setLoading(true);
    const { data } = await supabase
      .from("inspections")
      .select("*")
      .eq("id", jobId)
      .maybeSingle();
    setJob(data);
    setLoading(false);
  }
  useEffect(() => { load(); }, [jobId]);

  // Advance to the next logical stage based on where we are.
  // Per-slope flow: count → overview slope 1 → damage slope 1 →
  // overview slope 2 → damage slope 2 → next side.
  function advance() {
    if (stage.kind === "house_number") {
      setStage({ kind: "front_house" });
      return;
    }
    if (stage.kind === "front_house") {
      setStage({ kind: "story_pick" });
      return;
    }
    if (stage.kind === "story_pick") {
      // storyCount must be set by the step's buttons before advance.
      setStage({ kind: "roof_overview", story: 1 });
      return;
    }
    if (stage.kind === "story_transition") {
      setStage({ kind: "roof_overview", story: 2 });
      return;
    }
    if (stage.kind === "roof_overview") {
      setStage({ kind: "side_count", side: "left", story: stage.story });
      return;
    }
    if (stage.kind === "side_count") {
      const count = getSlopeCount(stage.story, stage.side);
      if (count > 0) {
        setStage({ kind: "side_overview", story: stage.story, side: stage.side, slopeIndex: 0 });
      } else {
        // No slopes on this side — skip to next side (or next story / result).
        goToNextSide(stage.story, stage.side);
      }
      return;
    }
    if (stage.kind === "side_overview") {
      // Right after overview, take damage photos for THIS slope.
      setStage({ kind: "side_damage", story: stage.story, side: stage.side, slopeIndex: stage.slopeIndex });
      return;
    }
    if (stage.kind === "side_damage") {
      const count = getSlopeCount(stage.story, stage.side);
      if (stage.slopeIndex + 1 < count) {
        // Next slope on this side — back to overview.
        setStage({ kind: "side_overview", story: stage.story, side: stage.side, slopeIndex: stage.slopeIndex + 1 });
      } else {
        goToNextSide(stage.story, stage.side);
      }
      return;
    }
    if (stage.kind === "result") {
      // Handled by result-button presses → submit() or retail step.
      return;
    }
  }

  function goToNextSide(currentStory, currentSide) {
    const idx = SIDES.indexOf(currentSide);
    if (idx >= 0 && idx + 1 < SIDES.length) {
      setStage({ kind: "side_count", side: SIDES[idx + 1], story: currentStory });
      return;
    }
    // All 4 sides done on this story. If 2-story and we just
    // finished story 1, show the transition card.
    if (storyCount === 2 && currentStory === 1) {
      setStage({ kind: "story_transition" });
      return;
    }
    setStage({ kind: "result" });
  }

  // Phone cameras produce 4–8 MB photos — too big to upload over
  // cell on the side of a roof. Compress each one to a max long-edge
  // of 1600px at JPEG quality 0.85 BEFORE stashing it in state, so
  // by submit time the upload payload is already small.
  async function addPhotos(files, metadata) {
    // Bump in-flight counter BEFORE we await. If the inspector taps
    // Submit while we're still resizing, submit() polls this counter
    // and waits for it to drain before reading `photos` from state —
    // otherwise the just-captured photos would be missing from the
    // snapshot and silently dropped. Decrement happens in a try/
    // finally so the counter doesn't get stuck if resize throws.
    pendingAddsRef.current += 1
    setPendingAdds(pendingAddsRef.current)
    try {
      const additions = await Promise.all(Array.from(files).map(async (rawFile) => {
        const file = await resizeImageForUpload(rawFile);
        return {
          file,
          previewUrl: URL.createObjectURL(file),
          uploaded: false,
          path: null,
          ...metadata,
        };
      }));
      setPhotos((prev) => [...prev, ...additions]);
    } finally {
      pendingAddsRef.current -= 1
      setPendingAdds(pendingAddsRef.current)
    }
  }

  function removePhoto(i) {
    setPhotos((prev) => prev.filter((_, idx) => idx !== i));
  }

  // Filter photos belonging to the current stage so we can show only
  // those previews instead of every photo accumulated so far.
  function currentStagePhotos() {
    if (stage.kind === "house_number") {
      return photos.filter((p) => p.category === "house_number");
    }
    if (stage.kind === "front_house") {
      return photos.filter((p) => p.category === "front_house");
    }
    if (stage.kind === "roof_overview") {
      return photos.filter((p) => p.category === "roof_overview" && p.story === stage.story);
    }
    if (stage.kind === "side_overview") {
      return photos.filter(
        (p) => p.category === "slope_overview"
          && p.side === stage.side
          && p.story === stage.story
          && p.slopeIndex === stage.slopeIndex,
      );
    }
    if (stage.kind === "side_damage") {
      return photos.filter(
        (p) => p.category === "slope_damage"
          && p.side === stage.side
          && p.story === stage.story
          && p.slopeIndex === stage.slopeIndex,
      );
    }
    if (stage.kind === "retail_worst") {
      return photos.filter((p) => p.category === "retail_worst");
    }
    return [];
  }

  async function submit() {
    if (!resultChoice) {
      setSubmitMsg({ kind: "error", text: "Pick a result first." });
      return;
    }
    setSubmitting(true);
    setSubmitMsg(null);

    // ── RACE FIX ──
    // If any addPhotos() calls are still resizing photos in the
    // background, wait for them to finish before we snapshot the
    // photos array. Without this, an inspector who taps Submit
    // within ~500ms of the last Capture would lose those photos —
    // resize hasn't called setPhotos yet, so React state doesn't
    // include them. This is what caused Carlos Gomez and Kenneth
    // Laws to land in JN with only 3 photos despite the inspectors
    // capturing more.
    if (pendingAddsRef.current > 0) {
      setSubmitProgress({ stage: "starting", uploaded: 0, total: 0 });
      // Tight poll — usually drains in 50-200ms after the last
      // capture. Cap at 10s as a runaway-guard; if a resize truly
      // never finishes, we surface a clear error instead of hanging.
      const deadline = Date.now() + 10000;
      while (pendingAddsRef.current > 0) {
        if (Date.now() > deadline) {
          setSubmitMsg({
            kind: "error",
            text: `${pendingAddsRef.current} photo(s) are still processing. Wait a moment and try Submit again.`,
          });
          setSubmitting(false);
          setSubmitProgress(null);
          return;
        }
        // 50ms poll keeps the UI responsive without hammering CPU.
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    // ── END RACE FIX ──

    setSubmitProgress({ stage: "starting", uploaded: 0, total: photos.length });
    try {
      // 1. Upload photos to Supabase Storage in PARALLEL batches.
      //    Sequential uploads on a phone with weak signal took long
      //    enough that inspectors thought the app was frozen. Batches
      //    of 4 finish ~4x faster while still keeping memory bounded.
      //    Per-photo failures cause a retry once before reporting.
      const BATCH_SIZE = 4;
      const indices = photos.map((_, i) => i);
      const uploadedPhotos = new Array(photos.length);
      let completed = 0;

      async function uploadOne(i) {
        const p = photos[i];
        if (p.uploaded) {
          uploadedPhotos[i] = { path: p.path, label: p.label };
          return;
        }
        const ext = (p.file.name.split(".").pop() || "jpg").toLowerCase();
        const ts = new Date().toISOString().replace(/[:.]/g, "-");
        const slug = labelToSlug(p.label);
        const path = `${PHOTO_PATH_PREFIX}/${jobId}/${slug}_${ts}_${i}.${ext}`;
        // Retry once on failure — phone networks blip.
        let lastErr = null;
        for (let attempt = 1; attempt <= 2; attempt++) {
          const { error } = await supabase.storage
            .from(SIGNED_BUCKET)
            .upload(path, p.file, {
              contentType: p.file.type || "image/jpeg",
              upsert: false,
            });
          if (!error) {
            uploadedPhotos[i] = { path, label: p.label };
            setPhotos((prev) => prev.map((x, idx) => idx === i ? { ...x, uploaded: true, path } : x));
            return;
          }
          lastErr = error;
          if (attempt < 2) await new Promise((r) => setTimeout(r, 800));
        }
        throw new Error(`Photo ${i + 1} (${p.label}): ${lastErr?.message || "upload failed"}`);
      }

      for (let i = 0; i < indices.length; i += BATCH_SIZE) {
        const batch = indices.slice(i, i + BATCH_SIZE);
        await Promise.all(batch.map(async (idx) => {
          await uploadOne(idx);
          completed++;
          setSubmitProgress({ stage: "uploading", uploaded: completed, total: photos.length });
        }));
      }

      setSubmitProgress({ stage: "saving", uploaded: completed, total: photos.length });

      // 2. Hand off to the server function for JN photo upload + PA PDN.
      const res = await fetch("/.netlify/functions/inspector-submit-result", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          inspectionId: jobId,
          result: resultChoice,
          inspector_name: me.name,
          photo_paths: uploadedPhotos.map((p) => p.path),
          photo_labels: uploadedPhotos.map((p) => p.label),
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.ok) {
        setSubmitMsg({ kind: "error", text: body.error || `Submit failed: ${res.status}` });
        setSubmitProgress(null);
        setSubmitting(false);
        return;
      }
      setSubmitProgress(null);
      setSubmitMsg({
        kind: "success",
        text:
          `Done — inspection saved. ${body.jn_photos_uploaded || 0} of ${uploadedPhotos.length} photos pushed to JN.` +
          (body.pa_pdn_fired ? " PA Ops Hub notified." : ""),
      });
      setTimeout(() => {
        onBack();
      }, 1800);
    } catch (e) {
      setSubmitMsg({ kind: "error", text: e.message || "Unknown error" });
      setSubmitProgress(null);
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) return <div style={{ padding: 16, color: "#6b7280" }}>Loading job…</div>;
  if (!job) return (
    <div style={{ padding: 16 }}>
      <div style={{ color: "#991b1b", marginBottom: 12 }}>Job not found.</div>
      <button type="button" onClick={onBack} style={secondaryBtn}>← Back</button>
    </div>
  );

  const stagePhotos = currentStagePhotos();
  const progressLabel = stageLabel(stage, slopeCounts, storyCount);
  const isResultDamage = resultChoice === "damage";
  const isResultRetail = resultChoice === "retail";
  const retailPhotoCount = photos.filter((p) => p.category === "retail_worst").length;
  const retailReady = retailPhotoCount >= 10;

  return (
    <div style={{ display: "grid", gap: 14 }}>
      <button
        type="button"
        onClick={() => {
          if (submitting) {
            if (!confirm("Inspection is still uploading. Leaving now will lose your work and you'll have to take all photos again. Are you sure?")) return;
          }
          onBack();
        }}
        style={{
          ...secondaryBtn,
          alignSelf: "flex-start",
          fontSize: 12,
          opacity: submitting ? 0.55 : 1,
        }}
      >
        ← Back to list
      </button>

      <div style={{ padding: 14, background: "#fff", borderRadius: 12, border: "1px solid #e5e7eb" }}>
        <div style={{ fontSize: 18, fontWeight: 700 }}>{job.client_name}</div>
        <div style={{ fontSize: 13, color: "#374151", marginTop: 4 }}>
          📍 {job.address}<br />
          {job.city}, {job.state} {job.zip}
        </div>
        {job.sales_rep_name && (
          <div style={{ fontSize: 12, color: "#6b7280", marginTop: 6 }}>
            Rep: {job.sales_rep_name}{job.mobile && <> · {job.mobile}</>}
          </div>
        )}
      </div>

      {/* Progress strip — shows the current step + total photos so far */}
      <div style={{
        padding: "12px 14px",
        background: "#ecfeff",
        border: "1px solid #67e8f9",
        borderRadius: 10,
        fontSize: 15,
        color: "#0e7490",
        lineHeight: 1.4,
      }}>
        <strong>Step:</strong> {progressLabel} · <strong>{photos.length}</strong> photo{photos.length === 1 ? "" : "s"} so far
      </div>

      {stage.kind === "house_number" && (
        <WizardPhotoStep
          title="📷 Step 1 — Photo of the house number"
          subtitle="Stand on the sidewalk or driveway and take ONE clear, in-focus photo of the house number on the front of the house (or on the mailbox). This is how we confirm we're at the right address."
          ctaLabel="Got it — next: front of the house →"
          ctaEnabled={stagePhotos.length >= 1}
          stagePhotos={stagePhotos}
          submitting={submitting}
          onAddPhotos={(files) => addPhotos(files, {
            category: "house_number",
            label: "House number",
          })}
          onRemove={(idx) => {
            const target = stagePhotos[idx];
            setPhotos((prev) => prev.filter((p) => p !== target));
          }}
          onContinue={advance}
        />
      )}

      {stage.kind === "front_house" && (
        <WizardPhotoStep
          title="📷 Step 2 — Photo of the front of the house"
          subtitle="Back up far enough to see the WHOLE front of the house in the frame — roof + walls + driveway. Take ONE photo, straight-on if you can."
          ctaLabel="Got it — next: how many stories? →"
          ctaEnabled={stagePhotos.length >= 1}
          stagePhotos={stagePhotos}
          submitting={submitting}
          onAddPhotos={(files) => addPhotos(files, {
            category: "front_house",
            label: "Front of house",
          })}
          onRemove={(idx) => {
            const target = stagePhotos[idx];
            setPhotos((prev) => prev.filter((p) => p !== target));
          }}
          onContinue={advance}
        />
      )}

      {stage.kind === "story_pick" && (
        <section style={{ padding: 16, background: "#fff", borderRadius: 12, border: "1px solid #e5e7eb", display: "grid", gap: 12 }}>
          <div style={{ fontSize: 22, fontWeight: 700, fontFamily: "'Oswald', sans-serif", lineHeight: 1.2 }}>
            🏠 Step 3 — How many stories does this house have?
          </div>
          <div style={{ fontSize: 16, color: "#374151", lineHeight: 1.5 }}>
            Count the floors of the house, not the roof slopes. A standard ranch is <strong>1 story</strong>. A house with bedrooms upstairs is <strong>2 stories</strong>. If it's 2-story, you'll photograph the 1st floor's roof first (all 4 sides), then climb up and do the 2nd floor's roof the same way.
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            {[1, 2].map((n) => (
              <button
                key={n}
                type="button"
                onClick={() => {
                  setStoryCount(n);
                  setStage({ kind: "roof_overview", story: 1 });
                }}
                style={{
                  padding: "24px 12px",
                  background: storyCount === n ? "#0e7490" : "#fff",
                  color: storyCount === n ? "#fff" : "#111827",
                  border: `2px solid ${storyCount === n ? "#0e7490" : "#e5e7eb"}`,
                  borderRadius: 12,
                  fontWeight: 700,
                  fontSize: 20,
                  cursor: "pointer",
                }}
              >
                {n === 1 ? "1 story" : "2 stories"}
              </button>
            ))}
          </div>
        </section>
      )}

      {stage.kind === "roof_overview" && (
        <WizardPhotoStep
          title={`📷 Step 4 — Roof overview${storyCount === 2 ? ` (${ordinal(stage.story)} floor)` : ""}`}
          subtitle={
            stage.story === 1
              ? "Now climb up onto the roof. Walk all the way over to the FAR LEFT side of the roof. From there, take ONE wide photo trying to capture as much of the roof as you can see. This gives us a single picture that shows the overall condition before we zoom into each slope."
              : "On the 2nd-floor roof: same idea. Walk to the FAR LEFT and take ONE wide photo capturing as much of the 2nd-floor roof as possible."
          }
          ctaLabel="Got it — now start slopes (LEFT side) →"
          ctaEnabled={stagePhotos.length >= 1}
          stagePhotos={stagePhotos}
          submitting={submitting}
          onAddPhotos={(files) => addPhotos(files, {
            category: "roof_overview",
            story: stage.story,
            label: `Roof overview${storyCount === 2 ? ` (${ordinal(stage.story)} floor)` : ""}`,
          })}
          onRemove={(idx) => {
            const target = stagePhotos[idx];
            setPhotos((prev) => prev.filter((p) => p !== target));
          }}
          onContinue={advance}
        />
      )}

      {stage.kind === "story_transition" && (
        <section style={{ padding: 20, background: "#ecfeff", borderRadius: 12, border: "2px solid #06b6d4", display: "grid", gap: 12, textAlign: "center" }}>
          <div style={{ fontSize: 40 }}>✅</div>
          <div style={{ fontSize: 24, fontWeight: 700, fontFamily: "'Oswald', sans-serif", lineHeight: 1.2 }}>
            1st floor finished
          </div>
          <div style={{ fontSize: 17, color: "#0e7490", lineHeight: 1.5 }}>
            Climb up to the 2nd-floor roof. We'll do the same thing all over again:
            roof overview from the FAR LEFT, then slopes clockwise from the LEFT side
            (left → front → right → rear).
          </div>
          <button
            type="button"
            onClick={advance}
            style={{ ...primaryBtn, padding: "18px 20px", fontSize: 18 }}
          >
            I'm on the 2nd-floor roof — continue →
          </button>
        </section>
      )}

      {stage.kind === "side_count" && (
        <SlopeCountStep
          side={stage.side}
          story={stage.story}
          storyCount={storyCount}
          value={getSlopeCount(stage.story, stage.side)}
          onSet={(n) => setSlopeCount(stage.story, stage.side, n)}
          onContinue={advance}
        />
      )}

      {(() => {
        if (stage.kind !== "side_overview" && stage.kind !== "side_damage") return null;
        const seq = slopeSequence(stage, slopeCounts);
        const ord = ordinal(seq);
        const floorTag = storyCount === 2 ? ` (${ordinal(stage.story)} floor)` : "";
        const overviewLabel = `${ord} slope overview${floorTag}`;
        const detailLabel = `${ord} slope detail${floorTag}`;
        const isOverview = stage.kind === "side_overview";

        // CTA depends on what's next.
        let ctaLabel;
        if (isOverview) {
          ctaLabel = "Got it — now detail photos of THIS slope →";
        } else {
          if (stage.slopeIndex + 1 < getSlopeCount(stage.story, stage.side)) {
            ctaLabel = `Done — next slope (${ordinal(seq + 1)}) overview →`;
          } else if (nextSideAfter(stage.side)) {
            ctaLabel = `Done — ${SIDE_LABELS[nextSideAfter(stage.side)]} side next →`;
          } else if (storyCount === 2 && stage.story === 1) {
            ctaLabel = "Done — 1st floor finished →";
          } else {
            ctaLabel = "Done — pick result →";
          }
        }

        const sideText = SIDE_LABELS[stage.side];
        return isOverview ? (
          <WizardPhotoStep
            title={`📷 ${overviewLabel}`}
            subtitle={`You should be facing the ${sideText} side of the roof. Stand back far enough to see the WHOLE slope in one shot. Take ONE wide overview photo of this slope.`}
            ctaLabel={ctaLabel}
            ctaEnabled={stagePhotos.length >= 1}
            stagePhotos={stagePhotos}
            submitting={submitting}
            onAddPhotos={(files) => addPhotos(files, {
              category: "slope_overview",
              side: stage.side,
              story: stage.story,
              slopeIndex: stage.slopeIndex,
              label: overviewLabel,
            })}
            onRemove={(idx) => {
              const target = stagePhotos[idx];
              setPhotos((prev) => prev.filter((p) => p !== target));
            }}
            onContinue={advance}
          />
        ) : (
          <WizardPhotoStep
            title={`📷 ${detailLabel}`}
            subtitle={`Still on the ${sideText} side. Now move in CLOSE and take detail photos of anything you see — hail strikes, missing or torn shingles, granule loss, wear marks, exposed nails, soft spots. Add as many photos as you need. Tap Done when this slope is fully documented.`}
            ctaLabel={ctaLabel}
            ctaEnabled={stagePhotos.length >= 1}
            stagePhotos={stagePhotos}
            submitting={submitting}
            onAddPhotos={(files) => addPhotos(files, {
              category: "slope_damage",
              side: stage.side,
              story: stage.story,
              slopeIndex: stage.slopeIndex,
              label: detailLabel,
            })}
            onRemove={(idx) => {
              const target = stagePhotos[idx];
              setPhotos((prev) => prev.filter((p) => p !== target));
            }}
            onContinue={advance}
          />
        );
      })()}

      {stage.kind === "result" && (
        <section style={{ display: "grid", gap: 12 }}>
          <div style={{ fontSize: 22, fontWeight: 700, fontFamily: "'Oswald', sans-serif", lineHeight: 1.2 }}>
            🧾 Final step — what did you find?
          </div>
          <div style={{ fontSize: 16, color: "#374151", lineHeight: 1.5 }}>
            Pick the result based on what you saw on the roof:
            <br/>• <strong>Damage</strong> — clear storm damage (hail strikes, wind-lifted shingles). Triggers the PA claim path.
            <br/>• <strong>Retail</strong> — significant wear & tear but no storm damage. Homeowner pays out of pocket. You'll be asked for 10 more close-ups of the worst spots before submitting.
            <br/>• <strong>No damage</strong> — roof is sound, nothing to file.
          </div>
          {[
            { key: "damage", label: "🚨 Damage — file PA claim", color: "#dc2626" },
            { key: "retail", label: "💰 Retail — homeowner pays (10 more photos)", color: "#7c3aed" },
            { key: "no_damage", label: "✓ No damage", color: "#059669" },
          ].map((opt) => (
            <button
              key={opt.key}
              type="button"
              onClick={() => {
                setResultChoice(opt.key);
                if (opt.key === "retail") {
                  setStage({ kind: "retail_worst" });
                }
              }}
              style={{
                padding: "18px 18px",
                background: resultChoice === opt.key ? opt.color : "#fff",
                color: resultChoice === opt.key ? "#fff" : "#111827",
                border: `2px solid ${resultChoice === opt.key ? opt.color : "#e5e7eb"}`,
                borderRadius: 12,
                fontWeight: 700,
                fontSize: 18,
                textAlign: "left",
                cursor: "pointer",
              }}
            >
              {opt.label}
            </button>
          ))}
          {(isResultDamage || resultChoice === "no_damage") && (
            <button
              type="button"
              onClick={submit}
              disabled={submitting || pendingAdds > 0}
              style={{
                padding: "20px 20px",
                background: (submitting || pendingAdds > 0) ? "#9ca3af" : "#13294b",
                color: "#fff",
                border: "none",
                borderRadius: 12,
                fontWeight: 700,
                fontSize: 20,
                cursor: (submitting || pendingAdds > 0) ? "wait" : "pointer",
              }}
            >
              {submitting
                ? "Submitting…"
                : pendingAdds > 0
                  ? `Processing ${pendingAdds} photo${pendingAdds === 1 ? '' : 's'}…`
                  : "Submit inspection →"}
            </button>
          )}
        </section>
      )}

      {stage.kind === "retail_worst" && (
        <section style={{ display: "grid", gap: 12 }}>
          <div style={{ fontSize: 22, fontWeight: 700, fontFamily: "'Oswald', sans-serif", lineHeight: 1.2 }}>
            💰 Retail — 10 worst-spot photos
          </div>
          <div style={{ fontSize: 16, color: "#374151", lineHeight: 1.5 }}>
            Walk the whole roof one more time and photograph the <strong>10 worst spots</strong> — anywhere across all sides. These are the close-ups we'll use to justify the retail recommendation. Submit unlocks once you've added at least 10.
          </div>
          <WizardPhotoStep
            title={`Worst-condition photos (${retailPhotoCount} / 10 minimum)`}
            subtitle=""
            ctaLabel={retailReady ? `Submit inspection (${retailPhotoCount} photos) →` : `Need ${10 - retailPhotoCount} more`}
            ctaEnabled={retailReady && !submitting}
            stagePhotos={stagePhotos}
            submitting={submitting}
            onAddPhotos={(files) => addPhotos(files, {
              category: "retail_worst",
              label: "Retail worst condition",
            })}
            onRemove={(idx) => {
              const target = stagePhotos[idx];
              setPhotos((prev) => prev.filter((p) => p !== target));
            }}
            onContinue={submit}
            ctaPrimary
          />
        </section>
      )}

      {submitProgress && (
        <div style={{
          padding: "14px 16px",
          borderRadius: 12,
          background: "#eff6ff",
          border: "2px solid #3b82f6",
          color: "#1e3a8a",
          fontSize: 16,
          fontWeight: 700,
          textAlign: "center",
          lineHeight: 1.4,
        }}>
          {submitProgress.stage === "starting" && (
            <>⏳ Starting upload…</>
          )}
          {submitProgress.stage === "uploading" && (
            <>
              📤 Uploading photos — {submitProgress.uploaded} / {submitProgress.total}
              <div style={{ height: 8, background: "#dbeafe", borderRadius: 4, marginTop: 8, overflow: "hidden" }}>
                <div
                  style={{
                    width: `${Math.round((submitProgress.uploaded / Math.max(1, submitProgress.total)) * 100)}%`,
                    height: "100%",
                    background: "#3b82f6",
                    transition: "width 0.3s ease",
                  }}
                />
              </div>
              <div style={{ fontSize: 12, fontWeight: 400, color: "#475569", marginTop: 6 }}>
                Don't close this page or hit Back — uploads are still going.
              </div>
            </>
          )}
          {submitProgress.stage === "saving" && (
            <>💾 All photos uploaded. Saving the inspection…</>
          )}
        </div>
      )}

      {submitMsg && (
        <div style={{
          padding: "10px 14px",
          borderRadius: 10,
          fontSize: 14,
          background: submitMsg.kind === "success" ? "#ecfdf5" : "#fef2f2",
          border: `1px solid ${submitMsg.kind === "success" ? "#86efac" : "#fca5a5"}`,
          color: submitMsg.kind === "success" ? "#065f46" : "#991b1b",
        }}>
          {submitMsg.text}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Wizard sub-components + helpers
// ─────────────────────────────────────────────────────────────────────
function WizardPhotoStep({ title, subtitle, ctaLabel, ctaEnabled, ctaPrimary, stagePhotos, submitting, onAddPhotos, onRemove, onContinue }) {
  const cameraInputRef = useRef(null);
  const libraryInputRef = useRef(null);
  return (
    <section style={{
      padding: 16,
      background: "#fff",
      borderRadius: 12,
      border: "1px solid #e5e7eb",
      display: "grid",
      gap: 12,
    }}>
      <div>
        <div style={{ fontSize: 22, fontWeight: 700, fontFamily: "'Oswald', sans-serif", lineHeight: 1.2 }}>{title}</div>
        {subtitle && <div style={{ fontSize: 16, color: "#374151", marginTop: 8, lineHeight: 1.5 }}>{subtitle}</div>}
      </div>
      {/* Two inputs: one forces the rear camera (capture="environment"),
          the other has NO capture attribute so iOS/Android opens the
          photo library picker. Lets the inspector either snap fresh
          shots OR pick already-taken photos from camera roll (handy
          when re-doing an inspection that previously failed to submit). */}
      <input
        ref={cameraInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        multiple
        onChange={(e) => {
          onAddPhotos(e.target.files || []);
          if (cameraInputRef.current) cameraInputRef.current.value = "";
        }}
        style={{ display: "none" }}
      />
      <input
        ref={libraryInputRef}
        type="file"
        accept="image/*"
        multiple
        onChange={(e) => {
          onAddPhotos(e.target.files || []);
          if (libraryInputRef.current) libraryInputRef.current.value = "";
        }}
        style={{ display: "none" }}
      />
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
        <button
          type="button"
          onClick={() => cameraInputRef.current?.click()}
          disabled={submitting}
          style={{
            padding: "16px 14px",
            background: "#0ea5e9",
            color: "#fff",
            border: "none",
            borderRadius: 12,
            fontWeight: 700,
            fontSize: 17,
            cursor: submitting ? "wait" : "pointer",
          }}
        >
          📷 Take photo
        </button>
        <button
          type="button"
          onClick={() => libraryInputRef.current?.click()}
          disabled={submitting}
          style={{
            padding: "16px 14px",
            background: "#fff",
            color: "#0c4a6e",
            border: "2px solid #0ea5e9",
            borderRadius: 12,
            fontWeight: 700,
            fontSize: 17,
            cursor: submitting ? "wait" : "pointer",
          }}
          title="Pick photos you already took from your phone's gallery"
        >
          🖼 Choose from phone
        </button>
      </div>
      {stagePhotos.length > 0 && (
        <div style={{ fontSize: 13, color: "#0e7490", fontWeight: 700, textAlign: "center" }}>
          ✓ {stagePhotos.length} photo{stagePhotos.length === 1 ? "" : "s"} added for this step
        </div>
      )}
      {stagePhotos.length > 0 && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 6 }}>
          {stagePhotos.map((p, i) => (
            <div key={i} style={{ position: "relative" }}>
              <img
                src={p.previewUrl}
                alt={`Photo ${i + 1}`}
                style={{ width: "100%", aspectRatio: "1", objectFit: "cover", borderRadius: 8, border: p.uploaded ? "2px solid #059669" : "1px solid #e5e7eb" }}
              />
              <button
                type="button"
                onClick={() => onRemove(i)}
                style={{
                  position: "absolute",
                  top: 4,
                  right: 4,
                  background: "rgba(0,0,0,0.6)",
                  color: "#fff",
                  border: "none",
                  borderRadius: 999,
                  width: 22,
                  height: 22,
                  cursor: "pointer",
                  fontSize: 12,
                  lineHeight: 1,
                }}
                disabled={submitting}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
      <button
        type="button"
        onClick={onContinue}
        disabled={!ctaEnabled || submitting}
        style={{
          padding: "18px 20px",
          background: !ctaEnabled || submitting ? "#9ca3af" : ctaPrimary ? "#13294b" : "#059669",
          color: "#fff",
          border: "none",
          borderRadius: 12,
          fontWeight: 700,
          fontSize: 18,
          cursor: !ctaEnabled || submitting ? "not-allowed" : "pointer",
        }}
      >
        {ctaLabel}
      </button>
    </section>
  );
}

function SlopeCountStep({ side, story, storyCount, value, onSet, onContinue }) {
  const isFirstSide = side === "left";
  const floorTag = storyCount === 2 ? ` — ${ordinal(story)} floor` : "";
  return (
    <section style={{
      padding: 16,
      background: "#fff",
      borderRadius: 12,
      border: "1px solid #e5e7eb",
      display: "grid",
      gap: 12,
    }}>
      <div>
        <div style={{ fontSize: 22, fontWeight: 700, fontFamily: "'Oswald', sans-serif", lineHeight: 1.2 }}>
          📐 How many {SIDE_LABELS[side]} slopes?{floorTag}
        </div>
        <div style={{ fontSize: 16, color: "#374151", marginTop: 8, lineHeight: 1.5 }}>
          {isFirstSide
            ? <>You're walking the roof <strong>clockwise starting from the LEFT</strong>: left → front → right → rear. Count the slopes you can see on the <strong>{SIDE_LABELS[side]}</strong> side and tap the number. (A "slope" is one flat plane of the roof. Most sides have 1 slope; complex roofs can have 2–4.)</>
            : <>Count the slopes on the <strong>{SIDE_LABELS[side]}</strong> side. Pick <strong>0</strong> if there are none on this side.</>}
        </div>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 6 }}>
        {[0, 1, 2, 3, 4].map((n) => (
          <button
            key={n}
            type="button"
            onClick={() => onSet(n)}
            style={{
              padding: "20px 0",
              background: value === n ? "#0e7490" : "#fff",
              color: value === n ? "#fff" : "#111827",
              border: `2px solid ${value === n ? "#0e7490" : "#d1d5db"}`,
              borderRadius: 10,
              fontWeight: 700,
              fontSize: 22,
              cursor: "pointer",
            }}
          >
            {n}
          </button>
        ))}
      </div>
      <button
        type="button"
        onClick={onContinue}
        disabled={value == null}
        style={{
          padding: "18px 20px",
          background: value == null ? "#9ca3af" : "#059669",
          color: "#fff",
          border: "none",
          borderRadius: 12,
          fontWeight: 700,
          fontSize: 18,
          cursor: value == null ? "not-allowed" : "pointer",
        }}
      >
        {value === 0 ? `No ${SIDE_LABELS[side]} slopes — skip ahead →` : `Continue → take overview photos`}
      </button>
    </section>
  );
}

function stageLabel(stage, slopeCounts, storyCount) {
  const floor = (s) => storyCount === 2 ? ` (${ordinal(s)} floor)` : "";
  if (stage.kind === "house_number") return "House number";
  if (stage.kind === "front_house") return "Front of house";
  if (stage.kind === "story_pick") return "How many stories?";
  if (stage.kind === "roof_overview") return `Roof overview${floor(stage.story)}`;
  if (stage.kind === "story_transition") return "1st floor done — start 2nd floor";
  if (stage.kind === "side_count") return `${SIDE_LABELS[stage.side]} slope count${floor(stage.story)}`;
  if (stage.kind === "side_overview") {
    const seq = slopeSequence(stage, slopeCounts);
    return `${ordinal(seq)} slope overview${floor(stage.story)}`;
  }
  if (stage.kind === "side_damage") {
    const seq = slopeSequence(stage, slopeCounts);
    return `${ordinal(seq)} slope detail${floor(stage.story)}`;
  }
  if (stage.kind === "result") return "Pick result";
  if (stage.kind === "retail_worst") return "Retail — 10 worst photos";
  return "";
}

function nextSideAfter(side) {
  const idx = SIDES.indexOf(side);
  return idx >= 0 && idx + 1 < SIDES.length ? SIDES[idx + 1] : null;
}

function capitalize(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : "";
}

// Cardinal → ordinal English string ("1st", "2nd", "3rd", …, "11th").
function ordinal(n) {
  if (n == null || !Number.isFinite(n)) return "";
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  const mod10 = n % 10;
  if (mod10 === 1) return `${n}st`;
  if (mod10 === 2) return `${n}nd`;
  if (mod10 === 3) return `${n}rd`;
  return `${n}th`;
}

// Slopes are numbered sequentially across all 4 sides on a given
// story. left=2, front=1, right=2, rear=1 → sequence runs 1..6.
// Reset per story (so 2-story labels are "1st…6th (1st floor)",
// then "1st…6th (2nd floor)").
function slopeSequence(stage, slopeCounts) {
  if (stage.kind !== "side_overview" && stage.kind !== "side_damage") return null;
  let seq = 0;
  for (const s of SIDES) {
    if (s === stage.side) break;
    seq += slopeCounts[`${stage.story}_${s}`] || 0;
  }
  return seq + stage.slopeIndex + 1;
}

function labelToSlug(label) {
  return String(label || "photo")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/(^_|_$)/g, "")
    .slice(0, 40);
}

// Client-side image compression. Modern phone cameras spit out 4–8 MB
// JPEGs, which take forever to upload over cell. Scaling the long
// edge to 1000px and re-encoding at JPEG quality 0.7 typically drops
// each photo to ~80–150 KB with no visible quality loss on the kind
// of detail an inspection needs.
//
// Why this small: the cert PDF embeds 10 photos as inline base64. At
// the previous 1600px/0.85, photos were ~400KB each and the rendered
// PDF was ~15MB, which OOM'd the cert-generator Lambda. At 1000px/0.7
// the cert PDF is ~2MB and the Lambda runs comfortably.
//
// Uses createImageBitmap with imageOrientation: 'from-image' so EXIF
// rotation is baked into the bitmap — otherwise portrait photos from
// some Androids come out sideways after the canvas round-trip.
//
// Falls back to the original File on any error (and skips files
// already under 200 KB or already small enough by dimension).
async function resizeImageForUpload(file, maxDim = 1000, quality = 0.7) {
  if (!file || !file.type || !file.type.startsWith("image/")) return file;
  if (file.size < 200 * 1024) return file;
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    const longEdge = Math.max(bitmap.width, bitmap.height);
    if (longEdge <= maxDim) {
      bitmap.close?.();
      return file;
    }
    const scale = maxDim / longEdge;
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close?.();
    const blob = await new Promise((res) => canvas.toBlob(res, "image/jpeg", quality));
    if (!blob || blob.size >= file.size) return file;
    const newName = (file.name || "photo").replace(/\.[a-zA-Z0-9]+$/, "") + ".jpg";
    return new File([blob], newName, { type: "image/jpeg", lastModified: Date.now() });
  } catch (e) {
    console.warn("Image resize failed, using original:", e);
    return file;
  }
}

// ─────────────────────────────────────────────────────────────────────
// Shared style helpers (kept inline so this file is self-contained).
// ─────────────────────────────────────────────────────────────────────
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

// ─────────────────────────────────────────────────────────────────────
// PA Report — list of homeowners sent to the PA in a date window,
// with the signed/refused/pending outcome we got back via the
// pa-ops-hub-status-callback webhook. Useful for closing the loop on
// what's still waiting on the PA vs. what's resolved.
// ─────────────────────────────────────────────────────────────────────
export function PAReportPanel() {
  // Default: last 30 days (inclusive). Manager can stretch or narrow.
  const today = new Date();
  const thirtyAgo = new Date();
  thirtyAgo.setDate(today.getDate() - 29);
  const toISODate = (d) => d.toISOString().slice(0, 10);
  const [fromDate, setFromDate] = useState(toISODate(thirtyAgo));
  const [toDate, setToDate] = useState(toISODate(today));
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState("all");

  async function load() {
    setLoading(true);
    // Query inspections sent to the PA in [fromDate, toDate+1day).
    // pa_intake_sent_at is the timestamp send-to-pa-ops-hub.js writes
    // after a successful POST to her endpoint.
    const fromIso = `${fromDate}T00:00:00Z`;
    const toEnd = new Date(`${toDate}T00:00:00Z`);
    toEnd.setDate(toEnd.getDate() + 1);
    const toIso = toEnd.toISOString();
    const { data, error } = await supabase
      .from("inspections")
      .select("id, client_name, address, city, state, zip, mobile, email, sales_rep_name, signed_at, result, result_at, pa_intake_sent_at, pa_status, pa_status_updated_at, pa_status_notes, jn_job_id")
      .gte("pa_intake_sent_at", fromIso)
      .lt("pa_intake_sent_at", toIso)
      .order("pa_intake_sent_at", { ascending: false });
    if (!error && Array.isArray(data)) setRows(data);
    else setRows([]);
    setLoading(false);
  }

  useEffect(() => { load(); }, []);

  const counts = useMemo(() => {
    const c = { total: rows.length, pending: 0, signed: 0, refused: 0 };
    for (const r of rows) {
      const s = (r.pa_status || "pending").toLowerCase();
      if (s === "signed") c.signed++;
      else if (s === "refused") c.refused++;
      else c.pending++;
    }
    return c;
  }, [rows]);

  const filteredRows = useMemo(() => {
    if (statusFilter === "all") return rows;
    return rows.filter((r) => (r.pa_status || "pending").toLowerCase() === statusFilter);
  }, [rows, statusFilter]);

  const fmtDateTime = (iso) => iso ? new Date(iso).toLocaleString() : "—";
  const fmtRelative = (iso) => {
    if (!iso) return "";
    const diffMs = Date.now() - new Date(iso).getTime();
    const days = Math.floor(diffMs / 86400000);
    if (days <= 0) return "today";
    if (days === 1) return "1 day ago";
    return `${days} days ago`;
  };

  function statusPill(s) {
    const status = (s || "pending").toLowerCase();
    if (status === "signed") {
      return <span style={{ background: "#199c2e", color: "#fff", borderRadius: 20, padding: "3px 10px", fontSize: 10, fontWeight: 700, fontFamily: "'Oswald', sans-serif", whiteSpace: "nowrap" }}>🤝 SIGNED</span>;
    }
    if (status === "refused") {
      return <span style={{ background: "#6b7280", color: "#fff", borderRadius: 20, padding: "3px 10px", fontSize: 10, fontWeight: 700, fontFamily: "'Oswald', sans-serif", whiteSpace: "nowrap" }}>🚫 REFUSED</span>;
    }
    return <span style={{ background: "#fef3c7", color: "#92400e", border: "1px solid #fbbf24", borderRadius: 20, padding: "3px 10px", fontSize: 10, fontWeight: 700, fontFamily: "'Oswald', sans-serif", whiteSpace: "nowrap" }}>⏳ PENDING</span>;
  }

  function csvExport() {
    const header = ["Sent At","Homeowner","Address","Sales Rep","PA Status","Status Updated","Days Pending","Notes"];
    const lines = [header.join(",")];
    for (const r of filteredRows) {
      const sent = r.pa_intake_sent_at ? new Date(r.pa_intake_sent_at).toISOString() : "";
      const updated = r.pa_status_updated_at ? new Date(r.pa_status_updated_at).toISOString() : "";
      const fullAddr = [r.address, r.city, r.state, r.zip].filter(Boolean).join(" ");
      const daysPending = r.pa_intake_sent_at && (r.pa_status || "pending").toLowerCase() === "pending"
        ? Math.floor((Date.now() - new Date(r.pa_intake_sent_at).getTime()) / 86400000)
        : "";
      const escape = (v) => {
        const s = String(v ?? "");
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      };
      lines.push([sent, r.client_name || "", fullAddr, r.sales_rep_name || "", r.pa_status || "pending", updated, daysPending, r.pa_status_notes || ""].map(escape).join(","));
    }
    const blob = new Blob([lines.join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `pa-report-${fromDate}-to-${toDate}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div>
      <h2 style={{ marginTop: 0, fontFamily: "'Oswald', sans-serif", fontSize: 22 }}>🤝 PA Report</h2>
      <p style={{ color: "#6b7280", fontSize: 13, marginTop: 0, lineHeight: 1.5 }}>
        Every homeowner we sent to the PA in this date range, with the signed / refused / pending outcome she returned. Pending = sent but the PA hasn't marked it yet.
      </p>

      {/* Date pickers + refresh + CSV */}
      <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", marginBottom: 16 }}>
        <label style={{ fontSize: 12, fontFamily: "'Oswald', sans-serif", fontWeight: 700, color: "#374151" }}>From:
          <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)}
            style={{ marginLeft: 6, padding: "6px 10px", borderRadius: 8, border: "1.5px solid #d1d5db", fontSize: 13, fontFamily: "'Nunito', sans-serif" }} />
        </label>
        <label style={{ fontSize: 12, fontFamily: "'Oswald', sans-serif", fontWeight: 700, color: "#374151" }}>To:
          <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)}
            style={{ marginLeft: 6, padding: "6px 10px", borderRadius: 8, border: "1.5px solid #d1d5db", fontSize: 13, fontFamily: "'Nunito', sans-serif" }} />
        </label>
        <button type="button" onClick={load} disabled={loading}
          style={{ padding: "8px 16px", borderRadius: 8, border: "1.5px solid #0a0a0a", background: "#0a0a0a", color: "#fff", fontSize: 12, fontFamily: "'Oswald', sans-serif", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.04em", cursor: loading ? "wait" : "pointer" }}>
          {loading ? "Loading…" : "🔄 Refresh"}
        </button>
        <button type="button" onClick={csvExport} disabled={loading || filteredRows.length === 0}
          style={{ padding: "8px 16px", borderRadius: 8, border: "1.5px solid #0e7490", background: "#ecfeff", color: "#0e7490", fontSize: 12, fontFamily: "'Oswald', sans-serif", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.04em", cursor: (loading || filteredRows.length === 0) ? "not-allowed" : "pointer" }}>
          ⬇ Export CSV
        </button>
      </div>

      {/* Summary tiles + status filter */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(140px, 1fr))", gap: 12, marginBottom: 16 }}>
        {[
          { key: "all", label: "Total Sent", count: counts.total, bg: "#eef1f8", color: "#1a2e5a" },
          { key: "pending", label: "Pending", count: counts.pending, bg: "#fef3c7", color: "#92400e" },
          { key: "signed", label: "Signed", count: counts.signed, bg: "#dcfce7", color: "#065f46" },
          { key: "refused", label: "Refused", count: counts.refused, bg: "#f3f4f6", color: "#374151" },
        ].map((tile) => (
          <button key={tile.key} type="button" onClick={() => setStatusFilter(tile.key)}
            style={{
              padding: "14px 16px",
              borderRadius: 12,
              border: statusFilter === tile.key ? "2px solid #0a0a0a" : "1.5px solid #e5e7eb",
              background: tile.bg,
              color: tile.color,
              cursor: "pointer",
              textAlign: "left",
              fontFamily: "'Oswald', sans-serif",
            }}>
            <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", opacity: 0.85 }}>{tile.label}</div>
            <div style={{ fontSize: 28, fontWeight: 700, marginTop: 4 }}>{tile.count}</div>
          </button>
        ))}
      </div>

      {/* Rows */}
      {loading ? (
        <div style={{ padding: 20, color: "#6b7280", fontSize: 13 }}>Loading…</div>
      ) : filteredRows.length === 0 ? (
        <div style={{ padding: 20, color: "#6b7280", fontSize: 13, background: "#fff", border: "1px dashed #e5e7eb", borderRadius: 12 }}>
          {statusFilter === "all"
            ? "No homeowners were sent to the PA in this date range."
            : `No homeowners with status "${statusFilter}" in this date range.`}
        </div>
      ) : (
        <div style={{ display: "grid", gap: 10 }}>
          {filteredRows.map((r) => {
            const status = (r.pa_status || "pending").toLowerCase();
            const daysPending = status === "pending" && r.pa_intake_sent_at
              ? Math.floor((Date.now() - new Date(r.pa_intake_sent_at).getTime()) / 86400000)
              : null;
            return (
              <div key={r.id} style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12, padding: "12px 16px", display: "grid", gridTemplateColumns: "1fr auto", gap: 12, alignItems: "start" }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 700, color: "#111827", fontFamily: "'Nunito', sans-serif" }}>{r.client_name || "—"}</div>
                  <div style={{ fontSize: 12, color: "#6b7280", fontFamily: "'Nunito', sans-serif" }}>{[r.address, r.city, r.state, r.zip].filter(Boolean).join(", ")}</div>
                  <div style={{ fontSize: 11, color: "#9ca3af", fontFamily: "'Nunito', sans-serif", marginTop: 4 }}>
                    Rep: {r.sales_rep_name || "—"} · Sent to PA: <strong style={{ color: "#374151" }}>{fmtDateTime(r.pa_intake_sent_at)}</strong> ({fmtRelative(r.pa_intake_sent_at)})
                  </div>
                  {r.pa_status_notes ? (
                    <div style={{ fontSize: 11, color: "#475569", fontFamily: "'Nunito', sans-serif", marginTop: 6, padding: "6px 10px", background: "#f8fafc", borderRadius: 6, borderLeft: "3px solid #cbd5e1" }}>
                      PA notes: {r.pa_status_notes}
                    </div>
                  ) : null}
                </div>
                <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4 }}>
                  {statusPill(r.pa_status)}
                  {r.pa_status_updated_at && status !== "pending" ? (
                    <div style={{ fontSize: 10, color: "#9ca3af", fontFamily: "'Nunito', sans-serif" }}>
                      {status} {fmtRelative(r.pa_status_updated_at)}
                    </div>
                  ) : null}
                  {daysPending !== null && daysPending >= 3 ? (
                    <div style={{ fontSize: 10, color: "#dc2626", fontFamily: "'Oswald', sans-serif", fontWeight: 700 }}>
                      {daysPending}d waiting
                    </div>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Sit Sold PA report — records currently in JN at status "Sit Sold PA".
// This is the OLD PA workflow (records the rep manually pushed to PA
// inside JN before our automated PA Ops Hub integration). Useful for
// knowing what the old PA still owes us on. Distinct from PAReportPanel
// which tracks only records sent via the new automated handoff.
// ─────────────────────────────────────────────────────────────────────
export function SitSoldPaReportPanel() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [resultFilter, setResultFilter] = useState("all");

  async function load() {
    setLoading(true);
    // Sync runs on a cron so jn_status reflects JN's view as of the
    // last sync (usually within an hour). We pull all rows at this
    // status — there's no date bound because the old PA workflow has
    // no SLA on how long records sit.
    const { data, error } = await supabase
      .from("inspections")
      .select("id, client_name, address, city, state, zip, mobile, email, sales_rep_name, signed_at, result, result_at, jn_status, jn_job_id, pa_status, pa_status_updated_at, pa_intake_sent_at, cancelled_at")
      .eq("jn_status", "Sit Sold PA")
      .is("cancelled_at", null)
      .order("signed_at", { ascending: false });
    if (!error && Array.isArray(data)) setRows(data);
    else setRows([]);
    setLoading(false);
  }

  useEffect(() => { load(); }, []);

  const counts = useMemo(() => {
    const c = { total: rows.length, damage: 0, no_damage: 0, retail: 0, no_result: 0 };
    for (const r of rows) {
      const k = (r.result || "").toLowerCase();
      if (k === "damage") c.damage++;
      else if (k === "no_damage") c.no_damage++;
      else if (k === "retail") c.retail++;
      else c.no_result++;
    }
    return c;
  }, [rows]);

  const filteredRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (resultFilter !== "all") {
        const k = (r.result || "").toLowerCase();
        if (resultFilter === "no_result" ? !!k : k !== resultFilter) return false;
      }
      if (!q) return true;
      const blob = [r.client_name, r.address, r.city, r.zip, r.sales_rep_name].filter(Boolean).join(" ").toLowerCase();
      return blob.includes(q);
    });
  }, [rows, search, resultFilter]);

  const fmtDateTime = (iso) => iso ? new Date(iso).toLocaleString() : "—";
  const fmtRelative = (iso) => {
    if (!iso) return "";
    const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
    if (days <= 0) return "today";
    if (days === 1) return "1 day ago";
    return `${days} days ago`;
  };

  function resultPill(r) {
    const k = (r || "").toLowerCase();
    if (k === "damage") return <span style={{ background: "#dc2626", color: "#fff", borderRadius: 20, padding: "3px 10px", fontSize: 10, fontWeight: 700, fontFamily: "'Oswald', sans-serif" }}>⚠ DAMAGE</span>;
    if (k === "no_damage") return <span style={{ background: "#16a34a", color: "#fff", borderRadius: 20, padding: "3px 10px", fontSize: 10, fontWeight: 700, fontFamily: "'Oswald', sans-serif" }}>✓ NO DAMAGE</span>;
    if (k === "retail") return <span style={{ background: "#d97706", color: "#fff", borderRadius: 20, padding: "3px 10px", fontSize: 10, fontWeight: 700, fontFamily: "'Oswald', sans-serif" }}>🏠 RETAIL</span>;
    return <span style={{ background: "#f3f4f6", color: "#6b7280", border: "1px solid #d1d5db", borderRadius: 20, padding: "3px 10px", fontSize: 10, fontWeight: 700, fontFamily: "'Oswald', sans-serif" }}>NO RESULT</span>;
  }

  function csvExport() {
    const header = ["Signed At","Homeowner","Address","Phone","Email","Sales Rep","Result","Days Since Signed","New PA Status","JN Job"];
    const lines = [header.join(",")];
    for (const r of filteredRows) {
      const signed = r.signed_at ? new Date(r.signed_at).toISOString() : "";
      const fullAddr = [r.address, r.city, r.state, r.zip].filter(Boolean).join(" ");
      const daysSince = r.signed_at ? Math.floor((Date.now() - new Date(r.signed_at).getTime()) / 86400000) : "";
      const escape = (v) => {
        const s = String(v ?? "");
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      };
      lines.push([signed, r.client_name || "", fullAddr, r.mobile || "", r.email || "", r.sales_rep_name || "", r.result || "", daysSince, r.pa_status || "", r.jn_job_id || ""].map(escape).join(","));
    }
    const blob = new Blob([lines.join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `sit-sold-pa-${new Date().toISOString().slice(0,10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div>
      <h2 style={{ marginTop: 0, fontFamily: "'Oswald', sans-serif", fontSize: 22 }}>📋 Sit Sold PA (Old PA)</h2>
      <p style={{ color: "#6b7280", fontSize: 13, marginTop: 0, lineHeight: 1.5 }}>
        Records currently at <strong>jn_status = "Sit Sold PA"</strong> in JobNimbus — what the old PA workflow still has on its plate. Pulled live from our last JN sync (usually within an hour). Distinct from the <em>PA Report</em> which tracks the new automated handoff.
      </p>

      <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", marginBottom: 16 }}>
        <input type="text" placeholder="🔍 Search name, address, rep…" value={search} onChange={(e) => setSearch(e.target.value)}
          style={{ flex: 1, minWidth: 200, padding: "8px 12px", borderRadius: 8, border: "1.5px solid #d1d5db", fontSize: 13, fontFamily: "'Nunito', sans-serif" }} />
        <button type="button" onClick={load} disabled={loading}
          style={{ padding: "8px 16px", borderRadius: 8, border: "1.5px solid #0a0a0a", background: "#0a0a0a", color: "#fff", fontSize: 12, fontFamily: "'Oswald', sans-serif", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.04em", cursor: loading ? "wait" : "pointer" }}>
          {loading ? "Loading…" : "🔄 Refresh"}
        </button>
        <button type="button" onClick={csvExport} disabled={loading || filteredRows.length === 0}
          style={{ padding: "8px 16px", borderRadius: 8, border: "1.5px solid #0e7490", background: "#ecfeff", color: "#0e7490", fontSize: 12, fontFamily: "'Oswald', sans-serif", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.04em", cursor: (loading || filteredRows.length === 0) ? "not-allowed" : "pointer" }}>
          ⬇ Export CSV
        </button>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(5, minmax(120px, 1fr))", gap: 12, marginBottom: 16 }}>
        {[
          { key: "all", label: "All Sit Sold PA", count: counts.total, bg: "#eef1f8", color: "#1a2e5a" },
          { key: "damage", label: "Damage", count: counts.damage, bg: "#fef2f2", color: "#991b1b" },
          { key: "retail", label: "Retail", count: counts.retail, bg: "#fef3c7", color: "#92400e" },
          { key: "no_damage", label: "No Damage", count: counts.no_damage, bg: "#dcfce7", color: "#065f46" },
          { key: "no_result", label: "No Result", count: counts.no_result, bg: "#f3f4f6", color: "#374151" },
        ].map((tile) => (
          <button key={tile.key} type="button" onClick={() => setResultFilter(tile.key)}
            style={{
              padding: "14px 16px",
              borderRadius: 12,
              border: resultFilter === tile.key ? "2px solid #0a0a0a" : "1.5px solid #e5e7eb",
              background: tile.bg,
              color: tile.color,
              cursor: "pointer",
              textAlign: "left",
              fontFamily: "'Oswald', sans-serif",
            }}>
            <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", opacity: 0.85 }}>{tile.label}</div>
            <div style={{ fontSize: 28, fontWeight: 700, marginTop: 4 }}>{tile.count}</div>
          </button>
        ))}
      </div>

      {loading ? (
        <div style={{ padding: 20, color: "#6b7280", fontSize: 13 }}>Loading…</div>
      ) : filteredRows.length === 0 ? (
        <div style={{ padding: 20, color: "#6b7280", fontSize: 13, background: "#fff", border: "1px dashed #e5e7eb", borderRadius: 12 }}>
          {rows.length === 0
            ? 'No records currently at jn_status "Sit Sold PA".'
            : "No records match your filter."}
        </div>
      ) : (
        <div style={{ display: "grid", gap: 10 }}>
          {filteredRows.map((r) => {
            const daysSinceSigned = r.signed_at
              ? Math.floor((Date.now() - new Date(r.signed_at).getTime()) / 86400000)
              : null;
            const stale = daysSinceSigned !== null && daysSinceSigned >= 14;
            return (
              <div key={r.id} style={{ background: "#fff", border: stale ? "2px solid #fca5a5" : "1px solid #e5e7eb", borderRadius: 12, padding: "12px 16px", display: "grid", gridTemplateColumns: "1fr auto", gap: 12, alignItems: "start" }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 700, color: "#111827", fontFamily: "'Nunito', sans-serif" }}>{r.client_name || "—"}</div>
                  <div style={{ fontSize: 12, color: "#6b7280", fontFamily: "'Nunito', sans-serif" }}>{[r.address, r.city, r.state, r.zip].filter(Boolean).join(", ")}</div>
                  <div style={{ fontSize: 11, color: "#9ca3af", fontFamily: "'Nunito', sans-serif", marginTop: 4 }}>
                    Rep: {r.sales_rep_name || "—"} · Signed: <strong style={{ color: "#374151" }}>{fmtDateTime(r.signed_at)}</strong> ({fmtRelative(r.signed_at)})
                    {r.mobile ? <> · 📱 {r.mobile}</> : null}
                  </div>
                </div>
                <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4 }}>
                  {resultPill(r.result)}
                  {stale ? (
                    <div style={{ fontSize: 10, color: "#dc2626", fontFamily: "'Oswald', sans-serif", fontWeight: 700 }}>
                      {daysSinceSigned}d STALE
                    </div>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
