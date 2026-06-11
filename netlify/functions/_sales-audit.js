// netlify/functions/_sales-audit.js
//
// SHARED sales-audit checklist. Used by BOTH cron-sales-audit (the morning
// scan that texts managers) AND zone-deals-to-fix (the regional-manager
// on-demand "Deals need to be fixed" view). Edit the rules HERE only, so the
// two surfaces can never drift apart.
//
// Underscore-prefixed → Netlify treats this as a helper module, not an
// endpoint.

// Checklist. Reads fields by their JN label (trailing spaces / *…* tolerated).
// Returns { missing: string[], errors: string[] } for one JN job.
export function auditJob(job) {
  const F = trimmedFieldMap(job);
  const missing = [];   // left blank / unanswered
  const errors = [];    // filled wrong

  const has = (label) => { const v = F[label]; return v !== undefined && v !== null && v !== "" && !(Array.isArray(v) && !v.length); };
  const str = (label) => (F[label] == null ? "" : String(F[label]).trim());
  const numv = (label) => { const n = Number(F[label]); return Number.isFinite(n) ? n : NaN; };
  const answered = (label) => label in F && F[label] !== null && F[label] !== "";   // booleans: present (true OR false)
  const yes = (label) => { const v = F[label]; return v === true || v === "true" || v === "Yes" || v === "yes" || v === 1; };
  const pos = (label) => { const n = numv(label); return Number.isFinite(n) && n > 0; };

  // Start Date is NOT checked — reps leave it alone (the office owns it).

  // ── Always-required answers ──────────────────────────────────────────
  if (!has("*Payment Type*")) missing.push("Payment Type");
  if (!has("Preferred Communication")) missing.push("Preferred Communication");
  if (!has("Sales Rep Harvested")) missing.push("Sales Rep Harvested (Yes/No)");
  if (!answered("Previous Pending")) missing.push("Previous Pending (Yes/No)");
  if (!answered("Detached Structure Included")) missing.push("Detached Structure Included (Yes/No)");
  if (!answered("Solar Panels")) missing.push("Solar Panels (Yes/No)");
  if (!answered("IRBADS")) missing.push("IRBADS (Yes/No)");
  if (!answered("Insulation")) missing.push("Insulation (Yes/No)");
  if (!answered("Radiant Barrier")) missing.push("Radiant Barrier (Yes/No)");
  if (!answered("Modified Bitman")) missing.push("Modified Bitumen (Yes/No)");
  if (!answered("TPO")) missing.push("TPO (Yes/No)");
  if (!has("Measurements Needed?")) missing.push("Measurements Needed?");
  if (!has("# of Stories")) missing.push("# of Stories");
  if (!pos("Roof Price ONLY")) errors.push("Roof Price ONLY is 0 / blank");
  // Squares can be Pitch (sloped) or Flat (flat roof) — only flag if BOTH are
  // 0/blank (a flat-only roof legitimately has Pitch 0 + Flat > 0).
  if (!pos("# of Squares (Pitch)") && !pos("# of Squares (Flat)")) errors.push("# of Squares is 0 / blank (enter Pitch or Flat squares)");

  // ── Roofing product + its color ──────────────────────────────────────
  // Includes the flat products (Modified Bitumen / TPO) so an all-flat roof
  // counts as having a product selected.
  const products = ["Exposed Fastener", "Standing Seam", "Shingle", "Permalock", "Tile", "Stone Coated Metal", "Modified Bitman", "TPO"];
  const soldProducts = products.filter((p) => yes(p));
  if (soldProducts.length === 0) {
    errors.push("No roofing product selected (Shingle / Exposed Fastener / Standing Seam / Permalock / Tile / Stone Coated Metal — or for a flat roof: Modified Bitumen / TPO)");
  }
  if (yes("Exposed Fastener") && !has("Exposed Fastener Color")) missing.push("Exposed Fastener Color");
  if (yes("Standing Seam") && !has("Standing Seam Color")) missing.push("Standing Seam Color");
  if (yes("Shingle")) {
    if (!has("Shingle Color")) missing.push("Shingle Color");
    if (!has("Drip Edge Color (Shingle Only)")) missing.push("Drip Edge Color (Shingle Only)");
  }
  if (yes("Permalock") && !has("Permalock Colors")) missing.push("Permalock Color");

  // ── Measurements rule ────────────────────────────────────────────────
  if ((yes("Exposed Fastener") || yes("Standing Seam")) && str("Measurements Needed?") !== "Needs Measurements") {
    errors.push('Measurements Needed? must be "Needs Measurements" for Exposed Fastener / Standing Seam');
  }

  // ── Flat-roof products ───────────────────────────────────────────────
  if (yes("Modified Bitman")) {
    if (!pos("# of Squares (Flat)")) errors.push("# of Squares (Flat) is 0 (Modified Bitumen sold)");
    if (!has("Mod Bit Color")) missing.push("Mod Bit Color");
  }
  if (yes("TPO") && !pos("# of Squares (Flat)")) errors.push("# of Squares (Flat) is 0 (TPO sold)");
  if (yes("Modified Bitman") && yes("TPO")) errors.push("Modified Bitumen and TPO can't both be Yes");

  // ── IRBADS ───────────────────────────────────────────────────────────
  if (yes("IRBADS") && !has("IRBADS Area")) missing.push("IRBADS Area");

  // ── Insulation (+ price-per-sqft mistake) ────────────────────────────
  if (yes("Insulation")) {
    if (!pos("Insulation SqFt")) errors.push("Insulation SqFt is 0 (Insulation sold)");
    if (!pos("Insulation Total Cost")) errors.push("Insulation Total Cost is 0 (Insulation sold)");
    else if (pos("Insulation SqFt") && numv("Insulation Total Cost") < numv("Insulation SqFt")) {
      errors.push(`Insulation Total Cost ($${numv("Insulation Total Cost")}) looks like price-per-sqft, not the contract total`);
    }
  }

  // ── Radiant Barrier (+ price-per-sqft mistake) ───────────────────────
  if (yes("Radiant Barrier")) {
    if (!pos("Radiant Barrier SqFt")) errors.push("Radiant Barrier SqFt is 0 (Radiant Barrier sold)");
    if (!pos("Radiant Barrier Total Cost")) errors.push("Radiant Barrier Total Cost is 0 (Radiant Barrier sold)");
    else if (pos("Radiant Barrier SqFt") && numv("Radiant Barrier Total Cost") < numv("Radiant Barrier SqFt")) {
      errors.push(`Radiant Barrier Total Cost ($${numv("Radiant Barrier Total Cost")}) looks like price-per-sqft, not the contract total`);
    }
  }

  return { missing, errors };
}

// JN echoes friendly labels as keys (sometimes with trailing spaces or *…*).
function trimmedFieldMap(job) {
  const m = {};
  for (const [k, v] of Object.entries(job)) {
    m[k.trim()] = v;
    const bare = k.trim().replace(/^\*|\*$/g, "").trim();
    if (!(bare in m)) m[bare] = v;
  }
  return m;
}
