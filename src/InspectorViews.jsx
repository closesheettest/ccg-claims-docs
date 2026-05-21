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
  // Add form state
  const [newName, setNewName] = useState("");
  const [newAddress, setNewAddress] = useState("");
  const [newLat, setNewLat] = useState("");
  const [newLng, setNewLng] = useState("");
  const [newMaxMiles, setNewMaxMiles] = useState("");
  const [findingCoords, setFindingCoords] = useState(false);
  const [adding, setAdding] = useState(false);
  // JN sync state
  const [syncing, setSyncing] = useState(false);
  // Per-row "send setup email" state
  const [sendingEmailId, setSendingEmailId] = useState(null);
  // Bulk-geocode state (for the one-time "give every old inspection
  // lat/lng" backfill — needed before mile distances appear).
  const [geocoding, setGeocoding] = useState(false);
  // Reassign panel state — claimed inspections + the selected one
  const [claimedJobs, setClaimedJobs] = useState([]);
  const [busyJobId, setBusyJobId] = useState(null);

  useEffect(() => {
    loadInspectors();
    loadClaimedJobs();
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

  async function loadInspectors() {
    setLoading(true);
    const { data, error } = await supabase
      .from("inspectors")
      .select("*")
      .order("name", { ascending: true });
    if (error) setMessage({ kind: "error", text: error.message });
    else setInspectors(data || []);
    setLoading(false);
  }

  async function loadClaimedJobs() {
    // Every inspection currently assigned to an inspector — manager
    // can override / un-assign each one.
    const { data } = await supabase
      .from("inspections")
      .select("id, client_name, address, city, signed_at, inspector_id, result")
      .not("inspector_id", "is", null)
      .order("signed_at", { ascending: false })
      .limit(100);
    setClaimedJobs(data || []);
  }

  async function findCoordsForNewInspector() {
    const query = newAddress.trim() || newName.trim();
    if (!query) {
      setMessage({ kind: "error", text: "Enter an address (or name) first." });
      return;
    }
    setFindingCoords(true);
    try {
      const res = await fetch("/.netlify/functions/geocode-place", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query }),
      });
      const body = await res.json().catch(() => ({}));
      if (!body.ok) {
        setMessage({ kind: "error", text: body.error || "Geocode failed" });
      } else {
        setNewLat(String(body.lat));
        setNewLng(String(body.lng));
        setMessage({ kind: "success", text: `Found: ${body.formatted_address}` });
      }
    } catch (e) {
      setMessage({ kind: "error", text: e.message || "Network error" });
    }
    setFindingCoords(false);
  }

  async function addInspector(e) {
    e?.preventDefault?.();
    if (!newName.trim()) {
      setMessage({ kind: "error", text: "Name is required." });
      return;
    }
    setAdding(true);
    const lat = newLat.trim() ? parseFloat(newLat) : null;
    const lng = newLng.trim() ? parseFloat(newLng) : null;
    const max = newMaxMiles.trim() ? parseInt(newMaxMiles, 10) : null;
    const { error } = await supabase.from("inspectors").insert({
      name: newName.trim(),
      latitude: Number.isFinite(lat) ? lat : null,
      longitude: Number.isFinite(lng) ? lng : null,
      max_distance_miles: Number.isFinite(max) ? max : null,
      active: true,
    });
    setAdding(false);
    if (error) {
      setMessage({ kind: "error", text: error.message });
      return;
    }
    setMessage({ kind: "success", text: `Added ${newName.trim()}.` });
    setNewName("");
    setNewAddress("");
    setNewLat("");
    setNewLng("");
    setNewMaxMiles("");
    loadInspectors();
  }

  async function toggleActive(insp) {
    const { error } = await supabase
      .from("inspectors")
      .update({ active: !insp.active })
      .eq("id", insp.id);
    if (error) return setMessage({ kind: "error", text: error.message });
    loadInspectors();
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
      .update({ inspector_id: null })
      .eq("inspector_id", insp.id);
    const { error } = await supabase.from("inspectors").delete().eq("id", insp.id);
    if (error) return setMessage({ kind: "error", text: error.message });
    setMessage({ kind: "success", text: `Removed ${insp.name}.` });
    loadInspectors();
    loadClaimedJobs();
  }

  async function reassignJob(jobId, newInspectorId) {
    setBusyJobId(jobId);
    const { error } = await supabase
      .from("inspections")
      .update({ inspector_id: newInspectorId || null })
      .eq("id", jobId);
    setBusyJobId(null);
    if (error) return setMessage({ kind: "error", text: error.message });
    setMessage({
      kind: "success",
      text: newInspectorId ? "Reassigned." : "Released to unassigned pool.",
    });
    loadClaimedJobs();
  }

  const inspectorById = useMemo(
    () => new Map(inspectors.map((i) => [i.id, i])),
    [inspectors],
  );

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

      {/* Add inspector */}
      <section style={{ border: "1px solid #e5e7eb", borderRadius: 12, padding: 16, background: "#fff" }}>
        <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 10 }}>➕ Add inspector</div>
        <form onSubmit={addInspector} style={{ display: "grid", gap: 10 }}>
          <input
            type="text"
            placeholder="Name (e.g. John Doe)"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            style={inputStyle}
            disabled={adding}
            required
          />
          <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 8 }}>
            <input
              type="text"
              placeholder="Home address (used to find lat/lng)"
              value={newAddress}
              onChange={(e) => setNewAddress(e.target.value)}
              style={inputStyle}
              disabled={adding || findingCoords}
            />
            <button
              type="button"
              onClick={findCoordsForNewInspector}
              disabled={adding || findingCoords || !newAddress.trim()}
              style={{ ...secondaryBtn, padding: "8px 12px" }}
            >
              {findingCoords ? "Finding…" : "📍 Find lat/lng"}
            </button>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr auto", gap: 8 }}>
            <input
              type="number"
              step="any"
              placeholder="Latitude"
              value={newLat}
              onChange={(e) => setNewLat(e.target.value)}
              style={inputStyle}
              disabled={adding}
            />
            <input
              type="number"
              step="any"
              placeholder="Longitude"
              value={newLng}
              onChange={(e) => setNewLng(e.target.value)}
              style={inputStyle}
              disabled={adding}
            />
            <input
              type="number"
              placeholder="Max miles (blank = no limit)"
              value={newMaxMiles}
              onChange={(e) => setNewMaxMiles(e.target.value)}
              style={inputStyle}
              disabled={adding}
            />
            <button
              type="submit"
              disabled={adding || !newName.trim()}
              style={{ ...primaryBtn, padding: "8px 14px" }}
            >
              {adding ? "Adding…" : "Add"}
            </button>
          </div>
        </form>
      </section>

      {/* List inspectors */}
      <section style={{ border: "1px solid #e5e7eb", borderRadius: 12, padding: 16, background: "#fff" }}>
        <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 10 }}>
          👷 All inspectors ({inspectors.length})
        </div>
        {loading ? (
          <div style={{ fontSize: 13, color: "#6b7280" }}>Loading…</div>
        ) : inspectors.length === 0 ? (
          <div style={{ fontSize: 13, color: "#6b7280" }}>No inspectors yet — add one above.</div>
        ) : (
          <div style={{ display: "grid", gap: 8 }}>
            {inspectors.map((insp) => (
              <InspectorRow
                key={insp.id}
                insp={insp}
                sendingEmail={sendingEmailId === insp.id}
                onToggle={() => toggleActive(insp)}
                onUpdate={(patch) => updateInspector(insp, patch)}
                onDelete={() => deleteInspector(insp)}
                onSendUpdateLink={() => sendUpdateLink(insp)}
              />
            ))}
          </div>
        )}
      </section>

      {/* Reassign in-progress jobs */}
      <section style={{ border: "1px solid #e5e7eb", borderRadius: 12, padding: 16, background: "#fff" }}>
        <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 4 }}>
          🔁 Claimed inspections ({claimedJobs.length})
        </div>
        <div style={{ fontSize: 11, color: "#6b7280", marginBottom: 10 }}>
          Override-reassign or release back to the unassigned pool.
        </div>
        {claimedJobs.length === 0 ? (
          <div style={{ fontSize: 13, color: "#6b7280" }}>Nothing claimed right now.</div>
        ) : (
          <div style={{ display: "grid", gap: 6 }}>
            {claimedJobs.map((job) => {
              const ass = inspectorById.get(job.inspector_id);
              return (
                <div
                  key={job.id}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1fr auto auto",
                    gap: 8,
                    alignItems: "center",
                    padding: "8px 10px",
                    background: "#f9fafb",
                    borderRadius: 8,
                    fontSize: 12,
                  }}
                >
                  <div>
                    <div style={{ fontWeight: 600 }}>{job.client_name || "(no name)"}</div>
                    <div style={{ fontSize: 11, color: "#6b7280" }}>
                      {job.address}, {job.city} · claimed by {ass?.name || "(unknown)"}
                      {job.result && <> · <span style={{ color: "#059669" }}>✓ {job.result}</span></>}
                    </div>
                  </div>
                  <select
                    value={job.inspector_id || ""}
                    onChange={(e) => reassignJob(job.id, e.target.value || null)}
                    disabled={busyJobId === job.id}
                    style={{ ...inputStyle, padding: "4px 6px", fontSize: 12 }}
                  >
                    <option value="">— Unassign —</option>
                    {inspectors.filter((i) => i.active).map((i) => (
                      <option key={i.id} value={i.id}>{i.name}</option>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={() => reassignJob(job.id, null)}
                    disabled={busyJobId === job.id}
                    style={{ ...secondaryBtn, padding: "4px 10px", fontSize: 11 }}
                  >
                    Release
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}

function InspectorRow({ insp, sendingEmail, onToggle, onUpdate, onDelete, onSendUpdateLink }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({
    name: insp.name,
    latitude: insp.latitude ?? "",
    longitude: insp.longitude ?? "",
    max_distance_miles: insp.max_distance_miles ?? "",
  });
  const setupDone = !!insp.info_updated_at;
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
              {insp.latitude != null && insp.longitude != null
                ? `📍 ${insp.latitude.toFixed(4)}, ${insp.longitude.toFixed(4)}`
                : "📍 No home base set"}
              {insp.max_distance_miles ? ` · max ${insp.max_distance_miles} mi` : " · no mile cap"}
            </div>
          </div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", justifyContent: "flex-end" }}>
            {(insp.email || insp.phone) && onSendUpdateLink && (
              <button
                type="button"
                onClick={onSendUpdateLink}
                disabled={sendingEmail}
                style={{
                  ...secondaryBtn,
                  fontSize: 11,
                  background: setupDone ? "#fff" : "#fef3c7",
                  borderColor: setupDone ? "#d1d5db" : "#fbbf24",
                }}
                title={
                  insp.phone
                    ? `Will SMS to ${insp.phone}`
                    : `Will email to ${insp.email}`
                }
              >
                {sendingEmail
                  ? "Sending…"
                  : setupDone
                    ? (insp.phone ? "📱 Send update SMS" : "📧 Send update email")
                    : (insp.phone ? "📱 Send setup SMS" : "📧 Send setup email")}
              </button>
            )}
            <button type="button" onClick={onToggle} style={{ ...secondaryBtn, fontSize: 11 }}>
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
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6 }}>
            <input
              type="number"
              step="any"
              value={draft.latitude}
              onChange={(e) => setDraft({ ...draft, latitude: e.target.value })}
              style={inputStyle}
              placeholder="Latitude"
            />
            <input
              type="number"
              step="any"
              value={draft.longitude}
              onChange={(e) => setDraft({ ...draft, longitude: e.target.value })}
              style={inputStyle}
              placeholder="Longitude"
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
// MOBILE APP — inspector-side. Self-serve.
// ═════════════════════════════════════════════════════════════════════

export function InspectorMobileApp({ onExit }) {
  const [stage, setStage] = useState("pick"); // pick | list | detail
  const [inspectors, setInspectors] = useState([]);
  const [me, setMe] = useState(null);
  // Persist the picked inspector in localStorage so the next visit
  // remembers them (same pattern as personas in TMS).
  useEffect(() => {
    const stored = localStorage.getItem("ccg_inspector_id");
    if (stored) {
      // Will hydrate after inspectors load.
    }
  }, []);
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
      .then(({ data }) => {
      const list = data || [];
      setInspectors(list);
      const stored = localStorage.getItem("ccg_inspector_id");
      if (stored) {
        const found = list.find((i) => i.id === stored);
        if (found) {
          setMe(found);
          setStage("list");
        }
      }
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
          {onExit && (
            <button type="button" onClick={onExit} style={{ ...secondaryBtn, fontSize: 11 }}>
              ← Main app
            </button>
          )}
        </div>
      </div>

      {stage === "pick" && (
        <InspectorPickName inspectors={inspectors} onPick={pickMe} />
      )}

      {stage === "list" && me && (
        <InspectorJobList
          me={me}
          onOpenJob={(jobId) => setStage({ kind: "detail", jobId })}
        />
      )}

      {stage && stage.kind === "detail" && me && (
        <InspectorJobDetail
          me={me}
          jobId={stage.jobId}
          onBack={() => setStage("list")}
        />
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

function InspectorJobList({ me, onOpenJob }) {
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
    const { error } = await supabase
      .from("inspections")
      .update({ inspector_id: me.id })
      .eq("id", jobId)
      .is("inspector_id", null); // optimistic — fails if someone beat me
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
      <div style={{ padding: 12, background: "#fff", borderRadius: 10, border: "1px solid #e5e7eb" }}>
        <div style={{ fontSize: 14, color: "#6b7280" }}>Signed in as</div>
        <div style={{ fontSize: 18, fontWeight: 700 }}>👷 {me.name}</div>
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
  // Tap-to-navigate URL — opens default maps app on iOS/Android, or
  // Google Maps in the browser on desktop. Universal `?q=` query param
  // accepts a freeform address.
  const navUrl = job.latitude != null && job.longitude != null
    ? `https://maps.google.com/?q=${job.latitude},${job.longitude}`
    : `https://maps.google.com/?q=${encodeURIComponent(
        [job.address, job.city, job.state, job.zip].filter(Boolean).join(", "),
      )}`;
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

function InspectorJobDetail({ me, jobId, onBack }) {
  const [job, setJob] = useState(null);
  const [loading, setLoading] = useState(true);
  const [photos, setPhotos] = useState([]); // [{ file, previewUrl, uploaded: false, path }]
  const [resultChoice, setResultChoice] = useState(""); // damage | no_damage | retail
  const [submitting, setSubmitting] = useState(false);
  const [submitMsg, setSubmitMsg] = useState(null);
  const fileInputRef = useRef(null);

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

  function onFilesPicked(e) {
    const files = Array.from(e.target.files || []);
    const additions = files.map((f) => ({
      file: f,
      previewUrl: URL.createObjectURL(f),
      uploaded: false,
      path: null,
    }));
    setPhotos((prev) => [...prev, ...additions]);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function removePhoto(i) {
    setPhotos((prev) => prev.filter((_, idx) => idx !== i));
  }

  async function submit() {
    if (!resultChoice) {
      setSubmitMsg({ kind: "error", text: "Pick a result first." });
      return;
    }
    setSubmitting(true);
    setSubmitMsg(null);
    try {
      // 1. Upload each photo to Supabase Storage.
      const uploadedPaths = [];
      for (let i = 0; i < photos.length; i++) {
        const p = photos[i];
        if (p.uploaded) {
          uploadedPaths.push(p.path);
          continue;
        }
        const ext = (p.file.name.split(".").pop() || "jpg").toLowerCase();
        const ts = new Date().toISOString().replace(/[:.]/g, "-");
        const path = `${PHOTO_PATH_PREFIX}/${jobId}/${ts}_${i}.${ext}`;
        const { error } = await supabase.storage
          .from(SIGNED_BUCKET)
          .upload(path, p.file, {
            contentType: p.file.type || "image/jpeg",
            upsert: false,
          });
        if (error) {
          setSubmitMsg({ kind: "error", text: `Upload failed (photo ${i + 1}): ${error.message}` });
          setSubmitting(false);
          return;
        }
        uploadedPaths.push(path);
        setPhotos((prev) => prev.map((x, idx) => idx === i ? { ...x, uploaded: true, path } : x));
      }

      // 2. Hand off to the server function for JN photo upload + PA PDN.
      const res = await fetch("/.netlify/functions/inspector-submit-result", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          inspectionId: jobId,
          result: resultChoice,
          inspector_name: me.name,
          photo_paths: uploadedPaths,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!body.ok) {
        setSubmitMsg({ kind: "error", text: body.error || `Submit failed: ${res.status}` });
        setSubmitting(false);
        return;
      }
      setSubmitMsg({
        kind: "success",
        text:
          `Done. ${body.jn_photos_uploaded || 0} of ${uploadedPaths.length} photos pushed to JN. ` +
          (body.pa_pdn_fired ? "PA Ops Hub notified." : ""),
      });
      setTimeout(() => {
        onBack();
      }, 1500);
    } catch (e) {
      setSubmitMsg({ kind: "error", text: e.message || "Unknown error" });
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

  return (
    <div style={{ display: "grid", gap: 14 }}>
      <button type="button" onClick={onBack} style={{ ...secondaryBtn, alignSelf: "flex-start", fontSize: 12 }}>
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
            Rep: {job.sales_rep_name}
            {job.mobile && <> · {job.mobile}</>}
          </div>
        )}
        {job.signed_at && (
          <div style={{ fontSize: 11, color: "#9ca3af", marginTop: 4 }}>
            Signed: {new Date(job.signed_at).toLocaleString()}
          </div>
        )}
      </div>

      <section>
        <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 8 }}>
          📸 Roof photos ({photos.length})
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          capture="environment"
          multiple
          onChange={onFilesPicked}
          style={{ display: "none" }}
        />
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          style={{
            padding: "14px 18px",
            background: "#0ea5e9",
            color: "#fff",
            border: "none",
            borderRadius: 12,
            fontWeight: 700,
            fontSize: 15,
            cursor: "pointer",
            width: "100%",
          }}
        >
          📷 Take / pick photos
        </button>
        {photos.length > 0 && (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 6, marginTop: 10 }}>
            {photos.map((p, i) => (
              <div key={i} style={{ position: "relative" }}>
                <img
                  src={p.previewUrl}
                  alt={`Photo ${i + 1}`}
                  style={{ width: "100%", aspectRatio: "1", objectFit: "cover", borderRadius: 8, border: p.uploaded ? "2px solid #059669" : "1px solid #e5e7eb" }}
                />
                <button
                  type="button"
                  onClick={() => removePhoto(i)}
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
                {p.uploaded && (
                  <div style={{
                    position: "absolute", bottom: 4, left: 4,
                    fontSize: 10, padding: "2px 5px",
                    background: "#059669", color: "#fff", borderRadius: 4,
                  }}>✓ uploaded</div>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      <section>
        <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 8 }}>Result</div>
        <div style={{ display: "grid", gap: 8 }}>
          {[
            { key: "damage", label: "🚨 Damage — file PA claim", color: "#dc2626" },
            { key: "retail", label: "💰 Retail — homeowner pays", color: "#7c3aed" },
            { key: "no_damage", label: "✓ No damage", color: "#059669" },
          ].map((opt) => (
            <button
              key={opt.key}
              type="button"
              onClick={() => setResultChoice(opt.key)}
              style={{
                padding: "14px 16px",
                background: resultChoice === opt.key ? opt.color : "#fff",
                color: resultChoice === opt.key ? "#fff" : "#111827",
                border: `2px solid ${resultChoice === opt.key ? opt.color : "#e5e7eb"}`,
                borderRadius: 12,
                fontWeight: 700,
                fontSize: 14,
                cursor: "pointer",
                textAlign: "left",
              }}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </section>

      {submitMsg && (
        <div style={{
          padding: "10px 14px",
          borderRadius: 10,
          fontSize: 13,
          background: submitMsg.kind === "success" ? "#ecfdf5" : "#fef2f2",
          border: `1px solid ${submitMsg.kind === "success" ? "#86efac" : "#fca5a5"}`,
          color: submitMsg.kind === "success" ? "#065f46" : "#991b1b",
        }}>
          {submitMsg.text}
        </div>
      )}

      <button
        type="button"
        onClick={submit}
        disabled={submitting || !resultChoice}
        style={{
          padding: "16px 18px",
          background: submitting || !resultChoice ? "#9ca3af" : "#13294b",
          color: "#fff",
          border: "none",
          borderRadius: 12,
          fontWeight: 700,
          fontSize: 16,
          cursor: submitting ? "wait" : (!resultChoice ? "not-allowed" : "pointer"),
        }}
      >
        {submitting ? "Submitting…" : "Submit inspection →"}
      </button>
    </div>
  );
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
