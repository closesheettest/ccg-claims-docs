// netlify/functions/regenerate-old-pdfs.js
//
// Server-side regeneration of signed paperwork from claim records.
// Use case: signings that happened before we started archiving PDFs to
// Supabase Storage. The PA never received them, or they were sent to the
// wrong email and the original copies are gone.
//
// We have everything we need in the claims table to reconstruct them:
//   - homeowner names + address + insurance info
//   - signature1 / signature2 (typed name strings, OR base64-encoded PNGs)
//   - signed_at timestamp + signed_ip for audit trail
//   - docs_signed list ("insp,lor,pac")
//
// This function builds HTML for each document, renders it to PDF via
// PDFShift, and uploads to Supabase Storage via archive-signed-docs.js.
//
// USAGE:
//   POST /.netlify/functions/regenerate-old-pdfs
//   Body: { inspectionId: "abc-123" }
//
// Returns: { ok: true, paths: { insp, lor, pac, welcome, uploaded_at } }
//
// IMPORTANT: regenerated PDFs are functionally equivalent to originals
// but include a "REGENERATED FROM RECORDS" stamp explaining the date
// they were re-built and the original signing date.

const PDFSHIFT_KEY = process.env.PDFSHIFT_API_KEY;
const SB_URL       = process.env.VITE_SUPABASE_URL;
const SB_KEY       = process.env.VITE_SUPABASE_ANON_KEY;

const sbHeaders = {
  apikey: SB_KEY,
  Authorization: `Bearer ${SB_KEY}`,
  "Content-Type": "application/json",
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

  // 1. Fetch the inspection
  const inspRes = await fetch(
    `${SB_URL}/rest/v1/inspections?id=eq.${inspectionId}&select=*&limit=1`,
    { headers: sbHeaders }
  );
  if (!inspRes.ok) return { statusCode: 500, body: JSON.stringify({ error: "Could not fetch inspection" }) };
  const insp = (await inspRes.json())?.[0];
  if (!insp) return { statusCode: 404, body: JSON.stringify({ error: "Inspection not found" }) };

  // 2. Fetch the matching claim record (by name+zip — most reliable)
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

  // 3. Build the HTML for each signed document and render to PDF
  const docsSigned = (claim.docs_signed || "").split(",").map(s => s.trim().toLowerCase());
  const includeInsp = docsSigned.includes("insp");
  const includeLor  = docsSigned.includes("lor");
  const includePac  = docsSigned.includes("pac");

  const pdfsToBuild = [];
  if (includeInsp) pdfsToBuild.push({ key: "insp", filename: "Free-Roof-Inspection-Agreement.pdf", html: buildInspectionHtml(claim, insp) });
  if (includeLor)  pdfsToBuild.push({ key: "lor",  filename: "Letter-of-Representation.pdf",       html: buildLorHtml(claim) });
  if (includePac)  pdfsToBuild.push({ key: "pac",  filename: "Public-Adjuster-Contract.pdf",       html: buildPacHtml(claim) });

  if (pdfsToBuild.length === 0) {
    return { statusCode: 400, body: JSON.stringify({ error: "Claim has no signed docs to regenerate" }) };
  }

  console.log("Regenerating PDFs:", pdfsToBuild.map(p => p.key).join(", "));

  // 4. Render each via PDFShift in parallel
  const renderedPdfs = {};
  const renders = pdfsToBuild.map(async (item) => {
    const pdfRes = await fetch("https://api.pdfshift.io/v3/convert/pdf", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Basic " + Buffer.from(`api:${PDFSHIFT_KEY}`).toString("base64"),
      },
      body: JSON.stringify({
        source: item.html,
        format: "Letter",
        margin: "0.5in",
      }),
    });
    if (!pdfRes.ok) {
      console.error("PDFShift failed for", item.key, ":", await pdfRes.text());
      return null;
    }
    const buffer = await pdfRes.arrayBuffer();
    renderedPdfs[item.key] = {
      filename: item.filename,
      base64: Buffer.from(buffer).toString("base64"),
    };
    return item.key;
  });
  await Promise.all(renders);

  if (Object.keys(renderedPdfs).length === 0) {
    return { statusCode: 500, body: JSON.stringify({ error: "All PDF renders failed" }) };
  }

  // 5. Pass to archive-signed-docs to upload + persist
  const base = process.env.URL || process.env.BASE_URL || "";
  const archiveRes = await fetch(`${base}/.netlify/functions/archive-signed-docs`, {
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
    }),
  };
};

