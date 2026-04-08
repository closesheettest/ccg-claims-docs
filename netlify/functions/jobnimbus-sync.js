const fetch = (...args) => import("node-fetch").then(({ default: f }) => f(...args));

const JN_BASE = "https://app.jobnimbus.com/api1";

const jnHeaders = (apiKey) => ({
  Authorization: `bearer ${apiKey}`,
  "Content-Type": "application/json",
});

// ─── Search contacts by address ───────────────────────────────────────────
async function findContactByAddress(apiKey, address, zip) {
  try {
    // Try searching by address string
    const query = encodeURIComponent(address.split(",")[0].trim());
    const res = await fetch(`${JN_BASE}/contacts?search=${query}&size=10`, {
      headers: jnHeaders(apiKey),
    });
    const text = await res.text();
    console.log("Contact search status:", res.status);
    console.log("Contact search response:", text.slice(0, 500));

    if (!res.ok) return null;
    const data = JSON.parse(text);
    const contacts = data.results || data.contacts || data.items || [];
    console.log("Contacts found:", contacts.length);
    if (!contacts.length) return null;

    // Match by address
    const addrLower = address.toLowerCase().replace(/\s+/g, " ").trim();
    const match = contacts.find((c) => {
      const cAddr = [c.address_line1, c.address_line2, c.city]
        .filter(Boolean).join(" ").toLowerCase();
      const streetNum = addrLower.split(" ")[0];
      return cAddr.includes(streetNum) && (
        !zip || (c.zip || "").replace(/\s/g, "") === zip.replace(/\s/g, "")
      );
    });
    return match || null;
  } catch (e) {
    console.error("findContactByAddress error:", e.message);
    return null;
  }
}

