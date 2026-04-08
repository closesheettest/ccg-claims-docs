const fetch = (...args) => import("node-fetch").then(({ default: f }) => f(...args));

const JN_BASE = "https://app.jobnimbus.com/api1";

// ─── helpers ────────────────────────────────────────────────────────────────

const jnHeaders = (apiKey) => ({
  Authorization: `bearer ${apiKey}`,
  "Content-Type": "application/json",
});

// Search contacts by address (partial match)
async function findContactByAddress(apiKey, address) {
  try {
    const encoded = encodeURIComponent(address);
    const res = await fetch(`${JN_BASE}/contacts?search=${encoded}&size=5`, {
      headers: jnHeaders(apiKey),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const contacts = data.results || data.contacts || [];
    if (!contacts.length) return null;

    // Find best match — address contains the search string
    const addrLower = address.toLowerCase().replace(/\s+/g, " ").trim();
    return contacts.find((c) => {
      const cAddr = ((c.address_line1 || "") + " " + (c.city || "")).toLowerCase();
      return cAddr.includes(addrLower.split(",")[0].toLowerCase());
    }) || contacts[0];
  } catch (e) {
    console.error("findContactByAddress error:", e.message);
    return null;
  }
}

// Create a new contact
async function createContact(apiKey, payload) {
  const res = await fetch(`${JN_BASE}/contacts`, {
    method: "POST",
    headers: jnHeaders(apiKey),
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Create contact failed: ${JSON.stringify(data)}`);
  return data;
}

// Create a new job linked to a contact
async function createJob(apiKey, payload) {
  const res = await fetch(`${JN_BASE}/jobs`, {
    method: "POST",
    headers: jnHeaders(apiKey),
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Create job failed: ${JSON.stringify(data)}`);
  return data;
}

// Upload a file to a job using single-part upload
// Step 1: initiate upload, get upload URL
// Step 2: PUT file bytes to S3 URL
// Step 3: complete upload
async function uploadFileToJob(apiKey, jobId, filename, base64Content) {
  try {
    const fileBytes = Buffer.from(base64Content, "base64");
    const fileSizeBytes = fileBytes.length;

    // Step 1 — initiate single-part upload
    const initRes = await fetch(`${JN_BASE}/files`, {
      method: "POST",
      headers: jnHeaders(apiKey),
      body: JSON.stringify({
        record_id: jobId,
        record_type: "job",
        filename: filename,
        content_type: "application/pdf",
        size: fileSizeBytes,
      }),
    });
    const initData = await initRes.json();
    console.log("File init response:", JSON.stringify(initData).slice(0, 300));

    if (!initRes.ok) {
      console.error("File init failed:", JSON.stringify(initData));
      return false;
    }

    const uploadUrl = initData.url || initData.upload_url;
    const fileId = initData.id || initData.jnid;

    if (!uploadUrl) {
      console.error("No upload URL returned:", JSON.stringify(initData));
      return false;
    }

    // Step 2 — PUT the file bytes to the S3 URL
    const s3Res = await fetch(uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": "application/pdf" },
      body: fileBytes,
    });
    if (!s3Res.ok) {
      console.error("S3 upload failed:", s3Res.status);
      return false;
    }

    // Step 3 — complete the upload
    const completeRes = await fetch(`${JN_BASE}/files/${fileId}/complete`, {
      method: "POST",
      headers: jnHeaders(apiKey),
      body: JSON.stringify({}),
    });
    if (!completeRes.ok) {
      const err = await completeRes.text();
      console.error("File complete failed:", err);
      return false;
    }

    console.log("✅ File uploaded successfully:", filename);
    return true;
  } catch (e) {
    console.error("uploadFileToJob error:", e.message);
    return false;
  }
}

// ─── main handler ────────────────────────────────────────────────────────────

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  const apiKey = process.env.JOBNIMBUS_API_KEY;
  if (!apiKey) {
    return { statusCode: 500, body: JSON.stringify({ error: "JOBNIMBUS_API_KEY not set" }) };
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: "Invalid JSON" }) };
  }

  const {
    leadSource,      // "NEED" or "INS"
    docsSignedList,  // e.g. ["insp"] or ["insp","lor","pac"] or ["lor","pac"]
    homeowner1,
    homeowner2,
    phone,
    email,
    address,
    city,
    state,
    zip,
    salesRepName,
    salesRepId,      // JN user id
    pdfBase64,       // base64 encoded PDF of the signed inspection form
    pdfFilename,     // e.g. "Free-Roof-Inspection-John-Smith.pdf"
  } = body;

  console.log("JN Sync payload:", {
    leadSource, docsSignedList, homeowner1, address, city, state, zip, salesRepName,
  });

  try {
    // ── Determine status based on what was signed ──────────────────────────
    const hasInsp = (docsSignedList || []).includes("insp");
    const hasPADocs = (docsSignedList || []).some((d) => d === "lor" || d === "pac");
    const status = hasPADocs ? "Sit Sold PA" : "Sit Sold Insp";

    // ── Build full name ────────────────────────────────────────────────────
    const fullName = [homeowner1, homeowner2].filter(Boolean).join(" & ");
    const [firstName, ...lastParts] = (homeowner1 || "Homeowner").split(" ");
    const lastName = lastParts.join(" ") || "";

    // ── Find or create contact ─────────────────────────────────────────────
    let contactId = null;

    if (leadSource === "INS") {
      // INS — contact should already exist, search by address
      console.log("INS flow — searching for existing contact by address:", address);
      const existing = await findContactByAddress(apiKey, address);
      if (existing) {
        contactId = existing.jnid || existing.id;
        console.log("Found existing contact:", contactId, existing.display_name);

        // Update contact name if different (new info takes precedence)
        if (homeowner1 && existing.first_name !== firstName) {
          await fetch(`${JN_BASE}/contacts/${contactId}`, {
            method: "PUT",
            headers: jnHeaders(apiKey),
            body: JSON.stringify({ first_name: firstName, last_name: lastName }),
          });
          console.log("Updated contact name to:", firstName, lastName);
        }
      } else {
        console.log("INS contact not found by address — creating new");
      }
    }

    if (!contactId) {
      // NEED flow (or INS not found) — create new contact
      console.log("Creating new contact:", fullName, address);
      const contactPayload = {
        first_name: firstName,
        last_name: lastName,
        email: email || "",
        mobile_phone: phone || "",
        address_line1: address || "",
        city: city || "",
        state_text: state || "",
        zip: zip || "",
        record_type_name: "Contact",
        sales_rep_name: salesRepName || "",
        sales_rep_id: salesRepId || "",
      };
      const newContact = await createContact(apiKey, contactPayload);
      contactId = newContact.jnid || newContact.id;
      console.log("Created contact:", contactId);
    }

    if (!contactId) {
      throw new Error("Could not find or create contact in JN");
    }

    // ── Create job ─────────────────────────────────────────────────────────
    console.log("Creating job for contact:", contactId, "status:", status);
    const jobPayload = {
      name: `${fullName} - ${address}`,
      record_type_name: "Job",
      status_name: status,
      sales_rep_name: salesRepName || "",
      sales_rep_id: salesRepId || "",
      primary: { id: contactId },
      number: "",
      location_name: "U.S. Shingle - Insurance",
      date_created: Math.floor(Date.now() / 1000),
    };
    const newJob = await createJob(apiKey, jobPayload);
    const jobId = newJob.jnid || newJob.id;
    console.log("Created job:", jobId);

    if (!jobId) {
      throw new Error("Job created but no ID returned");
    }

    // ── Upload PDF if provided ─────────────────────────────────────────────
    let fileUploaded = false;
    if (pdfBase64 && pdfFilename && hasInsp) {
      console.log("Uploading PDF to job:", pdfFilename);
      fileUploaded = await uploadFileToJob(apiKey, jobId, pdfFilename, pdfBase64);
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        contactId,
        jobId,
        status,
        fileUploaded,
        message: `JN sync complete — contact ${contactId}, job ${jobId}, status: ${status}`,
      }),
    };
  } catch (err) {
    console.error("jobnimbus-sync error:", err.message);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message }),
    };
  }
};