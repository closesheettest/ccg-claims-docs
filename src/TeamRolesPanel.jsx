// ═════════════════════════════════════════════════════════════════════
// TEAM ROLES — unified roster
// ---------------------------------------------------------------------
// One list of every person on the team (joined across the `inspectors`
// and `pas` tables by their JobNimbus user id). Each person has TWO role
// toggles:
//   • Inspector  → mirrors inspectors.active
//   • PA         → mirrors pas.active
// Check one or both. A person who is both an Inspector and a PA gets a
// "switch portals" button inside each portal (see InspectorMobileApp /
// PAMobileApp).
//
// Toggling reuses the SAME activate/deactivate helpers the standalone
// admin panels use (setInspectorActive / setPaActive), so the side
// effects stay identical:
//   • activate   → auto-fires the app-link invite (SMS/email)
//   • deactivate → inspector: releases pending claims to the pool
//                  PA:        parks live claims in "PA Decision Needed"
//
// Both rosters are seeded from the same JobNimbus sync, so almost every
// person already has a row in both tables (just active=false). If a row
// is missing for the role being switched on, we create it on the fly
// (copying name/email/phone from the side we do have) so the checkbox
// "just works".
// ═════════════════════════════════════════════════════════════════════
import { useEffect, useState } from "react";
import { supabase } from "./lib/supabase";
import { setInspectorActive } from "./InspectorViews";
import { setPaActive } from "./PAViews";

const card = {
  background: "#fff",
  border: "1px solid #e5e7eb",
  borderRadius: 12,
  padding: 14,
};

function RolePill({ on, busy, label, emoji, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      title={on ? `${label}: ON — tap to turn off` : `${label}: OFF — tap to turn on`}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: "8px 14px",
        borderRadius: 999,
        border: on ? "2px solid #16a34a" : "2px solid #e5e7eb",
        background: busy ? "#f3f4f6" : on ? "#dcfce7" : "#fff",
        color: on ? "#166534" : "#6b7280",
        fontFamily: "'Oswald', sans-serif",
        fontWeight: 700,
        fontSize: 13,
        cursor: busy ? "wait" : "pointer",
        minWidth: 118,
        justifyContent: "center",
      }}
    >
      <span style={{ fontSize: 15 }}>{emoji}</span>
      {label}
      <span style={{ fontWeight: 800, marginLeft: 2 }}>{busy ? "…" : on ? "✓" : "○"}</span>
    </button>
  );
}

