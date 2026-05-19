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
const BASE_URL    = process.env.URL || "https://free-roof-inspections.netlify.app";

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

// ── SMS Templates — loaded once per invocation, cached in-module ──
let _smsTemplatesCache = null;
async function loadSmsTemplatesServer() {
  if (_smsTemplatesCache) return _smsTemplatesCache;
  try {
    const r = await fetch(`${SB_URL}/rest/v1/sms_templates?select=key,body`, { headers: sbHeaders });
    if (!r.ok) {
      console.warn("SMS templates fetch failed:", r.status);
      _smsTemplatesCache = {};
      return _smsTemplatesCache;
    }
    const rows = await r.json();
    const map = {};
    (rows || []).forEach(row => { map[row.key] = row.body; });
    _smsTemplatesCache = map;
    console.log("SMS templates loaded:", Object.keys(map).length);
    return map;
  } catch (e) {
    console.warn("SMS templates exception:", e.message);
    _smsTemplatesCache = {};
    return _smsTemplatesCache;
  }
}
function renderTemplate(body, vars) {
  return String(body || "")
    .replace(/\{client\}/g,    vars.client    || "")
    .replace(/\{address\}/g,   vars.address   || "")
    .replace(/\{city\}/g,      vars.city      || "")
    .replace(/\{rep\}/g,       vars.rep       || "")
    .replace(/\{repPhone\}/g,  vars.repPhone  || "");
}

