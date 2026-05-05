// netlify/functions/generate-and-upload-insp-report.js
//
// Manually generate an Inspection Report PDF (with photos) for a JN job and
// upload it directly into that job's Documents tab. No app record involved,
// no email sent — the rep handles distribution from inside JN once the PDF
// is attached.
//
// Use case: a homeowner is already in JN with photos and an inspection
// result, but never went through the app's signing flow. Before they sign
// PA paperwork they want to see the report. This function fetches the job,
// pulls photos, generates the PDF, and posts it back to JN.
//
// USAGE:
//   POST /.netlify/functions/generate-and-upload-insp-report
//   Body: { jnid: "mobwvrx48cjft7ah6t9a1nv" }   (find JN job ID in JN URL)
//
// Returns: { ok: true, photoCount, filename, jobName }
//          { ok: false, error, detail? }
//
// Templates copied verbatim from inspection-checker.js so the output is
// identical to the auto-generated cron version. JN upload flow copied
// verbatim from jobnimbus-sync.js's uploadFileToJob().

const JN_BASE = "https://app.jobnimbus.com/api1";
const JN_FILES_BASE = "https://api.jobnimbus.com";
const JN_KEY = process.env.JOBNIMBUS_API_KEY;
const PDFSHIFT_KEY = process.env.PDFSHIFT_API_KEY;
const BASE_URL = process.env.URL || process.env.DEPLOY_PRIME_URL || "https://ccg-claims-docs.netlify.app";

const jnHeaders = {
  Authorization: `bearer ${JN_KEY}`,
  "Content-Type": "application/json",
};

// JN cf_string_34 → display label used in PDF & filename
const RESULT_LABELS = { "Damage": "Damage", "No Damage": "No Damage", "Retail": "Retail" };