// ─── Create contact ───────────────────────────────────────────────────────
async function createContact(apiKey, payload) {
  console.log("Creating contact payload:", JSON.stringify(payload));
  const res = await fetch(`${JN_BASE}/contacts`, {
    method: "POST",
    headers: jnHeaders(apiKey),
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  console.log("Create contact status:", res.status);
  console.log("Create contact response:", text.slice(0, 500));
  if (!res.ok) throw new Error(`Create contact failed (${res.status}): ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

// ─── Create job ───────────────────────────────────────────────────────────
async function createJob(apiKey, payload) {
  console.log("Creating job payload:", JSON.stringify(payload));
  const res = await fetch(`${JN_BASE}/jobs`, {
    method: "POST",
    headers: jnHeaders(apiKey),
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  console.log("Create job status:", res.status);
  console.log("Create job response:", text.slice(0, 500));
  if (!res.ok) throw new Error(`Create job failed (${res.status}): ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

// ─── Upload PDF to job (single-part) ─────────────────────────────────────
async function uploadFileToJob(apiKey, jobId, filename, base64Content) {
  try {
    const fileBytes = Buffer.from(base64Content, "base64");
    console.log("Uploading file:", filename, "size:", fileBytes.length, "to job:", jobId);

    // Step 1 — initiate upload
    const initBody = {
      record_id: jobId,
      record_type: "job",
      filename: filename,
      content_type: "application/pdf",
      size: fileBytes.length,
    };
    console.log("File init payload:", JSON.stringify(initBody));
    const initRes = await fetch(`${JN_BASE}/files`, {
      method: "POST",
      headers: jnHeaders(apiKey),
      body: JSON.stringify(initBody),
    });
    const initText = await initRes.text();
    console.log("File init status:", initRes.status);
    console.log("File init response:", initText.slice(0, 500));

    if (!initRes.ok) {
      console.error("File init failed:", initText);
      return { success: false, error: `Init failed ${initRes.status}: ${initText.slice(0,200)}` };
    }

    const initData = JSON.parse(initText);
    const uploadUrl = initData.url || initData.upload_url || initData.presigned_url;
    const fileId = initData.id || initData.jnid;
    console.log("Upload URL:", uploadUrl ? "received" : "MISSING");
    console.log("File ID:", fileId);

    if (!uploadUrl) {
      return { success: false, error: "No upload URL in response: " + initText.slice(0,200) };
    }

    // Step 2 — PUT bytes to S3
    const s3Res = await fetch(uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": "application/pdf", "Content-Length": String(fileBytes.length) },
      body: fileBytes,
    });
    console.log("S3 PUT status:", s3Res.status);
    if (!s3Res.ok) {
      const s3Err = await s3Res.text();
      console.error("S3 upload failed:", s3Err.slice(0, 200));
      return { success: false, error: `S3 upload failed ${s3Res.status}` };
    }

    // Step 3 — complete
    if (fileId) {
      const completeRes = await fetch(`${JN_BASE}/files/${fileId}/complete`, {
        method: "POST",
        headers: jnHeaders(apiKey),
        body: JSON.stringify({}),
      });
      const completeText = await completeRes.text();
      console.log("Complete status:", completeRes.status, completeText.slice(0, 200));
    }

    console.log("✅ File uploaded successfully");
    return { success: true };
  } catch (e) {
    console.error("uploadFileToJob error:", e.message);
    return { success: false, error: e.message };
  }
}

// ─── Main handler ─────────────────────────────────────────────────────────
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
    leadSource,
    docsSignedList,
    homeowner1, homeowner2,
    phone, email,
    address, city, state, zip,
    salesRepName, salesRepId,
    pdfBase64, pdfFilename,
  } = body;

  console.log("=== JN Sync Start ===");
  console.log("Lead:", leadSource, "| Docs:", docsSignedList, "| Address:", address, zip);
  console.log("Rep:", salesRepName, salesRepId);
  console.log("Has PDF:", !!pdfBase64);

  try {
    const hasPADocs = (docsSignedList || []).some(d => d === "lor" || d === "pac");
    const hasInsp   = (docsSignedList || []).includes("insp");
    const status    = hasPADocs ? "Sit Sold PA" : "Sit Sold Insp";

    const fullName  = [homeowner1, homeowner2].filter(Boolean).join(" & ");
    const nameParts = (homeowner1 || "Homeowner").trim().split(" ");
    const firstName = nameParts[0];
    const lastName  = nameParts.slice(1).join(" ") || "";

    console.log("Status will be:", status, "| Name:", fullName);

    // ── Find or create contact ──────────────────────────────────────────
    let contactId = null;
    let contactAction = "";

    if (leadSource === "INS") {
      console.log("INS: searching for contact by address:", address);
      const existing = await findContactByAddress(apiKey, address, zip);
      if (existing) {
        contactId = existing.jnid || existing.id;
        contactAction = "found_existing";
        console.log("Found contact:", contactId, existing.display_name || existing.name);

        // Update name if changed
        if (homeowner1 && (existing.first_name || "") !== firstName) {
          const updateRes = await fetch(`${JN_BASE}/contacts/${contactId}`, {
            method: "PUT",
            headers: jnHeaders(apiKey),
            body: JSON.stringify({ first_name: firstName, last_name: lastName }),
          });
          console.log("Name update status:", updateRes.status);
        }
      } else {
        console.log("INS contact not found — will create new");
      }
    }

    if (!contactId) {
      // Build contact payload — use JN field names from API docs
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
      };
      // Add rep if we have the JN id
      if (salesRepId) contactPayload.sales_rep = { id: salesRepId };

      const newContact = await createContact(apiKey, contactPayload);
      contactId = newContact.jnid || newContact.id;
      contactAction = "created";
      console.log("Contact created with ID:", contactId);
    }

    if (!contactId) throw new Error("No contact ID after create/find step");

    // ── Create job ──────────────────────────────────────────────────────
    const jobPayload = {
      name: `${fullName} - ${address}`.trim(),
      record_type_name: "Job",
      status_name: status,
      location_name: "U.S. Shingle - Insurance",
      primary: { id: contactId },
    };
    if (salesRepId) jobPayload.sales_rep = { id: salesRepId };

    const newJob = await createJob(apiKey, jobPayload);
    const jobId = newJob.jnid || newJob.id;
    console.log("Job created with ID:", jobId);

    if (!jobId) throw new Error("Job created but no ID returned");

    // ── Upload PDF ──────────────────────────────────────────────────────
    let fileResult = { success: false, error: "No PDF provided" };
    if (pdfBase64 && pdfFilename && hasInsp) {
      fileResult = await uploadFileToJob(apiKey, jobId, pdfFilename, pdfBase64);
    }

    console.log("=== JN Sync Complete ===");
    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        contactId,
        contactAction,
        jobId,
        status,
        fileUploaded: fileResult.success,
        fileError: fileResult.error || null,
      }),
    };
  } catch (err) {
    console.error("=== JN Sync Error ===", err.message);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message }),
    };
  }
};