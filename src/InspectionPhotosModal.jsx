// Manager-side photo gallery for an inspection record. Opens from
// Record Lookup → "📸 Photos" button on each row. Fetches the
// inspection_photos JSON on mount, requests signed URLs from
// Supabase Storage (the bucket is private), and shows each shot
// with its category label underneath (e.g. "1st slope overview
// (1st floor)").
//
// Photos are grouped by category so the wizard's mental order is
// visible at a glance: house number → front of house → roof
// overview → slopes → retail worst.

import { useEffect, useState } from "react";
import { supabase } from "./lib/supabase";

const CATEGORY_ORDER = [
  "house_number",
  "front_house",
  "roof_overview",
  "slope_overview",
  "slope_damage",
  "retail_worst",
];
const CATEGORY_LABELS = {
  house_number:    "🏷  House number",
  front_house:     "🏠 Front of house",
  roof_overview:   "📷 Roof overview",
  slope_overview:  "📷 Slope overviews",
  slope_damage:    "🔍 Slope details",
  retail_worst:    "💰 Retail — worst-spot photos",
};

const SIGNED_BUCKET = "signed-documents";

export default function InspectionPhotosModal({ inspectionId, onClose }) {
  const [photos, setPhotos] = useState([]); // { path, label, category?, signedUrl }
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError("");
      try {
        // Pull the inspection_photos JSONB column.
        const { data, error: lookupErr } = await supabase
          .from("inspections")
          .select("inspection_photos, client_name, address, result")
          .eq("id", inspectionId)
          .maybeSingle();
        if (cancelled) return;
        if (lookupErr) throw lookupErr;
        const raw = Array.isArray(data?.inspection_photos) ? data.inspection_photos : [];
        if (raw.length === 0) {
          setPhotos([]);
          setLoading(false);
          return;
        }
        // Create a signed URL per photo so the private bucket image
        // renders in <img>. 1-hour TTL is plenty for a single review.
        const enriched = await Promise.all(raw.map(async (p) => {
          const path = p.path || "";
          let signedUrl = null;
          if (path) {
            const { data: sd } = await supabase.storage
              .from(p.bucket || SIGNED_BUCKET)
              .createSignedUrl(path, 3600);
            signedUrl = sd?.signedUrl || null;
          }
          return {
            ...p,
            signedUrl,
            // Derive a category from filename if not provided (older
            // records pre-date the labeled-photos work).
            category: p.category || guessCategoryFromPath(path),
          };
        }));
        // Number duplicate labels for display so repeated shots are
        // distinguishable ("1st slope detail" → "1st slope detail 1",
        // "… 2", "… 3"). Labels that appear once are left untouched.
        const numbered = numberDuplicateLabels(enriched.map((p) => p.label || ""));
        enriched.forEach((p, i) => { p.displayLabel = numbered[i]; });
        setPhotos(enriched);
      } catch (e) {
        setError(e.message || "Could not load photos");
      } finally {
        setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [inspectionId]);

  // Group photos by category, preserving the wizard order.
  const grouped = (() => {
    const buckets = new Map();
    for (const p of photos) {
      const key = p.category || "other";
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(p);
    }
    const ordered = [];
    for (const k of CATEGORY_ORDER) {
      if (buckets.has(k)) ordered.push([k, buckets.get(k)]);
    }
    // Anything we didn't recognize goes at the end.
    for (const [k, v] of buckets) {
      if (!CATEGORY_ORDER.includes(k)) ordered.push([k, v]);
    }
    return ordered;
  })();

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(15,23,42,0.75)",
        zIndex: 9999,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "#fff",
          borderRadius: 14,
          maxWidth: 980,
          width: "100%",
          maxHeight: "90vh",
          overflow: "auto",
          padding: 20,
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <div style={{ fontSize: 18, fontFamily: "'Oswald', sans-serif", fontWeight: 700 }}>
            📸 Inspection photos
          </div>
          <button
            type="button"
            onClick={onClose}
            style={{
              background: "transparent",
              border: "1px solid #d1d5db",
              borderRadius: 8,
              padding: "6px 12px",
              fontSize: 12,
              fontWeight: 700,
              cursor: "pointer",
            }}
          >
            Close
          </button>
        </div>

        {loading && (
          <div style={{ padding: 24, textAlign: "center", color: "#6b7280" }}>
            Loading photos…
          </div>
        )}

        {!loading && error && (
          <div style={{ padding: 14, background: "#fef2f2", border: "1px solid #fca5a5", borderRadius: 10, color: "#991b1b", fontSize: 13 }}>
            {error}
          </div>
        )}

        {!loading && !error && photos.length === 0 && (
          <div style={{ padding: 24, background: "#f9fafb", border: "1px solid #e5e7eb", borderRadius: 10, textAlign: "center", color: "#6b7280", fontSize: 13 }}>
            No photos on file for this inspection.
            <div style={{ fontSize: 11, marginTop: 6 }}>
              (Photos taken before the inspector wizard launched live in JobNimbus directly — check the JN job's attachments.)
            </div>
          </div>
        )}

        {!loading && !error && photos.length > 0 && (
          <>
            <div style={{ fontSize: 12, color: "#475569", marginBottom: 14 }}>
              {photos.length} photo{photos.length === 1 ? "" : "s"} total. Click any thumbnail to open the full-size image in a new tab.
            </div>
            {grouped.map(([category, list]) => (
              <section key={category} style={{ marginBottom: 18 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: "#0f172a", marginBottom: 8, fontFamily: "'Oswald', sans-serif" }}>
                  {CATEGORY_LABELS[category] || `📷 ${category}`} ({list.length})
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: 10 }}>
                  {list.map((p, i) => (
                    <a
                      key={`${category}-${i}`}
                      href={p.signedUrl || "#"}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{
                        display: "block",
                        background: "#f8fafc",
                        border: "1px solid #e2e8f0",
                        borderRadius: 8,
                        overflow: "hidden",
                        textDecoration: "none",
                        color: "inherit",
                      }}
                      title={p.displayLabel || p.label || p.path}
                    >
                      {p.signedUrl ? (
                        <img
                          src={p.signedUrl}
                          alt={p.displayLabel || p.label || "Inspection photo"}
                          style={{ width: "100%", aspectRatio: "1", objectFit: "cover", display: "block", background: "#f1f5f9" }}
                          loading="lazy"
                        />
                      ) : (
                        <div style={{ aspectRatio: "1", display: "flex", alignItems: "center", justifyContent: "center", color: "#9ca3af", fontSize: 11 }}>
                          (no preview)
                        </div>
                      )}
                      <div style={{ padding: "8px 10px" }}>
                        <div style={{ fontSize: 12, fontWeight: 700, color: "#0f172a", lineHeight: 1.3 }}>
                          {p.displayLabel || p.label || "(no label)"}
                        </div>
                        {p.captured_at && (
                          <div style={{ fontSize: 10, color: "#64748b", marginTop: 2 }}>
                            {new Date(p.captured_at).toLocaleString()}
                          </div>
                        )}
                      </div>
                    </a>
                  ))}
                </div>
              </section>
            ))}
          </>
        )}
      </div>
    </div>
  );
}

