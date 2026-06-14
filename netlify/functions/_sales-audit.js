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
  // Yes/No fields (Previous Pending, Detached Structure, Solar Panels,
  // IRBADS, Insulation, Radiant Barrier, Modified Bitumen, TPO) are a
  // DROPDOWN on JN web but a TOGGLE in the JN mobile app — which is what
  // reps use. A toggle has no explicit "No"; OFF (and an untouched toggle,
  // which JN stores as no value at all) simply means No. So we do NOT
  // require an explicit answer — off / blank / false all count as "No".
  // We only act when a toggle is turned ON (yes(...)), via the conditional
  // checks below (e.g. IRBADS → IRBADS Area, Insulation → SqFt + Cost).
  // This kills the wall of unfixable "(Yes/No)" flags reps were getting.
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
  // "Measurements Needed?" is a MOVING field: the rep sets it to "Needs
  // Measurements", then whoever measures it flips it to "Pending" →
  // "Done - Measured". So we do NOT require an exact value — that flagged
  // already-measured deals (e.g. James Butler showed up just because the
  // measurer marked it "Done - Measured"). Rule per Neal: blank = error,
  // any value filled in = fine. The blank case is already covered by the
  // always-required `has("Measurements Needed?")` check above, so there's
  // nothing extra to flag for Exposed Fastener / Standing Seam here.

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

  // ── Deal-level checks (read the JN job directly, not custom fields) ──────
  // $0 value: a sold deal with no dollar amount on the job (no approved
  // estimate / invoice / budget revenue) — the estimate was never built in JN,
  // so it shows $0 even if "Roof Price ONLY" is filled.
  const dealValue = Math.max(
    Number(job.approved_estimate_total) || 0,
    Number(job.approved_invoice_total) || 0,
    Number(job.last_budget_revenue) || 0,
  );
  if (dealValue <= 0) errors.push("Deal value is $0 in JobNimbus — build the estimate (no approved $ on the job)");

  // No real sales rep (e.g. auto-created and left on "AI Bot", or blank).
  const rep = String(job.sales_rep_name || "").trim();
  if (!rep || /\bai\s*bot\b/i.test(rep)) errors.push("No real sales rep assigned (AI Bot / blank)");

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