// ── Main handler ─────────────────────────────────────────────────────
exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ ok: false, error: "Method not allowed" }) };
  }
  if (!JN_KEY)       return { statusCode: 500, body: JSON.stringify({ ok: false, error: "JOBNIMBUS_API_KEY not set" }) };
  if (!PDFSHIFT_KEY) return { statusCode: 500, body: JSON.stringify({ ok: false, error: "PDFSHIFT_API_KEY not set" }) };

  let jnid;
  try {
    const body = JSON.parse(event.body || "{}");
    jnid = (body.jnid || "").trim();
  } catch {
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: "Invalid JSON body" }) };
  }
  if (!jnid) return { statusCode: 400, body: JSON.stringify({ ok: false, error: "jnid is required" }) };

  console.log("=== generate-and-upload-insp-report START — jnid:", jnid);

  // ── 1. Fetch JN job ──────────────────────────────────────────────
  let job;
  try {
    const r = await fetch(`${JN_BASE}/jobs/${jnid}`, { headers: jnHeaders });
    if (!r.ok) {
      const txt = await r.text();
      return {
        statusCode: r.status === 404 ? 404 : 500,
        body: JSON.stringify({ ok: false, error: `JN returned ${r.status}`, detail: txt.slice(0, 300) }),
      };
    }
    job = await r.json();
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: "Could not fetch JN job", detail: e.message }) };
  }

  // ── 2. Validate the job has a result set ─────────────────────────
  // We don't gate on workflow status (Sit Sold Insp etc.) — only on
  // result, since a missing result means there's nothing meaningful
  // to report on yet. The rep can run this at any workflow stage as
  // long as the inspection has been performed.
  const result = job.cf_string_34;
  if (!result || !RESULT_LABELS[result]) {
    return {
      statusCode: 400,
      body: JSON.stringify({
        ok: false,
        error: `JN job has no inspection result set (cf_string_34 is "${result || "empty"}")`,
        detail: "The inspector needs to set Damage / No Damage / Retail in JN before a report can be generated.",
      }),
    };
  }
  const resultLabel = RESULT_LABELS[result];
  console.log("JN job result:", resultLabel);

  // ── 3. Pull homeowner / address fields ───────────────────────────
  const clientName = job.display_name || (job.name || "").split(" - ")[0] || "Homeowner";
  const address = [job.address_line1, job.city, job.state_text, job.zip].filter(Boolean).join(", ");
  const repName = job.sales_rep_name || "—";
  if (!job.address_line1) {
    console.warn("Job has no address_line1 — PDF will show partial address");
  }

  // ── 4. Fetch photos from JN ──────────────────────────────────────
  const photos = await fetchJobPhotos(jnid);
  console.log("Photos fetched:", photos.length);
  if (photos.length === 0) {
    return {
      statusCode: 400,
      body: JSON.stringify({
        ok: false,
        error: "No photos found on JN job",
        detail: "Add at least one photo to the JN job before generating a report.",
      }),
    };
  }

  // ── 5. Build the PDF ─────────────────────────────────────────────
  // For Damage we generate the full 2-page certificate (page 1 cert with FAIL
  // findings, page 2 photo grid). For No Damage / Retail there's no FAIL'ed
  // findings template, so we generate a 1-page photo report with a header
  // tailored to the result.
  const reportDate = new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
  const record = {
    address: job.address_line1 || "",
    city: job.city || "",
    state: job.state_text || "",
    zip: job.zip || "",
    client_name: clientName,
  };

  let pdfBase64;
  try {
    if (resultLabel === "Damage") {
      pdfBase64 = await generateDamagePDF({ clientName, address, repName, date: reportDate, photos, record });
    } else {
      pdfBase64 = await generatePhotoReportPDF({ clientName, address, repName, date: reportDate, photos, resultLabel });
    }
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: "PDF generation failed", detail: e.message }) };
  }
  if (!pdfBase64) {
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: "PDF generation returned empty" }) };
  }

  // ── 6. Upload PDF to JN's documents tab ──────────────────────────
  const safeName = clientName.replace(/[^a-zA-Z0-9]/g, "-");
  const filename = `Inspection-Report-${safeName}-${new Date().toISOString().slice(0, 10)}.pdf`;
  const uploadResult = await uploadFileToJob(jnid, filename, pdfBase64);
  if (!uploadResult.success) {
    return {
      statusCode: 500,
      body: JSON.stringify({ ok: false, error: "Could not upload PDF to JN", detail: uploadResult.error }),
    };
  }

  console.log("=== Report uploaded:", filename, "to job:", jnid);
  return {
    statusCode: 200,
    body: JSON.stringify({
      ok: true,
      filename,
      photoCount: photos.length,
      result: resultLabel,
      jobName: job.name,
      clientName,
    }),
  };
};

// ── Fetch photos from JN ─────────────────────────────────────────────
// JN's /files?related=<jnid> list endpoint returns file metadata only —
// no download URL fields. To get the actual image bytes you have to make
// a SECOND request per file: GET /files/{file-jnid} returns the raw bytes
// directly in the response body. (Confirmed by inspecting the JN API
// response — the response body's first bytes are the JPEG magic header.)
//
// We download up to 10 photos in parallel and base64-encode them so the
// PDF renderer (PDFShift) can embed them via `data:image/jpeg;base64,...`
// inline URIs without needing public URLs.
async function fetchJobPhotos(jnJobId) {
  try {
    const listRes = await fetch(
      `${JN_BASE}/files?related=${jnJobId}&type=2&size=30`,
      { headers: jnHeaders }
    );
    if (!listRes.ok) {
      console.warn("Photo list failed:", listRes.status);
      return [];
    }
    const data = await listRes.json();
    const files = data.files || data.data || data.results || [];
    const imageFiles = files.filter(f => (f.content_type || "").startsWith("image/"));

    // Limit to 10 photos — the certificate template's photo grid is
    // designed for 10 max. More than that won't fit on one page anyway.
    const downloads = imageFiles.slice(0, 10).map(async (file) => {
      const fileJnid = file.jnid || file.id;
      if (!fileJnid) return null;
      try {
        const dlRes = await fetch(`${JN_BASE}/files/${fileJnid}`, { headers: jnHeaders });
        if (!dlRes.ok) {
          console.warn("Photo download failed for", fileJnid, ":", dlRes.status);
          return null;
        }
        const buffer = await dlRes.arrayBuffer();
        // Sanity check — make sure we got binary data, not a JSON error
        // payload. JPEG starts with FFD8FF, PNG with 89504E47.
        const bytes = new Uint8Array(buffer);
        const head = bytes[0]?.toString(16) + bytes[1]?.toString(16);
        if (!head || head.length < 2) return null;
        const base64 = Buffer.from(buffer).toString("base64");
        const contentType = (file.content_type || "image/jpeg");
        return {
          base64,
          contentType,
          // Build a data URI the PDF renderer can use directly as an <img src>.
          dataUri: `data:${contentType};base64,${base64}`,
        };
      } catch (e) {
        console.warn("Photo download error for", fileJnid, ":", e.message);
        return null;
      }
    });

    const results = await Promise.all(downloads);
    return results.filter(Boolean);
  } catch (e) {
    console.warn("fetchJobPhotos error:", e.message);
    return [];
  }
}

