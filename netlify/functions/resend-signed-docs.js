// netlify/functions/resend-signed-docs.js
//
// Re-sends archived signed PDFs to a custom recipient. If the inspection
// has never been archived, it triggers regeneration first (only works for
// records that have a matching claim with all 3 docs signed).
//
// USAGE:
//   POST /.netlify/functions/resend-signed-docs
//   Body: {
//     inspectionId: "abc-123",
//     to: "claims@capitalclaimgroup.com",
//     cc: "office@example.com" (optional),
//     subject: "..." (optional, defaults to a sensible subject),
//   }

const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const BUCKET = "signed-documents";

const sbHeaders = {
  apikey: SB_KEY,
  Authorization: `Bearer ${SB_KEY}`,
  "Content-Type": "application/json",
};

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  let inspectionId, to, cc, subject, forceRegen;
  try {
    const body = JSON.parse(event.body || "{}");
    inspectionId = body.inspectionId;
    to = body.to;
    cc = body.cc;
    subject = body.subject;
    forceRegen = !!body.forceRegen;
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: "Invalid JSON body" }) };
  }
  if (!inspectionId || !to) {
    return { statusCode: 400, body: JSON.stringify({ error: "inspectionId and to are required" }) };
  }

  console.log("=== resend-signed-docs START for:", inspectionId, "to:", to, "forceRegen:", forceRegen);

  // 1. Fetch the inspection record (with signed_pdfs paths)
  const sbRes = await fetch(
    `${SB_URL}/rest/v1/inspections?id=eq.${inspectionId}&select=*&limit=1`,
    { headers: sbHeaders }
  );
  if (!sbRes.ok) {
    return { statusCode: 500, body: JSON.stringify({ error: "Could not fetch inspection" }) };
  }
  const rows = await sbRes.json();
  const rec = rows?.[0];
  if (!rec) {
    return { statusCode: 404, body: JSON.stringify({ error: "Inspection not found" }) };
  }

  // 2. If not yet archived, OR if caller asked for forceRegen, regenerate fresh
  let signed = rec.signed_pdfs;
  if (forceRegen || !signed || !signed.insp) {
    console.log(forceRegen ? "Force-regen requested" : "Not yet archived — calling regenerate-old-pdfs first");
    const base = process.env.URL || process.env.BASE_URL || "";
    const regenRes = await fetch(`${base}/.netlify/functions/regenerate-old-pdfs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ inspectionId }),
    });
    const regenJson = await regenRes.json().catch(() => ({}));
    if (!regenRes.ok || !regenJson.ok) {
      return {
        statusCode: 500,
        body: JSON.stringify({ error: "Could not regenerate PDFs", detail: regenJson }),
      };
    }
    signed = regenJson.paths;
  }

  // 3. Download each PDF from Supabase Storage and base64-encode for email attachment.
  //    Validate the magic bytes (%PDF-) before attaching, so we never send a non-PDF
  //    masquerading as a PDF (e.g. if a file was somehow corrupted in storage).
  const attachments = [];
  const downloadErrors = [];
  for (const [key, path] of Object.entries(signed)) {
    if (key === "uploaded_at" || !path) continue;
    const dlRes = await fetch(`${SB_URL}/storage/v1/object/${BUCKET}/${path}`, {
      headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
    });
    if (!dlRes.ok) {
      console.warn("Could not download:", path, dlRes.status);
      downloadErrors.push({ key, error: `download ${dlRes.status}` });
      continue;
    }
    const buffer = await dlRes.arrayBuffer();
    const head = Buffer.from(buffer).slice(0, 5).toString();
    if (head !== "%PDF-") {
      console.warn("Storage object is not a PDF:", path, "head:", head);
      downloadErrors.push({ key, error: "stored file is not a PDF (corrupted archive)" });
      continue;
    }
    const base64 = Buffer.from(buffer).toString("base64");
    // Use the original filename from path (everything after the timestamp prefix)
    const filename = path.split("/").pop().replace(/^[\d-T:.Z_]+_/, "");
    attachments.push({ filename: filename || `${key}.pdf`, content: base64 });
  }

  if (attachments.length === 0) {
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: "No valid PDFs available to send",
        detail: { downloadErrors },
      }),
    };
  }

  // 4. Build email
  const clientName = rec.client_name || "Homeowner";
  const propAddr = [rec.address, rec.city, rec.state, rec.zip].filter(Boolean).join(", ");
  const finalSubject = subject || `Signed Documents — ${clientName}`;
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">
      <div style="background:#1a2e5a;padding:20px 28px;border-radius:10px 10px 0 0">
        <h2 style="color:#fff;margin:0;font-size:18px">📋 Signed Documents</h2>
      </div>
      <div style="background:#f9fafb;padding:20px 28px;border-radius:0 0 10px 10px;border:1px solid #e5e7eb;border-top:none">
        <p>Attached are the signed documents for the homeowner below.</p>
        <table style="font-size:14px;color:#374151;width:100%;border-collapse:collapse;margin:14px 0">
          <tr><td style="padding:5px 0;font-weight:700;width:130px">Homeowner:</td><td>${clientName}</td></tr>
          <tr><td style="padding:5px 0;font-weight:700">Address:</td><td>${propAddr}</td></tr>
          <tr><td style="padding:5px 0;font-weight:700">Originally signed:</td><td>${rec.signed_at ? new Date(rec.signed_at).toLocaleDateString() : "—"}</td></tr>
          <tr><td style="padding:5px 0;font-weight:700">Documents:</td><td>${attachments.map(a => a.filename).join(", ")}</td></tr>
        </table>
        <p style="font-size:12px;color:#6b7280">Sent from CCG Claims Docs admin panel.</p>
      </div>
    </div>
  `;

  // 5. Send via Resend
  const toList = [to];
  if (cc) toList.push(cc); // For simplicity we put CC into the to: list — Resend supports cc separately too but this works fine

  const sendRes = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: `U.S. Shingle & Metal <${process.env.FROM_EMAIL || "noreply@inspectionforyou.com"}>`,
      to: [to],
      cc: cc ? [cc] : undefined,
      subject: finalSubject,
      html,
      attachments,
    }),
  });

  const sendData = await sendRes.json().catch(() => ({}));
  if (!sendRes.ok) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Email send failed", detail: sendData }),
    };
  }

  return {
    statusCode: 200,
    body: JSON.stringify({
      ok: true,
      to,
      cc,
      attachments: attachments.map(a => a.filename),
    }),
  };
};