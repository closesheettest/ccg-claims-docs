// netlify/functions/inspection-checker.js
// Polls JN for inspection result changes (Damage, No Damage, Retail)
// - Damage + insp only → SMS to sales rep
// - All results → email report with photos to rep + office

const JN_BASE     = "https://app.jobnimbus.com/api1";
const JN_FILES    = "https://api.jobnimbus.com/files/v1";
const JN_KEY      = process.env.JOBNIMBUS_API_KEY;
const SB_URL      = process.env.VITE_SUPABASE_URL;
const SB_KEY      = process.env.VITE_SUPABASE_ANON_KEY;
const OFFICE_EMAIL = process.env.OFFICE_EMAIL || "neals@shingleusa.com";
const BASE_URL    = process.env.URL || "https://ccg-claims-docs.netlify.app";

const sbHeaders = {
  apikey: SB_KEY,
  Authorization: `Bearer ${SB_KEY}`,
  "Content-Type": "application/json",
};

const jnHeaders = {
  Authorization: `bearer ${JN_KEY}`,
  "Content-Type": "application/json",
};

const TRIGGER_RESULTS = ["Damage", "No Damage", "Retail"];

exports.handler = async (event) => {
  console.log("=== Inspection Checker Start ===");

  try {
    // ── 1. Fetch recently updated JN jobs ──────────────────────
    const since = Math.floor(Date.now() / 1000) - 7 * 24 * 60 * 60;
    const jnRes = await fetch(
      `${JN_BASE}/jobs?size=100&sort=-date_updated&date_updated_after=${since}`,
      { headers: jnHeaders }
    );

    if (!jnRes.ok) {
      const err = await jnRes.text();
      console.error("JN fetch failed:", jnRes.status, err);
      return { statusCode: 500, body: JSON.stringify({ error: "JN fetch failed" }) };
    }

    const jnData = await jnRes.json();
    const allJobs = jnData.results || jnData.jobs || [];
    console.log("JN jobs fetched:", allJobs.length);

    // Log first job to see what fields come back in the list
    if (allJobs.length > 0) {
      const sample = allJobs[0];
      console.log("Sample job keys:", Object.keys(sample).join(", "));
      console.log("Sample cf_string_34:", sample.cf_string_34, "| name:", sample.name);
    }

    // cf_string_34 may not appear in list endpoint — fetch each job individually
    // to get custom fields. Only fetch jobs that are in PA workflow (record_type 45)
    const paJobs = allJobs.filter(j => j.record_type === 45 || j.record_type_name === "Lead" || j.record_type_name === "PA");
    console.log("PA/Lead jobs to check:", paJobs.length);

    // Fetch full details for each job to get cf_string_34
    const jobDetails = await Promise.all(
      paJobs.slice(0, 50).map(async (j) => {
        const jnid = j.jnid || j.id;
        try {
          const r = await fetch(`${JN_BASE}/jobs/${jnid}`, { headers: jnHeaders });
          if (!r.ok) return null;
          const d = await r.json();
          return d;
        } catch(e) { return null; }
      })
    );

    const fullJobs = jobDetails.filter(Boolean);
    console.log("Full job details fetched:", fullJobs.length);
    fullJobs.forEach(j => {
      if (j.cf_string_34) console.log("Job", j.jnid, j.name, "→ cf_string_34:", j.cf_string_34);
    });

    const triggeredJobs = fullJobs.filter(j => TRIGGER_RESULTS.includes(j.cf_string_34));
    console.log("Triggered jobs:", triggeredJobs.length);

    if (triggeredJobs.length === 0) {
      return {
        statusCode: 200,
        body: JSON.stringify({ message: "No changed inspections found", checked: allJobs.length, pa_jobs: paJobs.length, full_details: fullJobs.length }),
      };
    }

    const results = [];

    for (const job of triggeredJobs) {
      const jnJobId   = job.jnid || job.id;
      const newResult = job.cf_string_34;
      console.log("Processing:", jnJobId, job.name, "→", newResult);

      // ── 2. Find Supabase record ──────────────────────────────
      // Try by jn_job_id first, then fall back to name/address match
      let record = null;

      const sbRes = await fetch(
        `${SB_URL}/rest/v1/inspections?jn_job_id=eq.${jnJobId}&select=id,client_name,address,city,state,zip,sales_rep_id,sales_rep_email,inspection_result,docs_signed&limit=1`,
        { headers: sbHeaders }
      );
      if (sbRes.ok) {
        const sbData = await sbRes.json();
        if (sbData && sbData.length > 0) record = sbData[0];
      }

      // Fallback: match by job name which contains the homeowner name
      if (!record && job.name) {
        const jobNameParts = job.name.replace("[TEST] ", "").replace("[TEST-", "").split(" - ");
        const nameFromJob = jobNameParts[0]?.trim();
        const addrFromJob = jobNameParts[1]?.split("[")[0]?.trim();
        console.log("Fallback search by name:", nameFromJob, "addr:", addrFromJob);

        if (nameFromJob) {
          const fbRes = await fetch(
            `${SB_URL}/rest/v1/inspections?client_name=ilike.*${encodeURIComponent(nameFromJob)}*&select=id,client_name,address,city,state,zip,sales_rep_id,sales_rep_email,inspection_result,docs_signed&limit=1`,
            { headers: sbHeaders }
          );
          if (fbRes.ok) {
            const fbData = await fbRes.json();
            if (fbData && fbData.length > 0) {
              record = fbData[0];
              console.log("Found by name fallback:", record.id, record.client_name);
              // Save the jn_job_id so future lookups are faster
              await fetch(`${SB_URL}/rest/v1/inspections?id=eq.${record.id}`, {
                method: "PATCH",
                headers: { ...sbHeaders, Prefer: "return=minimal" },
                body: JSON.stringify({ jn_job_id: jnJobId }),
              });
              console.log("Saved jn_job_id to record:", jnJobId);
            }
          }
        }
      }

      if (!record) { console.log("No SB record found for:", jnJobId, job.name); continue; }

      // Skip if already processed this result
      if (record.inspection_result === newResult) {
        console.log("Already processed — skipping:", jnJobId);
        continue;
      }

      // ── 3. Get rep info ──────────────────────────────────────
      let repPhone = null;
      let repEmail = record.sales_rep_email || null;
      let repName  = null;

      if (record.sales_rep_id) {
        const repRes = await fetch(
          `${SB_URL}/rest/v1/sales_reps?jobnimbus_id=eq.${record.sales_rep_id}&select=name,phone,email&limit=1`,
          { headers: sbHeaders }
        );
        if (repRes.ok) {
          const repData = await repRes.json();
          if (repData && repData.length > 0) {
            repPhone = repData[0].phone;
            repName  = repData[0].name;
            repEmail = repEmail || repData[0].email;
          }
        }
      }

      // ── 4. SMS — Damage + insp only ─────────────────────────
      let smsSent = false;
      if (newResult === "Damage") {
        const docsSigned = record.docs_signed || "";
        console.log("SMS check — repPhone:", repPhone, "| docs_signed:", docsSigned, "| sales_rep_id:", record.sales_rep_id);
        if (!repPhone) {
          console.warn("No rep phone found — SMS skipped. Check sales_reps table for this rep:", record.sales_rep_id);
        } else if (docsSigned.includes("lor") || docsSigned.includes("pac")) {
          console.log("LOR/PA already signed — SMS skipped");
        } else {
          const msg = `🚨 ${record.client_name || "Homeowner"} at ${record.address || "their address"} has DAMAGE — call them immediately and get them to sign PA paperwork!`;
          console.log("Sending SMS to:", repPhone, "via", `${BASE_URL}/.netlify/functions/ghl-sms`);
          const smsRes = await fetch(`${BASE_URL}/.netlify/functions/ghl-sms`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ to: repPhone, message: msg, name: repName || "Sales Rep" }),
          });
          const smsText = await smsRes.text();
          smsSent = smsRes.ok;
          console.log("SMS result:", smsRes.status, smsText.slice(0, 300));
        }
      }

      // ── 5. Fetch photos from JN ──────────────────────────────
      const photos = await fetchJobPhotos(jnJobId);
      console.log("Photos fetched:", photos.length);

      // ── 6. Send report email ─────────────────────────────────
      const reportDate = new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });

      const reportHtml = buildReportEmail({
        clientName: record.client_name || "Homeowner",
        address: [record.address, record.city, record.state, record.zip].filter(Boolean).join(", "),
        result: newResult,
        repName: repName || "—",
        photos,
      });

      // For damage — generate a PDF attachment
      let pdfBase64 = null;
      let pdfFilename = null;
      if (newResult === "Damage" && photos.length > 0) {
        console.log("Generating damage PDF...");
        pdfBase64 = await generateDamagePDF({
          clientName: record.client_name || "Homeowner",
          address: [record.address, record.city, record.state, record.zip].filter(Boolean).join(", "),
          repName: repName || "—",
          date: reportDate,
          photos,
        });
        if (pdfBase64) {
          const safeName = (record.client_name || "Homeowner").replace(/[^a-zA-Z0-9]/g, "-");
          pdfFilename = `Damage-Report-${safeName}-${new Date().toISOString().slice(0,10)}.pdf`;
          console.log("Damage PDF ready:", pdfFilename);
        }
      }

      const resultEmoji = newResult === "Damage" ? "🚨" : newResult === "No Damage" ? "✅" : "🏠";
      const subject = `${resultEmoji} Inspection Result: ${newResult} — ${record.client_name || "Homeowner"} at ${record.address || ""}`;

      const emailTo = [];
      if (repEmail) emailTo.push(repEmail);
      if (!emailTo.includes(OFFICE_EMAIL)) emailTo.push(OFFICE_EMAIL);

      const emailSent = await sendEmail(emailTo, subject, reportHtml, pdfBase64, pdfFilename);
      console.log("Report email sent:", emailSent, "to:", emailTo, "| PDF attached:", !!pdfBase64);

      // ── 7. Update Supabase ───────────────────────────────────
      await updateInspectionResult(record.id, newResult, emailSent);

      results.push({
        job: jnJobId,
        client: record.client_name,
        result: newResult,
        sms_sent: smsSent,
        photos: photos.length,
        email_sent: emailSent,
        emailed_to: emailTo,
      });
    }

    console.log("=== Inspection Checker Complete ===", JSON.stringify(results));
    return {
      statusCode: 200,
      body: JSON.stringify({ message: "Check complete", checked: allJobs.length, processed: results.length, results }),
    };

  } catch (err) {
    console.error("=== Inspection Checker ERROR ===", err.message);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};

