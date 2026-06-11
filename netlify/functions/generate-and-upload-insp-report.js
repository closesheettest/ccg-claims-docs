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

const sharp = require("sharp");

const JN_BASE = "https://app.jobnimbus.com/api1";
const JN_FILES_BASE = "https://api.jobnimbus.com";
const JN_KEY = process.env.JOBNIMBUS_API_KEY;
const PDFSHIFT_KEY = process.env.PDFSHIFT_API_KEY;
const BASE_URL = process.env.URL || process.env.DEPLOY_PRIME_URL || "https://free-roof-inspections.netlify.app";
const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const SIGNED_BUCKET = "signed-documents";

const jnHeaders = {
  Authorization: `bearer ${JN_KEY}`,
  "Content-Type": "application/json",
};
const sbHeaders = {
  apikey: SB_KEY,
  Authorization: `Bearer ${SB_KEY}`,
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

  let jnid, skipJnUpload, force;
  try {
    const body = JSON.parse(event.body || "{}");
    jnid = (body.jnid || "").trim();
    // When set, skip the JN upload step and return PDF base64 in
    // the response so the client can fire upload-pdf-to-jn as a
    // separate Lambda call. This splits the work across two 10s
    // budgets so neither side times out.
    skipJnUpload = !!body.skip_jn_upload;
    // force=true re-renders even if the cert is already stamped in
    // Supabase. Used for genuine re-issues (e.g. a manager corrected
    // the result and needs a fresh cert). Default false so the
    // already-certified guard below protects PDFShift credits.
    force = !!body.force;
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

  // ── 2b. Already-certified guard (PDFShift credit saver) ──────────
  // PDFShift bills by output size (1 credit / 5MB), charged on the
  // RENDER call — before we ever upload to JN. So any path that
  // re-runs this function for a job whose cert is already on file
  // pays a fresh credit for an identical PDF. Historically that was
  // most of the bill: bulk back-fills re-rendering finished jobs and
  // the hourly retry cron re-rendering anything not yet stamped.
  //
  // If a non-cancelled inspections row already has jn_cert_uploaded_at
  // set, the cert is in JN — skip the render and return ok. `force:true`
  // (manager re-issue, e.g. a corrected result) bypasses this. We only
  // skip when skipJnUpload is false, since the split-upload caller
  // hasn't necessarily stamped yet for THIS render.
  if (!force && !skipJnUpload && SB_URL && SB_KEY) {
    try {
      const certRes = await fetch(
        `${SB_URL}/rest/v1/inspections?jn_job_id=eq.${encodeURIComponent(jnid)}&cancelled_at=is.null&jn_cert_uploaded_at=not.is.null&select=id&limit=1`,
        { headers: sbHeaders },
      );
      if (certRes.ok) {
        const certRows = await certRes.json().catch(() => []);
        if (Array.isArray(certRows) && certRows.length > 0) {
          console.log("Cert already stamped for", jnid, "— skipping render (pass force:true to re-issue)");
          return {
            statusCode: 200,
            body: JSON.stringify({
              ok: true,
              skipped: true,
              already_certified: true,
              detail: "Cert already on file (jn_cert_uploaded_at set). No PDFShift credit spent. Pass force:true to re-render.",
            }),
          };
        }
      }
    } catch (e) {
      // Non-fatal — if the guard lookup fails, fall through and render
      // as before rather than blocking a legitimate cert.
      console.warn("Already-certified guard lookup failed (rendering anyway):", e.message);
    }
  }

  // ── 2c. JN-truth idempotency guard ───────────────────────────────
  // The Supabase stamp (2b) is skipped on the split-upload path and can
  // race (it's written client-side AFTER the upload finishes), so it
  // missed dupes: same-minute double-fires and the overnight retry cron
  // both re-uploaded because the stamp hadn't landed yet. This guard
  // asks JN itself — if an "Inspection-Report-" document is already on
  // the job, the cert exists, full stop. Runs on EVERY path (including
  // skipJnUpload) so it also saves a PDFShift render. `force:true`
  // bypasses it for genuine re-issues. Fail-open on lookup error so a
  // transient JN hiccup never blocks a legitimate first cert.
  if (!force) {
    const exists = await jobAlreadyHasReport(jnid);
    if (exists) {
      console.log("JN already has an Inspection Report for", jnid, "— skipping (pass force:true to re-issue)");
      return {
        statusCode: 200,
        body: JSON.stringify({
          ok: true,
          skipped: true,
          already_in_jn: true,
          detail: "An Inspection Report document already exists on this JN job. No PDFShift credit spent, no duplicate uploaded. Pass force:true to re-render.",
        }),
      };
    }
  }

  // ── 3. Pull homeowner / address fields ───────────────────────────
  const clientName = job.display_name || (job.name || "").split(" - ")[0] || "Homeowner";
  const address = [job.address_line1, job.city, job.state_text, job.zip].filter(Boolean).join(", ");
  const repName = job.sales_rep_name || "—";
  if (!job.address_line1) {
    console.warn("Job has no address_line1 — PDF will show partial address");
  }

  // ── 4. Fetch photos. Supabase signed URLs first (fast — no download,
  //       PDFShift fetches the photos in parallel itself); fall back to
  //       JN attachments only when Supabase has no record (very old
  //       inspections that pre-date wizard storage).
  //
  //       Why signed URLs and not inline base64: embedding 10 photos as
  //       base64 produced ~10MB HTML bodies. PDFShift took 5-8s parsing
  //       that, putting total Lambda time over Netlify's 10s budget and
  //       returning HTTP 504. Signed URLs keep the HTML tiny and let
  //       PDFShift parallelize image downloads, cutting render time to
  //       ~3s.
  let photos = await fetchSupabasePhotosByJnId(jnid, { resultLabel });
  console.log("Supabase signed-URL photos fetched:", photos.length);
  let photoSource = "supabase";
  if (photos.length === 0) {
    const jnPhotos = await fetchJobPhotos(jnid);
    if (jnPhotos.length > 0) {
      photos = jnPhotos;
      photoSource = "jn";
      console.log("JN fallback found photos:", photos.length);
    }
  }
  // No Damage certs are a 1-page summary letter that doesn't embed photos,
  // so they render fine with none. Only Damage / Retail reports (which show
  // the roof photos) require at least one.
  if (photos.length === 0 && resultLabel !== "No Damage") {
    return {
      statusCode: 400,
      body: JSON.stringify({
        ok: false,
        error: "No photos found",
        detail: "Checked JN attachments and Supabase Storage — neither has photos for this job. Have the inspector add at least one photo before generating the report.",
      }),
    };
  }
  console.log("Photo source:", photoSource);

  // ── 5. Build the PDF ─────────────────────────────────────────────
  // Damage and Retail both get the full 2-page certificate (page 1 cert
  // with findings table, page 2 photo grid) — they just use different
  // findings rows and damage-status copy. No Damage falls back to the
  // simpler 1-page photo report since there's nothing to certify.
  const reportDate = new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });

  // Roof type (Shingle | Tile) captured at intake — drives the cert's
  // material + condition findings. Read from the inspections row; default
  // Shingle if unset/unavailable.
  let roofType = "Shingle";
  if (SB_URL && SB_KEY) {
    try {
      const rt = await fetch(
        `${SB_URL}/rest/v1/inspections?jn_job_id=eq.${encodeURIComponent(jnid)}&cancelled_at=is.null&roof_type=not.is.null&select=roof_type&limit=1`,
        { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` } },
      );
      if (rt.ok) { const rows = await rt.json().catch(() => []); if (rows[0]?.roof_type) roofType = rows[0].roof_type; }
    } catch (e) { console.warn("roof_type lookup failed (defaulting Shingle):", e.message); }
  }

  const record = {
    address: job.address_line1 || "",
    city: job.city || "",
    state: job.state_text || "",
    zip: job.zip || "",
    client_name: clientName,
    roof_type: roofType,
  };

  let pdfBase64;
  try {
    if (resultLabel === "Damage") {
      pdfBase64 = await generateDamagePDF({ clientName, address, repName, date: reportDate, photos, record });
    } else if (resultLabel === "Retail") {
      pdfBase64 = await generateRetailPDF({ clientName, address, repName, date: reportDate, photos, record });
    } else {
      pdfBase64 = await generateNoDamagePDF({ clientName, address, repName, date: reportDate, photos, record });
    }
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: "PDF generation failed", detail: e.message }) };
  }
  if (!pdfBase64) {
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: "PDF generation returned empty" }) };
  }

  // ── 6. Upload PDF to JN's documents tab — OR — return base64 ─────
  const safeName = clientName.replace(/[^a-zA-Z0-9]/g, "-");
  const filename = `Inspection-Report-${safeName}-${new Date().toISOString().slice(0, 10)}.pdf`;

  if (skipJnUpload) {
    // Caller will fire upload-pdf-to-jn separately. Returning the PDF
    // base64 in the JSON response was OOMing the Lambda (multi-MB
    // string + JSON.stringify copy + response encoding). Instead we
    // stash the PDF in Supabase Storage and return only a small
    // signed URL — Lambda B fetches the PDF from the URL.
    const tmpPath = `cert-temp/${jnid}-${Date.now()}.pdf`;
    const stash = await stashPdfInSupabase(tmpPath, pdfBase64);
    if (!stash.ok) {
      return {
        statusCode: 500,
        body: JSON.stringify({ ok: false, error: "Could not stash PDF in Supabase", detail: stash.error }),
      };
    }
    return {
      statusCode: 200,
      body: JSON.stringify({
        ok: true,
        pdf_signed_url: stash.signedUrl,
        pdf_storage_path: tmpPath,
        filename,
        photoCount: photos.length,
        result: resultLabel,
        jobName: job.name,
        clientName,
        skipped_jn_upload: true,
      }),
    };
  }

  const uploadResult = await uploadFileToJob(jnid, filename, pdfBase64);
  if (!uploadResult.success) {
    return {
      statusCode: 500,
      body: JSON.stringify({ ok: false, error: "Could not upload PDF to JN", detail: uploadResult.error }),
    };
  }

  console.log("=== Report uploaded:", filename, "to job:", jnid);

  // Stamp jn_cert_uploaded_at on the happy path. Historically ONLY the
  // hourly retry cron set this, so a normally-certified job stayed
  // jn_cert_uploaded_at=NULL forever — which made the retry cron treat
  // it as "missing" and re-render + re-upload it (a wasted PDFShift
  // credit AND a duplicate cert in JN's Documents tab). Stamping here
  // closes that loop: the retry cron and the already-certified guard
  // both key off this column. Non-fatal — if the write fails the cert
  // is still in JN and the retry cron remains the backstop.
  if (SB_URL && SB_KEY) {
    try {
      const nowIso = new Date().toISOString();
      await fetch(
        `${SB_URL}/rest/v1/inspections?jn_job_id=eq.${encodeURIComponent(jnid)}&cancelled_at=is.null&jn_cert_uploaded_at=is.null`,
        {
          method: "PATCH",
          headers: { ...sbHeaders, Prefer: "return=minimal" },
          body: JSON.stringify({ jn_cert_uploaded_at: nowIso }),
        },
      );
    } catch (e) {
      console.warn("jn_cert_uploaded_at stamp failed (non-fatal):", e.message);
    }
  }

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

// ── Stash a generated PDF in Supabase Storage and return a signed URL ──
// Used by the split cert flow. Lambda A renders + stashes; Lambda B
// downloads from the URL + uploads to JN. This keeps each Lambda well
// under Netlify's 10s budget and prevents OOM on the JSON response
// (returning multi-MB base64 in a JSON body was eating V8 heap).
async function stashPdfInSupabase(path, pdfBase64) {
  if (!SB_URL || !SB_KEY) {
    return { ok: false, error: "Supabase env not configured" };
  }
  try {
    const bytes = Buffer.from(pdfBase64, "base64");
    const putRes = await fetch(`${SB_URL}/storage/v1/object/${SIGNED_BUCKET}/${path}`, {
      method: "POST",
      headers: {
        apikey: SB_KEY,
        Authorization: `Bearer ${SB_KEY}`,
        "Content-Type": "application/pdf",
        // Allow overwrite so re-clicks don't 409.
        "x-upsert": "true",
      },
      body: bytes,
    });
    if (!putRes.ok) {
      const txt = await putRes.text();
      return { ok: false, error: `SB upload ${putRes.status}: ${txt.slice(0, 200)}` };
    }
    // Now create a signed URL Lambda B can fetch.
    const signRes = await fetch(
      `${SB_URL}/storage/v1/object/sign/${SIGNED_BUCKET}/${path}`,
      {
        method: "POST",
        headers: sbHeaders,
        body: JSON.stringify({ expiresIn: 600 }),
      },
    );
    if (!signRes.ok) {
      const txt = await signRes.text();
      return { ok: false, error: `SB sign ${signRes.status}: ${txt.slice(0, 200)}` };
    }
    const signData = await signRes.json().catch(() => ({}));
    const rel = signData.signedURL || signData.signedUrl;
    if (!rel) return { ok: false, error: "SB sign returned no URL" };
    const signedUrl = rel.startsWith("http") ? rel : `${SB_URL}/storage/v1${rel}`;
    return { ok: true, signedUrl };
  } catch (e) {
    return { ok: false, error: e.message || "stash failed" };
  }
}

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
// Primary photo source: look up the inspection by jn_job_id, download
// each photo from Supabase Storage, RESIZE via sharp to 800px wide /
// quality 70, and return as inline base64 data URIs.
//
// Why we resize in-Lambda instead of trusting Supabase image transforms:
// on user's project, transforms aren't honored — the signed URL serves
// the original-size photo regardless of the `transform` param. So 10
// photos × 400KB → ~5MB embedded in HTML → 15MB PDF → Lambda OOM.
//
// With sharp resize to 800px/q70, each photo becomes ~50-80KB. PDF is
// ~1MB, memory stays comfortably under Lambda limits.
async function fetchSupabasePhotosByJnId(jnJobId, { resultLabel } = {}) {
  if (!SB_URL || !SB_KEY) {
    console.warn("Supabase env not configured — skipped");
    return [];
  }
  try {
    // A single JN job can have more than one inspections row (the
    // double-submit dupe pattern — e.g. Rainer jakob 2026-06-03: one
    // real row with 42 photos + one empty phantom row, 0 photos). A
    // bare limit=1 with no ordering returned the phantom and the cert
    // 400'd with "No photos found". Pull all non-cancelled rows and
    // pick the one that actually has photos.
    const lookupRes = await fetch(
      `${SB_URL}/rest/v1/inspections?jn_job_id=eq.${encodeURIComponent(jnJobId)}&cancelled_at=is.null&select=inspection_photos`,
      { headers: sbHeaders },
    );
    if (!lookupRes.ok) {
      console.warn("Supabase inspection lookup failed:", lookupRes.status);
      return [];
    }
    const rows = await lookupRes.json().catch(() => []);
    const photoCounts = (Array.isArray(rows) ? rows : []).map((r) =>
      Array.isArray(r.inspection_photos) ? r.inspection_photos : [],
    );
    const raw = photoCounts.sort((a, b) => b.length - a.length)[0] || [];
    if (!Array.isArray(raw) || raw.length === 0) return [];

    // For Retail inspections the inspector is prompted to walk the
    // whole roof and take 10 worst-condition close-ups (category
    // "retail_worst"). Those are the photos the cert should show —
    // they justify the retail recommendation. For Damage/No-Damage
    // we fall back to the most-recent 10 photos of any kind.
    let candidates;
    if (resultLabel === "Retail") {
      const worst = raw.filter((p) => p.category === "retail_worst");
      candidates = worst.length > 0 ? worst : raw;
      console.log(`Retail cert: using ${candidates.length} retail_worst photos (fell back to all=${worst.length === 0})`);
    } else {
      candidates = raw;
    }

    // Sort by captured_at desc so the PDF gets the most recent shots
    // first (matches the JN-attachment sort).
    const sorted = [...candidates].sort((a, b) =>
      new Date(b.captured_at || 0) - new Date(a.captured_at || 0),
    );
    // Limit to 10 — same as the JN path. Cert template has 10 slots.
    const results = await Promise.all(sorted.slice(0, 10).map(async (p) => {
      if (!p.path) return null;
      try {
        const bucket = p.bucket || SIGNED_BUCKET;
        const dlRes = await fetch(
          `${SB_URL}/storage/v1/object/${bucket}/${p.path}`,
          { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` } },
        );
        if (!dlRes.ok) {
          console.warn("SB download failed for", p.path, ":", dlRes.status);
          return null;
        }
        const inputBytes = Buffer.from(await dlRes.arrayBuffer());
        if (!inputBytes.length) return null;
        // Resize: 800px max width, JPEG quality 70. EXIF rotation is
        // applied automatically by sharp() when input has orientation
        // metadata — important for portrait phone photos.
        const resized = await sharp(inputBytes)
          .rotate()
          .resize({ width: 800, withoutEnlargement: true })
          .jpeg({ quality: 70, mozjpeg: true })
          .toBuffer();
        const base64 = resized.toString("base64");
        return { dataUri: `data:image/jpeg;base64,${base64}` };
      } catch (e) {
        console.warn("SB photo resize error for", p.path, ":", e.message);
        return null;
      }
    }));
    return results.filter(Boolean);
  } catch (e) {
    console.warn("fetchSupabasePhotosByJnId error:", e.message);
    return [];
  }
}

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

    // Sort newest-first so the LAST 10 uploaded photos (the actual inspection
    // photos) win out over older photos like lead-source pictures. JN file
    // objects expose `date_created` as a Unix timestamp; fall back to other
    // common date fields, and to original list order if no dates are present.
    const ts = (f) => Number(f.date_created || f.date_uploaded || f.date_added || 0);
    const sorted = [...imageFiles].sort((a, b) => ts(b) - ts(a));

    // Limit to 10 photos — the certificate template's photo grid is
    // designed for 10 max. More than that won't fit on one page anyway.
    //
    // Resize via sharp to 800px / quality 70 — same as the Supabase
    // path. Without this, embedding 10 originals as inline base64
    // produced ~15MB PDFs and OOM'd the Lambda.
    const downloads = sorted.slice(0, 10).map(async (file) => {
      const fileJnid = file.jnid || file.id;
      if (!fileJnid) return null;
      try {
        const dlRes = await fetch(`${JN_BASE}/files/${fileJnid}`, { headers: jnHeaders });
        if (!dlRes.ok) {
          console.warn("Photo download failed for", fileJnid, ":", dlRes.status);
          return null;
        }
        const inputBytes = Buffer.from(await dlRes.arrayBuffer());
        if (!inputBytes.length) return null;
        const resized = await sharp(inputBytes)
          .rotate()
          .resize({ width: 800, withoutEnlargement: true })
          .jpeg({ quality: 70, mozjpeg: true })
          .toBuffer();
        const base64 = resized.toString("base64");
        return { dataUri: `data:image/jpeg;base64,${base64}` };
      } catch (e) {
        console.warn("Photo download/resize error for", fileJnid, ":", e.message);
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

// Retail variant — roof needs replacement but no storm damage was found,
// so the homeowner is a retail (non-insurance) sale. Findings call out
// age/wear-driven failures rather than storm damage.
const INSP_ROWS_RETAIL = [
  { category: "Roofing Material Type",       finding: "Asphalt Shingle",                                                  result: "N/A"  },
  { category: "Shingle Condition",            finding: "Significant granular loss, degraded elasticity, seal failures.",   result: "FAIL" },
  { category: "Metal Panel Condition",        finding: "N/A",                                                              result: "N/A"  },
  { category: "Flashing & Sealants",          finding: "Thermal cycling fatigue",                                          result: "FAIL" },
  { category: "Gutters & Downspouts",         finding: "N/A",                                                              result: "N/A"  },
  { category: "Ridge & Hip Caps",             finding: "Significant granular loss, degraded elasticity, seal failures.",   result: "FAIL" },
  { category: "Roof Deck (Visible)",          finding: "Unknown",                                                          result: "N/A"  },
  { category: "Ventilation",                  finding: "N/A",                                                              result: "N/A"  },
  { category: "Water Intrusion / Leaks",      finding: "Not assessed at enrollment.",                                      result: "N/A"  },
  { category: "Overall Structural Integrity", finding: "Moderately poor to poor",                                          result: "FAIL" },
];

// No-Damage variant — the roof was inspected and NO storm damage was
// found, so every category passes. This is the homeowner's "evidence the
// roof was professionally inspected and found in good condition" cert.
const INSP_ROWS_NO_DAMAGE = [
  { category: "Roofing Material Type",       finding: "Asphalt Shingle & Metal Roofing System",     result: "N/A"  },
  { category: "Shingle Condition",            finding: "No storm damage observed — sound condition", result: "PASS" },
  { category: "Metal Panel Condition",        finding: "No damage observed",                         result: "PASS" },
  { category: "Flashing & Sealants",          finding: "Intact and sealed",                          result: "PASS" },
  { category: "Gutters & Downspouts",         finding: "No damage observed",                         result: "PASS" },
  { category: "Ridge & Hip Caps",             finding: "Sound condition",                            result: "PASS" },
  { category: "Roof Deck (Visible)",          finding: "No deformation observed",                    result: "PASS" },
  { category: "Ventilation",                  finding: "Adequate",                                   result: "PASS" },
  { category: "Water Intrusion / Leaks",      finding: "No active leaks or intrusion observed",      result: "PASS" },
  { category: "Overall Structural Integrity", finding: "Roof system in serviceable condition",       result: "PASS" },
];

// ── TILE-roof variants ──────────────────────────────────────────────
// Used when the intake recorded a tile roof. Same structure as the
// shingle/metal rows above, but the material + condition rows speak to
// tile (we only sign up shingle or tile — no metal).
const INSP_ROWS_DAMAGE_TILE = [
  { category: "Roofing Material Type",       finding: "Tile Roofing System",                              result: "N/A"  },
  { category: "Tile Condition",               finding: "Storm damage observed — cracked & displaced tiles", result: "FAIL" },
  { category: "Metal Panel Condition",        finding: "N/A",                                              result: "N/A"  },
  { category: "Flashing & Sealants",          finding: "N/A",                                              result: "N/A"  },
  { category: "Gutters & Downspouts",         finding: "N/A",                                              result: "N/A"  },
  { category: "Ridge & Hip Caps",             finding: "N/A",                                              result: "N/A"  },
  { category: "Roof Deck (Visible)",          finding: "N/A",                                              result: "N/A"  },
  { category: "Ventilation",                  finding: "N/A",                                              result: "N/A"  },
  { category: "Water Intrusion / Leaks",      finding: "N/A",                                              result: "N/A"  },
  { category: "Overall Structural Integrity", finding: "Structural damage confirmed — replacement required", result: "FAIL" },
];
const INSP_ROWS_RETAIL_TILE = [
  { category: "Roofing Material Type",       finding: "Tile Roofing System",                              result: "N/A"  },
  { category: "Tile Condition",               finding: "Significant tiles loose, tiles cracked, and very porous", result: "FAIL" },
  { category: "Metal Panel Condition",        finding: "N/A",                                              result: "N/A"  },
  { category: "Flashing & Sealants",          finding: "Thermal cycling fatigue",                          result: "FAIL" },
  { category: "Gutters & Downspouts",         finding: "N/A",                                              result: "N/A"  },
  { category: "Ridge & Hip Caps",             finding: "Cracked & loose ridge tiles",                      result: "FAIL" },
  { category: "Roof Deck (Visible)",          finding: "Unknown",                                          result: "N/A"  },
  { category: "Ventilation",                  finding: "N/A",                                              result: "N/A"  },
  { category: "Water Intrusion / Leaks",      finding: "Not assessed at enrollment.",                      result: "N/A"  },
  { category: "Overall Structural Integrity", finding: "Moderately poor to poor",                          result: "FAIL" },
];
const INSP_ROWS_NO_DAMAGE_TILE = [
  { category: "Roofing Material Type",       finding: "Tile Roofing System",                              result: "N/A"  },
  { category: "Tile Condition",               finding: "No cracked, loose, or displaced tiles — sound condition", result: "PASS" },
  { category: "Metal Panel Condition",        finding: "No damage observed",                               result: "PASS" },
  { category: "Flashing & Sealants",          finding: "Intact and sealed",                                result: "PASS" },
  { category: "Gutters & Downspouts",         finding: "No damage observed",                               result: "PASS" },
  { category: "Ridge & Hip Caps",             finding: "Sound condition",                                  result: "PASS" },
  { category: "Roof Deck (Visible)",          finding: "No deformation observed",                          result: "PASS" },
  { category: "Ventilation",                  finding: "Adequate",                                         result: "PASS" },
  { category: "Water Intrusion / Leaks",      finding: "No active leaks or intrusion observed",            result: "PASS" },
  { category: "Overall Structural Integrity", finding: "Roof system in serviceable condition",             result: "PASS" },
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

// ── Build certificate HTML (page 1 of the Damage/Retail PDF) ─────────
// Copied from inspection-checker.js. Renders the formal certificate page
// with company logo, findings table, signature, etc.
//
// `variant` controls findings rows, the certification statement, and the
// damage-status banner — "damage" calls out storm damage and PA notification,
// "retail" calls out a failed inspection without storm damage (retail sale).
function buildCertificateHTML({ record, inspectorName, inspectionDateISO, logoUrl, signatureUrl, variant = "damage" }) {
  const today = inspectionDateISO || new Date().toISOString().split("T")[0];
  const certNo = genCertNo(today);
  const inspector = inspectorName || "Hank Smith";
  const isRetail = variant === "retail";
  const isNoDamage = variant === "no_damage";
  // Tile vs shingle/metal findings — driven by the roof type captured at
  // intake (record.roof_type). Defaults to shingle when unset.
  const isTile = String(record.roof_type || "").trim().toLowerCase() === "tile";
  const rows = isNoDamage
    ? (isTile ? INSP_ROWS_NO_DAMAGE_TILE : INSP_ROWS_NO_DAMAGE)
    : isRetail
    ? (isTile ? INSP_ROWS_RETAIL_TILE : INSP_ROWS_RETAIL)
    : (isTile ? INSP_ROWS_DAMAGE_TILE : INSP_ROWS_DAMAGE);
  // Banner copy/colors per variant: green "NO DAMAGE FOUND" for a passing
  // roof, gray "NONE FOUND" for retail (failed but no storm damage), red
  // "DAMAGE FOUND" for storm damage.
  const statusBg = isNoDamage ? "#199c2e" : isRetail ? "#6b7280" : "#dc2626";
  const statusValue = isNoDamage ? "NO DAMAGE FOUND" : isRetail ? "NONE FOUND" : "DAMAGE FOUND";
  const remainingLife = isNoDamage ? "5+ Years" : "Needs Replacement";

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

      <div style="margin:8px 14px;border:2px solid #1a2e5a;border-radius:4px;padding:9px 13px;background:${isNoDamage ? "#f0fdf4" : "#fff5f5"};">
        <div style="font-size:12px;font-weight:700;color:#1a2e5a;text-align:center;margin-bottom:5px;text-transform:uppercase;">OFFICIAL CERTIFICATION STATEMENT</div>
        <div style="font-size:10.5px;line-height:1.65;color:#111827;text-align:center;">
          ${isNoDamage
            ? `This is to certify that a thorough roofing inspection was conducted by U.S. Shingle and Metal LLC on the above-referenced property. Based on the findings, the roof system has been evaluated and <strong>NO STORM DAMAGE WAS IDENTIFIED</strong>. The roof system was found to be in serviceable condition at the time of inspection.`
            : isRetail
            ? `This is to certify that a thorough roofing inspection was conducted by U.S. Shingle and Metal LLC on the above-referenced property. Based on the findings, the roof system has been evaluated. The roof system requires immediate attention. It has <strong>FAILED INSPECTION</strong> in multiple areas.`
            : `This is to certify that a thorough roofing inspection was conducted by U.S. Shingle and Metal LLC on the above-referenced property. Based on the findings, the roof system has been evaluated and <strong>STORM DAMAGE HAS BEEN IDENTIFIED</strong>. The roof system requires immediate attention. A licensed Public Adjuster has been notified to assist with the insurance claims process.`}
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
          <div style="font-size:8.5px;color:${isRetail || isNoDamage ? "#fff" : "#c8392b"};font-weight:700;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:2px;">ESTIMATED REMAINING ROOF LIFE:</div>
          <div style="font-size:14px;font-weight:700;color:#fff;">${remainingLife}</div>
        </div>
        <div style="background:${statusBg};padding:9px 13px;text-align:center;border-right:2px solid #fff;display:flex;flex-direction:column;align-items:center;justify-content:center;">
          <div style="font-size:9.5px;font-weight:700;color:rgba(255,255,255,0.85);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:2px;">${isRetail ? "STORM DAMAGE STATUS" : "DAMAGE STATUS"}</div>
          <div style="font-size:20px;font-weight:700;color:#fff;">${statusValue}</div>
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
  return buildCertificatePdf({ clientName, address, date, photos, record, variant: "damage" });
}

// ── Retail PDF: 2 pages (certificate + photo grid) ───────────────────
// Same layout as Damage but with retail-specific findings rows and a
// "STORM DAMAGE STATUS: NONE FOUND" banner — the roof needs replacement
// but no storm damage was identified, so the customer is a retail sale.
async function generateRetailPDF({ clientName, address, repName, date, photos, record }) {
  return buildCertificatePdf({ clientName, address, date, photos, record, variant: "retail" });
}

// ── No-Damage PDF: formal certificate (photo page only if photos exist) ─
// The homeowner is promised an "official inspection certificate" they can
// give their insurer as evidence the roof was inspected and found in good
// condition — so No Damage gets the SAME formal certificate as Damage/
// Retail (green "NO DAMAGE FOUND" banner), NOT the old 1-page summary.
async function generateNoDamagePDF({ clientName, address, repName, date, photos, record }) {
  return buildCertificatePdf({ clientName, address, date, photos, record, variant: "no_damage" });
}

async function buildCertificatePdf({ clientName, address, date, photos, record, variant }) {
  const logoUrl = `${BASE_URL}/uss-header.png`;
  const signatureUrl = `${BASE_URL}/rep-signature.png`;
  const inspectionDateISO = new Date().toISOString().split("T")[0];
  const certPageHtml = buildCertificateHTML({
    record,
    inspectorName: "Hank Smith",
    inspectionDateISO,
    logoUrl,
    signatureUrl,
    variant,
  });

  // Photos are embedded as a 2nd page photo grid. The wizard now
  // compresses photos to 1000px/quality 0.7 (~80-150KB each), so 10
  // photos inline + cert page produces a ~2MB PDF that fits in Lambda
  // memory. If we ever loosen the wizard compression we'll OOM again.
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
    ${photoCount > 0 ? `<div class="photos-page">
      <div class="photos-header">
        <h2>📷 Inspection Photos</h2>
        <span>${escapeHtml(clientName)} · ${date}</span>
      </div>
      <div class="photos-subheader">${escapeHtml(address)} · ${photoCount} photos shown</div>
      <table class="photo-grid">${photoRows}</table>
      <div class="photos-footer">
        U.S. Shingle &amp; Metal LLC · License #CCC1331960 · Photos taken during roof inspection · ${date}
      </div>
    </div>` : ""}
  </body></html>`;

  return await renderPdfFromHtml(html);
}

// ── No-Damage PDF: 1 page summary (no photos) ───────────────────────
// Used when the JN result is "No Damage". Photos live in JN's Photos
// tab — embedding them inline was OOMing the Lambda. This is a short
// summary letter the rep can hand to the homeowner showing the result.
async function generatePhotoReportPDF({ clientName, address, repName, date, photos, resultLabel }) {
  const logoUrl = `${BASE_URL}/uss-header.png`;
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
    .meta { padding: 14px 22px; background: #f9fafb; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 8px 8px; }
    .meta table { width: 100%; border-collapse: collapse; font-size: 12px; }
    .meta td { padding: 5px 0; }
    .meta td:first-child { color: #6b7280; font-weight: 700; text-transform: uppercase; font-size: 10px; letter-spacing: 0.05em; width: 130px; }
    .note { margin-top: 22px; font-size: 12px; color: #374151; line-height: 1.55; }
    .footer { margin-top: 24px; padding-top: 10px; border-top: 1px solid #e5e7eb; font-size: 10px; color: #9ca3af; text-align: center; }
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
    <div class="note">
      The above-referenced property was inspected by a U.S. Shingle and Metal LLC
      roofing inspector. Inspection photos are filed on the homeowner's job record.
    </div>
    <div class="footer">
      U.S. Shingle &amp; Metal LLC · License #CCC1331960 · Inspection date: ${date}
    </div>
  </body></html>`;

  return await renderPdfFromHtml(html);
}

// ── JN-truth idempotency check ───────────────────────────────────────
// Ask JN whether this job already carries an Inspection Report document.
// Used as the dedup guard so we never upload a second copy regardless of
// what the Supabase stamp says. Mirrors bulk-list-insp-report-candidates.js:
// list the job's documents (type=1) and look for our filename prefix.
// Fail-OPEN (returns false) on any error so a transient JN hiccup never
// blocks a legitimate first cert.
async function jobAlreadyHasReport(jnid) {
  try {
    const r = await fetch(`${JN_BASE}/files?related=${encodeURIComponent(jnid)}&type=1&size=50`, { headers: jnHeaders });
    if (!r.ok) {
      console.warn("jobAlreadyHasReport lookup failed:", r.status, "— treating as no report (fail-open)");
      return false;
    }
    const data = await r.json().catch(() => ({}));
    const files = data.files || data.results || [];
    return files.some((f) => {
      const fn = (f.filename || "");
      const desc = (f.description || "");
      return fn.startsWith("Inspection-Report-") || desc.startsWith("Inspection Report (with photos)");
    });
  } catch (e) {
    console.warn("jobAlreadyHasReport error (fail-open):", e.message);
    return false;
  }
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