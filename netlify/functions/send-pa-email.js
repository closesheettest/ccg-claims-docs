// netlify/functions/send-pa-email.js
//
// Sends a damage-confirmation email to the PA (public adjuster) at
// claims@capitalclaimgroup.com with inspection photos from JobNimbus.
//
// USAGE (from App.jsx):
//   POST /.netlify/functions/send-pa-email
//   Body: { inspectionId: "<supabase id>" }
//
// This function:
//   1. Looks up the inspection record in Supabase by id
//   2. Fetches the associated JN job's photos
//   3. Builds an email with photo thumbnails inline + high-res attached
//   4. Sends via Resend
//   5. Returns { ok: true, photoCount: N } on success
//
// Safety:
//   • Requires result = 'damage' and jn_job_id to be set
//   • Does NOT write last_notified_pa_at — the caller (App.jsx) does that
//     after confirming success, so we don't mark an unsent email as sent

const JN_BASE  = "https://app.jobnimbus.com/api1";
const JN_FILES = "https://app.jobnimbus.com/api1";
const JN_KEY   = process.env.JOBNIMBUS_API_KEY;
const SB_URL   = process.env.VITE_SUPABASE_URL;
const SB_KEY   = process.env.VITE_SUPABASE_ANON_KEY;
const PA_EMAIL = "claims@capitalclaimgroup.com";

const sbHeaders = {
  apikey: SB_KEY,
  Authorization: `Bearer ${SB_KEY}`,
  "Content-Type": "application/json",
};
const jnHeaders = {
  Authorization: `bearer ${JN_KEY}`,
  "Content-Type": "application/json",
};

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  let inspectionId;
  try {
    const body = JSON.parse(event.body || "{}");
    inspectionId = body.inspectionId;
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: "Invalid JSON body" }) };
  }

  if (!inspectionId) {
    return { statusCode: 400, body: JSON.stringify({ error: "inspectionId is required" }) };
  }

  console.log("=== send-pa-email START for:", inspectionId);

  // 1. Fetch the inspection record
  const sbRes = await fetch(
    `${SB_URL}/rest/v1/inspections?id=eq.${inspectionId}&select=id,client_name,address,city,state,zip,sales_rep_name,jn_job_id,result,docs_signed&limit=1`,
    { headers: sbHeaders }
  );
  if (!sbRes.ok) {
    return { statusCode: 500, body: JSON.stringify({ error: "Could not fetch inspection", detail: await sbRes.text() }) };
  }
  const rows = await sbRes.json();
  if (!rows || rows.length === 0) {
    return { statusCode: 404, body: JSON.stringify({ error: "Inspection not found" }) };
  }
  const rec = rows[0];

  // 2. Gate: only send if result is damage AND jn_job_id is set
  if (rec.result !== "damage") {
    return { statusCode: 400, body: JSON.stringify({ error: `Cannot notify PA — result is "${rec.result || "pending"}" (only damage)` }) };
  }
  if (!rec.jn_job_id) {
    return { statusCode: 400, body: JSON.stringify({ error: "Cannot notify PA — no JN job linked to this record" }) };
  }

  // 3. Fetch photos from JN
  console.log("Fetching photos for jn_job_id:", rec.jn_job_id);
  const photos = await fetchJobPhotos(rec.jn_job_id);
  console.log("Photos fetched:", photos.length);

  // 4. Build email HTML — photos shown inline + attached
  const clientName = rec.client_name || "Homeowner";
  const address = [rec.address, rec.city, rec.state, rec.zip].filter(Boolean).join(", ");
  const repName = rec.sales_rep_name || "—";
  const reportDate = new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });

  const photoGrid = photos.length > 0
    ? `<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:20px">
         ${photos.slice(0, 10).map((p, i) =>
           `<div style="background:#fff;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden"><img src="cid:photo${i}" style="width:100%;display:block" alt="Photo ${i + 1}" /></div>`
         ).join("")}
       </div>
       ${photos.length > 10 ? `<p style="font-size:12px;color:#6b7280;margin-top:8px">+ ${photos.length - 10} more photos attached</p>` : ""}`
    : `<p style="color:#991b1b;font-weight:700">⚠️ No photos were available on the JobNimbus job.</p>`;

  const html = `<div style="font-family:Arial,sans-serif;max-width:700px;margin:0 auto">
    <div style="background:#dc2626;padding:24px 32px;border-radius:12px 12px 0 0">
      <h1 style="color:#fff;margin:0;font-size:22px">⚠️ Damage Confirmed — PA Action Required</h1>
    </div>
    <div style="background:#f9fafb;padding:24px 32px;border-radius:0 0 12px 12px;border:1px solid #e5e7eb;border-top:none">
      <p>A roof inspection has confirmed <strong>storm damage</strong> at the following property. All paperwork (inspection + LOR + PA) has been signed and the claim is ready to be processed.</p>

      <table style="width:100%;border-collapse:collapse;margin:16px 0">
        <tr><td style="padding:8px 12px;background:#fff;border:1px solid #e5e7eb;font-weight:700;width:140px">Homeowner</td><td style="padding:8px 12px;background:#fff;border:1px solid #e5e7eb">${clientName}</td></tr>
        <tr><td style="padding:8px 12px;background:#fff;border:1px solid #e5e7eb;font-weight:700">Property</td><td style="padding:8px 12px;background:#fff;border:1px solid #e5e7eb">${address}</td></tr>
        <tr><td style="padding:8px 12px;background:#fff;border:1px solid #e5e7eb;font-weight:700">Sales Rep</td><td style="padding:8px 12px;background:#fff;border:1px solid #e5e7eb">${repName}</td></tr>
        <tr><td style="padding:8px 12px;background:#fff;border:1px solid #e5e7eb;font-weight:700">Inspection Date</td><td style="padding:8px 12px;background:#fff;border:1px solid #e5e7eb">${reportDate}</td></tr>
        <tr><td style="padding:8px 12px;background:#fff;border:1px solid #e5e7eb;font-weight:700">Result</td><td style="padding:8px 12px;background:#fef2f2;border:1px solid #e5e7eb;color:#991b1b;font-weight:700">DAMAGE CONFIRMED</td></tr>
      </table>

      <h3 style="margin-top:24px;color:#1a2e5a">Inspection Photos (${photos.length})</h3>
      ${photoGrid}

      <div style="background:#1a2e5a;border-radius:10px;padding:16px 20px;margin:24px 0 0">
        <p style="margin:0;font-weight:700;color:#fff">📞 U.S. Shingle &amp; Metal LLC</p>
        <p style="margin:6px 0 0;color:rgba(255,255,255,0.85);font-size:14px">Phone: 727-761-5200 &nbsp;|&nbsp; Email: inspection@shingleusa.com</p>
      </div>
    </div>
  </div>`;

  // 5. Build attachments — first 10 photos as inline CID refs, any extras as regular attachments
  const attachments = photos.map((p, i) => ({
    filename: `photo-${i + 1}.jpg`,
    content: p.base64,
    cid: i < 10 ? `photo${i}` : undefined,
    disposition: i < 10 ? "inline" : "attachment",
  }));

  // 6. Send via Resend
  const subject = `⚠️ Damage Confirmed — ${clientName} at ${address}`;
  const ok = await sendEmail(PA_EMAIL, subject, html, attachments);

  if (!ok) {
    return { statusCode: 500, body: JSON.stringify({ error: "Email send failed" }) };
  }

  return {
    statusCode: 200,
    body: JSON.stringify({
      ok: true,
      to: PA_EMAIL,
      photoCount: photos.length,
      inspection: { id: rec.id, client: clientName, address },
    }),
  };
};

