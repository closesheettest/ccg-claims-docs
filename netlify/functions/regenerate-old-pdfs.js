// netlify/functions/regenerate-old-pdfs.js
//
// Server-side regeneration of signed paperwork from claim records.
//
// This function rebuilds the original LOR, PAC, and Free Roof Inspection
// Agreement PDFs by re-rendering the same templates that were used at signing
// time. Templates were ported word-for-word from App.jsx (LetterOfRepresentation,
// PublicAdjusterContract, and the inspection-printable component) plus
// AuditTrailPage. Header/footer images are loaded from the live site's
// /public folder.
//
// USAGE:
//   POST /.netlify/functions/regenerate-old-pdfs
//   Body: { inspectionId: "abc-123" }
//
// Returns: { ok: true, paths: { insp, lor, pac, uploaded_at }, regenerated: [...] }

const PDFSHIFT_KEY = process.env.PDFSHIFT_API_KEY;
const SB_URL       = process.env.VITE_SUPABASE_URL;
const SB_KEY       = process.env.VITE_SUPABASE_ANON_KEY;

const sbHeaders = {
  apikey: SB_KEY,
  Authorization: `Bearer ${SB_KEY}`,
  "Content-Type": "application/json",
};

// ──────────────────────────────────────────────────────────────────
// Constants — mirror the App.jsx source so output matches
// ──────────────────────────────────────────────────────────────────
const PA_FIXED = {
  name: "Benito Paul",
  initials: "BP",
  license: "P199496",
};

const REP_FIXED = {
  name: "Hank Smith",
};