// ── Fetch photos from JN ─────────────────────────────────────────
async function fetchJobPhotos(jnJobId) {
  try {
    const res = await fetch(
      `${JN_FILES}/files?related=${jnJobId}&type=2&size=30`,
      { headers: { Authorization: `bearer ${JN_KEY}`, "Content-Type": "application/json" } }
    );
    if (!res.ok) { console.warn("Photo list failed:", res.status); return []; }
    const data = await res.json();
    console.log("Photo API response keys:", Object.keys(data).join(", "));
    console.log("Photo API sample:", JSON.stringify(data).slice(0, 500));
    const files = data.data || data.files || data.results || [];
    console.log("Photo files found:", files.length);

    const imageFiles = files.filter(f => (f.content_type || "").startsWith("image/"));
    console.log("Image files (non-PDF):", imageFiles.length);

    const photoPromises = imageFiles.slice(0, 20).map(async (file) => {
      try {
        const url = file.presigned_url || file.url || file.download_url
          || file.file_url || file.original_url
          || file.src || file.link || file.public_url || file.signed_url;

        if (!url) {
          console.warn("No URL found for photo:", file.jnid || file.id);
          return null;
        }

        console.log("Downloading photo from:", url.slice(0, 80));
        const imgRes = await fetch(url);
        if (!imgRes.ok) {
          console.warn("Photo download failed:", imgRes.status, url.slice(0, 80));
          return null;
        }
        const buffer = await imgRes.arrayBuffer();
        const base64 = Buffer.from(buffer).toString("base64");
        const contentType = imgRes.headers.get("content-type") || "image/jpeg";
        console.log("Photo downloaded ok, size:", buffer.byteLength, "type:", contentType);

        // Also download thumbnail (much smaller) for PDF use
        let thumbBase64 = null;
        if (file.thumbnail_url) {
          try {
            const thumbRes = await fetch(file.thumbnail_url);
            if (thumbRes.ok) {
              const thumbBuf = await thumbRes.arrayBuffer();
              thumbBase64 = Buffer.from(thumbBuf).toString("base64");
              console.log("Thumbnail downloaded, size:", thumbBuf.byteLength);
            }
          } catch(e) { /* ignore thumb errors */ }
        }

        return { base64, contentType, thumbBase64 };
      } catch (e) { console.warn("Photo download error:", e.message); return null; }
    });

    return (await Promise.all(photoPromises)).filter(Boolean);
  } catch (e) {
    console.warn("fetchJobPhotos error:", e.message);
    return [];
  }
}

