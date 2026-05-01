// netlify/functions/generate-weekly-report-pdf.js
//
// Generates a Letter-sized PDF of the weekly commission report from the
// reportData object the app already builds in memory. Used by both the
// "Download PDF" button and the "Email PDF" modal in App.jsx — neither
// caller needs anything other than `{ ok, base64 }` back.
//
// USAGE:
//   POST /.netlify/functions/generate-weekly-report-pdf
//   Body: { reportData: {
//     startDate, endDate, totalRows, totalEarned,
//     byRep: { "Rep Name": [signing, ...], ... },
//     repTotals: { "Rep Name": <number>, ... }
//   }}
//
// Returns: { ok: true, base64: "<base64-encoded-pdf>" } on success
//          { ok: false, error, detail? }                on failure

const PDFSHIFT_KEY = process.env.PDFSHIFT_API_KEY;

// ── HTML escape helper ────────────────────────────────────────────
// Anything that goes into the rendered HTML must be escaped — homeowner
// names and addresses occasionally contain &, <, ', etc. and we don't
// want them to break the markup or become injection vectors.
const esc = (s) => String(s ?? "")
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;")
  .replace(/'/g, "&#39;");

// Format a USD amount with comma separators, no cents (matches the on-screen UI).
const fmtUSD = (n) => "$" + (Number(n) || 0).toLocaleString("en-US");

// Render the three doc-status circles for a single signing row.
// Mirrors the on-screen logic:
//   "current" → green checkmark (counted toward pay this period)
//   "prior"   → grey checkmark (signed before, no pay)
//   anything else (incl. undefined) → empty grey ring
const renderCheck = (status) => {
  if (status === "current") return `<span style="color:#16a34a;font-weight:700">✓</span>`;
  if (status === "prior")   return `<span style="color:#9ca3af">✓</span>`;
  return `<span style="color:#d1d5db">○</span>`;
};

// Build a single signing row for a rep section.
const renderSigningRow = (s, idx) => {
  // Cancelled rows get a faded red background, a CANCELLED tag, and $0
  // earned. They stay in the report so the rep sees what was lost — totals
  // already excluded them via earned=0 at calc time.
  const stripe = s.cancelled
    ? (idx % 2 === 0 ? "#fef2f2" : "#fee2e2")
    : (idx % 2 === 0 ? "#ffffff" : "#f9fafb");
  const earnedColor = (s.earned || 0) > 0 ? "#166534" : "#9ca3af";
  const signedAt = s.signedAt ? new Date(s.signedAt).toLocaleString("en-US") : "";
  // If the inspection was already signed in a prior period, surface that
  // hint inline — matches the on-screen tooltip behavior.
  const inspHint = (s.inspStatus === "prior" && s.inspSignedAt)
    ? ` · Insp signed ${new Date(s.inspSignedAt).toLocaleDateString("en-US")}`
    : "";
  const cancelHint = (s.cancelled && s.cancelledAt)
    ? ` · Cancelled ${new Date(s.cancelledAt).toLocaleDateString("en-US")}`
    : "";
  const nameStyle = s.cancelled
    ? `font-size:11px;font-weight:700;color:#6b7280;text-decoration:line-through`
    : `font-size:11px;font-weight:700;color:#111827`;
  const cancelTag = s.cancelled
    ? `<span style="display:inline-block;margin-left:6px;padding:1px 6px;border-radius:4px;background:#dc2626;color:#fff;font-size:8px;font-weight:700;letter-spacing:0.04em;vertical-align:middle">CANCELLED</span>`
    : "";
  return `
    <tr style="background:${stripe}">
      <td style="padding:6px 10px;border-top:1px solid #f3f4f6">
        <div style="${nameStyle}">${esc(s.name)}${cancelTag}</div>
        <div style="font-size:10px;color:#6b7280">${esc(s.address)}</div>
        <div style="font-size:9px;color:#9ca3af">${esc(signedAt + inspHint + cancelHint)}</div>
      </td>
      <td style="padding:6px 4px;border-top:1px solid #f3f4f6;text-align:center;font-size:14px">${renderCheck(s.inspStatus)}</td>
      <td style="padding:6px 4px;border-top:1px solid #f3f4f6;text-align:center;font-size:14px">${renderCheck(s.lorStatus)}</td>
      <td style="padding:6px 4px;border-top:1px solid #f3f4f6;text-align:center;font-size:14px">${renderCheck(s.pacStatus)}</td>
      <td style="padding:6px 10px;border-top:1px solid #f3f4f6;text-align:right;font-size:11px;font-weight:700;color:${earnedColor}">${fmtUSD(s.earned)}</td>
    </tr>
  `;
};

// Build a single rep block: header pill + table of signings.
const renderRepBlock = (rep, signings, repTotal) => {
  const rowCount = signings.length;
  const rows = signings.map((s, i) => renderSigningRow(s, i)).join("");
  return `
    <div style="margin-bottom:18px;page-break-inside:avoid">
      <div style="background:#dbeafe;color:#1e40af;padding:8px 14px;border-radius:8px;display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
        <div style="font-size:13px;font-weight:700">${esc(rep)}</div>
        <div style="font-size:11px">${rowCount} signing${rowCount !== 1 ? "s" : ""} · <strong>${fmtUSD(repTotal)}</strong></div>
      </div>
      <table style="width:100%;border-collapse:collapse;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden">
        <thead>
          <tr style="background:#f3f4f6">
            <th style="padding:6px 10px;text-align:left;font-size:9px;color:#6b7280;text-transform:uppercase;letter-spacing:0.04em">Property</th>
            <th style="padding:6px 4px;text-align:center;font-size:9px;color:#6b7280;text-transform:uppercase;width:40px">Insp</th>
            <th style="padding:6px 4px;text-align:center;font-size:9px;color:#6b7280;text-transform:uppercase;width:40px">LOR</th>
            <th style="padding:6px 4px;text-align:center;font-size:9px;color:#6b7280;text-transform:uppercase;width:40px">PA</th>
            <th style="padding:6px 10px;text-align:right;font-size:9px;color:#6b7280;text-transform:uppercase;width:64px">Earned</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
};

// Build the full report HTML — page-styled for Letter, headers and footers
// rendered inline rather than via PDFShift's margin-box feature so we don't
// need to coordinate a separate header template.
const buildReportHtml = (reportData) => {
  const { startDate, endDate, totalRows, totalEarned, byRep, repTotals } = reportData;

  // Sort reps by total earnings desc — biggest contributors first
  const repNames = Object.keys(byRep || {}).sort(
    (a, b) => (repTotals?.[b] || 0) - (repTotals?.[a] || 0)
  );

  const repSections = repNames.length === 0
    ? `<div style="text-align:center;padding:40px 0;color:#9ca3af;font-size:14px">No signings recorded this period.</div>`
    : repNames.map(rep => renderRepBlock(rep, byRep[rep], repTotals[rep] || 0)).join("");

  const generatedAt = new Date().toLocaleString("en-US");

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Weekly Report — ${esc(startDate)} to ${esc(endDate)}</title>
  <style>
    * { box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif; margin: 0; color: #111827; }
    .page { padding: 28px 32px; }
  </style>
</head>
<body>
  <div class="page">
    <!-- Header -->
    <div style="background:#1a2e5a;color:#fff;padding:18px 24px;border-radius:10px;margin-bottom:18px">
      <div style="font-size:20px;font-weight:700;letter-spacing:0.02em">Weekly Commission Report</div>
      <div style="font-size:12px;color:rgba(255,255,255,0.85);margin-top:4px">
        ${esc(startDate)} &nbsp;→&nbsp; ${esc(endDate)}
      </div>
    </div>

    <!-- Totals summary -->
    <div style="display:flex;gap:12px;margin-bottom:20px">
      <div style="flex:1;background:#f9fafb;border:1px solid #e5e7eb;border-radius:10px;padding:12px 16px">
        <div style="font-size:10px;color:#6b7280;text-transform:uppercase;letter-spacing:0.04em">Total Signings</div>
        <div style="font-size:22px;font-weight:700;color:#1a2e5a;margin-top:2px">${totalRows}</div>
      </div>
      <div style="flex:1;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;padding:12px 16px">
        <div style="font-size:10px;color:#166534;text-transform:uppercase;letter-spacing:0.04em">Total Earned</div>
        <div style="font-size:22px;font-weight:700;color:#166534;margin-top:2px">${fmtUSD(totalEarned)}</div>
      </div>
      <div style="flex:1;background:#f9fafb;border:1px solid #e5e7eb;border-radius:10px;padding:12px 16px">
        <div style="font-size:10px;color:#6b7280;text-transform:uppercase;letter-spacing:0.04em">Reps</div>
        <div style="font-size:22px;font-weight:700;color:#1a2e5a;margin-top:2px">${repNames.length}</div>
      </div>
    </div>

    <!-- Per-rep breakdown -->
    ${repSections}

    <!-- Footer / pay rules legend -->
    <div style="margin-top:18px;padding:10px 14px;background:#f9fafb;border-radius:8px;font-size:9px;color:#6b7280;display:flex;gap:16px;flex-wrap:wrap">
      <div><span style="color:#16a34a;font-weight:700">✓</span> signed this period</div>
      <div><span style="color:#9ca3af">✓</span> signed previously (no pay)</div>
      <div><span style="color:#d1d5db">○</span> not yet signed</div>
      <div style="margin-left:auto">Insp $100 · LOR+PA $150 · All 3 $250</div>
    </div>

    <div style="margin-top:8px;text-align:right;font-size:9px;color:#9ca3af">
      Generated ${esc(generatedAt)}
    </div>
  </div>
</body>
</html>`;
};

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      body: JSON.stringify({ ok: false, error: "Method not allowed" }),
    };
  }

  if (!PDFSHIFT_KEY) {
    return {
      statusCode: 500,
      body: JSON.stringify({ ok: false, error: "PDFSHIFT_API_KEY env var is not set" }),
    };
  }

  let reportData;
  try {
    const body = JSON.parse(event.body || "{}");
    reportData = body.reportData;
  } catch {
    return {
      statusCode: 400,
      body: JSON.stringify({ ok: false, error: "Invalid JSON body" }),
    };
  }

  if (!reportData || typeof reportData !== "object") {
    return {
      statusCode: 400,
      body: JSON.stringify({ ok: false, error: "reportData is required" }),
    };
  }

  // Build the HTML and hand it to PDFShift. Letter page size matches the
  // existing PDF templates the rest of the app generates so a manager
  // printing both this and a signed-doc set ends up with consistent paper.
  let html;
  try {
    html = buildReportHtml(reportData);
  } catch (e) {
    return {
      statusCode: 500,
      body: JSON.stringify({ ok: false, error: "HTML render failed", detail: e.message }),
    };
  }

  try {
    const pdfRes = await fetch("https://api.pdfshift.io/v3/convert/pdf", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Basic " + Buffer.from(`api:${PDFSHIFT_KEY}`).toString("base64"),
      },
      body: JSON.stringify({
        source: html,
        format: "Letter",
      }),
    });

    if (!pdfRes.ok) {
      const errText = await pdfRes.text();
      console.error("PDFShift error:", pdfRes.status, errText.slice(0, 500));
      return {
        statusCode: 500,
        body: JSON.stringify({
          ok: false,
          error: `PDFShift returned ${pdfRes.status}`,
          detail: errText.slice(0, 500),
        }),
      };
    }

    const buffer = await pdfRes.arrayBuffer();
    // Verify magic bytes — PDFs always start with "%PDF-".
    // PDFShift occasionally returns a 200 with a JSON error payload instead
    // of binary PDF bytes; check before we ship something useless to the user.
    const head = Buffer.from(buffer).slice(0, 5).toString();
    if (head !== "%PDF-") {
      console.error("PDFShift returned non-PDF, head:", head);
      return {
        statusCode: 500,
        body: JSON.stringify({ ok: false, error: "PDFShift returned non-PDF response" }),
      };
    }

    const base64 = Buffer.from(buffer).toString("base64");
    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true, base64 }),
    };
  } catch (e) {
    console.error("generate-weekly-report-pdf error:", e);
    return {
      statusCode: 500,
      body: JSON.stringify({ ok: false, error: e.message || "Unknown error" }),
    };
  }
};