const INSPECTION_COMPANY = {
  name: "U.S. Shingle & Metal LLC",
  address: "3845 Gateway Centre Blvd Suite 300 \u2022 Pinellas Park, FL 33782",
  phone: "727.761.5200",
  email: "info@shingleusa.com",
  license: "CCC1331960",
};

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  let inspectionId;
  try {
    inspectionId = JSON.parse(event.body || "{}").inspectionId;
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: "Invalid JSON body" }) };
  }
  if (!inspectionId) {
    return { statusCode: 400, body: JSON.stringify({ error: "inspectionId is required" }) };
  }

  console.log("=== regenerate-old-pdfs START for:", inspectionId);

  // Site URL — used both for header/footer image absolute URLs in HTML and
  // for the recursive call to archive-signed-docs at the end.
  const baseUrl = process.env.URL || process.env.BASE_URL || "https://ccg-claims-docs.netlify.app";

  // 1. Fetch the inspection
  const inspRes = await fetch(
    `${SB_URL}/rest/v1/inspections?id=eq.${inspectionId}&select=*&limit=1`,
    { headers: sbHeaders }
  );
  if (!inspRes.ok) return { statusCode: 500, body: JSON.stringify({ error: "Could not fetch inspection" }) };
  const insp = (await inspRes.json())?.[0];
  if (!insp) return { statusCode: 404, body: JSON.stringify({ error: "Inspection not found" }) };

  // 2. Fetch the matching claim record (by zip + address-ilike)
  const addr = (insp.address || "").trim();
  const zip  = (insp.zip || "").trim();
  let claim = null;
  if (addr && zip) {
    const qs = new URLSearchParams({
      select: "*",
      address: `ilike.${addr}`,
      zip: `eq.${zip}`,
      order: "signed_at.desc",
      limit: "1",
    }).toString();
    const claimRes = await fetch(`${SB_URL}/rest/v1/claims?${qs}`, { headers: sbHeaders });
    if (claimRes.ok) {
      const rows = await claimRes.json();
      if (rows?.[0]) claim = rows[0];
    }
  }

  if (!claim) {
    return { statusCode: 404, body: JSON.stringify({ error: "No matching claim found — cannot regenerate" }) };
  }

  // Decide which docs to rebuild based on docs_signed
  const docsSigned = (claim.docs_signed || "").split(",").map(s => s.trim().toLowerCase());
  const includeInsp = docsSigned.includes("insp");
  const includeLor  = docsSigned.includes("lor");
  const includePac  = docsSigned.includes("pac");

  const pdfsToBuild = [];
  if (includeInsp) pdfsToBuild.push({ key: "insp", filename: "Free-Roof-Inspection-Agreement.pdf", html: buildInspectionHtml(claim, insp, baseUrl) });
  if (includeLor)  pdfsToBuild.push({ key: "lor",  filename: "Letter-of-Representation.pdf",       html: buildLorHtml(claim, baseUrl) });
  if (includePac)  pdfsToBuild.push({ key: "pac",  filename: "Public-Adjuster-Contract.pdf",       html: buildPacHtml(claim, baseUrl) });

  if (pdfsToBuild.length === 0) {
    return { statusCode: 400, body: JSON.stringify({ error: "Claim has no signed docs to regenerate" }) };
  }

  console.log("Regenerating PDFs:", pdfsToBuild.map(p => p.key).join(", "));

  // 3. Render each via PDFShift in parallel, tracking failures
  const renderedPdfs = {};
  const renderErrors = [];
  const renders = pdfsToBuild.map(async (item) => {
    try {
      const pdfRes = await fetch("https://api.pdfshift.io/v3/convert/pdf", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Basic " + Buffer.from(`api:${PDFSHIFT_KEY}`).toString("base64"),
        },
        body: JSON.stringify({
          source: item.html,
          format: "Letter",
          // Templates supply their own padding via the Letter-sized page wrappers.
          // PDFShift's margin defaults are fine; explicit zero would clip headers.
        }),
      });
      if (!pdfRes.ok) {
        const errText = await pdfRes.text();
        console.error(`PDFShift ${pdfRes.status} for ${item.key}:`, errText.slice(0, 300));
        renderErrors.push({ key: item.key, status: pdfRes.status, error: errText.slice(0, 500) });
        return null;
      }
      const buffer = await pdfRes.arrayBuffer();
      // Verify magic bytes — PDFs always start with "%PDF-"
      const head = Buffer.from(buffer).slice(0, 5).toString();
      if (head !== "%PDF-") {
        console.error("PDFShift returned non-PDF for", item.key, "head:", head);
        renderErrors.push({ key: item.key, error: "PDFShift returned non-PDF response" });
        return null;
      }
      renderedPdfs[item.key] = {
        filename: item.filename,
        base64: Buffer.from(buffer).toString("base64"),
      };
      return item.key;
    } catch (e) {
      console.error("Render exception for", item.key, ":", e.message);
      renderErrors.push({ key: item.key, error: e.message });
      return null;
    }
  });
  await Promise.all(renders);

  if (Object.keys(renderedPdfs).length === 0) {
    return { statusCode: 500, body: JSON.stringify({ error: "All PDF renders failed", renderErrors }) };
  }
  if (renderErrors.length > 0) {
    console.warn("Partial render — failed:", renderErrors.map(e => e.key).join(", "), "succeeded:", Object.keys(renderedPdfs).join(", "));
  }

  // 4. Pass to archive-signed-docs to upload + persist paths to DB
  const archiveRes = await fetch(`${baseUrl}/.netlify/functions/archive-signed-docs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ inspectionId, pdfs: renderedPdfs }),
  });
  const archiveJson = await archiveRes.json().catch(() => ({}));
  if (!archiveRes.ok || !archiveJson.ok) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Archive failed after regen", detail: archiveJson }),
    };
  }

  return {
    statusCode: 200,
    body: JSON.stringify({
      ok: true,
      paths: { ...archiveJson.paths, uploaded_at: new Date().toISOString() },
      regenerated: Object.keys(renderedPdfs),
      renderErrors: renderErrors.length > 0 ? renderErrors : undefined,
    }),
  };
};

// ──────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────
const esc = (s) => String(s == null ? "" : s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

// Format an address from claim record fields (mirrors formatAddress in App.jsx)
function formatAddress(claim) {
  const street = claim.address || "";
  const cityStateZip = [claim.city, claim.state].filter(Boolean).join(", ") + (claim.zip ? ` ${claim.zip}` : "");
  return [street, cityStateZip.trim()].filter(Boolean).join("\n");
}

// Render a signature value: data:image/* URLs → <img>, plain strings → cursive script
function renderSignatureHtml(val, opts = {}) {
  if (!val) return "";
  const { maxHeight = 80 } = opts;
  const isImg = String(val).startsWith("data:image");
  if (isImg) {
    return `<img src="${val}" style="max-width:100%;max-height:${maxHeight}px;object-fit:contain" />`;
  }
  return `<span style="font-family:'Brush Script MT', cursive; font-size:30px; color:#111827">${esc(val)}</span>`;
}

// Audit trail page — mirrors AuditTrailPage component in App.jsx
function buildAuditTrailHtml(claim, docLabel) {
  const claimId = claim.id || "Not available";
  const signedByName = claim.signed_by_name || [claim.homeowner1, claim.homeowner2].filter(Boolean).join(", ") || "Not available";
  const signedByEmail = claim.signed_by_email || claim.homeowner_email || "Not available";
  const signedAt = claim.signed_at || "Not available";
  const signedIp = claim.signed_ip || "Not available";
  const signedCity = claim.signed_city || "";
  const signedRegion = claim.signed_region || "";
  const cityState = [signedCity, signedRegion].filter(Boolean).join(", ");
  const signMethod = claim.sign_method || "sign_now";
  const userAgent = claim.signed_user_agent || "Not available";

  const rows = [
    ["Document", docLabel],
    ["Claim ID", claimId],
    ["Signed by", signedByName],
    ["Signer email", signedByEmail],
    ["Signed at", signedAt],
    ["IP address", signedIp],
    ...(cityState ? [["City / State", cityState]] : []),
    ["Sign method", signMethod],
    ["Browser / device", userAgent],
  ];

  const rowsHtml = rows.map(([label, value], i) => `
    <div style="display:grid; grid-template-columns:200px 1fr; ${i === 0 ? "" : "border-top:1px solid #e5e7eb;"}">
      <div style="background:#f8fafc; padding:14px 16px; font-weight:700; font-size:13px;">${esc(label)}</div>
      <div style="padding:14px 16px; font-size:13px; word-break:break-word; white-space:pre-wrap;">${esc(value || "Not available")}</div>
    </div>
  `).join("");

  return `
    <div style="width:8.5in; min-height:11in; background:#fff; box-sizing:border-box; font-family:Georgia, 'Times New Roman', serif; color:#111827;">
      <div style="padding:0.55in 0.6in; box-sizing:border-box;">
        <div style="font-size:26px; font-weight:700; margin-bottom:10px;">Signature Acknowledgment</div>
        <div style="font-size:14px; color:#4b5563; margin-bottom:24px;">Electronic signing audit trail for this document.</div>

        <div style="border:1px solid #d1d5db; border-radius:16px; overflow:hidden;">
          ${rowsHtml}
        </div>

        <div style="margin-top:24px; border:1px solid #d1d5db; border-radius:16px; padding:18px; background:#f8fafc; font-size:13px; line-height:1.6;">
          By signing electronically, the signer acknowledged intent to sign this document and submitted the signature using the browser session that generated the audit information shown above.
        </div>
      </div>
    </div>
  `;
}

// ──────────────────────────────────────────────────────────────────
// LETTER OF REPRESENTATION (2 pages + audit trail)
// ──────────────────────────────────────────────────────────────────
function buildLorHtml(claim, baseUrl) {
  const fullAddress = formatAddress(claim);
  const displayedLossLocation = claim.loss_location && !claim.loss_location_same_as_address
    ? claim.loss_location
    : fullAddress;
  const insuredNames = [claim.homeowner1, claim.homeowner2].filter(Boolean).join(", ");
  const dateStr = claim.signed_at ? new Date(claim.signed_at).toLocaleDateString() : (claim.date || "");
  const sig1 = claim.signature1;
  const sig2 = claim.signature2;
  const hasSecond = Boolean((claim.homeowner2 || "").trim());

  // Style snippets
  const labelStyle = "display:block; font-size:12px; color:#4b5563; margin-bottom:6px; font-weight:400;";
  const fieldBoxStyle = "min-height:46px; border:1px solid #d1d5db; border-radius:12px; padding:10px 12px; background:#fff; font-size:12px; line-height:1.35; color:#111827; box-sizing:border-box;";
  const bodyText = "font-size:14px; line-height:1.5; color:#111827;";

  // HTML-rendered header — Healthy Homes black/gold theme with the
  // shield mark on the left and company info on the right. Table
  // layout for reliable side-by-side positioning under PDFShift.
  const headerImg = `
    <div style="width:100%; height:1.55in; box-sizing:border-box; background:#0a0a0a; color:#fff; border-bottom:3px solid #c9a35c; padding:0.1in 0.4in;">
      <div style="display:table; width:100%; height:100%;">
        <div style="display:table-cell; vertical-align:middle; width:0.95in; padding-right:14px;">
          <img src="${baseUrl}/hh-shield.png" alt="Healthy Homes shield" style="height:1.05in; width:auto; display:block;" />
        </div>
        <div style="display:table-cell; vertical-align:middle; text-align:left;">
          <div style="font-size:14px; font-weight:700; color:#c9a35c; letter-spacing:0.05em; line-height:1.2; font-family:'Oswald', Arial, sans-serif;">HEALTHY HOMES PUBLIC ADJUSTING</div>
          <div style="font-size:9px; color:#d4af6c; margin-top:3px; line-height:1.25; font-family:Georgia, 'Times New Roman', serif; font-style:italic;">Public Adjusting &nbsp;·&nbsp; Property Claim Documentation &nbsp;·&nbsp; Roof / Wind / Water Support</div>
          <div style="font-size:9px; color:#fff; margin-top:3px; line-height:1.25; font-family:Georgia, 'Times New Roman', serif;">Kortni Keckler &nbsp;|&nbsp; Public Adjuster &nbsp;|&nbsp; FL License W435195</div>
          <div style="font-size:9px; color:#fff; margin-top:1px; line-height:1.25; font-family:Georgia, 'Times New Roman', serif;">Phone: 561-283-5674 &nbsp;|&nbsp; Email: Kkeckleradj@gmail.com</div>
        </div>
      </div>
    </div>
  `;
  const footerImg = `
    <div style="width:100%; height:0.82in; box-sizing:border-box; background:#0a0a0a; color:#fff; border-top:3px solid #c9a35c; padding:0.08in 0.4in 0; text-align:center; font-family:Georgia, 'Times New Roman', serif;">
      <div style="font-size:8.5px; font-weight:700; color:#c9a35c; text-transform:uppercase; letter-spacing:0.08em; line-height:1.2; font-family:'Oswald', Arial, sans-serif;">Confidential &nbsp;·&nbsp; For Intended Recipient Only</div>
      <div style="font-size:7px; color:#d1d5db; line-height:1.35; margin-top:3px; font-style:italic;">This document is for claim-documentation and operational coordination purposes only. No coverage determination, engineering opinion, construction guarantee, or legal advice is being provided. All claim decisions remain subject to policy terms, carrier review, applicable Florida law, and licensed public adjuster review.</div>
      <div style="font-size:8px; color:#c9a35c; font-weight:700; margin-top:3px; line-height:1.2; font-family:'Oswald', Arial, sans-serif; letter-spacing:0.04em;">Healthy Homes Public Adjusting &nbsp;|&nbsp; FL PA License: W435195</div>
    </div>
  `;

  const lorTitleBar = `
    <div style="margin:10px 0 12px; background:#c9a35c; color:#fff; text-align:center; font-weight:700; font-size:20px; letter-spacing:1px; padding:11px 16px; text-transform:uppercase; font-family:'Oswald', Arial, sans-serif;">
      Letter of Representation
    </div>
  `;

  const footerBlock = `
    <div style="border-top:3px solid #c9a35c; margin-top:14px; padding-top:10px; font-size:12px; color:#111827; line-height:1.35;">
      <div style="font-weight:700;">3570 S Ocean Blvd</div>
      <div>South Palm Beach, FL 33480 &bull; Kkeckleradj@gmail.com &bull; 561-283-5674 &bull; propertydamageinspection.com</div>
      <div style="margin-top:6px; font-weight:700; color:#a17e3f;">License No: W435195</div>
    </div>
  `;

  const sigBox = `
    <div style="border:1px dashed #cbd5e1; border-radius:12px; min-height:138px; background:#fff; display:flex; align-items:center; justify-content:center; overflow:hidden; padding:12px;">
      <div style="width:100%; display:grid; grid-template-columns:${hasSecond ? "1fr 1fr" : "1fr"}; gap:18px; align-items:center;">
        <div style="text-align:center;">${sig1 ? renderSignatureHtml(sig1) : `<span style="color:#94a3b8; font-size:12px;">Signature pending</span>`}</div>
        ${hasSecond ? `<div style="text-align:center;">${sig2 ? renderSignatureHtml(sig2) : `<span style="color:#94a3b8; font-size:12px;">Signature pending</span>`}</div>` : ""}
      </div>
    </div>
  `;

  // Page wrapper — replicates PdfPage layout (header at top absolute, footer absolute bottom, content padded)
  const page = (innerHtml) => `
    <div style="position:relative; width:8.5in; height:11in; background:#fff; box-sizing:border-box; overflow:hidden; font-family:Georgia, 'Times New Roman', serif; color:#111827;">
      <div style="position:absolute; top:0; left:0; right:0; height:1.55in; line-height:0; overflow:hidden;">${headerImg}</div>
      <div style="position:absolute; left:0; right:0; bottom:0; height:0.82in; line-height:0; overflow:hidden;">${footerImg}</div>
      <div style="position:absolute; top:1.55in; left:0; right:0; bottom:0.82in; box-sizing:border-box; padding:0 0.42in 0.12in; overflow:hidden;">${innerHtml}</div>
    </div>
  `;

  const page1 = page(`
    ${lorTitleBar}
    <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px; margin-top:10px; margin-bottom:14px;">
      <div><div style="${labelStyle}">Date</div><div style="${fieldBoxStyle}">${esc(dateStr)}</div></div>
      <div><div style="${labelStyle}">Insurance Company</div><div style="${fieldBoxStyle}">${esc(claim.insurance_company || "")}</div></div>
      <div><div style="${labelStyle}">Address</div><div style="${fieldBoxStyle}"><div style="white-space:pre-line;">${esc(fullAddress)}</div></div></div>
      <div><div style="${labelStyle}">State</div><div style="${fieldBoxStyle}">${esc(claim.state || "")}</div></div>
      <div><div style="${labelStyle}">Claim #</div><div style="${fieldBoxStyle}">${esc(claim.claim_number || "")}</div></div>
      <div><div style="${labelStyle}">Client / Insured</div><div style="${fieldBoxStyle}">${esc(insuredNames)}</div></div>
      <div><div style="${labelStyle}">Loss Location</div><div style="${fieldBoxStyle}"><div style="white-space:pre-line;">${esc(displayedLossLocation)}</div></div></div>
      <div><div style="${labelStyle}">Policy #</div><div style="${fieldBoxStyle}">${esc(claim.policy_number || "")}</div></div>
      <div><div style="${labelStyle}">Date of Loss</div><div style="${fieldBoxStyle}">${esc(claim.date_of_loss || "")}</div></div>
      <div><div style="${labelStyle}">Signer Email (recipient)</div><div style="${fieldBoxStyle}">${esc(claim.signed_by_email || claim.homeowner_email || "")}</div></div>
    </div>

    <div style="border-top:1px solid #d1d5db; margin-bottom:14px;"></div>

    <div style="${bodyText}">
      <p style="margin:0 0 10px;">Dear Claims Manager:</p>
      <p style="margin:0 0 10px;">This correspondence will serve to inform you and the Insurance Company that your insured has formally retained our services to assist them in evaluating and presenting their above-referenced claim. We have enclosed a copy of our signed representation notice, which we request that you record in your claim file and properly provide us with a written acknowledgment of our involvement.</p>
      <p style="margin:0 0 10px;">Additionally, we request that all further contact and communication involving this claim&rsquo;s processing from the Insurance Company be directed exclusively through our offices. This also extends to your representative contractor/claims agents and/or any other claims agents you may be using in the processing of this claim.</p>
      <p style="margin:0 0 10px;">Further, as the policy sets forth the duties, rights, and parameters of coverage, it is critical that we have expedited access to this information, we hereby request a true and complete certified copy of the applicable policy contract including the declarations page, all policy endorsements, and the original policy application. Please expedite these documents to our attention.</p>
    </div>
  `);

  const page2 = page(`
    <div style="${bodyText} margin-top:10px;">
      <p style="margin:0 0 14px; font-style:italic;">Also, please note that Healthy Homes Public Adjusting should be named as an additional payee on all insurance drafts and/or payments, pursuant to the enclosed Notice of Loss/Notice of Representation signed by the Insured(s). The insured(s) hereby reserve all rights to make claims under the policy for replacement cost benefits as set forth in the policy and likewise invoke their rights to repair, rebuild or replace the damaged property.</p>
      <p style="margin:0 0 10px;">Surely, you understand the Assured&rsquo;s need to have this claim processed as quickly as possible, and as such, we will be undertaking all necessary steps to document and prepare their claim for submission. We look forward to working cooperatively with you to reach a fair and prompt resolution to this claim. Please feel free to contact us at 954-874-3563 to discuss the current status of this claim and to coordinate our efforts in the loss investigation and valuation process.</p>
      <p style="margin:0 0 18px; font-style:italic;">The Assureds hereby reserve all of their rights under the policy and the laws of this State and nothing contained herein is intended to waive or prejudice said rights.</p>

      <div style="font-size:12px; font-weight:500; margin-bottom:8px;">Insured Signature</div>
      ${sigBox}
      ${footerBlock}
    </div>
  `);

  return `<!DOCTYPE html><html><head><meta charset="utf-8">
    <style>@page { size: Letter; margin:0; } body { margin:0; padding:0; }
    .pdf-page-break { page-break-after: always; }</style>
    </head><body>
      ${page1}
      <div class="pdf-page-break"></div>
      ${page2}
      <div class="pdf-page-break"></div>
      ${buildAuditTrailHtml(claim, "Letter of Representation")}
    </body></html>`;
}

// ──────────────────────────────────────────────────────────────────
// PUBLIC ADJUSTER CONTRACT (4 pages + audit trail)
// ──────────────────────────────────────────────────────────────────
function buildPacHtml(claim, baseUrl) {
  const insuredNames = [claim.homeowner1, claim.homeowner2].filter(Boolean).join(", ");
  const hasSecond = Boolean((claim.homeowner2 || "").trim());
  const sig1 = claim.signature1;
  const sig2 = claim.signature2;
  const dateStr = claim.signed_at ? new Date(claim.signed_at).toLocaleDateString() : (claim.date || "");
  const propAddr = [claim.address, claim.city, claim.state, claim.zip].filter(Boolean).join(", ");

  const bodyText = "font-size:13.5px; line-height:1.55; color:#111827; font-family:Georgia, 'Times New Roman', serif;";
  const sectionHead = "color:#c9a35c; font-weight:700; text-transform:uppercase;";

  const headerImg = `<img src="${baseUrl}/pa-header.png" alt="header" style="width:100%; display:block;" />`;
  const footerImg = `<img src="${baseUrl}/pa-footer.png" alt="footer" style="width:100%; display:block;" />`;

  const titleBarImg = `
    <div style="width:100%; display:block; margin:10px 0 12px; background:#c9a35c; color:#fff; text-align:center; font-weight:700; font-size:20px; letter-spacing:1px; padding:11px 16px; text-transform:uppercase; font-family:'Oswald', Arial, sans-serif; box-sizing:border-box;">
      Public Adjuster Contract
    </div>
  `;

  const topGrid = `
    <div style="${bodyText} display:grid; grid-template-columns:1fr 1fr; column-gap:36px; row-gap:10px; margin-top:10px; margin-bottom:4px;">
      <div><strong>Insured:</strong> ${esc(insuredNames)}</div>
      <div><strong>Loss Description:</strong> ${esc(claim.loss_description || "")}</div>
      <div><strong>Phone:</strong> ${esc(claim.phone || "")}</div>
      <div><strong>Claim Type:</strong> ${esc(claim.claim_type || "")}</div>
      <div><strong>Email:</strong> ${esc(claim.signed_by_email || claim.homeowner_email || "")}</div>
      <div><strong>Situation:</strong> ${esc(claim.situation || "")}</div>
      <div><strong>Insurer:</strong> ${esc(claim.insurance_company || "")}</div>
      <div><strong>Date of Loss:</strong> ${esc(claim.date_of_loss || "")}</div>
      <div><strong>Policy #:</strong> ${esc(claim.policy_number || "")}</div>
      <div><strong>Claim #:</strong> ${esc(claim.claim_number || "")}</div>
      <div style="grid-column: 1 / -1;"><strong>Address:</strong> ${esc(propAddr)}</div>
    </div>
  `;

  const renderInitials = (val) => {
    if (!val) return `<span style="font-size:13px; color:#9ca3af;">__</span>`;
    if (String(val).startsWith("data:image")) {
      return `<img src="${val}" alt="initials" style="height:20px;" />`;
    }
    return `<span style="font-family:'Brush Script MT',cursive; font-size:18px;">${esc(val)}</span>`;
  };
  const initialsRow = `
    <div style="display:flex; align-items:flex-end; gap:24px; margin-top:12px; padding-top:8px; border-top:1px solid #e5e7eb; flex-wrap:wrap;">
      <div style="min-width:80px;">
        <div style="font-size:12px; color:#6b7280; margin-bottom:2px;">PA Initials:</div>
        <div style="border-bottom:1px solid #c9a35c; height:26px; display:flex; align-items:flex-end; padding-bottom:2px;">
          <span style="font-family:'Brush Script MT', cursive; font-size:20px; color:#111827; line-height:1;">BP</span>
        </div>
      </div>
      <div style="min-width:80px;">
        <div style="font-size:12px; color:#6b7280; margin-bottom:2px;">${claim.homeowner1 ? esc(claim.homeowner1) + " Initials:" : "Homeowner Initials:"}</div>
        <div style="border-bottom:1px solid #000; height:26px; display:flex; align-items:flex-end; padding-bottom:2px;">${renderInitials(claim.initials1)}</div>
      </div>
      ${hasSecond ? `
      <div style="min-width:80px;">
        <div style="font-size:12px; color:#6b7280; margin-bottom:2px;">${esc(claim.homeowner2)} Initials:</div>
        <div style="border-bottom:1px solid #000; height:26px; display:flex; align-items:flex-end; padding-bottom:2px;">${renderInitials(claim.initials2)}</div>
      </div>` : ""}
    </div>
  `;

  const footerWithPageNum = (pageNum) => `
    <div>
      <div style="text-align:center; font-size:11px; color:#6b7280; font-style:italic; margin-bottom:4px; line-height:1.2; font-family:Georgia, 'Times New Roman', serif;">Page ${pageNum} of 4</div>
      ${footerImg}
    </div>
  `;

  const pacPage = (pageNum, innerHtml) => `
    <div style="position:relative; width:8.5in; height:11in; background:#fff; box-sizing:border-box; overflow:hidden; font-family:Georgia, 'Times New Roman', serif; color:#111827;">
      <div style="position:absolute; top:0; left:0; right:0; height:1.55in; line-height:0; overflow:hidden;">${headerImg}</div>
      <div style="position:absolute; left:0; right:0; bottom:0; height:0.82in; line-height:0; overflow:hidden;">${footerWithPageNum(pageNum)}</div>
      <div style="position:absolute; top:1.55in; left:0; right:0; bottom:0.82in; box-sizing:border-box; padding:0 0.42in 0.12in; overflow:hidden;">${innerHtml}</div>
    </div>
  `;

  const page1Content = `
    ${topGrid}
    ${titleBarImg}
    <div style="${bodyText}">
      <p style="margin:0 0 6px;">1. <span style="${sectionHead}">Service Fee:</span></p>
      <p style="margin:0 0 6px;">The insured(s) hereby retains Healthy Homes Public Adjusting to be its public adjuster and hereby appoints Healthy Homes Public Adjusting to be its independent appraiser to appraise, advise, negotiate, and/or settle the above-referenced claim.</p>
      <p style="margin:0 0 6px; font-weight:700; font-size:18px; line-height:1.5;">The insured(s) agrees to pay and hereby assigns to Healthy Homes Public Adjusting <strong>10%</strong> of all payments made by the insurance company related to this claim.</p>
      <p style="margin:0 0 10px;">In the event appraisal, mediation is demanded, or a lawsuit ensues regarding the above-mentioned claim, there will be an additional charge of five percent. The total contractual percentage shall not exceed the maximum allowed by law.</p>

      <p style="margin:0 0 6px;">2. <span style="${sectionHead}">Additional Payee:</span></p>
      <p style="margin:0 0 10px;">The insured authorizes and requests the insurer and the insured&rsquo;s mortgage carrier to have Healthy Homes Public Adjusting appear as an additional payee on all checks issued regarding the above-mentioned claim. The insured hereby grants Healthy Homes Public Adjusting a lien on recovered proceeds received by the insurer to the extent of the fee due to Healthy Homes Public Adjusting pursuant to this agreement.</p>

      <p style="margin:0 0 6px;">3. <span style="${sectionHead}">Third-Party Fees:</span></p>
      <p style="margin:0;">The insured understands it may be necessary to incur professional fees on the insured&rsquo;s behalf to properly adjust the claim. These fees may include, but are not limited to, a General Contractor, Engineer, Claim Appraiser, Plumber, Roofer, and Environmental Hygienist. The insured understands that no professional fees will be incurred without the insured&rsquo;s written or verbal authorization, and that the insured may then be responsible for such fees.</p>

      ${initialsRow}
    </div>
  `;

  const page2Content = `
    <div style="${bodyText}">
      <p style="margin:0 0 6px;">4. <span style="${sectionHead}">Endorsement:</span></p>
      <p style="margin:0 0 10px;">The insured&rsquo;s endorsement on any insurance proceeds check will be deemed to be an agreement with the terms and conditions of any related settlement regarding the above-mentioned claim.</p>

      <p style="margin:0 0 6px;">5. <span style="${sectionHead}">Affidavit:</span></p>
      <p style="margin:0 0 10px;">I, <span style="display:inline-block; min-width:250px; border-bottom:1px solid #111827; font-weight:600;">${esc(insuredNames || "____________________________")}</span>, a named insured under the above-mentioned policy, hereby swear and attest that I have the authority to enter into this contract and settle all claims issued on behalf of all named insureds. Insured acknowledges, understands, and agrees that under section 626.8796, Florida Statutes, an agreement with a public adjuster must be signed by all named insureds.</p>

      <p style="margin:0 0 6px;">6. <span style="${sectionHead}">Legal:</span></p>
      <p style="margin:0 0 10px;">Healthy Homes Public Adjusting is not a law firm and does not offer legal advice, and there will be no attorney-client relationship with the insured(s). The insured is hereby advised of the right to counsel and may consult with an attorney regarding their claim independently of Healthy Homes Public Adjusting.</p>

      <p style="margin:0 0 6px;">7. <span style="${sectionHead}">Letter of Protection:</span></p>
      <p style="margin:0 0 10px;">The insured understands and agrees that if it becomes necessary to retain an attorney, the insured authorizes and agrees to a Letter of Protection for Healthy Homes Public Adjusting.</p>

      <p style="margin:0 0 6px;">8. <span style="${sectionHead}">Representation:</span></p>
      <p style="margin:0 0 10px;">The insured hereby affirms that no other claim(s) have been filed in reference to the same peril and that no other legal representation is involved with the claim other than:</p>

      <div style="border-bottom:1px solid #111827; width:320px; margin-bottom:12px; min-height:18px; font-weight:600;">Healthy Homes Public Adjusting</div>

      <p style="margin:0 0 6px;">9. <span style="${sectionHead}">Severability:</span></p>
      <p style="margin:0;">Unenforceability or invalidity of one or more clauses in this Agreement shall not affect any other clause.</p>

      <p style="margin:0 0 6px;">10. <span style="${sectionHead}">Dispute:</span></p>
      <p style="margin:0 0 12px;">In the event of litigation arising from this agreement, the venue shall be in Miami-Dade County, Florida. The prevailing party shall be entitled to recover its court costs, reasonable attorney fees, including those incurred during any appeal proceedings, and interest on any past due fees at the maximum rate permitted by applicable law.</p>

      <p style="margin:0 0 6px;">11. <span style="${sectionHead}">Commercial Policy Cancellation:</span></p>
      <p style="margin:0 0 12px;">You, the insured(s), may cancel this contract for any reason without penalty or obligation to you within 10 days after the date of this contract.</p>

      ${initialsRow}
    </div>
  `;

  const page3Content = `
    <div style="${bodyText}">
      <p style="margin:0 0 6px; font-weight:700; font-size:18px; line-height:1.4;">12. <span style="color:#c9a35c;">Residential Policy Cancellation:</span></p>

      <p style="margin:0 0 10px; font-weight:700; font-size:18px; line-height:1.5;">You, the insured, may cancel this contract for any reason without penalty or obligation to you within 10 days after the date of this contract.</p>

      <p style="margin:0 0 10px; font-weight:700; font-size:18px; line-height:1.5;">If this contract was entered into based on events that are the subject of a declaration of a state of emergency by the Governor, you may cancel this contract for any reason without penalty or obligation to you within 30 days after the date of loss or 10 days after the date on which the contract is executed, whichever is longer. You may also cancel this contract without penalty or obligation to you if I, as your public adjuster, fail to provide you and your insurer a copy of a written estimate within 60 days of the execution of the contract, unless the failure to provide the estimate within 60 days is caused by factors beyond my control.</p>

      <p style="margin:0 0 10px; font-weight:700; font-size:18px; line-height:1.5;">The notice of cancellation shall be provided to Healthy Homes Public Adjusting, submitted in writing, and sent by certified mail, return receipt requested, or another form of mailing that provides proof thereof, at the address specified in the contract.</p>

      <p style="margin:0 0 10px; font-weight:700; font-size:18px; line-height:1.5;">Pursuant to s. 817.234, Florida Statutes, any person who, with the intent to injure, defraud, or deceive any insurer or insured, prepares, presents, or causes to be presented a proof of loss or estimate of cost or repair of damaged property in support of a claim under an insurance policy, knowing that the proof of loss or estimate of claim or repairs contains any false, incomplete, or misleading information concerning any fact or thing material to the claim, commits a felony of the third degree, punishable as provided in s. 775.082, s. 775.803, or s. 775.084, Florida Statutes.</p>

      <p style="margin:0 0 10px; font-weight:700; font-size:18px; line-height:1.5;">Insured(s) have read, understand and voluntarily sign the foregoing Agreement. A computer or faxed signature or copy of this document shall be deemed to have the same effect as the original.</p>

      ${initialsRow}
    </div>
  `;

  const benitoSig = `<img src="${baseUrl}/benito-signature.png" alt="Benito Paul signature" style="height:22px; object-fit:contain;" />`;
  const insuredSigBlock = (homeowner, sigVal) => `
    <div style="margin-bottom:10px; font-size:12px;">
      <div>Insured (Print): ${esc(homeowner)}</div>
      <div style="margin-top:8px; min-height:36px;">${sigVal ? renderSignatureHtml(sigVal, { maxHeight: 30 }) : ""}</div>
      <div style="font-size:12px;">Signature of the policyholder</div>
      <div style="margin-top:8px;">Date: ${esc(dateStr)}</div>
    </div>
  `;

  const page4Content = `
    <div style="${bodyText}">
      <div style="border-top:4px solid #c9a35c; margin-top:18px; margin-bottom:14px;"></div>
      <div style="color:#c9a35c; font-weight:700; font-size:14px; margin-bottom:14px;">HEALTHY HOMES PUBLIC ADJUSTING</div>

      <div style="display:grid; grid-template-columns:${hasSecond ? "1fr 1fr" : "1fr"}; gap:24px; align-items:start;">
        <div>
          <div style="display:grid; grid-template-columns:70px 1fr; row-gap:8px; column-gap:8px; font-size:12px;">
            <div>By:</div>
            <div style="background:#d7c2f0; padding:4px 8px;">${esc(PA_FIXED.name)}</div>

            <div>License:</div>
            <div style="background:#d7c2f0; padding:4px 8px; font-weight:700;">${esc(PA_FIXED.license)}</div>

            <div>Signature:</div>
            <div style="background:#d7c2f0; padding:4px 8px;">${benitoSig}</div>

            <div>Date:</div>
            <div>${esc(dateStr)}</div>
          </div>
        </div>

        <div>
          ${insuredSigBlock(claim.homeowner1 || "", sig1)}
          ${hasSecond ? `<div style="margin-top:18px;">${insuredSigBlock(claim.homeowner2, sig2)}</div>` : ""}
        </div>
      </div>
    </div>
  `;

  return `<!DOCTYPE html><html><head><meta charset="utf-8">
    <style>@page { size: Letter; margin:0; } body { margin:0; padding:0; }
    .pdf-page-break { page-break-after: always; }</style>
    </head><body>
      ${pacPage(1, page1Content)}
      <div class="pdf-page-break"></div>
      ${pacPage(2, page2Content)}
      <div class="pdf-page-break"></div>
      ${pacPage(3, page3Content)}
      <div class="pdf-page-break"></div>
      ${pacPage(4, page4Content)}
      <div class="pdf-page-break"></div>
      ${buildAuditTrailHtml(claim, "Public Adjuster Contract")}
    </body></html>`;
}

// ──────────────────────────────────────────────────────────────────
// FREE ROOF INSPECTION AGREEMENT (1 page + audit trail)
// Mirrors id="inspection-printable" component in App.jsx
// ──────────────────────────────────────────────────────────────────
function buildInspectionHtml(claim, insp, baseUrl) {
  const insuredNames = [claim.homeowner1, claim.homeowner2].filter(Boolean).join(" & ");
  const dateStr = claim.signed_at ? new Date(claim.signed_at).toLocaleDateString() : (claim.date || "");
  const sig1 = claim.signature1;
  const phone = claim.phone || insp?.mobile || "";
  const email = claim.signed_by_email || claim.homeowner_email || insp?.email || "";

  const clientSig = sig1 ? renderSignatureHtml(sig1, { maxHeight: 44 }) : "";
  const repSig = `<img src="${baseUrl}/rep-signature.png" alt="Rep signature" style="max-height:44px; object-fit:contain;" />`;

  return `<!DOCTYPE html><html><head><meta charset="utf-8">
    <style>@page { size: Letter; margin:0; } body { margin:0; padding:0; }
    .pdf-page-break { page-break-after: always; }</style>
    </head><body>
      <div style="font-family:Arial, Helvetica, sans-serif; background:#fff; width:8.5in; padding:0.6in 0.7in; box-sizing:border-box;">
        <div style="text-align:center; margin-bottom:24px;">
          <img src="${baseUrl}/uss-header.png" alt="U.S. Shingle &amp; Metal" style="height:70px; object-fit:contain; margin-bottom:10px;" />
          <div style="font-size:20px; font-weight:700; color:#0a0a0a; margin-bottom:4px; text-transform:uppercase; letter-spacing:1.5px;">Free Roof Inspection Agreement</div>
          <div style="width:60px; height:3px; background:#c9a35c; margin:0 auto 10px; border-radius:2px;"></div>
          <div style="font-size:12px; color:#374151; line-height:1.7;">
            ${esc(INSPECTION_COMPANY.name)} &nbsp;|&nbsp; ${esc(INSPECTION_COMPANY.address)}<br />
            Phone: ${esc(INSPECTION_COMPANY.phone)} &nbsp;|&nbsp; Email: ${esc(INSPECTION_COMPANY.email)} &nbsp;|&nbsp; License #: ${esc(INSPECTION_COMPANY.license)}
          </div>
          <div style="border-bottom:2px solid #0a0a0a; margin-top:14px;"></div>
        </div>

        <div style="display:grid; gap:6px; font-size:14px; margin-bottom:20px;">
          <div><strong>Date:</strong> ${esc(dateStr)}</div>
          <div><strong>Client:</strong> ${esc(insuredNames)}</div>
          <div><strong>Mobile:</strong> ${esc(phone)}</div>
          <div><strong>Address:</strong> ${esc(claim.address || "")} &nbsp; <strong>City:</strong> ${esc(claim.city || "")} &nbsp; <strong>St:</strong> ${esc(claim.state || "")} &nbsp; <strong>Zip:</strong> ${esc(claim.zip || "")}</div>
          <div><strong>Email:</strong> ${esc(email)}</div>
        </div>

        <div style="font-size:13px; line-height:1.7; margin-bottom:28px; color:#111827;">
          <p style="margin:0 0 10px;">Client agrees to allow ${esc(INSPECTION_COMPANY.name)} (Company) to perform a free roof inspection at the above address and to forward all pictures and findings to a Public Adjuster for review. The Company maintains all required licenses and insurance and will not perform repairs during the inspection.</p>
          <p style="margin:0 0 10px;">Client understands that they do not need to be present during the inspection; however, Company personnel will knock on the door upon arrival.</p>
          <p style="margin:0 0 10px;">If the Public Adjuster determines that storm damage exists, they may proceed with filing an insurance claim provided the Client has hired them. Client authorizes the Public Adjuster to notify the Company of its findings and to keep the Company updated throughout the claims process.</p>
          <p style="margin:0;">Client acknowledges that the Company is a licensed roofing contractor and cannot discuss policy coverages, insurance requirements, or statutory guidelines. Any such questions should be directed to the Public Adjuster or the Client&rsquo;s homeowner&rsquo;s insurance carrier.</p>
        </div>

        <div style="display:grid; grid-template-columns:1fr 1fr; gap:40px; margin-top:20px;">
          <div>
            <div style="margin-bottom:4px; font-size:12px;">Client:</div>
            <div style="border-bottom:1px solid #000; min-height:50px; display:flex; align-items:flex-end; padding-bottom:4px; margin-bottom:4px;">${clientSig}</div>
            <div style="font-size:11px; color:#374151;">${esc(insuredNames)}</div>
            <div style="font-size:12px; margin-top:8px;">Date: ${esc(dateStr)}</div>
          </div>
          <div>
            <div style="margin-bottom:4px; font-size:12px;">Representative:</div>
            <div style="border-bottom:1px solid #000; min-height:50px; display:flex; align-items:flex-end; padding-bottom:4px; margin-bottom:4px;">${repSig}</div>
            <div style="font-size:11px; color:#374151;">${esc(REP_FIXED.name)}</div>
            <div style="font-size:12px; margin-top:8px;">Date: ${esc(dateStr)}</div>
          </div>
        </div>
      </div>

      <div class="pdf-page-break"></div>
      ${buildAuditTrailHtml(claim, "Free Roof Inspection Agreement")}
    </body></html>`;
}