// ── Fetch photos from JN (copied from inspection-checker.js so we don't
//    need to import across function boundaries) ───────────────────────
async function fetchJobPhotos(jnJobId) {
  try {
    const res = await fetch(
      `${JN_FILES}/files?related=${jnJobId}&type=2&size=30`,
      { headers: jnHeaders }
    );
    if (!res.ok) { console.warn("Photo list failed:", res.status); return []; }
    const data = await res.json();
    const files = data.data || data.files || data.results || [];
    const imageFiles = files.filter(f => (f.content_type || "").startsWith("image/"));

    const photoPromises = imageFiles.slice(0, 20).map(async (file) => {
      try {
        const url = file.presigned_url || file.url || file.download_url
          || file.file_url || file.original_url
          || file.src || file.link || file.public_url || file.signed_url;
        if (!url) return null;
        const imgRes = await fetch(url);
        if (!imgRes.ok) return null;
        const buffer = await imgRes.arrayBuffer();
        const base64 = Buffer.from(buffer).toString("base64");
        return { base64 };
      } catch { return null; }
    });
    return (await Promise.all(photoPromises)).filter(Boolean);
  } catch (e) {
    console.warn("fetchJobPhotos error:", e.message);
    return [];
  }
}

// ── Email sender via Resend ───────────────────────────────────────
async function sendEmail(to, subject, html, attachments) {
  try {
    const payload = {
      from: `U.S. Shingle & Metal <${process.env.FROM_EMAIL || "noreply@inspectionforyou.com"}>`,
      to: Array.isArray(to) ? to : [to],
      subject,
      html,
    };
    if (attachments && attachments.length > 0) payload.attachments = attachments;

    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    const d = await res.json().catch(() => ({}));
    console.log("Email result:", res.status, JSON.stringify(d).slice(0, 200));
    return res.ok;
  } catch (e) {
    console.error("sendEmail error:", e.message);
    return false;
  }
}