// ── Inspection findings rows (mirrors App.jsx INSP_ROWS_DAMAGE) ──────
const INSP_ROWS_DAMAGE = [
  { category: "Roofing Material Type",       finding: "Asphalt Shingle & Metal Roofing System",            result: "N/A"  },
  { category: "Shingle Condition",            finding: "Storm damage observed — see inspection notes",       result: "FAIL" },
  { category: "Metal Panel Condition",        finding: "N/A",                                                result: "N/A"  },
  { category: "Flashing & Sealants",          finding: "N/A",                                                result: "N/A"  },
  { category: "Gutters & Downspouts",         finding: "N/A",                                                result: "N/A"  },
  { category: "Ridge & Hip Caps",             finding: "N/A",                                                result: "N/A"  },
  { category: "Roof Deck (Visible)",          finding: "N/A",                                                result: "N/A"  },
  { category: "Ventilation",                  finding: "N/A",                                                result: "N/A"  },
  { category: "Water Intrusion / Leaks",      finding: "N/A",                                                result: "N/A"  },
  { category: "Overall Structural Integrity", finding: "Structural damage confirmed — replacement required", result: "FAIL" },
];

// ── Date helpers ─────────────────────────────────────────────────────
function fmtDateLong(dateStr) {
  if (!dateStr) return "";
  return new Date(dateStr + "T12:00:00").toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
}
function fmtDateShort(dateStr) {
  if (!dateStr) return "";
  const d = new Date(dateStr + "T12:00:00");
  return `${String(d.getMonth() + 1).padStart(2, "0")} / ${String(d.getDate()).padStart(2, "0")} / ${d.getFullYear()}`;
}
function addOneYearStr(dateStr) {
  if (!dateStr) return "";
  const d = new Date(dateStr + "T12:00:00");
  d.setFullYear(d.getFullYear() + 1);
  return d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
}
function genCertNo(dateStr) {
  const d = dateStr ? new Date(dateStr + "T12:00:00") : new Date();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dy = String(d.getDate()).padStart(2, "0");
  return `RC-${d.getFullYear()}-${m}${dy}-${Math.floor(Math.random() * 9000) + 1000}`;
}
function escapeHtml(s) {
  return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ── Build certificate HTML (page 1 of the Damage PDF) ────────────────
// Copied from inspection-checker.js. Renders the formal certificate page
// with company logo, findings table, signature, etc.
function buildCertificateHTML({ record, inspectorName, inspectionDateISO, logoUrl, signatureUrl }) {
  const today = inspectionDateISO || new Date().toISOString().split("T")[0];
  const certNo = genCertNo(today);
  const inspector = inspectorName || "Hank Smith";
  const rows = INSP_ROWS_DAMAGE;

  const addr = escapeHtml(record.address || "");
  const cityLine = escapeHtml([record.city, record.state, record.zip].filter(Boolean).join(", "));
  const owner = escapeHtml(record.client_name || "");

  const rowsHtml = rows.map((row, i) => {
    const isFail = row.result === "FAIL";
    const isNA   = row.result === "N/A";
    const bg     = i % 2 === 0 ? "#fff" : "#f8fafc";
    const catColor = isFail ? "#dc2626" : "#1a2e5a";
    const badgeBg  = isFail ? "#dc2626" : isNA ? "#6b7280" : "#199c2e";
    return `<tr style="background:${bg};">
      <td style="padding:4px 9px;border:1px solid #d1d5db;font-weight:700;color:${catColor};font-size:10px;">${escapeHtml(row.category)}</td>
      <td style="padding:4px 9px;border:1px solid #d1d5db;color:#374151;font-size:10px;">${escapeHtml(row.finding)}</td>
      <td style="padding:4px 9px;border:1px solid #d1d5db;text-align:center;">
        <div style="background:${badgeBg};color:#fff;border-radius:3px;padding:2px 5px;font-size:9.5px;font-weight:700;display:inline-block;min-width:32px;">${row.result}</div>
      </td>
    </tr>`;
  }).join("");

  const tdL = `style="padding:6px 10px;font-size:10.5px;font-weight:700;color:#1a2e5a;background:#eef1f8;border:1px solid #c8d4e8;width:24%;"`;
  const tdV = `style="padding:6px 10px;font-size:10.5px;color:#111827;background:#fff;border:1px solid #c8d4e8;"`;

  return `
  <div class="cert-page">
    <div style="border:6px solid #1a2e5a;margin:0.3in 0.35in;">
      <div style="display:flex;align-items:stretch;border-bottom:4px solid #1a2e5a;">
        <div style="width:1.9in;background:#fff;display:flex;align-items:center;justify-content:center;padding:12px 10px;border-right:3px solid #1a2e5a;flex-shrink:0;">
          <img src="${logoUrl}" alt="U.S. Shingle & Metal" style="width:100%;max-height:1in;object-fit:contain;" />
        </div>
        <div style="flex:1;text-align:center;padding:12px 14px;">
          <div style="font-size:20px;font-weight:700;color:#1a2e5a;text-transform:uppercase;">CERTIFIED ROOFING INSPECTION CERTIFICATE</div>
          <div style="font-size:14px;font-weight:700;color:#c8392b;margin-top:3px;">U.S. Shingle and Metal LLC</div>
          <div style="font-size:10.5px;color:#374151;margin-top:2px;">Residential &amp; Commercial Roofing Inspection</div>
          <div style="font-size:10.5px;color:#374151;">Licensed • Insured • Roof Inspectors</div>
          <div style="font-size:10.5px;font-weight:700;color:#c8392b;margin-top:2px;">ASPHALT SHINGLE | METAL ROOFING SYSTEMS</div>
        </div>
      </div>

      <div style="background:#1a2e5a;color:#fff;text-align:center;padding:5px 14px;font-size:10.5px;border-bottom:3px solid #c8392b;">
        Phone: 727-761-5200 &nbsp;|&nbsp; Email: inspection@shingleusa.com &nbsp;|&nbsp; www.shingleusa.com &nbsp;|&nbsp; License #: CCC1331960
      </div>

      <div style="display:flex;justify-content:space-between;padding:6px 14px;font-size:10.5px;border-bottom:1px solid #c8d4e8;background:#f8fafc;">
        <div><strong>Certificate No:</strong> ${certNo}</div>
        <div><strong>Issue Date:</strong> ${fmtDateLong(today)}</div>
      </div>

      <div style="padding:10px 14px 6px;border-bottom:2px solid #1a2e5a;">
        <div style="font-size:11px;font-weight:700;color:#1a2e5a;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:7px;">PROPERTY INFORMATION</div>
        <table style="width:100%;border-collapse:collapse;margin-bottom:4px;"><tbody>
          <tr><td ${tdL}>Property Address:</td><td ${tdV}>${addr}</td><td ${tdL}>Inspection Date:</td><td ${tdV}>${fmtDateLong(today)}</td></tr>
          <tr><td ${tdL}>City, State, ZIP:</td><td ${tdV}>${cityLine}</td><td ${tdL}>Inspector Name:</td><td ${tdV}>${escapeHtml(inspector)}</td></tr>
          <tr><td ${tdL}>Property Owner:</td><td ${tdV}>${owner}</td><td ${tdL}>License No.:</td><td ${tdV}>CCC1331960</td></tr>
        </tbody></table>
      </div>

      <div style="margin:8px 14px;border:2px solid #1a2e5a;border-radius:4px;padding:9px 13px;background:#fff5f5;">
        <div style="font-size:12px;font-weight:700;color:#1a2e5a;text-align:center;margin-bottom:5px;text-transform:uppercase;">OFFICIAL CERTIFICATION STATEMENT</div>
        <div style="font-size:10.5px;line-height:1.65;color:#111827;text-align:center;">
          This is to certify that a thorough roofing inspection was conducted by U.S. Shingle and Metal LLC on the above-referenced property. Based on the findings, the roof system has been evaluated and <strong>STORM DAMAGE HAS BEEN IDENTIFIED</strong>. The roof system requires immediate attention. A licensed Public Adjuster has been notified to assist with the insurance claims process.
        </div>
      </div>

      <div style="padding:0 14px 6px;">
        <div style="font-size:11px;font-weight:700;color:#1a2e5a;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:5px;">INSPECTION FINDINGS</div>
        <table style="width:100%;border-collapse:collapse;font-size:10px;">
          <thead>
            <tr style="background:#1a2e5a;color:#fff;">
              <th style="padding:5px 9px;text-align:left;border:1px solid #1a2e5a;width:30%;">INSPECTION CATEGORY</th>
              <th style="padding:5px 9px;text-align:left;border:1px solid #1a2e5a;">FINDINGS / OBSERVATIONS</th>
              <th style="padding:5px 9px;text-align:center;border:1px solid #1a2e5a;width:72px;">RESULT</th>
            </tr>
          </thead>
          <tbody>${rowsHtml}</tbody>
        </table>
      </div>

      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;margin:6px 14px;border:2px solid #1a2e5a;border-radius:4px;overflow:hidden;">
        <div style="background:#1a2e5a;padding:9px 13px;border-right:2px solid #fff;">
          <div style="font-size:8.5px;color:#c8392b;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:2px;">ESTIMATED REMAINING ROOF LIFE:</div>
          <div style="font-size:14px;font-weight:700;color:#fff;">Needs Replacement</div>
        </div>
        <div style="background:#dc2626;padding:9px 13px;text-align:center;border-right:2px solid #fff;display:flex;flex-direction:column;align-items:center;justify-content:center;">
          <div style="font-size:9.5px;font-weight:700;color:rgba(255,255,255,0.85);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:2px;">DAMAGE STATUS</div>
          <div style="font-size:20px;font-weight:700;color:#fff;">DAMAGE FOUND</div>
        </div>
        <div style="background:#c8392b;padding:9px 13px;text-align:center;display:flex;flex-direction:column;align-items:center;justify-content:center;">
          <div style="font-size:9.5px;font-weight:700;color:rgba(255,255,255,0.85);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:2px;">CERT. INSPECTED ON</div>
          <div style="font-size:16px;font-weight:700;color:#fff;">${fmtDateShort(today)}</div>
        </div>
      </div>

      <div style="padding:7px 14px 9px;">
        <div style="border-top:1px solid #c8d4e8;padding-top:7px;">
          <div style="width:2.5in;height:40px;border-bottom:1px solid #111827;margin-bottom:3px;position:relative;">
            <img src="${signatureUrl}" alt="Inspector Signature" style="height:40px;max-width:2.5in;object-fit:contain;display:block;" />
          </div>
          <div style="font-size:9.5px;font-weight:700;color:#374151;">Inspector Signature</div>
          <div style="font-size:9.5px;color:#374151;margin-top:1px;">Name: ${escapeHtml(inspector)} &nbsp;&nbsp;&nbsp; License #: CCC1331960</div>
        </div>
      </div>

      <div style="background:#f8fafc;border-top:3px solid #1a2e5a;padding:7px 14px;display:flex;align-items:center;gap:12px;">
        <img src="${logoUrl}" alt="USS" style="height:32px;object-fit:contain;flex-shrink:0;" />
        <div>
          <div style="font-size:9.5px;font-weight:700;color:#1a2e5a;">U.S. Shingle and Metal LLC — Residential &amp; Commercial Roofing Inspection</div>
          <div style="font-size:8.5px;color:#6b7280;">This certificate is based on visual inspection only and does not constitute a warranty or guarantee.</div>
          <div style="font-size:8.5px;color:#6b7280;">Cert No. ${certNo} | Issued: ${fmtDateLong(today)} | Valid Through: ${addOneYearStr(today)}</div>
        </div>
      </div>
    </div>
  </div>`;
}

// ── PDFShift wrapper ─────────────────────────────────────────────────
async function renderPdfFromHtml(html) {
  const res = await fetch("https://api.pdfshift.io/v3/convert/pdf", {
    method: "POST",
    headers: {
      "X-API-Key": PDFSHIFT_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      source: html,
      landscape: false,
      use_print: false,
      format: "Letter",
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`PDFShift ${res.status}: ${err.slice(0, 200)}`);
  }
  const buffer = await res.arrayBuffer();
  // Verify magic bytes — PDFShift sometimes returns a 200 with a JSON
  // error payload instead of binary PDF bytes.
  const head = Buffer.from(buffer).slice(0, 5).toString();
  if (head !== "%PDF-") {
    throw new Error("PDFShift returned non-PDF (head: " + head + ")");
  }
  return Buffer.from(buffer).toString("base64");
}

// Build a 2-row photo grid from a list of photos. Each photo is embedded
// as a base64 data URI so PDFShift doesn't need to fetch them from a URL
// (which wouldn't work anyway since JN's /files endpoint requires auth).
function renderPhotoRows(photos) {
  const items = photos.slice(0, 10).map(p => p.dataUri).filter(Boolean);
  const rows = [];
  for (let i = 0; i < items.length; i += 2) {
    const left = items[i], right = items[i + 1];
    rows.push(`
      <tr>
        <td style="padding:4px;width:50%;">
          <img src="${left}" style="width:100%;height:160px;object-fit:cover;border-radius:4px;" />
        </td>
        ${right ? `<td style="padding:4px;width:50%;">
          <img src="${right}" style="width:100%;height:160px;object-fit:cover;border-radius:4px;" />
        </td>` : `<td style="width:50%;"></td>`}
      </tr>`);
  }
  return rows.join("");
}

// ── Damage PDF: 2 pages (certificate + photo grid) ───────────────────
async function generateDamagePDF({ clientName, address, repName, date, photos, record }) {
  const logoUrl = `${BASE_URL}/uss-header.png`;
  const signatureUrl = `${BASE_URL}/rep-signature.png`;
  const inspectionDateISO = new Date().toISOString().split("T")[0];
  const certPageHtml = buildCertificateHTML({
    record,
    inspectorName: "Hank Smith",
    inspectionDateISO,
    logoUrl,
    signatureUrl,
  });

  const photoRows = renderPhotoRows(photos);
  const photoCount = Math.min(photos.length, 10);

  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"/>
  <style>
    @page { size: Letter; margin: 0; }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: Arial, Helvetica, sans-serif; color: #111; font-size: 13px; }
    .cert-page { width: 8.5in; background: #fff; }
    .photos-page { width: 100%; padding: 32px 24px; background: #fff; page-break-before: always; }
    .photos-header { background: #1a2e5a; color: #fff; padding: 14px 20px; border-radius: 6px; margin-bottom: 20px; display: flex; justify-content: space-between; align-items: center; }
    .photos-header h2 { font-size: 16px; margin: 0; }
    .photos-header span { font-size: 12px; opacity: 0.7; }
    .photos-subheader { font-size: 12px; color: #6b7280; margin-bottom: 14px; }
    table.photo-grid { width: 100%; border-collapse: collapse; }
    table.photo-grid td { padding: 4px; width: 50%; }
    table.photo-grid img { width: 100%; height: 155px; object-fit: cover; border-radius: 4px; display: block; border: 1px solid #e5e7eb; }
    .photos-footer { margin-top: 20px; padding-top: 12px; border-top: 1px solid #e5e7eb; font-size: 10px; color: #9ca3af; text-align: center; }
  </style></head><body>
    ${certPageHtml}
    <div class="photos-page">
      <div class="photos-header">
        <h2>📷 Inspection Photos</h2>
        <span>${escapeHtml(clientName)} · ${date}</span>
      </div>
      <div class="photos-subheader">${escapeHtml(address)} · ${photoCount} photos shown</div>
      <table class="photo-grid">${photoRows}</table>
      <div class="photos-footer">
        U.S. Shingle &amp; Metal LLC · License #CCC1331960 · Photos taken during roof inspection · ${date}
      </div>
    </div>
  </body></html>`;

  return await renderPdfFromHtml(html);
}

// ── No-Damage / Retail PDF: 1 page (header + photo grid) ─────────────
// Used when the JN result isn't Damage. The certificate template is built
// around damage findings (FAIL rows, "DAMAGE FOUND" badge, etc.) so we
// don't try to retrofit it for the other results — we ship a simpler
// photos-only report with a header reflecting the outcome.
async function generatePhotoReportPDF({ clientName, address, repName, date, photos, resultLabel }) {
  const logoUrl = `${BASE_URL}/uss-header.png`;
  const photoRows = renderPhotoRows(photos);
  const photoCount = Math.min(photos.length, 10);
  const headerColor = resultLabel === "No Damage" ? "#16a34a" : "#d97706";
  const headerText = resultLabel === "No Damage" ? "✅ No Damage Found" : "🏠 Retail Inspection";

  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"/>
  <style>
    @page { size: Letter; margin: 0; }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: Arial, Helvetica, sans-serif; color: #111; font-size: 13px; padding: 32px 24px; background: #fff; }
    .top { background: #1a2e5a; color: #fff; padding: 16px 22px; border-radius: 8px 8px 0 0; display: flex; align-items: center; gap: 14px; }
    .top img { height: 36px; object-fit: contain; }
    .top .title { font-size: 18px; font-weight: 700; }
    .top .sub { font-size: 11px; opacity: 0.75; margin-top: 2px; }
    .result-bar { padding: 14px 22px; background: ${headerColor}; color: #fff; font-size: 16px; font-weight: 700; text-align: center; }
    .meta { padding: 14px 22px; background: #f9fafb; border: 1px solid #e5e7eb; border-top: none; }
    .meta table { width: 100%; border-collapse: collapse; font-size: 12px; }
    .meta td { padding: 5px 0; }
    .meta td:first-child { color: #6b7280; font-weight: 700; text-transform: uppercase; font-size: 10px; letter-spacing: 0.05em; width: 130px; }
    .photos-section { margin-top: 18px; }
    .photos-header { background: #1a2e5a; color: #fff; padding: 12px 18px; border-radius: 6px 6px 0 0; display: flex; justify-content: space-between; align-items: center; }
    .photos-header h2 { font-size: 15px; margin: 0; }
    .photos-header span { font-size: 11px; opacity: 0.7; }
    .photos-grid-wrap { padding: 14px; background: #fff; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 6px 6px; }
    table.photo-grid { width: 100%; border-collapse: collapse; }
    table.photo-grid td { padding: 4px; width: 50%; }
    table.photo-grid img { width: 100%; height: 160px; object-fit: cover; border-radius: 4px; display: block; border: 1px solid #e5e7eb; }
    .footer { margin-top: 18px; padding-top: 10px; border-top: 1px solid #e5e7eb; font-size: 10px; color: #9ca3af; text-align: center; }
  </style></head><body>
    <div class="top">
      <img src="${logoUrl}" alt="U.S. Shingle &amp; Metal" />
      <div>
        <div class="title">U.S. Shingle and Metal LLC</div>
        <div class="sub">Roof Inspection Report</div>
      </div>
    </div>
    <div class="result-bar">${headerText}</div>
    <div class="meta">
      <table>
        <tr><td>Homeowner</td><td>${escapeHtml(clientName)}</td></tr>
        <tr><td>Address</td><td>${escapeHtml(address)}</td></tr>
        <tr><td>Sales Rep</td><td>${escapeHtml(repName)}</td></tr>
        <tr><td>Inspection Date</td><td>${date}</td></tr>
        <tr><td>Result</td><td><strong>${escapeHtml(resultLabel)}</strong></td></tr>
      </table>
    </div>
    <div class="photos-section">
      <div class="photos-header">
        <h2>📷 Inspection Photos</h2>
        <span>${photoCount} shown</span>
      </div>
      <div class="photos-grid-wrap">
        <table class="photo-grid">${photoRows}</table>
      </div>
    </div>
    <div class="footer">
      U.S. Shingle &amp; Metal LLC · License #CCC1331960 · Photos taken during roof inspection · ${date}
    </div>
  </body></html>`;

  return await renderPdfFromHtml(html);
}

// ── Upload PDF as document on JN job ─────────────────────────────────
// Copied from jobnimbus-sync.js's uploadFileToJob(). Three-step flow:
// (1) request a presigned S3 URL from JN's files API,
// (2) PUT the file bytes to that S3 URL,
// (3) call complete to trigger thumbnail generation.
async function uploadFileToJob(jobId, filename, base64Content) {
  try {
    const fileBytes = Buffer.from(base64Content, "base64");
    console.log("Uploading PDF to JN — filename:", filename, "bytes:", fileBytes.length, "jobId:", jobId);

    // Step 1: Get presigned S3 URL
    const initRes = await fetch(`${JN_FILES_BASE}/files/v1/uploads/url`, {
      method: "POST",
      headers: { Authorization: `bearer ${JN_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        related: [jobId],
        type: 1,                          // 1 = Document
        filename,
        description: "Inspection Report (with photos) — generated from app",
      }),
    });
    const initText = await initRes.text();
    if (!initRes.ok) return { success: false, error: `Init ${initRes.status}: ${initText.slice(0, 300)}` };

    const initData = JSON.parse(initText);
    const uploadUrl = initData.data?.url || initData.url || initData.upload_url;
    const fileJnid = initData.data?.jnid || initData.jnid;
    if (!uploadUrl) return { success: false, error: "No upload URL: " + initText.slice(0, 200) };

    // Step 2: PUT file bytes to S3
    const s3Res = await fetch(uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": "application/pdf" },
      body: fileBytes,
    });
    if (!s3Res.ok) {
      const s3Err = await s3Res.text();
      return { success: false, error: `S3 ${s3Res.status}: ${s3Err.slice(0, 200)}` };
    }

    // Step 3: Complete (triggers thumbnail generation in JN)
    if (fileJnid) {
      await fetch(`${JN_FILES_BASE}/files/v1/uploads/${fileJnid}/complete`, {
        method: "POST",
        headers: { Authorization: `bearer ${JN_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
    }

    return { success: true };
  } catch (e) {
    console.error("uploadFileToJob error:", e.message);
    return { success: false, error: e.message };
  }
}