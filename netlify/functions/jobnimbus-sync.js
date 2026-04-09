// Netlify serverless function — ES module format
// Native fetch available in Node 18+

const JN_BASE = "https://app.jobnimbus.com/api1";

const jnHeaders = (apiKey) => ({
  Authorization: `bearer ${apiKey}`,
  "Content-Type": "application/json",
});

// Search contacts by address AND name
async function findContact(apiKey, address, zip, firstName, lastName) {
  try {
    // Try by address first
    const addrQuery = encodeURIComponent(address.split(",")[0].trim());
    const addrRes = await fetch(`${JN_BASE}/contacts?search=${addrQuery}&size=10`, {
      headers: jnHeaders(apiKey),
    });
    if (addrRes.ok) {
      const addrData = await addrRes.json();
      const contacts = addrData.results || addrData.contacts || addrData.items || [];
      console.log("Address search returned:", contacts.length, "contacts");
      const streetNum = address.trim().split(" ")[0];
      const byAddr = contacts.find((c) => {
        const cAddr = [c.address_line1, c.city].filter(Boolean).join(" ").toLowerCase();
        const zipMatch = !zip || (c.zip || "").replace(/\s/g,"") === zip.replace(/\s/g,"");
        return cAddr.includes(streetNum.toLowerCase()) && zipMatch;
      });
      if (byAddr) {
        console.log("Found by address:", byAddr.jnid || byAddr.id, byAddr.display_name);
        return byAddr;
      }
    }

    // Then try by name
    const nameQuery = encodeURIComponent(`${firstName} ${lastName}`.trim());
    const nameRes = await fetch(`${JN_BASE}/contacts?search=${nameQuery}&size=10`, {
      headers: jnHeaders(apiKey),
    });
    if (nameRes.ok) {
      const nameData = await nameRes.json();
      const contacts = nameData.results || nameData.contacts || nameData.items || [];
      console.log("Name search returned:", contacts.length, "contacts");
      const byName = contacts.find((c) =>
        (c.first_name || "").toLowerCase() === firstName.toLowerCase() &&
        (c.last_name || "").toLowerCase() === lastName.toLowerCase()
      );
      if (byName) {
        console.log("Found by name:", byName.jnid || byName.id, byName.display_name);
        return byName;
      }
    }

    console.log("No existing contact found");
    return null;
  } catch (e) {
    console.error("findContact error:", e.message);
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

// GET an existing job to see what field names JN uses
async function inspectJob(apiKey, jobId) {
  try {
    const res = await fetch(`${JN_BASE}/jobs/${jobId}`, { headers: jnHeaders(apiKey) });
    const text = await res.text();
    console.log("Job inspect status:", res.status);
    console.log("Job fields:", text.slice(0, 1000));
  } catch(e) {
    console.warn("inspectJob error:", e.message);
  }
}

async function uploadFileToJob(apiKey, jobId, filename, base64Content) {
  try {
    const fileBytes = Buffer.from(base64Content, "base64");
    console.log("Uploading file:", filename, "bytes:", fileBytes.length, "jobId:", jobId);

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
    console.log("Upload URL present:", !!uploadUrl, "| File ID:", fileId);
    if (!uploadUrl) return { success: false, error: "No upload URL: " + initText.slice(0,200) };

    const s3Res = await fetch(uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": "application/pdf" },
      body: fileBytes,
    });
    console.log("S3 PUT status:", s3Res.status);
    if (!s3Res.ok) return { success: false, error: `S3 failed ${s3Res.status}` };

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

    // Sold date = today as Unix timestamp (seconds)
    const soldDateUnix = Math.floor(Date.now() / 1000);

    console.log("Status:", status, "| Full name:", fullName, "| Sold date:", soldDateUnix);

    // ── Always search first ─────────────────────────────────────────────
    console.log("Searching for existing contact...");
    const existing = await findContact(apiKey, address, zip, firstName, lastName);

    let contactId = null;
    let contactAction = "none";

    if (existing) {
      contactId = existing.jnid || existing.id;
      contactAction = "found";
      console.log("Using existing contact:", contactId, existing.display_name);

      if (leadSource === "INS" && homeowner1 &&
          (existing.first_name || "").toLowerCase() !== firstName.toLowerCase()) {
        await fetch(`${JN_BASE}/contacts/${contactId}`, {
          method: "PUT",
          headers: jnHeaders(apiKey),
          body: JSON.stringify({ first_name: firstName, last_name: lastName }),
        }).then(r => console.log("Name update status:", r.status))
          .catch(e => console.warn("Name update failed:", e.message));
      }
    } else {
      console.log("No existing contact — creating new");
      // Clean city — strip any trailing ", ST" if address parsing bled over
      const cleanCity = (city || "").split(",")[0].trim();

      const contactPayload = {
        first_name: firstName,
        last_name: lastName,
        display_name: fullName,
        email: email || "",
        mobile_phone: phone || "",
        address_line1: address || "",
        city: cleanCity,
        state_text: state || "",
        zip: zip || "",
      };
      // Note: NOT setting sales_rep on contact — causes Couchbase key error
      // Rep is set on the job instead

      const newContact = await createContact(apiKey, contactPayload);
      contactId = newContact.jnid || newContact.id;
      contactAction = "created";
      console.log("Contact created:", contactId);
    }

    if (!contactId) throw new Error("No contact ID after create/find step");

    // ── Create job ──────────────────────────────────────────────────────
    const cleanCity = (city || "").split(",")[0].trim();

    const jobPayload = {
      name: `${fullName} - ${address}`.trim(),
      status_name: status,
      location_name: "U.S. Shingle - Insurance",
      primary: { id: contactId },
      date_sold: soldDateUnix,
      sold_date: soldDateUnix,
      inspection: "Needs Inspection",
      inspection_status: "Needs Inspection",
      inspection_type: "Needs Inspection",
    };

    // Try rep assignment — log salesRepId so we can verify format
    console.log("Rep ID being sent:", salesRepId, "Rep name:", salesRepName);
    if (salesRepId) {
      // Try the sales_rep_id field (string) rather than nested object
      jobPayload.sales_rep_id = salesRepId;
    } else if (salesRepName) {
      jobPayload.sales_rep_name = salesRepName;
    }

    const newJob = await createJob(apiKey, jobPayload);
    const jobId = newJob.jnid || newJob.id;
    console.log("Job created:", jobId);
    if (!jobId) throw new Error("Job created but no ID returned");

    // Inspect the created job so we can see what fields JN actually saved
    await inspectJob(apiKey, jobId);

    // ── Upload PDF ──────────────────────────────────────────────────────
    let fileResult = { success: false, error: "skipped" };
    if (pdfBase64 && pdfFilename && hasInsp) {
      fileResult = await uploadFileToJob(apiKey, jobId, pdfFilename, pdfBase64);
    }

    console.log("=== JN Sync Complete ===");
    console.log("Contact:", contactId, contactAction, "| Job:", jobId, "| Status:", status, "| File:", fileResult);
    return {
      statusCode: 200,
      body: JSON.stringify({ success: true, contactId, contactAction, jobId, status, fileResult }),
    };
  } catch (err) {
    console.error("=== JN Sync ERROR ===", err.message);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};