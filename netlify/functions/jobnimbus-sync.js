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

    // Step 1 — Get presigned S3 URL
    // Correct endpoint: http://api.jobnimbus.com/files/v1/uploads/url (different base URL!)
    const initBody = {
      related: [jobId],
      type: 1,            // 1 = Document
      filename: filename,
      description: "Signed Inspection Agreement",
    };
    console.log("File init payload:", JSON.stringify(initBody));

    const initRes = await fetch("https://api.jobnimbus.com/files/v1/uploads/url", {
      method: "POST",
      headers: {
        Authorization: `bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(initBody),
    });
    const initText = await initRes.text();
    console.log("File init status:", initRes.status, initText.slice(0, 500));
    if (!initRes.ok) return { success: false, error: `Init ${initRes.status}: ${initText.slice(0,300)}` };

    const initData = JSON.parse(initText);
    // Response is { data: { url: "...", jnid: "..." } }
    const uploadUrl = initData.data?.url || initData.url || initData.upload_url;
    const fileJnid  = initData.data?.jnid || initData.jnid;
    console.log("Upload URL present:", !!uploadUrl, "| File jnid:", fileJnid);
    if (!uploadUrl) return { success: false, error: "No upload URL in response: " + initText.slice(0,300) };

    // Step 2 — PUT file bytes to S3 presigned URL
    const s3Res = await fetch(uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": "application/pdf" },
      body: fileBytes,
    });
    console.log("S3 PUT status:", s3Res.status);
    if (!s3Res.ok) {
      const s3Err = await s3Res.text();
      return { success: false, error: `S3 failed ${s3Res.status}: ${s3Err.slice(0,200)}` };
    }

    // Step 3 — Complete upload (optional but triggers thumbnail generation)
    if (fileJnid) {
      const compRes = await fetch(`https://api.jobnimbus.com/files/v1/uploads/${fileJnid}/complete`, {
        method: "POST",
        headers: {
          Authorization: `bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
      });
      console.log("Complete upload status:", compRes.status);
    }

    console.log("✅ File uploaded successfully");
    return { success: true };
  } catch (e) {
    console.error("uploadFileToJob error:", e.message);
    return { success: false, error: e.message };
  }
}

exports.handler = async (event) => {
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

    // ── Location is hardcoded now that we know ID 3 = U.S. SHINGLE - Insurance
    const locationId = 3;

    // ── Location hardcoded — ID 3 = U.S. SHINGLE - Insurance ──────────────
    const locationId = 3;

    // ── Create job with all correct field names ─────────────────────────
    // From debug: custom fields are sent as flat keys on the job object
    // cf_string_34 = "Inspection", cf_date_5 = "Sold Date", sales_rep = JN user ID string
    const jobPayload = {
      name: `${fullName} - ${address}`.trim(),
      status_name: status,
      primary: { id: contactId },
      location: { id: locationId },
      // Sales rep — top-level string field with JN user ID
      sales_rep: salesRepId || undefined,
      // Custom fields sent as flat keys matching their field name
      cf_string_34: "Needs Inspection",   // Inspection field
      cf_date_5: soldDateUnix,            // Sold Date field (unix timestamp)
    };

    console.log("Creating job payload:", JSON.stringify(jobPayload));

    const newJob = await createJob(apiKey, jobPayload);
    const jobId = newJob.jnid || newJob.id;
    console.log("Job created:", jobId);
    if (!jobId) throw new Error("Job created but no ID returned");

    // Follow-up PUT to ensure all fields are set
    try {
      const putBody = {
        sales_rep: salesRepId || undefined,
        cf_string_34: "Needs Inspection",
        cf_date_5: soldDateUnix,
      };
      console.log("PUT body:", JSON.stringify(putBody));
      const putRes = await fetch(`${JN_BASE}/jobs/${jobId}`, {
        method: "PUT",
        headers: jnHeaders(apiKey),
        body: JSON.stringify(putBody),
      });
      const putText = await putRes.text();
      console.log("Job PUT status:", putRes.status, putText.slice(0, 200));
    } catch(e) { console.warn("Job PUT failed:", e.message); }

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