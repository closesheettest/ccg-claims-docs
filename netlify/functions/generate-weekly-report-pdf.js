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
// Bucketize one rep's signings the same way computeTimeBuckets does in
// App.jsx. "Latest" = latest hour-of-day (NOT chronologically most
// recent) — see the App.jsx comment for the reasoning. Duplicated
// rather than imported because this is a Netlify function and the
// React source isn't bundled here.
const computeRepBuckets = (signings) => {
  const out = {
    morning:   { count: 0, latest: null, _m: -1 },
    afternoon: { count: 0, latest: null, _m: -1 },
    evening:   { count: 0, latest: null, _m: -1 },
  };
  const bump = (k, signedAt, m) => {
    out[k].count++;
    if (signedAt != null && m != null && m > out[k]._m) {
      out[k].latest = signedAt;
      out[k]._m = m;
    }
  };
  for (const s of signings || []) {
    if (!s.signedAt) continue;
    const d = new Date(s.signedAt);
    if (Number.isNaN(d.getTime())) continue;
    const m = d.getHours() * 60 + d.getMinutes();
    if (m < 12 * 60) bump("morning", s.signedAt, m);
    else if (m <= 17 * 60) bump("afternoon", s.signedAt, m);
    else bump("evening", s.signedAt, m);
  }
  for (const k of Object.keys(out)) delete out[k]._m;
  return out;
};

const fmtRepTime = (iso) => {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
};

const renderRepBlock = (rep, signings, repTotal) => {
  const rowCount = signings.length;
  const rows = signings.map((s, i) => renderSigningRow(s, i)).join("");

  // Per-rep mini time-of-day strip — small pills, only non-zero buckets
  // shown. Mirrors RepTimeOfDayStrip in App.jsx.
  const repBuckets = computeRepBuckets(signings);
  const pill = (emoji, data) => data.count > 0 ? `
    <span style="display:inline-flex;align-items:center;gap:4px;background:rgba(255,255,255,0.85);color:#075985;padding:3px 8px;border-radius:999px;border:1px solid #bae6fd;font-size:10px;font-weight:700;margin-right:5px">
      <span>${emoji}</span>
      <span>${data.count}</span>
      ${data.latest ? `<span style="font-weight:500;opacity:0.8">&middot; last ${esc(fmtRepTime(data.latest))}</span>` : ""}
    </span>` : "";
  const repStrip = `
    <div style="margin-top:6px;font-family:Arial,sans-serif">
      ${pill("🌅", repBuckets.morning)}${pill("☀️", repBuckets.afternoon)}${pill("🌙", repBuckets.evening)}
    </div>`;

  return `
    <div style="margin-bottom:18px;page-break-inside:avoid">
      <div style="background:#dbeafe;color:#1e40af;padding:8px 14px;border-radius:8px;margin-bottom:6px">
        <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:6px">
          <div style="font-size:13px;font-weight:700">${esc(rep)}</div>
          <div style="font-size:11px">${rowCount} signing${rowCount !== 1 ? "s" : ""} &middot; <strong>${fmtUSD(repTotal)}</strong></div>
        </div>
        ${repStrip}
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
  const { startDate, endDate, totalRows, totalEarned, byRep, repTotals, timeBuckets } = reportData;

  // Sort reps by total earnings desc — biggest contributors first
  const repNames = Object.keys(byRep || {}).sort(
    (a, b) => (repTotals?.[b] || 0) - (repTotals?.[a] || 0)
  );

  const repSections = repNames.length === 0
    ? `<div style="text-align:center;padding:40px 0;color:#9ca3af;font-size:14px">No signings recorded this period.</div>`
    : repNames.map(rep => renderRepBlock(rep, byRep[rep], repTotals[rep] || 0)).join("");

  // Time-of-day breakdown block — matches the on-screen UI's
  // TimeOfDayBreakdown component (App.jsx). Keep the labels, ranges,
  // and color palette in sync. Hidden when totalRows = 0.
  //
  // The bucket data shape is { count, latest } — see computeTimeBuckets
  // in App.jsx. A small back-compat shim treats older clients (which
  // sent just numbers) as { count: N, latest: null }.
  const tbTotal = totalRows || 0;
  const pct = (n) => tbTotal > 0 ? Math.round((n / tbTotal) * 100) : 0;
  // Normalize either shape into { count, latest } so the template
  // below can be uniform.
  const tbNormalize = (raw) => {
    if (raw == null) return { count: 0, latest: null };
    if (typeof raw === "number") return { count: raw, latest: null };
    return { count: raw.count || 0, latest: raw.latest || null };
  };
  const fmtTimeShort = (iso) => {
    if (!iso) return "";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  };
  const tb = {
    morning:   tbNormalize(timeBuckets?.morning),
    afternoon: tbNormalize(timeBuckets?.afternoon),
    evening:   tbNormalize(timeBuckets?.evening),
    unknown:   tbNormalize(timeBuckets?.unknown),
  };

  // Each bucket renders as a small vertical card: label, time range,
  // count + percent, latest signing time. Cards sit side-by-side with
  // flex; on a Letter-sized PDF page they fit comfortably in one row.
  const tbCard = (label, range, data, bg, fg, border) => `
    <div style="flex:1 1 0;min-width:0;padding:10px 12px;border-radius:10px;background:${bg};color:${fg};border:1px solid ${border};font-family:Arial,sans-serif">
      <div style="font-weight:700;font-size:12px">${label}</div>
      <div style="font-size:10px;opacity:0.85;margin-top:1px">${esc(range)}</div>
      <div style="font-size:15px;font-weight:700;margin-top:6px">
        ${data.count} <span style="font-weight:600;font-size:11px;opacity:0.85">(${pct(data.count)}%)</span>
      </div>
      <div style="font-size:10px;margin-top:4px;opacity:0.85">
        ${data.latest
          ? `Latest: <strong>${esc(fmtTimeShort(data.latest))}</strong>`
          : `<span style="font-style:italic;opacity:0.7">No signings</span>`}
      </div>
    </div>`;
  const timeBreakdownBlock = tbTotal > 0 ? `
    <div style="margin-bottom:16px;padding:12px 14px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px">
      <div style="font-size:9px;font-weight:700;color:#475569;letter-spacing:0.06em;text-transform:uppercase;margin-bottom:8px">
        Time of day &middot; ${tbTotal} signing${tbTotal === 1 ? "" : "s"}
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        ${tbCard("🌅 Morning",   "before noon",       tb.morning,   "#fef3c7", "#92400e", "#fcd34d")}
        ${tbCard("☀️ Afternoon", "12 PM – 5 PM",     tb.afternoon, "#dbeafe", "#1e40af", "#93c5fd")}
        ${tbCard("🌙 Evening",   "after 5 PM",        tb.evening,   "#ede9fe", "#5b21b6", "#c4b5fd")}
        ${tb.unknown.count > 0 ? tbCard("❔ Unknown", "no timestamp", tb.unknown, "#f1f5f9", "#475569", "#cbd5e1") : ""}
      </div>
    </div>` : "";

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

    <!-- Time-of-day breakdown -->
    ${timeBreakdownBlock}

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