export function TeamRolesPanel() {
  const [people, setPeople] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busyKey, setBusyKey] = useState(null);
  const [msg, setMsg] = useState(null);
  const [q, setQ] = useState("");
  const [syncing, setSyncing] = useState(false);

  useEffect(() => { load(); }, []);

  async function load() {
    setLoading(true);
    const [{ data: insps }, { data: pas }] = await Promise.all([
      supabase.from("inspectors").select("*").order("name", { ascending: true }),
      supabase.from("pas").select("*").order("name", { ascending: true }),
    ]);
    // Merge both tables into one person-per-row map, keyed by JobNimbus
    // user id (the shared identity). Fall back to a table-scoped key if a
    // row somehow has no jn_user_id so it still shows up.
    const map = new Map();
    const slot = (key, jn, name) => {
      let e = map.get(key);
      if (!e) { e = { key, jn_user_id: jn, name: name || "", insp: null, pa: null }; map.set(key, e); }
      if (!e.name && name) e.name = name;
      return e;
    };
    for (const i of insps || []) {
      slot(i.jn_user_id || `insp:${i.id}`, i.jn_user_id || null, i.name).insp = i;
    }
    for (const p of pas || []) {
      slot(p.jn_user_id || `pa:${p.id}`, p.jn_user_id || null, p.name).pa = p;
    }
    const list = [...map.values()].sort((a, b) =>
      (a.name || "").localeCompare(b.name || ""),
    );
    setPeople(list);
    setLoading(false);
  }

  // Ensure a row exists for the role we're switching ON. Both tables are
  // seeded from the same JN sync, so this is rare — but if (say) someone
  // is only in `inspectors` and we switch their PA role on, create the PA
  // row from what we know. Returns the row, or null on error (msg set).
  async function ensureRow(person, table) {
    const existing = table === "inspectors" ? person.insp : person.pa;
    if (existing) return existing;
    if (!person.jn_user_id) {
      setMsg({ kind: "error", text: `${person.name} has no JobNimbus ID — run "Sync from JobNimbus" first.` });
      return null;
    }
    const src = (table === "inspectors" ? person.pa : person.insp) || {};
    const { data: created, error } = await supabase
      .from(table)
      .upsert(
        {
          jn_user_id: person.jn_user_id,
          name: person.name,
          email: src.email || null,
          phone: src.phone || null,
          active: false,
        },
        { onConflict: "jn_user_id" },
      )
      .select("*")
      .maybeSingle();
    if (error || !created) {
      setMsg({ kind: "error", text: error?.message || `Could not create the ${table === "inspectors" ? "inspector" : "adjuster"} record.` });
      return null;
    }
    return created;
  }

  async function toggleInspector(person) {
    const isOn = !!person.insp?.active;
    if (isOn && !window.confirm(`Turn OFF the Inspector role for ${person.name}?\n\nAny pending inspection claims they hold go back to the available pool.`)) return;
    setBusyKey(person.key + ":insp");
    const row = await ensureRow(person, "inspectors");
    if (!row) { setBusyKey(null); return; }
    const result = await setInspectorActive(row, !isOn);
    setBusyKey(null);
    setMsg({ kind: result.ok ? "success" : "error", text: result.text });
    await load();
  }

  async function togglePa(person) {
    const isOn = !!person.pa?.active;
    if (isOn && !window.confirm(`Turn OFF the Public Adjuster role for ${person.name}?\n\nAny deals they've claimed move to "PA Decision Needed" for you to reassign.`)) return;
    setBusyKey(person.key + ":pa");
    const row = await ensureRow(person, "pas");
    if (!row) { setBusyKey(null); return; }
    const result = await setPaActive(row, !isOn);
    setBusyKey(null);
    setMsg({ kind: result.ok ? "success" : "error", text: result.text });
    await load();
  }

  // Inspector home-address setup link (only meaningful once the inspector
  // role exists). Inspectors can't sign in until they confirm their home
  // base, so surface this right where the role is switched on.
  async function sendSetupLink(person) {
    if (!person.insp) return;
    setBusyKey(person.key + ":setup");
    try {
      const res = await fetch("/.netlify/functions/send-inspector-update-link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ inspectorId: person.insp.id, channel: "auto" }),
      });
      const body = await res.json().catch(() => ({}));
      if (!body.ok) {
        setMsg({ kind: "error", text: body.error || `Send failed (status ${res.status})` });
      } else {
        const dest = body.channel_used === "sms" ? `📱 SMS to ${body.phone}` : `📧 email to ${body.email}`;
        setMsg({ kind: "success", text: `Setup link sent to ${person.name} (${dest}).` });
      }
    } catch (e) {
      setMsg({ kind: "error", text: e.message || "Network error" });
    }
    setBusyKey(null);
  }

  async function syncFromJn() {
    if (!window.confirm("Pull the latest user list from JobNimbus into both rosters?\n\nNew people are added as INACTIVE — you pick their roles here. Existing rows keep their roles; only name/email refresh.")) return;
    setSyncing(true);
    try {
      const [a, b] = await Promise.all([
        fetch("/.netlify/functions/sync-inspectors-from-jn", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }).then(r => r.json()).catch(() => ({})),
        fetch("/.netlify/functions/sync-pas-from-jn", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }).then(r => r.json()).catch(() => ({})),
      ]);
      setMsg({
        kind: "success",
        text: `Synced from JobNimbus — ${a.inserted || 0} new to the inspector roster, ${b.inserted || 0} new to the adjuster roster.`,
      });
      await load();
    } catch (e) {
      setMsg({ kind: "error", text: e.message || "Sync failed" });
    }
    setSyncing(false);
  }

  const needle = q.trim().toLowerCase();
  const shown = needle ? people.filter(p => (p.name || "").toLowerCase().includes(needle)) : people;
  const counts = {
    insp: people.filter(p => p.insp?.active).length,
    pa: people.filter(p => p.pa?.active).length,
    both: people.filter(p => p.insp?.active && p.pa?.active).length,
  };

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap", marginBottom: 8 }}>
        <div>
          <div style={{ fontSize: 20, fontWeight: 700, fontFamily: "'Oswald', sans-serif" }}>🧑‍🤝‍🧑 Team Roles</div>
          <div style={{ fontSize: 13, color: "#6b7280" }}>
            Check <b>Inspector</b>, <b>PA</b>, or both for each person. Turning a role on texts/emails them their portal link automatically.
          </div>
        </div>
        <button type="button" onClick={syncFromJn} disabled={syncing}
          style={{ padding: "10px 16px", borderRadius: 10, border: "2px solid #0a0a0a", background: syncing ? "#9ca3af" : "#0a0a0a", color: "#fff", fontFamily: "'Oswald', sans-serif", fontWeight: 700, fontSize: 13, cursor: syncing ? "wait" : "pointer" }}>
          {syncing ? "Syncing…" : "⟳ Sync from JobNimbus"}
        </button>
      </div>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", margin: "10px 0 14px" }}>
        <span style={{ ...card, padding: "6px 12px", fontSize: 13 }}>🔍 Inspectors active: <b>{counts.insp}</b></span>
        <span style={{ ...card, padding: "6px 12px", fontSize: 13 }}>🧑‍⚖️ Adjusters active: <b>{counts.pa}</b></span>
        <span style={{ ...card, padding: "6px 12px", fontSize: 13 }}>🧑‍🤝‍🧑 Both roles: <b>{counts.both}</b></span>
      </div>

      {msg && (
        <div style={{
          padding: "10px 14px", borderRadius: 10, marginBottom: 12, fontSize: 13,
          background: msg.kind === "error" ? "#fef2f2" : "#f0fdf4",
          border: `1px solid ${msg.kind === "error" ? "#fca5a5" : "#86efac"}`,
          color: msg.kind === "error" ? "#991b1b" : "#166534",
        }}>
          {msg.text}
        </div>
      )}

      <input
        type="text"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search by name…"
        style={{ width: "100%", padding: "10px 14px", borderRadius: 10, border: "1px solid #d1d5db", fontSize: 14, marginBottom: 14, boxSizing: "border-box" }}
      />

      {loading ? (
        <div style={{ padding: 24, textAlign: "center", color: "#6b7280" }}>Loading roster…</div>
      ) : shown.length === 0 ? (
        <div style={{ padding: 24, textAlign: "center", color: "#6b7280" }}>
          {needle ? "No one matches that search." : "No team members yet — tap \"Sync from JobNimbus\"."}
        </div>
      ) : (
        <div style={{ display: "grid", gap: 8 }}>
          {shown.map((person) => {
            const inspOn = !!person.insp?.active;
            const paOn = !!person.pa?.active;
            const needsSetup = inspOn && person.insp && !person.insp.info_updated_at;
            return (
              <div key={person.key} style={{ ...card, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                <div style={{ minWidth: 160, flex: "1 1 160px" }}>
                  <div style={{ fontSize: 15, fontWeight: 700, color: "#111827" }}>{person.name || "(no name)"}</div>
                  <div style={{ fontSize: 12, color: "#9ca3af" }}>
                    {inspOn && paOn ? "Inspector + PA" : inspOn ? "Inspector" : paOn ? "Public Adjuster" : "No role yet"}
                  </div>
                  {needsSetup && (
                    <div style={{ marginTop: 4, fontSize: 12, color: "#b45309", display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                      ⚠ Needs home-address setup before they can sign in.
                      <button type="button" onClick={() => sendSetupLink(person)} disabled={busyKey === person.key + ":setup"}
                        style={{ padding: "4px 10px", borderRadius: 8, border: "1px solid #f59e0b", background: "#fffbeb", color: "#b45309", fontWeight: 700, fontSize: 11, cursor: "pointer" }}>
                        {busyKey === person.key + ":setup" ? "Sending…" : "Send setup link"}
                      </button>
                    </div>
                  )}
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <RolePill
                    label="Inspector" emoji="🔍"
                    on={inspOn}
                    busy={busyKey === person.key + ":insp"}
                    onClick={() => toggleInspector(person)}
                  />
                  <RolePill
                    label="PA" emoji="🧑‍⚖️"
                    on={paOn}
                    busy={busyKey === person.key + ":pa"}
                    onClick={() => togglePa(person)}
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div style={{ marginTop: 14, fontSize: 12, color: "#9ca3af", lineHeight: 1.5 }}>
        Need the deeper settings? <b>Inspectors</b> (home base, mileage cap, result-confirmation gate) and{" "}
        <b>Public Adjusters</b> (portal preview, decision queue) each still have their own page under
        Inspections / Public Adjuster.
      </div>
    </div>
  );
}