// ── Build HTML report ────────────────────────────────────────────
function buildReportEmail({ clientName, address, result, repName, photos }) {
  const resultColor = result === "Damage" ? "#dc2626" : result === "No Damage" ? "#16a34a" : "#d97706";
  const resultBg    = result === "Damage" ? "#fef2f2" : result === "No Damage" ? "#f0fdf4" : "#fffbeb";
  const resultEmoji = result === "Damage" ? "🚨" : result === "No Damage" ? "✅" : "🏠";

  const photoRows = [];
  for (let i = 0; i < photos.length; i += 2) {
    const left  = photos[i];
    const right = photos[i + 1];
    photoRows.push(`
      <tr>
        <td style="padding:5px;">
          <img src="data:${left.contentType};base64,${left.base64}"
            style="width:100%;max-width:290px;height:200px;object-fit:cover;border-radius:6px;display:block;" />
        </td>
        ${right ? `<td style="padding:5px;">
          <img src="data:${right.contentType};base64,${right.base64}"
            style="width:100%;max-width:290px;height:200px;object-fit:cover;border-radius:6px;display:block;" />
        </td>` : "<td></td>"}
      </tr>`);
  }

  const photoSection = photos.length > 0
    ? `<div style="margin-top:24px;">
        <div style="font-size:13px;font-weight:700;color:#374151;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:12px;">
          📷 Inspection Photos (${photos.length})
        </div>
        <table style="width:100%;border-collapse:collapse;">${photoRows.join("")}</table>
      </div>`
    : `<div style="margin-top:20px;padding:16px;background:#f9fafb;border-radius:8px;text-align:center;color:#9ca3af;font-size:14px;">
        No photos found in JobNimbus for this inspection.
      </div>`;

  return `<div style="font-family:Arial,sans-serif;max-width:680px;margin:0 auto;background:#f3f4f6;padding:20px;">
    <div style="background:#1a2e5a;padding:22px 28px;border-radius:10px 10px 0 0;">
      <div style="font-size:20px;font-weight:700;color:#fff;">Inspection Report</div>
      <div style="font-size:13px;color:rgba(255,255,255,0.6);margin-top:3px;">U.S. Shingle &amp; Metal LLC</div>
    </div>
    <div style="background:#fff;padding:28px;border-radius:0 0 10px 10px;border:1px solid #e5e7eb;border-top:none;">

      <div style="background:${resultBg};border:2px solid ${resultColor};border-radius:10px;padding:20px;text-align:center;margin-bottom:24px;">
        <div style="font-size:36px;margin-bottom:6px;">${resultEmoji}</div>
        <div style="font-size:28px;font-weight:700;color:${resultColor};">${result}</div>
      </div>

      <table style="width:100%;border-collapse:collapse;font-size:14px;margin-bottom:20px;">
        <tr><td style="padding:9px 14px;background:#f9fafb;border:1px solid #e5e7eb;font-weight:700;color:#6b7280;text-transform:uppercase;font-size:11px;letter-spacing:0.06em;width:30%;">Homeowner</td>
            <td style="padding:9px 14px;border:1px solid #e5e7eb;font-weight:600;color:#111827;">${clientName}</td></tr>
        <tr><td style="padding:9px 14px;background:#f9fafb;border:1px solid #e5e7eb;font-weight:700;color:#6b7280;text-transform:uppercase;font-size:11px;letter-spacing:0.06em;">Address</td>
            <td style="padding:9px 14px;border:1px solid #e5e7eb;color:#111827;">${address}</td></tr>
        <tr><td style="padding:9px 14px;background:#f9fafb;border:1px solid #e5e7eb;font-weight:700;color:#6b7280;text-transform:uppercase;font-size:11px;letter-spacing:0.06em;">Sales Rep</td>
            <td style="padding:9px 14px;border:1px solid #e5e7eb;color:#111827;">${repName}</td></tr>
        <tr><td style="padding:9px 14px;background:#f9fafb;border:1px solid #e5e7eb;font-weight:700;color:#6b7280;text-transform:uppercase;font-size:11px;letter-spacing:0.06em;">Date</td>
            <td style="padding:9px 14px;border:1px solid #e5e7eb;color:#111827;">${new Date().toLocaleDateString("en-US",{month:"long",day:"numeric",year:"numeric"})}</td></tr>
      </table>

      ${result === "Damage" ? `<div style="background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:14px 18px;margin-bottom:20px;">
        <div style="font-weight:700;color:#991b1b;margin-bottom:4px;">🚨 Action Required</div>
        <div style="font-size:14px;color:#dc2626;line-height:1.6;">Damage has been found. Contact the homeowner immediately to schedule PA paperwork signing.</div>
      </div>` : ""}

      ${photoSection}

      <div style="margin-top:24px;padding-top:18px;border-top:1px solid #e5e7eb;font-size:11px;color:#9ca3af;text-align:center;">
        U.S. Shingle &amp; Metal LLC · License #CCC1331960 · (727) 761-5200<br/>
        Generated automatically from JobNimbus.
      </div>
    </div>
  </div>`;
}