exports.handler = async (event) => {
  console.log("=== Inspection Checker Start ===");

  try {
    // ── 1. Fetch recently updated JN jobs (paged) ────────────────
    // 60-day lookback. We use date_updated_after on the JN list endpoint
    // to limit traffic, but if a JN result is set and then nothing else on
    // the job changes, the job's date_updated stops moving forward. A short
    // window (we used to run with 7 days) silently drops these jobs and the
    // result change never makes it into Supabase. 60 days is wide enough to
    // catch the slowest inspection-to-resolution timelines we've seen, while
    // keeping the request volume bounded.
    const since = Math.floor(Date.now() / 1000) - 60 * 24 * 60 * 60;

    // JN paginated fetch — up to 5 pages of 100 = 500 jobs max per run.
    // If you regularly exceed this volume, increase MAX_PAGES.
    const MAX_PAGES = 5;
    const allJobs = [];
    for (let page = 0; page < MAX_PAGES; page++) {
      const from = page * 100;
      const jnRes = await fetch(
        `${JN_BASE}/jobs?size=100&from=${from}&sort=-date_updated&date_updated_after=${since}`,
        { headers: jnHeaders }
      );
      if (!jnRes.ok) {
        const err = await jnRes.text();
        console.error(`JN fetch failed on page ${page}:`, jnRes.status, err);
        if (page === 0) return { statusCode: 500, body: JSON.stringify({ error: "JN fetch failed" }) };
        break; // stop paging on error, work with what we have
      }
      const jnData = await jnRes.json();
      const pageJobs = jnData.results || jnData.jobs || [];
      allJobs.push(...pageJobs);
      console.log(`JN page ${page}: ${pageJobs.length} jobs (total: ${allJobs.length})`);
      if (pageJobs.length < 100) break; // last page
    }
    console.log("JN jobs fetched:", allJobs.length);

    // Log first job to see what fields come back in the list
    if (allJobs.length > 0) {
      const sample = allJobs[0];
      console.log("Sample job keys:", Object.keys(sample).join(", "));
      console.log("Sample cf_string_34:", sample.cf_string_34, "| name:", sample.name);
    }

    // cf_string_34 may not appear in list endpoint — fetch each job individually
    // to get custom fields. Only fetch jobs that are in PA workflow (record_type 45)
    // Include all workflows that could have an inspection result:
    // 37 = PA, 45 = Lead, 36 = Retail. Previously only PA/Lead were included
    // which silently hid every Retail record from the cron.
    const paJobs = allJobs.filter(j =>
      j.record_type === 37 || j.record_type === 45 || j.record_type === 36 ||
      j.record_type_name === "PA" || j.record_type_name === "Lead" || j.record_type_name === "Retail"
    );
    console.log("PA/Lead jobs to check:", paJobs.length);

    // Fetch full details for ALL PA jobs in batches of 20 (polite on JN rate limits,
    // but dramatically faster than sequential). Previously capped at 50 — that's
    // why records past the top 50 most-recent kept getting skipped.
    const BATCH_SIZE = 20;
    const jobDetails = [];
    for (let i = 0; i < paJobs.length; i += BATCH_SIZE) {
      const batch = paJobs.slice(i, i + BATCH_SIZE);
      const batchResults = await Promise.all(
        batch.map(async (j) => {
          const jnid = j.jnid || j.id;
          try {
            const r = await fetch(`${JN_BASE}/jobs/${jnid}`, { headers: jnHeaders });
            if (!r.ok) return null;
            return await r.json();
          } catch (e) { return null; }
        })
      );
      jobDetails.push(...batchResults);
    }

    const fullJobs = jobDetails.filter(Boolean);
    console.log("Full job details fetched:", fullJobs.length);
    fullJobs.forEach(j => {
      if (j.cf_string_34) console.log("Job", j.jnid, j.name, "→ cf_string_34:", j.cf_string_34);
    });

    // ── Detect cancellations ──────────────────────────────────────
    // Any job whose status_name === "Lost" should cause us to mark the matching
    // inspection as cancelled in our DB. This runs BEFORE the result-change
    // filter because a Lost job doesn't have a cf_string_34 result — it's
    // purely status-based.
    const lostJobs = fullJobs.filter(j => {
      const status = (j.status_name || "").trim().toLowerCase();
      return status === "lost";
    });
    console.log("Lost jobs detected:", lostJobs.length);

    const cancellationResults = [];
    for (const job of lostJobs) {
      const jnJobId = job.jnid || job.id;
      // Find the inspection record linked to this job
      const sbRes = await fetch(
        `${SB_URL}/rest/v1/inspections?jn_job_id=eq.${jnJobId}&select=id,client_name,address,cancelled_at,jn_status&limit=1`,
        { headers: sbHeaders }
      );
      if (!sbRes.ok) continue;
      const rows = await sbRes.json();
      const rec = rows?.[0];
      if (!rec) continue;
      // Skip if already cancelled
      if (rec.cancelled_at) {
        console.log("Already cancelled, skipping:", rec.client_name);
        continue;
      }
      // Mark cancelled
      const updateRes = await fetch(
        `${SB_URL}/rest/v1/inspections?id=eq.${rec.id}`,
        {
          method: "PATCH",
          headers: { ...sbHeaders, Prefer: "return=minimal" },
          body: JSON.stringify({
            cancelled_at: new Date().toISOString(),
            cancel_reason: "JN status changed to Lost",
            jn_status: "Lost",
          }),
        }
      );
      if (!updateRes.ok) {
        console.warn("Failed to mark cancelled:", rec.client_name, await updateRes.text());
        continue;
      }
      console.log("Marked cancelled:", rec.client_name, "at", rec.address);
      cancellationResults.push({ client: rec.client_name, address: rec.address });

      // Email office about the cancellation
      if (process.env.OFFICE_EMAIL) {
        const html = `<div style="font-family:Arial,sans-serif;max-width:600px">
          <div style="background:#6b7280;padding:20px 28px;border-radius:10px 10px 0 0">
            <h2 style="color:#fff;margin:0;font-size:18px">❌ Job Cancelled in JobNimbus</h2>
          </div>
          <div style="background:#f9fafb;padding:20px 28px;border-radius:0 0 10px 10px;border:1px solid #e5e7eb;border-top:none">
            <p>A JobNimbus job was marked <strong>Lost</strong> and has been auto-cancelled in the app.</p>
            <p><strong>Homeowner:</strong> ${rec.client_name}<br>
            <strong>Property:</strong> ${rec.address}<br>
            <strong>JN Job ID:</strong> ${jnJobId}</p>
            <p style="color:#6b7280;font-size:12px">This record has been removed from pending lists and reports, but is still visible in Record Lookup with a cancelled status.</p>
          </div>
        </div>`;
        await sendEmail(process.env.OFFICE_EMAIL, `❌ Job Cancelled: ${rec.client_name}`, html);
      }
    }

    const triggeredJobs = fullJobs.filter(j => TRIGGER_RESULTS.includes(j.cf_string_34));
    console.log("Triggered jobs:", triggeredJobs.length);

    if (triggeredJobs.length === 0 && cancellationResults.length === 0) {
      return {
        statusCode: 200,
        body: JSON.stringify({ message: "No changed inspections or cancellations found", checked: allJobs.length, pa_jobs: paJobs.length, full_details: fullJobs.length }),
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
        `${SB_URL}/rest/v1/inspections?jn_job_id=eq.${jnJobId}&select=id,client_name,address,city,state,zip,mobile,email,sales_rep_id,sales_rep_email,inspection_result,docs_signed&limit=1`,
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
            `${SB_URL}/rest/v1/inspections?client_name=ilike.*${encodeURIComponent(nameFromJob)}*&select=id,client_name,address,city,state,zip,mobile,email,sales_rep_id,sales_rep_email,inspection_result,docs_signed&limit=1`,
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

      // ── 4. SMS — AUTO-NOTIFICATIONS DISABLED ──────────────────
      // Manager sends rep + homeowner SMS manually from the Pending list.
      // Set AUTO_NOTIFY to true to restore automatic sending.
      const AUTO_NOTIFY = false;
      let smsSent = false;
      if (AUTO_NOTIFY) {
        const docsSigned = record.docs_signed || "";
        const paIsSigned = docsSigned.includes("lor") || docsSigned.includes("pac");
        const variant = paIsSigned ? "all" : "insp";

        // Map JN result string → template key prefix
        const resultKey = newResult === "Damage" ? "damage"
                        : newResult === "No Damage" ? "nodamage"
                        : newResult === "Retail" ? "retail"
                        : null;

        console.log("SMS check — result:", newResult, "| resultKey:", resultKey, "| variant:", variant, "| repPhone:", repPhone || "none", "| docs_signed:", docsSigned);

        if (resultKey) {
          const templates = await loadSmsTemplatesServer();
          const vars = {
            client:   record.client_name || "Homeowner",
            address:  record.address || "",
            city:     record.city || "",
            rep:      repName || "your rep",
            repPhone: repPhone || "",
          };

          // Send to rep
          const repTemplate = templates[`${resultKey}_${variant}_rep`];
          if (repPhone && repTemplate) {
            const msg = renderTemplate(repTemplate, vars);
            console.log("Sending rep SMS to:", repPhone, "| template:", `${resultKey}_${variant}_rep`);
            try {
              const r = await fetch(`${BASE_URL}/.netlify/functions/ghl-sms`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ to: repPhone, message: msg, name: repName || "Sales Rep" }),
              });
              const t = await r.text();
              smsSent = r.ok;
              console.log("Rep SMS result:", r.status, t.slice(0, 200));
            } catch (e) { console.warn("Rep SMS error:", e.message); }
          } else if (!repPhone) {
            console.warn("No rep phone — rep SMS skipped");
          } else {
            console.warn(`No template body for ${resultKey}_${variant}_rep — rep SMS skipped`);
          }

          // Send to homeowner
          const homeownerPhone = record.mobile || "";
          const homeownerTemplate = templates[`${resultKey}_${variant}_homeowner`];
          if (homeownerPhone && homeownerTemplate) {
            const msg = renderTemplate(homeownerTemplate, vars);
            console.log("Sending homeowner SMS to:", homeownerPhone, "| template:", `${resultKey}_${variant}_homeowner`);
            try {
              const r = await fetch(`${BASE_URL}/.netlify/functions/ghl-sms`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ to: homeownerPhone, message: msg, name: record.client_name || "Homeowner" }),
              });
              const t = await r.text();
              console.log("Homeowner SMS result:", r.status, t.slice(0, 200));
            } catch (e) { console.warn("Homeowner SMS error:", e.message); }
          } else if (!homeownerPhone) {
            console.warn("No homeowner phone — homeowner SMS skipped");
          } else {
            console.warn(`No template body for ${resultKey}_${variant}_homeowner — homeowner SMS skipped`);
          }
        } else {
          console.warn("Unknown result, no SMS sent:", newResult);
        }
      } else {
        console.log("AUTO_NOTIFY disabled — skipping SMS. Manager sends manually from Pending list.");
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
          record,
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

      // AUTO_NOTIFY disabled — skip internal report email too.
      // Manager sends notifications manually from the Pending list.
      let emailSent = false;
      if (AUTO_NOTIFY) {
        emailSent = await sendEmail(emailTo, subject, reportHtml, pdfBase64, pdfFilename);
        console.log("Report email sent:", emailSent, "to:", emailTo, "| PDF attached:", !!pdfBase64);
      } else {
        console.log("AUTO_NOTIFY disabled — skipping report email.");
      }

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

    console.log("=== Inspection Checker Complete ===", JSON.stringify(results), "cancellations:", cancellationResults.length);
    return {
      statusCode: 200,
      body: JSON.stringify({ message: "Check complete", checked: allJobs.length, processed: results.length, results, cancellations: cancellationResults }),
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

        return { base64, contentType, thumbBase64, thumbnailUrl: file.thumbnail_url || null, presignedUrl: url };
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

// ── Inspection findings rows (mirrors App.jsx INSP_ROWS_DAMAGE) ───
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

// ── Date helpers (mirror App.jsx) ─────────────────────────────────
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

// ── Build the certificate HTML (page 1) — mirrors InspectionCertificatePDF in App.jsx
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

      <!-- Header -->
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

      <!-- Contact bar -->
      <div style="background:#1a2e5a;color:#fff;text-align:center;padding:5px 14px;font-size:10.5px;border-bottom:3px solid #c8392b;">
        Phone: 727-761-5200 &nbsp;|&nbsp; Email: inspection@shingleusa.com &nbsp;|&nbsp; www.shingleusa.com &nbsp;|&nbsp; License #: CCC1331960
      </div>

      <!-- Cert # / date -->
      <div style="display:flex;justify-content:space-between;padding:6px 14px;font-size:10.5px;border-bottom:1px solid #c8d4e8;background:#f8fafc;">
        <div><strong>Certificate No:</strong> ${certNo}</div>
        <div><strong>Issue Date:</strong> ${fmtDateLong(today)}</div>
      </div>

      <!-- Property info -->
      <div style="padding:10px 14px 6px;border-bottom:2px solid #1a2e5a;">
        <div style="font-size:11px;font-weight:700;color:#1a2e5a;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:7px;">PROPERTY INFORMATION</div>
        <table style="width:100%;border-collapse:collapse;margin-bottom:4px;"><tbody>
          <tr><td ${tdL}>Property Address:</td><td ${tdV}>${addr}</td><td ${tdL}>Inspection Date:</td><td ${tdV}>${fmtDateLong(today)}</td></tr>
          <tr><td ${tdL}>City, State, ZIP:</td><td ${tdV}>${cityLine}</td><td ${tdL}>Inspector Name:</td><td ${tdV}>${escapeHtml(inspector)}</td></tr>
          <tr><td ${tdL}>Property Owner:</td><td ${tdV}>${owner}</td><td ${tdL}>License No.:</td><td ${tdV}>CCC1331960</td></tr>
        </tbody></table>
      </div>

      <!-- Certification statement -->
      <div style="margin:8px 14px;border:2px solid #1a2e5a;border-radius:4px;padding:9px 13px;background:#fff5f5;">
        <div style="font-size:12px;font-weight:700;color:#1a2e5a;text-align:center;margin-bottom:5px;text-transform:uppercase;">OFFICIAL CERTIFICATION STATEMENT</div>
        <div style="font-size:10.5px;line-height:1.65;color:#111827;text-align:center;">
          This is to certify that a thorough roofing inspection was conducted by U.S. Shingle and Metal LLC on the above-referenced property. Based on the findings, the roof system has been evaluated and <strong>STORM DAMAGE HAS BEEN IDENTIFIED</strong>. The roof system requires immediate attention. A licensed Public Adjuster has been notified to assist with the insurance claims process.
        </div>
      </div>

      <!-- Findings table -->
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

      <!-- Status boxes -->
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

      <!-- Signature -->
      <div style="padding:7px 14px 9px;">
        <div style="border-top:1px solid #c8d4e8;padding-top:7px;">
          <div style="width:2.5in;height:40px;border-bottom:1px solid #111827;margin-bottom:3px;position:relative;">
            <img src="${signatureUrl}" alt="Inspector Signature" style="height:40px;max-width:2.5in;object-fit:contain;display:block;" />
          </div>
          <div style="font-size:9.5px;font-weight:700;color:#374151;">Inspector Signature</div>
          <div style="font-size:9.5px;color:#374151;margin-top:1px;">Name: ${escapeHtml(inspector)} &nbsp;&nbsp;&nbsp; License #: CCC1331960</div>
        </div>
      </div>

      <!-- Footer -->
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

// ── Generate damage report PDF via PDFShift API ──────────────────
async function generateDamagePDF({ clientName, address, repName, date, photos, record }) {
  try {
    const PDFSHIFT_KEY = process.env.PDFSHIFT_API_KEY;
    if (!PDFSHIFT_KEY) {
      console.warn("No PDFSHIFT_API_KEY — skipping PDF generation");
      return null;
    }

    // Use all photos (up to 10) with direct URLs
    const pdfPhotoUrls = photos.slice(0, 10)
      .map(p => p.thumbnailUrl || p.presignedUrl)
      .filter(Boolean);
    console.log("PDF photo URLs for PDF:", pdfPhotoUrls.length);

    const photoRows = [];
    for (let i = 0; i < pdfPhotoUrls.length; i += 2) {
      const left  = pdfPhotoUrls[i];
      const right = pdfPhotoUrls[i + 1];
      photoRows.push(`
        <tr>
          <td style="padding:4px;width:50%;">
            <img src="${left}" style="width:100%;height:160px;object-fit:cover;border-radius:4px;" />
          </td>
          ${right ? `<td style="padding:4px;width:50%;">
            <img src="${right}" style="width:100%;height:160px;object-fit:cover;border-radius:4px;" />
          </td>` : `<td style="width:50%;"></td>`}
        </tr>`);
    }

    // Build the certificate page using the shared helper
    // Inspector is always Hank Smith for damage certs; signature lives in public/
    const logoUrl = `${BASE_URL}/uss-header.png`;
    const signatureUrl = `${BASE_URL}/rep-signature.png`;
    const inspectionDateISO = new Date().toISOString().split("T")[0];
    const certRecord = record || {
      address: (address || "").split(",")[0] || "",
      city: "", state: "", zip: "",
      client_name: clientName,
    };
    const certPageHtml = buildCertificateHTML({
      record: certRecord,
      inspectorName: "Hank Smith",
      inspectionDateISO,
      logoUrl,
      signatureUrl,
    });

    const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"/>
    <style>
      @page { size: Letter; margin: 0; }
      * { box-sizing: border-box; margin: 0; padding: 0; }
      body { font-family: Arial, Helvetica, sans-serif; color: #111; font-size: 13px; }

      /* ── PAGE 1: CERTIFICATE ── */
      .cert-page {
        width: 8.5in;
        background: #fff;
        box-sizing: border-box;
      }

      /* ── PAGE 2: PHOTOS ── */
      .photos-page {
        width: 100%;
        padding: 32px 24px;
        background: #fff;
        page-break-before: always;
      }
      .photos-header {
        background: #1a2e5a;
        color: #fff;
        padding: 14px 20px;
        border-radius: 6px;
        margin-bottom: 20px;
        display: flex;
        justify-content: space-between;
        align-items: center;
      }
      .photos-header h2 { font-size: 16px; margin: 0; }
      .photos-header span { font-size: 12px; opacity: 0.7; }
      .photos-subheader {
        font-size: 12px;
        color: #6b7280;
        margin-bottom: 14px;
      }
      table.photo-grid { width: 100%; border-collapse: collapse; }
      table.photo-grid td { padding: 4px; width: 50%; }
      table.photo-grid img {
        width: 100%;
        height: 155px;
        object-fit: cover;
        border-radius: 4px;
        display: block;
        border: 1px solid #e5e7eb;
      }
      .photos-footer {
        margin-top: 20px;
        padding-top: 12px;
        border-top: 1px solid #e5e7eb;
        font-size: 10px;
        color: #9ca3af;
        text-align: center;
      }
    </style></head><body>

      <!-- PAGE 1: CERTIFICATE -->
      ${certPageHtml}

      <!-- PAGE 2: PHOTOS -->
      <div class="photos-page">
        <div class="photos-header">
          <h2>📷 Inspection Photos</h2>
          <span>${escapeHtml(clientName)} · ${date}</span>
        </div>
        <div class="photos-subheader">${escapeHtml(address)} · ${pdfPhotoUrls.length} photos shown</div>
        <table class="photo-grid">
          ${photoRows.join("")}
        </table>
        <div class="photos-footer">
          U.S. Shingle &amp; Metal LLC · License #CCC1331960 · Photos taken during roof inspection · ${date}
        </div>
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
        format: "Letter",
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
  // Normalize JN result ("Damage" / "No Damage" / "Retail") to the lowercase
  // snake_case format the app UI expects in `result` column.
  const resultMap = {
    "Damage": "damage",
    "No Damage": "no_damage",
    "Retail": "retail",
  };
  const uiResult = resultMap[result] || null;

  const payload = {
    inspection_result: result,           // raw JN value (legacy)
    result: uiResult,                    // UI-facing normalized value
    result_at: new Date().toISOString(), // so it shows as non-pending in the UI
  };
  if (notified) payload.inspection_notified_at = new Date().toISOString();
  await fetch(`${SB_URL}/rest/v1/inspections?id=eq.${recordId}`, {
    method: "PATCH",
    headers: { ...sbHeaders, Prefer: "return=minimal" },
    body: JSON.stringify(payload),
  });
}