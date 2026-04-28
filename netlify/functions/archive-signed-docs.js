// netlify/functions/archive-signed-docs.js
//
// Stores signed PDF documents in Supabase Storage so they're permanently
// retrievable. Called from App.jsx during the live signing flow, AND from
// regenerate-old-pdfs.js during backfill.
//
// USAGE:
//   POST /.netlify/functions/archive-signed-docs
//   Body: {
//     inspectionId: "abc-123",
//     pdfs: {
//       insp:    { filename: "Free-Roof-Inspection-Agreement.pdf", base64: "..." },
//       lor:     { filename: "Letter-of-Representation.pdf",       base64: "..." },
//       pac:     { filename: "Public-Adjuster-Contract.pdf",       base64: "..." },
//       welcome: { filename: "CCG-Welcome-Package.pdf",            base64: "..." },
//     }
//   }
//
// Returns: { ok: true, paths: { insp: "...", lor: "...", ... } }

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

  let inspectionId, pdfs;
  try {
    const body = JSON.parse(event.body || "{}");
    inspectionId = body.inspectionId;
    pdfs = body.pdfs || {};
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: "Invalid JSON body" }) };
  }
  if (!inspectionId) {
    return { statusCode: 400, body: JSON.stringify({ error: "inspectionId is required" }) };
  }

  console.log("=== archive-signed-docs START for:", inspectionId, "docs:", Object.keys(pdfs));

  // Build a folder name with timestamp so re-archives don't collide
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const paths = {};

  // Upload each PDF in parallel
  const uploads = Object.entries(pdfs).map(async ([key, doc]) => {
    if (!doc?.base64) return null;
    const filename = (doc.filename || `${key}.pdf`).replace(/[^a-zA-Z0-9._-]/g, "_");
    const path = `${inspectionId}/${ts}_${filename}`;

    // Decode base64 to a Buffer for upload
    const buffer = Buffer.from(doc.base64, "base64");

    // POST to Supabase Storage REST API
    const upRes = await fetch(`${SB_URL}/storage/v1/object/${BUCKET}/${path}`, {
      method: "POST",
      headers: {
        apikey: SB_KEY,
        Authorization: `Bearer ${SB_KEY}`,
        "Content-Type": "application/pdf",
        "x-upsert": "true",
      },
      body: buffer,
    });
    if (!upRes.ok) {
      const errText = await upRes.text();
      console.error("Upload failed for", key, ":", upRes.status, errText.slice(0, 200));
      return { key, error: errText };
    }
    paths[key] = path;
    return { key, path };
  });

  const results = await Promise.all(uploads);
  const errors = results.filter(r => r && r.error);
  if (errors.length > 0) {
    console.warn("Some uploads failed:", errors);
  }

  // Save the paths back to the inspection record
  const updateRes = await fetch(
    `${SB_URL}/rest/v1/inspections?id=eq.${inspectionId}`,
    {
      method: "PATCH",
      headers: { ...sbHeaders, Prefer: "return=minimal" },
      body: JSON.stringify({
        signed_pdfs: { ...paths, uploaded_at: new Date().toISOString() },
      }),
    }
  );
  if (!updateRes.ok) {
    const errText = await updateRes.text();
    console.warn("Could not save signed_pdfs to inspection:", errText);
    // Don't fail the whole call — files are uploaded successfully, this
    // just means we can't find them via the inspection record.
  }

  console.log("Archive complete. Paths:", paths);
  return {
    statusCode: 200,
    body: JSON.stringify({
      ok: true,
      paths,
      uploaded: Object.keys(paths).length,
      failed: errors.length,
    }),
  };
};