// Append a running number to any label that appears more than once, in
// order ("1st slope detail" → "1st slope detail 1", "… 2", "… 3").
// Labels that appear only once (e.g. "1st slope overview") are left as
// is. Empty labels stay empty so the "(no label)" fallback still shows.
// Display-only — the stored labels are never modified.
function numberDuplicateLabels(labels) {
  const counts = {};
  for (const l of labels) if (l) counts[l] = (counts[l] || 0) + 1;
  const seen = {};
  return labels.map((l) => {
    if (l && counts[l] > 1) {
      seen[l] = (seen[l] || 0) + 1;
      return `${l} ${seen[l]}`;
    }
    return l;
  });
}

// Older inspection_photos rows (pre-wizard) may not include a
// `category` field. Best-effort: pull a hint from the filename slug.
function guessCategoryFromPath(path) {
  const lower = String(path || "").toLowerCase();
  if (lower.includes("house_number")) return "house_number";
  if (lower.includes("front_house")) return "front_house";
  if (lower.includes("roof_overview")) return "roof_overview";
  if (lower.includes("retail_worst")) return "retail_worst";
  if (lower.includes("slope_overview")) return "slope_overview";
  if (lower.includes("slope_damage") || lower.includes("slope_detail")) return "slope_damage";
  return null;
}
