// JnMatchPickerModal — shown before "Sync to JN" creates anything.
//
// Calls /find-existing-jn-matches to get any contacts + jobs in
// JobNimbus that might match the orphan record. Manager either:
//   • Clicks "Link this job" on an existing job (just sets our row's
//     jn_job_id — no new JN record gets created), or
//   • Clicks "None match — create new in JN" (proceeds with the
//     original create-job flow via retry-jn-sync)
//
// Props:
//   open: boolean
//   row: the inspection row (has id, client_name, address, …)
//   onClose: () => void
//   onLinked: (jnJobId, source: "linked"|"created") => void
//
// The component owns its own fetch state — no need to hoist into App.

import { useEffect, useState } from "react";
import { supabase } from "./lib/supabase";

export default function JnMatchPickerModal({ open, row, onClose, onLinked }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [data, setData] = useState(null); // response from find-existing-jn-matches
  const [busyAction, setBusyAction] = useState(null); // jobId being linked, or "create"
  const [manualJobId, setManualJobId] = useState("");

  useEffect(() => {
    if (!open || !row) {
      setLoading(false);
      setError("");
      setData(null);
      setBusyAction(null);
      setManualJobId("");
      return;
    }
    setLoading(true);
    setError("");
    setData(null);
    (async () => {
      try {
        const r = await fetch("/.netlify/functions/find-existing-jn-matches", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ inspectionId: row.id }),
        });
        const body = await r.json().catch(() => ({}));
        if (!r.ok || !body.ok) {
          setError(body.error || `Server returned ${r.status}`);
        } else {
          setData(body);
        }
      } catch (e) {
        setError(e.message || "Network error");
      } finally {
        setLoading(false);
      }
    })();
  }, [open, row?.id]);

  if (!open) return null;

  async function linkExisting(jobId) {
    if (!jobId || !row) return;
    setBusyAction(jobId);
    try {
      const { error: updErr } = await supabase
        .from("inspections")
        .update({ jn_job_id: jobId })
        .eq("id", row.id);
      if (updErr) throw updErr;
      onLinked?.(jobId, "linked");
      onClose();
    } catch (e) {
      setError(`Could not save link: ${e.message || e}`);
      setBusyAction(null);
    }
  }

  async function linkManual() {
    const jobId = manualJobId.trim();
    if (!jobId) return;
    linkExisting(jobId);
  }

  async function createNew() {
    if (!row) return;
    setBusyAction("create");
    try {
      const r = await fetch("/.netlify/functions/retry-jn-sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ inspectionId: row.id }),
      });
      const d = await r.json().catch(() => ({}));
      if (r.ok && d.ok) {
        onLinked?.(d.jobId, d.linkedExisting ? "linked" : "created");
        onClose();
      } else {
        setError(d.error || `Server returned ${r.status}`);
        setBusyAction(null);
      }
    } catch (e) {
      setError(e.message || "Network error");
      setBusyAction(null);
    }
  }

  return (
    <div
      onClick={() => !busyAction && onClose()}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(15,23,42,0.72)",
        zIndex: 9999,
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        padding: 24,
        overflow: "auto",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "#fff",
          borderRadius: 14,
          maxWidth: 880,
          width: "100%",
          maxHeight: "90vh",
          overflow: "auto",
          padding: 24,
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, marginBottom: 16 }}>
          <div>
            <div style={{ fontSize: 18, fontWeight: 700, fontFamily: "'Oswald', sans-serif" }}>
              🔍 Look for {row?.client_name} in JobNimbus first
            </div>
            <div style={{ fontSize: 12, color: "#475569", marginTop: 4, lineHeight: 1.5 }}>
              Before creating a NEW JN job for this record, here's what JN already has under similar names or addresses. If any of these look like the same homeowner, click <strong>Link this job</strong> — no new JN record gets created. Only click <strong>Create new in JN</strong> if you're sure JN doesn't already have this homeowner.
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={!!busyAction}
            style={{ background: "transparent", border: "1px solid #d1d5db", borderRadius: 8, padding: "6px 12px", fontSize: 12, fontWeight: 700, cursor: busyAction ? "wait" : "pointer" }}
          >
            Cancel
          </button>
        </div>

        {row && (
          <div style={{ background: "#f1f5f9", border: "1px solid #cbd5e1", borderRadius: 10, padding: 12, marginBottom: 16, fontSize: 13 }}>
            <div style={{ fontWeight: 700 }}>Our record:</div>
            <div>{row.client_name}</div>
            <div style={{ color: "#475569" }}>
              {row.address}{row.city && `, ${row.city}`}{row.state && `, ${row.state}`} {row.zip}
            </div>
          </div>
        )}

        {loading && (
          <div style={{ padding: 24, textAlign: "center", color: "#64748b" }}>
            Searching JobNimbus for possible matches…
          </div>
        )}

        {error && (
          <div style={{ padding: 14, background: "#fef2f2", border: "1px solid #fca5a5", borderRadius: 10, color: "#991b1b", fontSize: 13, marginBottom: 16 }}>
            {error}
          </div>
        )}

        {data && !loading && (
          <>
            {data.contacts.length === 0 ? (
              <div style={{ padding: 16, background: "#ecfdf5", border: "1px solid #86efac", borderRadius: 10, color: "#065f46", fontSize: 13, marginBottom: 16 }}>
                ✅ Searched JN for: {data.queries_tried.map((q) => `"${q}"`).join(", ")}.{" "}
                <strong>No possibly-matching contacts found.</strong> Safe to create a new JN job.
                {data.filtered_out > 0 ? (
                  <span style={{ display: "block", marginTop: 6, fontSize: 11, color: "#065f46" }}>
                    ({data.filtered_out} unrelated result{data.filtered_out === 1 ? "" : "s"} from JN's broad search were filtered out — none of their names or addresses matched this homeowner.)
                  </span>
                ) : null}
              </div>
            ) : (
              <>
                <div style={{ fontSize: 13, color: "#475569", marginBottom: 10 }}>
                  Found <strong>{data.contacts.length}</strong> relevant match{data.contacts.length === 1 ? "" : "es"} in JN.
                  Queries tried: {data.queries_tried.map((q) => `"${q}"`).join(", ")}.
                  {data.filtered_out > 0 ? (
                    <span style={{ display: "block", marginTop: 4, fontSize: 11, color: "#9ca3af" }}>
                      ({data.filtered_out} unrelated result{data.filtered_out === 1 ? "" : "s"} hidden — no name or address overlap with this homeowner.)
                    </span>
                  ) : null}
                </div>
                <div style={{ display: "grid", gap: 10, marginBottom: 18 }}>
                  {data.contacts.map((c) => (
                    <ContactCard
                      key={c.contactId}
                      contact={c}
                      ourStreetNum={(row?.address || "").trim().split(/\s+/)[0] || ""}
                      busyAction={busyAction}
                      onLink={(jobId) => linkExisting(jobId)}
                    />
                  ))}
                </div>
              </>
            )}

            {/* Manual paste — for the case the auto-search misses but the
                manager already knows the JN job ID. */}
            <div style={{ background: "#fffbeb", border: "1px solid #fbbf24", borderRadius: 10, padding: 12, marginBottom: 16, display: "grid", gap: 8 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: "#92400e" }}>
                Know the JN job ID already? Paste it:
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 8 }}>
                <input
                  type="text"
                  value={manualJobId}
                  onChange={(e) => setManualJobId(e.target.value)}
                  placeholder="e.g. mobwvrx48cjft7ah6t9a1nv"
                  style={{ padding: "8px 12px", border: "1px solid #cbd5e1", borderRadius: 8, fontSize: 14, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}
                  disabled={!!busyAction}
                />
                <button
                  type="button"
                  onClick={linkManual}
                  disabled={!manualJobId.trim() || !!busyAction}
                  style={{
                    padding: "8px 14px",
                    background: !manualJobId.trim() || busyAction ? "#9ca3af" : "#0a0a0a",
                    color: "#fff",
                    border: "none",
                    borderRadius: 8,
                    fontWeight: 700,
                    fontSize: 12,
                    fontFamily: "'Oswald', sans-serif",
                    letterSpacing: "0.04em",
                    textTransform: "uppercase",
                    cursor: !manualJobId.trim() || busyAction ? "not-allowed" : "pointer",
                  }}
                >
                  Link
                </button>
              </div>
            </div>

            {/* Last-resort: create new */}
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, borderTop: "1px solid #e5e7eb", paddingTop: 16 }}>
              <button
                type="button"
                onClick={onClose}
                disabled={!!busyAction}
                style={{ padding: "10px 18px", background: "#fff", border: "1px solid #d1d5db", borderRadius: 10, fontSize: 12, fontWeight: 700, fontFamily: "'Oswald', sans-serif", letterSpacing: "0.04em", textTransform: "uppercase", cursor: busyAction ? "wait" : "pointer" }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={createNew}
                disabled={!!busyAction}
                style={{
                  padding: "10px 18px",
                  background: busyAction === "create" ? "#9ca3af" : "#dc2626",
                  color: "#fff",
                  border: "none",
                  borderRadius: 10,
                  fontSize: 12,
                  fontWeight: 700,
                  fontFamily: "'Oswald', sans-serif",
                  letterSpacing: "0.04em",
                  textTransform: "uppercase",
                  cursor: busyAction ? "wait" : "pointer",
                }}
              >
                {busyAction === "create" ? "Creating…" : "None match — Create new in JN"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function ContactCard({ contact, ourStreetNum, busyAction, onLink }) {
  const addrHit = ourStreetNum && contact.contact_address.toLowerCase().includes(ourStreetNum.toLowerCase());
  return (
    <div style={{ border: `2px solid ${addrHit ? "#10b981" : "#e5e7eb"}`, borderRadius: 10, padding: 12, background: addrHit ? "#ecfdf5" : "#fff" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8, marginBottom: 8 }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 700 }}>
            {contact.contact_name}
            {addrHit && (
              <span style={{ fontSize: 10, padding: "2px 8px", background: "#10b981", color: "#fff", borderRadius: 999, marginLeft: 8, fontFamily: "'Oswald', sans-serif", letterSpacing: "0.04em" }}>
                ADDRESS MATCH
              </span>
            )}
          </div>
          <div style={{ fontSize: 12, color: "#64748b", marginTop: 2 }}>
            {contact.contact_address || "(no address on contact)"}
          </div>
          <div style={{ fontSize: 10, color: "#9ca3af", marginTop: 2, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}>
            contact id: {contact.contactId}
          </div>
        </div>
      </div>
      {contact.jobs.length === 0 ? (
        <div style={{ fontSize: 12, color: "#64748b", fontStyle: "italic", padding: 8 }}>
          (no jobs under this contact yet — you can still link to the contact by creating a new job under it, or use the manual paste below)
        </div>
      ) : (
        <div style={{ display: "grid", gap: 6 }}>
          {contact.jobs.map((j) => {
            const jobAddrHit = ourStreetNum && j.job_address.toLowerCase().includes(ourStreetNum.toLowerCase());
            return (
              <div key={j.jobId} style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 8, alignItems: "center", padding: 8, background: jobAddrHit ? "#d1fae5" : "#f8fafc", border: `1px solid ${jobAddrHit ? "#86efac" : "#e2e8f0"}`, borderRadius: 8 }}>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 600 }}>{j.job_name}</div>
                  <div style={{ fontSize: 11, color: "#64748b" }}>
                    {j.job_address || "(no address on job)"}
                    {j.status_name && ` · ${j.status_name}`}
                    {j.record_type_name && ` · ${j.record_type_name}`}
                  </div>
                  <div style={{ fontSize: 10, color: "#9ca3af", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}>
                    {j.jobId}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => onLink(j.jobId)}
                  disabled={!!busyAction}
                  style={{
                    padding: "6px 14px",
                    background: busyAction === j.jobId ? "#9ca3af" : (jobAddrHit ? "#059669" : "#0e7490"),
                    color: "#fff",
                    border: "none",
                    borderRadius: 8,
                    fontSize: 11,
                    fontWeight: 700,
                    fontFamily: "'Oswald', sans-serif",
                    letterSpacing: "0.04em",
                    textTransform: "uppercase",
                    cursor: busyAction ? "wait" : "pointer",
                    whiteSpace: "nowrap",
                  }}
                >
                  {busyAction === j.jobId ? "Linking…" : "Link this job"}
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