// ── Send email with optional PDF attachment ──────────────────────
async function sendEmail(to, subject, html, pdfBase64, pdfFilename) {
  try {
    const payload = {
      from: `U.S. Shingle & Metal <${process.env.FROM_EMAIL || "noreply@inspectionforyou.com"}>`,
      to,
      subject,
      html,
    };

    if (pdfBase64 && pdfFilename) {
      payload.attachments = [{
        filename: pdfFilename,
        content: pdfBase64,
      }];
    }

    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    const d = await res.json();
    console.log("Email result:", res.status, JSON.stringify(d).slice(0, 150));
    return res.ok;
  } catch (e) {
    console.error("sendEmail error:", e.message);
    return false;
  }
}

// ── Generate damage report PDF via PDFShift API ──────────────────
async function generateDamagePDF({ clientName, address, repName, date, photos }) {
  try {
    const PDFSHIFT_KEY = process.env.PDFSHIFT_API_KEY;
    if (!PDFSHIFT_KEY) {
      console.warn("No PDFSHIFT_API_KEY — skipping PDF generation");
      return null;
    }

    // Use thumbnails (much smaller) for PDF, limit to 6 photos
    const pdfPhotos = photos.slice(0, 6).map(p => ({
      // Use thumbnail if available, otherwise full image
      base64: p.thumbBase64 || p.base64,
      contentType: p.contentType,
    }));

    const photoRows = [];
    for (let i = 0; i < pdfPhotos.length; i += 2) {
      const left  = pdfPhotos[i];
      const right = pdfPhotos[i + 1];
      photoRows.push(`
        <tr>
          <td style="padding:4px;width:50%;">
            <img src="data:${left.contentType};base64,${left.base64}"
              style="width:100%;height:160px;object-fit:cover;border-radius:4px;" />
          </td>
          ${right ? `<td style="padding:4px;width:50%;">
            <img src="data:${right.contentType};base64,${right.base64}"
              style="width:100%;height:160px;object-fit:cover;border-radius:4px;" />
          </td>` : `<td style="width:50%;"></td>`}
        </tr>`);
    }

    const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"/>
    <style>
      * { box-sizing: border-box; }
      body { font-family: Arial, sans-serif; margin: 0; padding: 24px; color: #111; font-size: 13px; }
      .header { background: #1a2e5a; color: white; padding: 18px 22px; border-radius: 6px; margin-bottom: 18px; }
      .header h1 { margin: 0; font-size: 20px; }
      .header p { margin: 3px 0 0; font-size: 12px; opacity: 0.7; }
      .banner { background: #fef2f2; border: 2px solid #dc2626; border-radius: 6px; padding: 14px; text-align: center; margin-bottom: 18px; }
      .banner h2 { color: #dc2626; font-size: 24px; margin: 0 0 4px; }
      .banner p { color: #991b1b; font-size: 12px; margin: 0; }
      table.info { width: 100%; border-collapse: collapse; margin-bottom: 18px; }
      table.info td { padding: 7px 12px; border: 1px solid #e5e7eb; font-size: 12px; }
      table.info td:first-child { background: #f9fafb; font-weight: 700; color: #6b7280; text-transform: uppercase; font-size: 10px; letter-spacing: 0.06em; width: 28%; }
      .photos-title { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: #374151; margin-bottom: 8px; }
      table.photos { width: 100%; border-collapse: collapse; }
      .footer { margin-top: 20px; padding-top: 12px; border-top: 1px solid #e5e7eb; font-size: 10px; color: #9ca3af; text-align: center; }
    </style></head><body>
      <div class="header">
        <h1>🚨 Damage Inspection Report</h1>
        <p>U.S. Shingle &amp; Metal LLC · ${date}</p>
      </div>
      <div class="banner">
        <h2>DAMAGE FOUND</h2>
        <p>Contact homeowner immediately to schedule PA paperwork signing.</p>
      </div>
      <table class="info">
        <tr><td>Homeowner</td><td>${clientName}</td></tr>
        <tr><td>Address</td><td>${address}</td></tr>
        <tr><td>Sales Rep</td><td>${repName}</td></tr>
        <tr><td>Report Date</td><td>${date}</td></tr>
      </table>
      <div class="photos-title">📷 Inspection Photos (showing ${pdfPhotos.length} of ${photos.length})</div>
      <table class="photos">${photoRows.join("")}</table>
      <div class="footer">
        U.S. Shingle &amp; Metal LLC · License #CCC1331960 · (727) 761-5200 · Generated automatically from JobNimbus
      </div>
    </body></html>`;

    console.log("PDF HTML size (chars):", html.length);

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
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      console.warn("PDFShift failed:", res.status, err.slice(0, 200));
      return null;
    }

    const buffer = await res.arrayBuffer();
    const base64 = Buffer.from(buffer).toString("base64");
    console.log("Damage PDF generated, size:", buffer.byteLength, "bytes");
    return base64;

  } catch (e) {
    console.warn("generateDamagePDF error:", e.message);
    return null;
  }
}

// ── Build damage PDF HTML helper (reused above) ───────────────────
function buildDamagePDF() { return null; } // unused, kept for compat

// ── Update Supabase ──────────────────────────────────────────────
async function updateInspectionResult(recordId, result, notified) {
  const payload = { inspection_result: result };
  if (notified) payload.inspection_notified_at = new Date().toISOString();
  await fetch(`${SB_URL}/rest/v1/inspections?id=eq.${recordId}`, {
    method: "PATCH",
    headers: { ...sbHeaders, Prefer: "return=minimal" },
    body: JSON.stringify(payload),
  });
}