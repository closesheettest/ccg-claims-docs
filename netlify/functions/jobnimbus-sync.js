// Netlify serverless function — ES module format
// Native fetch available in Node 18+

const JN_BASE = "https://app.jobnimbus.com/api1";

// TEMPORARY: mirror of PA_FORMS_DISABLED in src/App.jsx. While true,
// this server forces the JN status to "Sit Sold Insp" no matter what
// docsSignedList the client sent — guarantees no claim ever gets
// pushed into "Sit Sold PA" while the new PA is being onboarded, even
// if a stale browser cache somehow submits lor/pac. Flip in BOTH
// places (App.jsx + this file) when re-enabling.
const PA_FORMS_DISABLED = true;

const jnHeaders = (apiKey) => ({
  Authorization: `bearer ${apiKey}`,
  "Content-Type": "application/json",
});

// Search contacts by address AND name
// Normalize an address for comparison: lowercase, strip punctuation,
// collapse whitespace, expand/abbreviate common street suffixes so
// "2334 N Orange Ave" and "2334 North Orange Avenue" match.
function normalizeAddress(s) {
  if (!s) return "";
  let t = String(s).toLowerCase()
    .replace(/[.,#]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const suffixes = [
    [/\bavenue\b/g, "ave"], [/\bav\b/g, "ave"],
    [/\bstreet\b/g, "st"], [/\bdrive\b/g, "dr"],
    [/\bboulevard\b/g, "blvd"], [/\bblvd\b/g, "blvd"],
    [/\broad\b/g, "rd"], [/\blane\b/g, "ln"], [/\bcourt\b/g, "ct"],
    [/\bcircle\b/g, "cir"], [/\bplace\b/g, "pl"],
    [/\bparkway\b/g, "pkwy"], [/\bhighway\b/g, "hwy"],
    [/\bterrace\b/g, "ter"], [/\btrail\b/g, "trl"],
    [/\bnorth\b/g, "n"], [/\bsouth\b/g, "s"], [/\beast\b/g, "e"], [/\bwest\b/g, "w"],
  ];
  for (const [re, abbr] of suffixes) t = t.replace(re, abbr);
  return t;
}

// First 5 digits of a US zip — JN sometimes stores ZIP+4 ("34234-1234")
// while we have just "34234", so equality on the full string misses.
function normalizeZip(z) {
  if (!z) return "";
  const m = String(z).match(/\d{5}/);
  return m ? m[0] : "";
}

async function findContact(apiKey, address, zip, firstName, lastName) {
  try {
    const streetNum = (address || "").trim().split(/\s+/)[0] || "";
    const targetAddrNorm = normalizeAddress(address);
    const targetZip5 = normalizeZip(zip);
    const fnLower = (firstName || "").toLowerCase().trim();
    const lnLower = (lastName || "").toLowerCase().trim();

    // Helper: does this contact look like a match for our homeowner?
    function isMatch(c) {
      const cAddrNorm = normalizeAddress([c.address_line1, c.city].filter(Boolean).join(" "));
      const cZip5 = normalizeZip(c.zip);
      const cFn = (c.first_name || "").toLowerCase().trim();
      const cLn = (c.last_name || "").toLowerCase().trim();

      // Strong: normalized address contains the street number AND zip matches (or no zip on either side)
      const streetNumHit = streetNum && cAddrNorm.includes(streetNum.toLowerCase());
      const zipHit = !targetZip5 || !cZip5 || cZip5 === targetZip5;
      if (streetNumHit && zipHit) return "strong-addr";

      // Medium: normalized full-address overlaps (handles abbreviation differences)
      if (targetAddrNorm && cAddrNorm && (cAddrNorm.includes(targetAddrNorm) || targetAddrNorm.includes(cAddrNorm))) {
        return "medium-addr";
      }

      // Medium: exact case-insensitive first + last name (regardless of address)
      if (fnLower && lnLower && cFn === fnLower && cLn === lnLower) return "name-exact";

      // Weak: last-name match + street-number match (catches Jr/Sr suffix differences)
      if (lnLower && cLn === lnLower && streetNumHit) return "name+streetnum";

      return null;
    }

    // Pass 1: search JN by street number (matches existing pattern).
    if (streetNum) {
      const addrRes = await fetch(`${JN_BASE}/contacts?search=${encodeURIComponent(streetNum)}&size=20`, {
        headers: jnHeaders(apiKey),
      });
      if (addrRes.ok) {
        const addrData = await addrRes.json();
        const contacts = addrData.results || addrData.contacts || addrData.items || [];
        console.log("Street-num search returned:", contacts.length, "contacts");
        // Score each — strong addr matches win.
        const ranked = [];
        for (const c of contacts) {
          const tier = isMatch(c);
          if (tier) ranked.push({ c, tier });
        }
        // Prefer strong-addr over anything else.
        const order = { "strong-addr": 0, "medium-addr": 1, "name-exact": 2, "name+streetnum": 3 };
        ranked.sort((a, b) => order[a.tier] - order[b.tier]);
        if (ranked[0]) {
          const top = ranked[0];
          console.log(`Found by ${top.tier}:`, top.c.jnid || top.c.id, top.c.display_name);
          return top.c;
        }
      }
    }

    // Pass 2: search JN by name. Same scoring — any tier wins.
    const nameQuery = `${firstName} ${lastName}`.trim();
    if (nameQuery) {
      const nameRes = await fetch(`${JN_BASE}/contacts?search=${encodeURIComponent(nameQuery)}&size=20`, {
        headers: jnHeaders(apiKey),
      });
      if (nameRes.ok) {
        const nameData = await nameRes.json();
        const contacts = nameData.results || nameData.contacts || nameData.items || [];
        console.log("Name search returned:", contacts.length, "contacts");
        for (const c of contacts) {
          const tier = isMatch(c);
          if (tier) {
            console.log(`Found by ${tier} (name search):`, c.jnid || c.id, c.display_name);
            return c;
          }
        }
      }
    }

    console.log("No existing contact found");
    return null;
  } catch (e) {
    console.error("findContact error:", e.message);
    return null;
  }
}

// Given a contact's JNID and a target address, see if the contact
// already has a job at that address. Used to prevent duplicate JOBS
// even when the contact lookup succeeds — the original duplicate
// happened because we found the right contact but then created a
// fresh job on top of one that already existed for the same property.
async function findJobOnContactByAddress(apiKey, contactId, address) {
  if (!contactId) return null;
  try {
    const r = await fetch(`${JN_BASE}/jobs?related=${encodeURIComponent(contactId)}&size=30`, {
      headers: jnHeaders(apiKey),
    });
    if (!r.ok) {
      console.warn("findJobOnContactByAddress list failed:", r.status);
      return null;
    }
    const data = await r.json().catch(() => ({}));
    const list = data.results || data.jobs || data.items || [];
    if (!Array.isArray(list) || list.length === 0) return null;
    const targetNorm = normalizeAddress(address);
    const streetNum = (address || "").trim().split(/\s+/)[0] || "";
    // Prefer an exact normalized-address match; fall back to street-num.
    const exact = list.find((j) => {
      const jAddrNorm = normalizeAddress([j.address_line1, j.city].filter(Boolean).join(" "));
      return targetNorm && jAddrNorm && (jAddrNorm === targetNorm || jAddrNorm.includes(targetNorm) || targetNorm.includes(jAddrNorm));
    });
    if (exact) return exact;
    if (streetNum) {
      const partial = list.find((j) => {
        const jAddrNorm = normalizeAddress([j.address_line1, j.city].filter(Boolean).join(" "));
        return jAddrNorm.includes(streetNum.toLowerCase());
      });
      if (partial) return partial;
    }
    return null;
  } catch (e) {
    console.warn("findJobOnContactByAddress error:", e.message);
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

// Search JN for a job by name. Used when createJob returns
// "Duplicate job exists" — we link our Supabase row to the
// already-existing job instead of failing the sync.
async function findJobByName(apiKey, name) {
  if (!name) return null;
  try {
    const q = encodeURIComponent(name.trim());
    const r = await fetch(`${JN_BASE}/jobs?search=${q}&size=10`, { headers: jnHeaders(apiKey) });
    if (!r.ok) return null;
    const data = await r.json().catch(() => ({}));
    const list = data.results || data.jobs || data.items || [];
    if (!Array.isArray(list) || list.length === 0) return null;
    const target = name.trim().toLowerCase();
    const exact = list.find((j) => (j.name || j.display_name || "").trim().toLowerCase() === target);
    return exact || list[0] || null;
  } catch (e) {
    console.warn("findJobByName error:", e.message);
    return null;
  }
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
    phone, email: rawEmail,
    address, city, state, zip,
    salesRepName, salesRepId,
    pdfBase64, pdfFilename,
    // Optional: override the "sold date" (cf_date_5) with an explicit
    // timestamp. Used by retry-jn-sync so re-synced orphans land in
    // JN with their ORIGINAL signed_at, not today's date. Accepts a
    // Unix-seconds integer OR an ISO 8601 string.
    soldDate,
    isTest, testOverrideEmail, testOverridePhone,
  } = body;

  // JN's create-contact endpoint 400s if email is set but malformed
  // (e.g. rep typed just "ppumphrey" without a domain). Empty email
  // is accepted. So if the value doesn't look like a real address,
  // null it out — the contact still syncs, just without an email.
  function isValidEmail(s) {
    if (typeof s !== "string") return false;
    const t = s.trim();
    if (!t) return false;
    // Basic RFC-light check: chars + @ + chars + . + 2+ chars.
    return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(t);
  }
  const email = isValidEmail(rawEmail) ? rawEmail.trim() : "";
  if (rawEmail && !email) {
    console.warn(`Stripped malformed email "${rawEmail}" — syncing without email`);
  }

  console.log("=== JN Sync Start ===");
  if (isTest) console.log("🧪 TEST MODE — overrides:", testOverrideEmail, testOverridePhone);
  console.log("Lead:", leadSource, "| Docs:", docsSignedList);
  console.log("Name:", homeowner1, "| Address:", address, city, state, zip);
  console.log("Rep:", salesRepName, salesRepId, "| Has PDF:", !!pdfBase64);

  try {
    // Force-strip lor/pac while PA forms are disabled — defense in depth
    // against stale clients that might still submit them.
    const safeDocsSignedList = PA_FORMS_DISABLED
      ? (docsSignedList || []).filter(d => d !== "lor" && d !== "pac")
      : (docsSignedList || []);
    if (PA_FORMS_DISABLED && (docsSignedList || []).some(d => d === "lor" || d === "pac")) {
      console.warn("PA_FORMS_DISABLED: stripping lor/pac from docsSignedList. Original:", docsSignedList);
    }
    const hasPADocs = safeDocsSignedList.some(d => d === "lor" || d === "pac");
    const hasInsp   = safeDocsSignedList.includes("insp");
    const status    = hasPADocs ? "Sit Sold PA" : "Sit Sold Insp";
    const nameParts = (homeowner1 || "Homeowner").trim().split(" ");
    const firstName = nameParts[0];
    const lastName  = nameParts.slice(1).join(" ") || "";
    const fullName  = [homeowner1, homeowner2].filter(Boolean).join(" & ");

    // Sold date — defaults to "now" but caller can override via the
    // soldDate param. Used by retry-jn-sync to preserve the original
    // signed_at on re-synced orphans (otherwise JN's weekly report
    // shows old signings under "this week" because cf_date_5 = today).
    let soldDateUnix;
    if (soldDate != null) {
      if (typeof soldDate === "number") {
        // If it looks like ms (>10 digits), divide by 1000.
        soldDateUnix = soldDate > 1e11 ? Math.floor(soldDate / 1000) : Math.floor(soldDate);
      } else {
        const ms = Date.parse(String(soldDate));
        soldDateUnix = Number.isFinite(ms) ? Math.floor(ms / 1000) : Math.floor(Date.now() / 1000);
      }
    } else {
      soldDateUnix = Math.floor(Date.now() / 1000);
    }

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

      // For test mode, append timestamp to avoid duplicate display_name error
      const displayName = isTest
        ? `${fullName} [TEST-${Date.now()}]`
        : fullName;

      const contactPayload = {
        first_name: firstName,
        last_name: lastName,
        display_name: displayName,
        email: email || "",
        mobile_phone: phone || "",
        address_line1: address || "",
        city: cleanCity,
        state_text: state || "",
        zip: zip || "",
      };
      // Note: NOT setting sales_rep on contact — causes Couchbase key error
      // Rep is set on the job instead

      let newContact;
      try {
        newContact = await createContact(apiKey, contactPayload);
      } catch (createErr) {
        // If duplicate, try with a unique display name suffix
        if (createErr.message && createErr.message.toLowerCase().includes("duplicate")) {
          console.log("Duplicate contact — retrying with unique display name");
          contactPayload.display_name = `${fullName} [${Date.now()}]`;
          newContact = await createContact(apiKey, contactPayload);
        } else {
          throw createErr;
        }
      }
      contactId = newContact.jnid || newContact.id;
      contactAction = "created";
      console.log("Contact created:", contactId);
    }

    if (!contactId) throw new Error("No contact ID after create/find step");

    // ── Location hardcoded — ID 3 = U.S. SHINGLE - Insurance ──────────────
    const locationId = 3;

    // Status IDs from PA workflow (id:37)
    // 597 = Sit Sold Insp, 598 = Sit Sold PA
    const statusId = hasPADocs ? 598 : 597;
    const statusName = hasPADocs ? "Sit Sold PA" : "Sit Sold Insp";

    // Send BOTH the numeric `status` AND the `status_name` string.
    // Sending status alone has caused some records to display
    // correctly in JN's UI but be missed by status-filtered reports —
    // admin had to re-click the dropdown option to "bind" them to the
    // workflow status. Sending both keeps the binding explicit.
    const jobPayload = {
      name: `${isTest ? "[TEST] " : ""}${fullName} - ${address}`.trim(),
      record_type_name: "PA",
      status: statusId,
      status_name: statusName,
      primary: { id: contactId },
      location: { id: locationId },
      source_name: leadSource || "Inspection",
      // Address fields on the job so city shows in reports
      address_line1: address || "",
      city: (city || "").split(",")[0].trim(),
      state_text: state || "",
      zip: zip || "",
      sales_rep: salesRepId || undefined,
      owners: salesRepId ? [{ id: salesRepId }] : undefined,
      cf_string_34: "Needs Inspection",
      cf_date_5: soldDateUnix,
      // Pin date_start to the actual signed date too, not just the
      // custom sold-date field. JN's weekly "new this week" reports
      // filter on date_start — without this, re-syncing an older
      // record makes it show up under THIS week. Same Unix-seconds
      // format as cf_date_5.
      date_start: soldDateUnix,
    };

    console.log("Creating job payload:", JSON.stringify(jobPayload));

    // BEFORE calling createJob — if we already have the contact ID,
    // ask JN for the contact's existing jobs at this address. If one
    // exists we LINK to it instead of creating. This catches the
    // case where findContact succeeded (we used the existing JN
    // contact) but the contact already had a job for this property —
    // previously we'd create a brand-new duplicate job alongside it.
    let jobId;
    let linkedExisting = false;
    const preexistingJob = await findJobOnContactByAddress(apiKey, contactId, address);
    if (preexistingJob) {
      jobId = preexistingJob.jnid || preexistingJob.id;
      linkedExisting = true;
      console.log("Pre-flight: contact already has a job at this address — linking to", jobId);
    } else {
      // No existing job on this contact at this address. Create.
      // If JN STILL returns "Duplicate job exists" (different contact
      // with same job-name), fall back to findJobByName to link.
      try {
        const newJob = await createJob(apiKey, jobPayload);
        jobId = newJob.jnid || newJob.id;
        console.log("Job created:", jobId);
      } catch (createErr) {
        const isDup = (createErr.message || "").toLowerCase().includes("duplicate");
        if (!isDup) throw createErr;
        console.log("Job duplicate-name error from JN — searching by name to link");
        const existing = await findJobByName(apiKey, jobPayload.name);
        if (!existing) throw createErr;
        jobId = existing.jnid || existing.id;
        linkedExisting = true;
        console.log("Linked to existing JN job (by name):", jobId);
      }
    }
    if (!jobId) throw new Error("Job created but no ID returned");

    // Follow-up PUT to ensure all fields are set. SKIP when we linked
    // to an existing JN job — overwriting cf_string_34 / cf_date_5 /
    // date_start would wipe out manual changes the manager already
    // made in JN (e.g. the Retail status they just set).
    if (!linkedExisting) {
      try {
        const putBody = {
          jnid: jobId,
          sales_rep: salesRepId || undefined,
          owners: salesRepId ? [{ id: salesRepId }] : undefined,
          cf_string_34: "Needs Inspection",
          cf_date_5: soldDateUnix,
          date_start: soldDateUnix,
        };
        console.log("PUT body:", JSON.stringify(putBody));
        const putRes = await fetch(`${JN_BASE}/jobs/${jobId}`, {
          method: "PUT",
          headers: jnHeaders(apiKey),
          body: JSON.stringify(putBody),
        });
        const putText = await putRes.text();
        console.log("Job PUT status:", putRes.status, putText.slice(0, 500));
      } catch(e) { console.warn("Job PUT failed:", e.message); }

      // Inspect the created job so we can see what fields JN actually saved
      await inspectJob(apiKey, jobId);
    } else {
      console.log("Skipped follow-up PUT to preserve manual JN edits on linked job");
    }

    // ── Upload PDF ──────────────────────────────────────────────────────
    let fileResult = { success: false, error: "skipped" };
    if (pdfBase64 && pdfFilename && hasInsp) {
      fileResult = await uploadFileToJob(apiKey, jobId, pdfFilename, pdfBase64);
    }

    console.log("=== JN Sync Complete ===");
    console.log("Contact:", contactId, contactAction, "| Job:", jobId, "| Status:", status, "| File:", fileResult, "| Linked existing:", linkedExisting);
    return {
      statusCode: 200,
      body: JSON.stringify({ success: true, contactId, contactAction, jobId, status, fileResult, linkedExisting }),
    };
  } catch (err) {
    console.error("=== JN Sync ERROR ===", err.message);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};