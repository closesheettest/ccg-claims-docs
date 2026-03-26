const JN_API = "https://app.jobnimbus.com/api1";
const JN_KEY = process.env.JOBNIMBUS_API_KEY;

const jnHeaders = {
  "Authorization": `Bearer ${JN_KEY}`,
  "Content-Type": "application/json",
};

// ── Helpers ──────────────────────────────────────────────────────────────────

async function searchContactByAddress(address) {
  const q = encodeURIComponent(address);
  const res = await fetch(`${JN_API}/contacts?search=${q}&size=5`, { headers: jnHeaders });
  if (!res.ok) return null;
  const data = await res.json();
  return data.results?.length ? data.results[0] : null;
}

async function createContact(payload) {
  const res = await fetch(`${JN_API}/contacts`, {
    method: "POST",
    headers: jnHeaders,
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`Create contact failed: ${await res.text()}`);
  return res.json();
}

async function updateContact(jnid, payload) {
  const res = await fetch(`${JN_API}/contacts/${jnid}`, {
    method: "PUT",
    headers: jnHeaders,
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`Update contact failed: ${await res.text()}`);
  return res.json();
}

async function createJob(payload) {
  const res = await fetch(`${JN_API}/jobs`, {
    method: "POST",
    headers: jnHeaders,
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`Create job failed: ${await res.text()}`);
  return res.json();
}

async function uploadAttachment(jobId, filename, base64Content) {
  const binaryStr = Buffer.from(base64Content, "base64");
  const res = await fetch(`${JN_API}/jobs/${jobId}/files`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${JN_KEY}`,
      "Content-Type": "application/octet-stream",
      "X-File-Name": filename,
    },
    body: binaryStr,
  });
  if (!res.ok) {
    const txt = await res.text();
    console.warn(`Attachment upload failed (non-fatal): ${txt}`);
  }
  return res.ok;
}

// ── Main handler ──────────────────────────────────────────────────────────────

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  try {
    const {
      // Contact fields
      firstName,
      lastName,
      address,
      city,
      state,
      zip,
      phone,
      email,

      // Job fields
      salesRepId,       // JN user id
      leadSource,       // "NEED" | "INS"
      soldDate,         // ISO date string

      // Flow control
      paSignedAlso,     // boolean — true if LOR+PA also signed

      // PDF attachments (base64 strings)
      inspectionPdfBase64,
      lorPdfBase64,
      pacPdfBase64,
    } = JSON.parse(event.body || "{}");

    // ── Determine status based on what was signed ──
    // Location: U.S. Shingle - Insurance only has these statuses
    const jobStatus = paSignedAlso ? "Sit Sold PA" : "Sit Sold Insp";

    // ── Contact: find or create ──
    let contactId;

    if (leadSource === "INS") {
      // Search by address — record already exists in JN
      const existing = await searchContactByAddress(`${address} ${city}`);
      if (existing) {
        contactId = existing.jnid;
        // Update name with the new (more current) contact info
        await updateContact(contactId, {
          first_name: firstName,
          last_name: lastName,
          mobile_phone: phone,
          email,
        });
      } else {
        // Not found — create fresh
        const contact = await createContact({
          first_name: firstName,
          last_name: lastName,
          address,
          city,
          state_text: state,
          zip,
          mobile_phone: phone,
          email,
          lead_source: leadSource,
        });
        contactId = contact.jnid;
      }
    } else {
      // NEED — always create new contact
      const contact = await createContact({
        first_name: firstName,
        last_name: lastName,
        address,
        city,
        state_text: state,
        zip,
        mobile_phone: phone,
        email,
        lead_source: leadSource,
      });
      contactId = contact.jnid;
    }

    // ── Create Job ──
    const job = await createJob({
      contact: { jnid: contactId },
      sales_rep: salesRepId ? { jnid: salesRepId } : undefined,
      status: jobStatus,
      sold_date: soldDate || new Date().toISOString().split("T")[0],
      lead_source: leadSource,
      location: "U.S. Shingle - Insurance",
      // Insurance / inspection fields
      inspection_status: "Needs Inspection",
      // Address mirrors contact
      address,
      city,
      state_text: state,
      zip,
    });

    const jobId = job.jnid;

    // ── Upload PDFs ──
    const uploads = [];

    if (inspectionPdfBase64) {
      uploads.push(uploadAttachment(jobId, "Free-Roof-Inspection-Agreement.pdf", inspectionPdfBase64));
    }
    if (lorPdfBase64) {
      uploads.push(uploadAttachment(jobId, "Letter-of-Representation.pdf", lorPdfBase64));
    }
    if (pacPdfBase64) {
      uploads.push(uploadAttachment(jobId, "Public-Adjuster-Contract.pdf", pacPdfBase64));
    }

    await Promise.allSettled(uploads);

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        success: true,
        contactId,
        jobId,
        status: jobStatus,
      }),
    };

  } catch (err) {
    console.error("jobnimbus-sync error:", err);
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: err.message || "Job Nimbus sync failed" }),
    };
  }
};