// ──────────────────────────────────────────────────────────────────
// HTML builders for each document
// ──────────────────────────────────────────────────────────────────
const esc = (s) => String(s == null ? "" : s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

function regenStamp(claim) {
  return `
    <div style="background:#fffbeb;border:2px solid #f59e0b;border-radius:8px;padding:10px 14px;margin:14px 0;font-size:11px;color:#92400e">
      <strong>📄 REGENERATED FROM RECORDS</strong> · This document was reconstructed on ${new Date().toLocaleDateString()} from signing data on file. Originally signed on <strong>${claim.signed_at ? new Date(claim.signed_at).toLocaleString() : "(date unknown)"}</strong>${claim.signed_ip ? ` from IP ${esc(claim.signed_ip)}` : ""}.
    </div>
  `;
}

function signatureBlock(claim) {
  const sig1 = claim.signature1 || claim.signed_by_name || claim.homeowner1 || "";
  const sig2 = claim.signature2 || (claim.homeowner2 ? claim.homeowner2 : "");
  // signature1 may be a base64 PNG (data URL) or a typed name. Detect.
  const renderSig = (val, label) => {
    if (!val) return "";
    const isImg = String(val).startsWith("data:image");
    return `
      <div style="display:inline-block;margin-right:24px;vertical-align:top">
        <div style="border-bottom:1px solid #111;width:280px;padding-bottom:4px;margin-bottom:4px;height:40px">
          ${isImg ? `<img src="${val}" style="height:38px;max-width:280px;object-fit:contain" />` : `<span style="font-family:'Brush Script MT',cursive;font-size:24px;color:#1a2e5a">${esc(val)}</span>`}
        </div>
        <div style="font-size:10px;color:#6b7280">${label}</div>
      </div>
    `;
  };
  return `
    <div style="margin-top:30px">
      ${renderSig(sig1, "Homeowner Signature")}
      ${claim.homeowner2 ? renderSig(sig2, "Co-Owner Signature") : ""}
      <div style="margin-top:16px;font-size:11px;color:#6b7280">
        Signed: ${claim.signed_at ? esc(new Date(claim.signed_at).toLocaleString()) : ""}${claim.signed_ip ? ` · IP: ${esc(claim.signed_ip)}` : ""}${claim.signed_by_email ? ` · Email: ${esc(claim.signed_by_email)}` : ""}
      </div>
    </div>
  `;
}

function pageHeader(title, color="#1a2e5a") {
  return `
    <div style="border-bottom:3px solid ${color};padding-bottom:10px;margin-bottom:18px;text-align:center">
      <div style="font-size:20px;font-weight:700;color:${color};text-transform:uppercase;letter-spacing:1.5px">${esc(title)}</div>
      <div style="width:60px;height:3px;background:#c8392b;margin:6px auto;border-radius:2px"></div>
    </div>
  `;
}

function buildInspectionHtml(claim, insp) {
  const homeownerName = [claim.homeowner1, claim.homeowner2].filter(Boolean).join(" & ");
  const propertyAddress = [claim.address, claim.city, claim.state, claim.zip].filter(Boolean).join(", ");
  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
  <body style="margin:0;padding:30px;font-family:Arial,Helvetica,sans-serif;color:#111827">
    ${pageHeader("Free Roof Inspection Agreement")}
    ${regenStamp(claim)}
    <div style="margin-bottom:20px">
      <div style="font-size:12px;color:#6b7280;text-transform:uppercase;letter-spacing:0.05em;font-weight:700;margin-bottom:6px">Homeowner Information</div>
      <table style="width:100%;font-size:13px;border-collapse:collapse">
        <tr><td style="padding:4px 0;width:140px;font-weight:700">Homeowner:</td><td>${esc(homeownerName)}</td></tr>
        <tr><td style="padding:4px 0;font-weight:700">Property Address:</td><td>${esc(propertyAddress)}</td></tr>
        <tr><td style="padding:4px 0;font-weight:700">Phone:</td><td>${esc(claim.phone || "")}</td></tr>
        <tr><td style="padding:4px 0;font-weight:700">Email:</td><td>${esc(claim.signed_by_email || claim.homeowner_email || "")}</td></tr>
        <tr><td style="padding:4px 0;font-weight:700">Sales Rep:</td><td>${esc(claim.sales_rep_name || "")}</td></tr>
      </table>
    </div>
    <div style="font-size:13px;line-height:1.6;color:#374151;margin:18px 0">
      <p>The undersigned homeowner ("Homeowner") hereby authorizes <strong>U.S. Shingle &amp; Metal LLC</strong> ("Contractor") to perform a free, no-obligation inspection of the roof at the property address listed above.</p>
      <p>Homeowner acknowledges that this inspection is provided at no cost and creates no obligation to enter into any service contract. The Contractor will inspect the roof for storm damage, hail damage, wind damage, or other defects and will provide a report of findings to the Homeowner.</p>
      <p>If damage is identified, the Homeowner may, at their sole discretion, elect to engage the Contractor or another party for any subsequent repair or claim services. No work will be performed without separate written authorization.</p>
      <p>Homeowner authorizes Contractor and its agents access to the property for the purpose of conducting this inspection.</p>
    </div>
    ${signatureBlock(claim)}
    <div style="margin-top:30px;padding-top:14px;border-top:1px solid #e5e7eb;font-size:10px;color:#9ca3af;text-align:center">
      U.S. Shingle &amp; Metal LLC · 727-761-5200 · inspection@shingleusa.com
    </div>
  </body></html>`;
}

function buildLorHtml(claim) {
  const homeownerName = [claim.homeowner1, claim.homeowner2].filter(Boolean).join(" & ");
  const propertyAddress = [claim.address, claim.city, claim.state, claim.zip].filter(Boolean).join(", ");
  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
  <body style="margin:0;padding:30px;font-family:Arial,Helvetica,sans-serif;color:#111827">
    ${pageHeader("Letter of Representation", "#199c2e")}
    ${regenStamp(claim)}
    <div style="margin-bottom:20px">
      <table style="width:100%;font-size:13px;border-collapse:collapse">
        <tr><td style="padding:4px 0;width:140px;font-weight:700">Date:</td><td>${claim.signed_at ? esc(new Date(claim.signed_at).toLocaleDateString()) : ""}</td></tr>
        <tr><td style="padding:4px 0;font-weight:700">Insured / Homeowner:</td><td>${esc(homeownerName)}</td></tr>
        <tr><td style="padding:4px 0;font-weight:700">Property Address:</td><td>${esc(propertyAddress)}</td></tr>
        <tr><td style="padding:4px 0;font-weight:700">Phone:</td><td>${esc(claim.phone || "")}</td></tr>
        <tr><td style="padding:4px 0;font-weight:700">Email:</td><td>${esc(claim.signed_by_email || claim.homeowner_email || "")}</td></tr>
      </table>
    </div>
    <div style="font-size:13px;line-height:1.6;color:#374151;margin:20px 0">
      <p>To Whom It May Concern:</p>
      <p>The undersigned homeowner(s) hereby formally authorize <strong>Capital Claims Group Inc.</strong> ("CCG") to act as the public adjuster of record for any and all property damage claims pertaining to the property listed above.</p>
      <p>This Letter of Representation grants CCG full authority to communicate with our insurance carrier, file claims, request information, and negotiate settlements on our behalf.</p>
      <p>All correspondence regarding the claim should be directed to CCG using the contact information below.</p>
      <p>This authorization remains in effect until revoked in writing by the undersigned.</p>
    </div>
    <div style="background:#f0fdf4;border:1px solid #199c2e;border-radius:8px;padding:14px 18px;margin:20px 0">
      <div style="font-weight:700;color:#166534;margin-bottom:4px">Capital Claims Group Inc.</div>
      <div style="font-size:13px;color:#166534">License No: G240595 · claims@capitalclaimgroup.com · +1 (954) 571-3035 · www.ccgclaims.com</div>
    </div>
    ${signatureBlock(claim)}
  </body></html>`;
}

function buildPacHtml(claim) {
  const homeownerName = [claim.homeowner1, claim.homeowner2].filter(Boolean).join(" & ");
  const propertyAddress = [claim.address, claim.city, claim.state, claim.zip].filter(Boolean).join(", ");
  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
  <body style="margin:0;padding:30px;font-family:Arial,Helvetica,sans-serif;color:#111827">
    ${pageHeader("Public Adjuster Contract", "#dc2626")}
    ${regenStamp(claim)}
    <div style="margin-bottom:20px">
      <table style="width:100%;font-size:13px;border-collapse:collapse">
        <tr><td style="padding:4px 0;width:140px;font-weight:700">Insured / Homeowner:</td><td>${esc(homeownerName)}</td></tr>
        <tr><td style="padding:4px 0;font-weight:700">Property Address:</td><td>${esc(propertyAddress)}</td></tr>
        <tr><td style="padding:4px 0;font-weight:700">Phone:</td><td>${esc(claim.phone || "")}</td></tr>
        <tr><td style="padding:4px 0;font-weight:700">Email:</td><td>${esc(claim.signed_by_email || claim.homeowner_email || "")}</td></tr>
        <tr><td style="padding:4px 0;font-weight:700">Date:</td><td>${claim.signed_at ? esc(new Date(claim.signed_at).toLocaleDateString()) : ""}</td></tr>
      </table>
    </div>
    <div style="font-size:13px;line-height:1.6;color:#374151;margin:20px 0">
      <p><strong>Engagement of Public Adjuster.</strong> The undersigned (the "Insured") hereby engages <strong>Capital Claims Group Inc.</strong>, a licensed Florida public adjuster firm (License No: G240595), to represent the Insured in connection with any insurance claim for damage to the property described above.</p>
      <p><strong>Scope of Representation.</strong> Capital Claims Group is authorized to investigate, document, file, prepare, present, and adjust any property damage claim with the Insured's insurance company. This includes communicating with adjusters, requesting policy information, attending inspections, negotiating settlements, and receiving claim payments where the Insured directs.</p>
      <p><strong>Compensation.</strong> Capital Claims Group's fee for services is governed by the executed fee agreement between Capital Claims Group and the Insured, in accordance with applicable Florida law and regulation. The Insured acknowledges receipt of and agreement to that fee structure.</p>
      <p><strong>Authority.</strong> The Insured authorizes Capital Claims Group to obtain copies of insurance policies and claim files, to communicate directly with the carrier, and to act as the Insured's representative in all matters relating to the claim.</p>
      <p><strong>Term and Termination.</strong> This Contract remains in effect until the claim is fully resolved or until terminated in writing by either party in accordance with applicable law.</p>
      <p><strong>Acknowledgment.</strong> The Insured acknowledges that this is a legally binding contract and has had the opportunity to review and ask questions before signing.</p>
    </div>
    <div style="background:#fef2f2;border:1px solid #dc2626;border-radius:8px;padding:14px 18px;margin:20px 0">
      <div style="font-weight:700;color:#991b1b;margin-bottom:4px">Capital Claims Group Inc.</div>
      <div style="font-size:13px;color:#991b1b">License No: G240595 · claims@capitalclaimgroup.com · +1 (954) 571-3035</div>
    </div>
    ${signatureBlock(claim)}
  </body></html>`;
}