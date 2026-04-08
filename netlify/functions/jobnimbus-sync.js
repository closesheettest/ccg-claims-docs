// Netlify serverless function — ES module format
// Native fetch is available in Node 18+ (Netlify default)

const JN_BASE = "https://app.jobnimbus.com/api1";

const jnHeaders = (apiKey) => ({
  Authorization: `bearer ${apiKey}`,
  "Content-Type": "application/json",
});

async function findContactByAddress(apiKey, address, zip) {
  try {
    const query = encodeURIComponent(address.split(",")[0].trim());
    const res = await fetch(`${JN_BASE}/contacts?search=${query}&size=10`, {
      headers: jnHeaders(apiKey),
    });
    const text = await res.text();
    console.log("Contact search status:", res.status);
    console.log("Contact search snippet:", text.slice(0, 400));
    if (!res.ok) return null;
    const data = JSON.parse(text);
    const contacts = data.results || data.contacts || data.items || [];
    console.log("Contacts returned:", contacts.length);
    if (!contacts.length) return null;
    const streetNum = address.trim().split(" ")[0];
    return contacts.find((c) => {
      const cAddr = [c.address_line1, c.city].filter(Boolean).join(" ").toLowerCase();
      const zipMatch = !zip || (c.zip || "").replace(/\s/g,"") === zip.replace(/\s/g,"");
      return cAddr.includes(streetNum.toLowerCase()) && zipMatch;
    }) || null;
  } catch (e) {
    console.error("findContactByAddress error:", e.message);
    return null;
  }
}

async function createContact(apiKey, payload) {
  console.log("Creating contact:", JSON.stringify(payload));
  const res = await fetch(`${JN_BASE}/contacts`, {
    method: "POST",
    headers: jnHeaders(apiKey),
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  console.log("Create contact status:", res.status, text.slice(0, 400));
  if (!res.ok) throw new Error(`Create contact failed (${res.status}): ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

async function createJob(apiKey, payload) {
  console.log("Creating job:", JSON.stringify(payload));
  const res = await fetch(`${JN_BASE}/jobs`, {
    method: "POST",
    headers: jnHeaders(apiKey),
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  console.log("Create job status:", res.status, text.slice(0, 400));
  if (!res.ok) throw new Error(`Create job failed (${res.status}): ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

async function uploadFileToJob(apiKey, jobId, filename, base64Content) {
  try {
    const fileBytes = Buffer.from(base64Content, "base64");
    console.log("Uploading file:", filename, "bytes:", fileBytes.length, "jobId:", jobId);

    // Step 1 — initiate single-part upload
    const initRes = await fetch(`${JN_BASE}/files`, {
      method: "POST",
      headers: jnHeaders(apiKey),
      body: JSON.stringify({
        record_id: jobId,
        record_type: "job",
        filename,
        content_type: "application/pdf",
        size: fileBytes.length,
      }),
    });
    const initText = await initRes.text();
    console.log("File init status:", initRes.status, initText.slice(0, 400));
    if (!initRes.ok) return { success: false, error: `Init ${initRes.status}: ${initText.slice(0,200)}` };

    const initData = JSON.parse(initText);
    const uploadUrl = initData.url || initData.upload_url || initData.presigned_url;
    const fileId = initData.id || initData.jnid;
    console.log("Upload URL present:", !!uploadUrl, "File ID:", fileId);
    if (!uploadUrl) return { success: false, error: "No upload URL: " + initText.slice(0,200) };

    // Step 2 — PUT to S3
    const s3Res = await fetch(uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": "application/pdf" },
      body: fileBytes,
    });
    console.log("S3 PUT status:", s3Res.status);
    if (!s3Res.ok) return { success: false, error: `S3 failed ${s3Res.status}` };

    // Step 3 — complete upload
    if (fileId) {
      const compRes = await fetch(`${JN_BASE}/files/${fileId}/complete`, {
        method: "POST",
        headers: jnHeaders(apiKey),
        body: JSON.stringify({}),
      });
      console.log("Complete upload status:", compRes.status);
    }
    return { success: true };
  } catch (e) {
    console.error("uploadFileToJob error:", e.message);
    return { success: false, error: e.message };
  }
}

export const handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  const apiKey = process.env.JOBNIMBUS_API_KEY;
  if (!apiKey) {
    return { statusCode: 500, body: JSON.stringify({ error: "JOBNIMBUS_API_KEY not set" }) };
  }

  let body;
  try { body = JSON.parse(event.body || "{}"); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: "Invalid JSON" }) }; }

  const {
    leadSource, docsSignedList,
    homeowner1, homeowner2,
    phone, email,
    address, city, state, zip,
    salesRepName, salesRepId,
    pdfBase64, pdfFilename,
  } = body;

  console.log("=== JN Sync Start ===");
  console.log("Lead:", leadSource, "| Docs:", docsSignedList);
  console.log("Name:", homeowner1, "| Address:", address, city, state, zip);
  console.log("Rep:", salesRepName, salesRepId, "| Has PDF:", !!pdfBase64);

  try {
    const hasPADocs = (docsSignedList || []).some(d => d === "lor" || d === "pac");
    const hasInsp   = (docsSignedList || []).includes("insp");
    const status    = hasPADocs ? "Sit Sold PA" : "Sit Sold Insp";
    const nameParts = (homeowner1 || "Homeowner").trim().split(" ");
    const firstName = nameParts[0];
    const lastName  = nameParts.slice(1).join(" ") || "";
    const fullName  = [homeowner1, homeowner2].filter(Boolean).join(" & ");
    console.log("Status:", status, "| Full name:", fullName);

    // ── Find or create contact ──────────────────────────────────────────
    let contactId = null;
    let contactAction = "none";

    if (leadSource === "INS") {
      console.log("INS: searching by address:", address, zip);
      const existing = await findContactByAddress(apiKey, address, zip);
      if (existing) {
        contactId = existing.jnid || existing.id;
        contactAction = "found";
        console.log("Found contact:", contactId);
        // Update name if changed
        if (homeowner1 && existing.first_name !== firstName) {
          await fetch(`${JN_BASE}/contacts/${contactId}`, {
            method: "PUT",
            headers: jnHeaders(apiKey),
            body: JSON.stringify({ first_name: firstName, last_name: lastName }),
          }).then(r => console.log("Name update:", r.status)).catch(e => console.warn(e.message));
        }
      } else {
        console.log("INS contact not found — creating new");
      }
    }

    if (!contactId) {
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
      if (salesRepId) contactPayload.sales_rep = { id: salesRepId };
      const newContact = await createContact(apiKey, contactPayload);
      contactId = newContact.jnid || newContact.id;
      contactAction = "created";
      console.log("Contact created:", contactId);
    }

    if (!contactId) throw new Error("No contact ID — create/find failed");

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
    console.log("Job created:", jobId);
    if (!jobId) throw new Error("Job created but no ID returned");

    // ── Upload PDF ──────────────────────────────────────────────────────
    let fileResult = { success: false, error: "skipped" };
    if (pdfBase64 && pdfFilename && hasInsp) {
      fileResult = await uploadFileToJob(apiKey, jobId, pdfFilename, pdfBase64);
    }

    console.log("=== JN Sync Complete ===", { contactId, jobId, status, fileResult });
    return {
      statusCode: 200,
      body: JSON.stringify({ success: true, contactId, contactAction, jobId, status, fileResult }),
    };
  } catch (err) {
    console.error("=== JN Sync ERROR ===", err.message);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};