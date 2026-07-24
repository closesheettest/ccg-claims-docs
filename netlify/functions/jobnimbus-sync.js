// Netlify serverless function — ES module format
// Native fetch available in Node 18+

const JN_BASE = "https://app.jobnimbus.com/api1";

// JN location id 3 = "U.S. SHINGLE - Insurance" — the home for every
// inspection/PA job this app creates. Retail leads (incl. "Credit Denial")
// live on location id 1 ("U.S. SHINGLE"). We key the duplicate-job guard
// on this so a homeowner who already has a *retail* job at the address
// gets a NEW inspection job created under the same contact, rather than
// the inspection linking onto — and eventually overwriting — their retail
// credit-denial job. One contact ends up owning both: the retail job
// (history preserved) and the insurance inspection.
const INSURANCE_LOCATION_ID = 3;

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

// Last 10 digits of a phone number — strips formatting and any leading
// country code so "(904) 442-4428", "9044424428" and "+19044424428" all
// compare equal.
function normalizePhone(p) {
  const digits = String(p || "").replace(/\D/g, "");
  return digits.length >= 10 ? digits.slice(-10) : "";
}

async function findContact(apiKey, address, zip, firstName, lastName, phone, email) {
  try {
    const streetNum = (address || "").trim().split(/\s+/)[0] || "";
    const targetAddrNorm = normalizeAddress(address);
    const targetZip5 = normalizeZip(zip);
    const fnLower = (firstName || "").toLowerCase().trim();
    const lnLower = (lastName || "").toLowerCase().trim();
    const targetPhone10 = normalizePhone(phone);
    const targetEmail = (email || "").toLowerCase().trim();

    // Helper: does this contact look like a match for our homeowner?
    function isMatch(c) {
      const cAddrNorm = normalizeAddress([c.address_line1, c.city].filter(Boolean).join(" "));
      const cZip5 = normalizeZip(c.zip);
      const cFn = (c.first_name || "").toLowerCase().trim();
      const cLn = (c.last_name || "").toLowerCase().trim();

      // Strongest: same email or same phone is an identity match regardless
      // of address/name spelling — this is what catches the homeowner who
      // came in months earlier as a retail lead (e.g. last name typo'd) so
      // we reuse that contact instead of spawning a duplicate.
      const cEmail = (c.email || "").toLowerCase().trim();
      if (targetEmail && cEmail && cEmail === targetEmail) return "email";
      const cPhones = [c.mobile_phone, c.home_phone, c.work_phone].map(normalizePhone).filter(Boolean);
      if (targetPhone10 && cPhones.includes(targetPhone10)) return "phone";

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
        // Prefer identity (email/phone) > strong-addr > everything else.
        const order = { email: 0, phone: 1, "strong-addr": 2, "medium-addr": 3, "name-exact": 4, "name+streetnum": 5 };
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

    // Pass 3 & 4: search JN by phone digits, then by email. These are the
    // identity signals the dedup previously lacked — a homeowner whose
    // retail lead was filed under a misspelled name (so name + street-num
    // search missed it) is still caught here, preventing a duplicate
    // contact.
    for (const q of [targetPhone10, targetEmail].filter(Boolean)) {
      const res = await fetch(`${JN_BASE}/contacts?search=${encodeURIComponent(q)}&size=20`, {
        headers: jnHeaders(apiKey),
      });
      if (!res.ok) continue;
      const d = await res.json().catch(() => ({}));
      const contacts = d.results || d.contacts || d.items || [];
      console.log(`Identity search "${q}" returned:`, contacts.length, "contacts");
      for (const c of contacts) {
        const tier = isMatch(c);
        if (tier) {
          console.log(`Found by ${tier} (identity search):`, c.jnid || c.id, c.display_name);
          return c;
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
    // Only INSURANCE-location jobs count as "ours" to link/re-sync onto.
    // A retail job at the same address (e.g. a Credit Denial lead on
    // location 1) is deliberately ignored so the inspection becomes a
    // separate job under this same contact instead of overwriting it.
    const inspJobs = list.filter((j) => (j.location && j.location.id) === INSURANCE_LOCATION_ID);
    if (inspJobs.length === 0) {
      console.log("findJobOnContactByAddress: contact has jobs but none on the insurance location — will create a new inspection job");
      return null;
    }
    const targetNorm = normalizeAddress(address);
    const streetNum = (address || "").trim().split(/\s+/)[0] || "";
    // Prefer an exact normalized-address match; fall back to street-num.
    const exact = inspJobs.find((j) => {
      const jAddrNorm = normalizeAddress([j.address_line1, j.city].filter(Boolean).join(" "));
      return targetNorm && jAddrNorm && (jAddrNorm === targetNorm || jAddrNorm.includes(targetNorm) || targetNorm.includes(jAddrNorm));
    });
    if (exact) return exact;
    if (streetNum) {
      const partial = inspJobs.find((j) => {
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
//
// IMPORTANT: returns ONLY an EXACT name match (case-insensitive).
// We do NOT fall back to list[0]. JN's /jobs?search= endpoint is a
// fuzzy ranker — it will happily rank a different homeowner's job
// near the top if they share a rep or recent activity. Blindly
// linking to list[0] caused a real mis-attach (Oswaldo Cabrera's
// signing got linked to Priscilla Montalvo Garcia's job because
// they shared rep William Hernandez). If exact match fails, we
// return null so the calling code re-throws the original error
// instead of silently linking to the wrong job.
//
// Optional defense-in-depth: pass `expectedAddress` to filter
// candidates whose `address_line1` doesn't match.
async function findJobByName(apiKey, name, expectedAddress = null) {
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
    if (!exact) {
      console.log(`findJobByName: no exact match for "${name}" — refusing to fuzzy-link (was returning list[0] which caused mis-attaches)`);
      return null;
    }
    // If an expected address was passed, validate it matches before
    // returning. Catches the case where two unrelated homeowners
    // share an identical job-name string (rare but possible).
    if (expectedAddress && exact.address_line1) {
      const a = (exact.address_line1 || "").trim().toLowerCase();
      const b = (expectedAddress || "").trim().toLowerCase();
      if (a && b && a !== b) {
        console.log(`findJobByName: name matched but address mismatch — refusing to link. JN address="${exact.address_line1}" expected="${expectedAddress}"`);
        return null;
      }
    }
    return exact;
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

// Normalized street key so a signed address matches its map pin despite geocode
// drift + spelling ("365 Cowry Road" == "365 COWRY RD"). Mirrors the harvest dedup.
const PIN_SUF = { street: "st", st: "st", avenue: "ave", ave: "ave", av: "ave", place: "pl", pl: "pl", drive: "dr", dr: "dr", lane: "ln", ln: "ln", court: "ct", ct: "ct", terrace: "ter", terr: "ter", ter: "ter", boulevard: "blvd", blvd: "blvd", road: "rd", rd: "rd", circle: "cir", cir: "cir", trail: "trl", trl: "trl", parkway: "pkwy", pkwy: "pkwy", highway: "hwy", hwy: "hwy", cove: "cv", cv: "cv", point: "pt", pt: "pt", square: "sq", sq: "sq" };
const PIN_DIR = { north: "n", n: "n", south: "s", s: "s", east: "e", e: "e", west: "w", w: "w", northeast: "ne", ne: "ne", northwest: "nw", nw: "nw", southeast: "se", se: "se", southwest: "sw", sw: "sw" };
function pinStreetKey(address) {
  const s = String(address || "").split(",")[0].toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
  if (!s || !/^\d/.test(s)) return null;
  return s.split(" ").map((t) => PIN_SUF[t] || PIN_DIR[t] || t).join(" ");
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
    leadSource, docsSignedList, sourceOverride,
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
    // Optional: the Supabase inspections.id this signing came from. When
    // present, we write jn_job_id back to that row HERE, server-side, the
    // moment the JN job exists — instead of relying on the rep's browser
    // staying open long enough to do it. Browser-side back-write still
    // runs too (harmless redundancy); this closes the gap when the tab
    // is closed mid-sync, which stranded records like Heidi/Stephen.
    inspectionId,
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
  // JN lead source. Default "Inspection" (every signed roof inspection), but a
  // caller can override — e.g. a rep-generated door on the DoorDispatcher sends
  // "Self Generated" so JN's source reporting credits it as self-gen.
  const jnSource = (typeof sourceOverride === "string" && sourceOverride.trim()) ? sourceOverride.trim() : "Inspection";
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
    const existing = await findContact(apiKey, address, zip, firstName, lastName, phone, email);

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

    // ── Put the signing rep on the CONTACT too ────────────────────────────
    // JN hides a contact's phone/email from a rep who doesn't OWN it, so a
    // job-only assignment (what we used to do) left reps locked out of their
    // own signed clients — the office had to hand-assign each contact. Setting
    // sales_rep at contact-CREATE time throws a Couchbase key error, but a
    // post-create UPDATE is fine. Best-effort: never block the signing sync.
    // Owners is the field that controls visibility, so if the combined write is
    // rejected we retry with owners alone.
    if (salesRepId && !isTest) {
      try {
        const rc = await fetch(`${JN_BASE}/contacts/${contactId}`, {
          method: "PUT", headers: jnHeaders(apiKey),
          body: JSON.stringify({ owners: [{ id: salesRepId }], sales_rep: salesRepId }),
        });
        console.log("Contact rep-assign status:", rc.status);
        if (!rc.ok) {
          await fetch(`${JN_BASE}/contacts/${contactId}`, {
            method: "PUT", headers: jnHeaders(apiKey),
            body: JSON.stringify({ owners: [{ id: salesRepId }] }),
          }).then((r2) => console.log("Contact owners-only retry:", r2.status));
        }
      } catch (e) { console.warn("Contact rep-assign failed (non-fatal):", e.message); }
    }

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
      // A signed ROOF INSPECTION is always source = "Inspection" (this sync only
      // creates Sit Sold Insp / Sit Sold PA jobs). Hardcoded — not leadSource —
      // so the source is correct from signing forward, no matter what the rep
      // picked, and JN's source-based reporting always credits the inspection.
      source_name: jnSource,
      // Address fields on the job so city shows in reports
      address_line1: address || "",
      city: (city || "").split(",")[0].trim(),
      state_text: state || "",
      zip: zip || "",
      sales_rep: salesRepId || undefined,
      owners: salesRepId ? [{ id: salesRepId }] : undefined,
      cf_string_34: "Needs Inspection",
      cf_date_5: soldDateUnix,
      // NOTE: we intentionally do NOT set date_start on signing — per the
      // user, leave JN's Start Date alone for inspection sign-ups (the
      // office sets it later). cf_date_5 (Sold Date) is still recorded.
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
        console.log("Job duplicate-name error from JN — searching by name to link (with address verification)");
        const existing = await findJobByName(apiKey, jobPayload.name, address);
        if (!existing) {
          console.log("findJobByName returned null — surfacing the original duplicate error instead of silently mis-attaching");
          throw createErr;
        }
        jobId = existing.jnid || existing.id;
        linkedExisting = true;
        console.log("Linked to existing JN job (by name + address verified):", jobId);
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
          source_name: jnSource,   // re-assert the source (Inspection, or an override)
          cf_string_34: "Needs Inspection",
          cf_date_5: soldDateUnix,
          // date_start intentionally omitted — leave JN's Start Date alone.
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
      // …but still enforce source = "Inspection" on the linked job — a signed
      // roof inspection should always read as Inspection, even on a pre-existing
      // job. Source-only PUT so we DON'T touch the cf result/date fields a
      // manager may have already set (the reason we skip the full PUT above).
      try {
        await fetch(`${JN_BASE}/jobs/${jobId}`, {
          method: "PUT",
          headers: jnHeaders(apiKey),
          body: JSON.stringify({ jnid: jobId, source_name: jnSource }),
        });
      } catch (e) { console.warn("Linked-job source PUT failed:", e.message); }
    }

    // ── Upload signed agreement PDF ─────────────────────────────────────
    // The contact + job are created above; this attaches the signed
    // inspection agreement to the job. Historically this step silently
    // no-op'd: if the upload failed — or the client never produced a PDF —
    // we still returned success:true, so the contact+job synced with NO
    // agreement and nobody knew until the inspector showed up to a job
    // with no paperwork (see the Mark Hamersly incident, 2026-06).
    //
    // Now: (1) retry the upload a few times to ride out a transient JN/S3
    // blip, and (2) surface the outcome explicitly so a missing agreement
    // is caught — by the response flags below and the daily-orphan-alert
    // catch-net, never swallowed.
    const agreementExpected = hasInsp;            // a signed INSP agreement should exist
    const havePdf = !!(pdfBase64 && pdfFilename); // the client actually sent one
    let fileResult = { success: false, error: "skipped" };
    if (agreementExpected && havePdf) {
      for (let attempt = 1; attempt <= 3; attempt++) {
        fileResult = await uploadFileToJob(apiKey, jobId, pdfFilename, pdfBase64);
        if (fileResult.success) break;
        console.warn(`Agreement upload attempt ${attempt}/3 failed: ${fileResult.error}`);
        if (attempt < 3) await new Promise((r) => setTimeout(r, attempt * 750));
      }
    }

    // Three distinct end states for the agreement:
    //   uploaded  — attached to the JN job (the happy path)
    //   missing   — INSP was signed but the client sent no PDF at all
    //               (the PDF pipeline failed before sync — Mark's case)
    //   failed    — we had a PDF but every upload attempt failed
    const agreementUploaded = fileResult.success === true;
    const agreementMissing = agreementExpected && !havePdf;
    const agreementFailed = agreementExpected && havePdf && !agreementUploaded;
    if (agreementMissing) {
      console.error(
        `❌ AGREEMENT MISSING — INSP signed but no PDF in payload. Contact+job synced WITHOUT agreement. job=${jobId} name="${fullName}" rep="${salesRepName}"`,
      );
    }
    if (agreementFailed) {
      console.error(
        `❌ AGREEMENT UPLOAD FAILED after 3 attempts: ${fileResult.error}. job=${jobId} name="${fullName}" rep="${salesRepName}"`,
      );
    }

    // ── Server-side jn_job_id write-back ────────────────────────────────
    // The reliable half of the fix: persist the link the instant the JN
    // job exists, so a closed browser tab can't strand the row. Only
    // patches rows where jn_job_id IS NULL (never clobbers an existing
    // link). Non-fatal — failure here just falls back to the browser
    // write + the daily orphan cron.
    let dbLinked = false;
    if (inspectionId && jobId) {
      const SB_URL = process.env.VITE_SUPABASE_URL;
      const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
      if (SB_URL && SB_KEY) {
        try {
          const patchRes = await fetch(
            `${SB_URL}/rest/v1/inspections?id=eq.${encodeURIComponent(inspectionId)}&jn_job_id=is.null`,
            {
              method: "PATCH",
              headers: {
                apikey: SB_KEY,
                Authorization: `Bearer ${SB_KEY}`,
                "Content-Type": "application/json",
                Prefer: "return=minimal",
              },
              body: JSON.stringify({ jn_job_id: jobId, docs_signed: "insp" }),
            },
          );
          dbLinked = patchRes.ok;
          if (!patchRes.ok) {
            console.warn("Server-side jn_job_id write-back failed:", patchRes.status, (await patchRes.text()).slice(0, 200));
          } else {
            console.log("Server-side jn_job_id write-back OK:", jobId, "→ inspection", inspectionId);
          }
        } catch (e) {
          console.warn("Server-side jn_job_id write-back threw:", e.message);
        }
      } else {
        console.warn("Supabase env missing — skipping server-side write-back");
      }
    }

    // ── Flip the matching Harvesting-Map pin to SOLD (server-side, reliable) ──
    // The intake's client-side flip can miss (tab closed, no map link, or an
    // off-map signing), leaving the door stuck at "needs inspection" so reps
    // re-knock a signed house. Match the signed address to its map pin and mark
    // it insp_sold here — every signed inspection flips its pin, no exceptions.
    try {
      const SBU = process.env.VITE_SUPABASE_URL, SBK = process.env.VITE_SUPABASE_ANON_KEY;
      const sk = pinStreetKey(address);
      if (SBU && SBK && sk) {
        const sbh = { apikey: SBK, Authorization: `Bearer ${SBK}`, "Content-Type": "application/json" };
        const houseNum = (String(address).trim().match(/^\d+/) || [""])[0];
        const firstWord = sk.split(" ")[1] || "";
        const z = String(zip || "").replace(/\D/g, "").slice(0, 5);
        const like = encodeURIComponent(`${houseNum}%${firstWord}%`);
        const pins = await fetch(`${SBU}/rest/v1/canvass_prospects?address=ilike.${like}&select=id,address,zip,status,status_log&limit=50`, { headers: sbh }).then((r) => (r.ok ? r.json() : [])).catch(() => []);
        const zipOk = (pz) => { const p = String(pz || "").replace(/\D/g, "").slice(0, 5); return !z || !p || p === z; };
        const hit = (pins || []).find((p) => pinStreetKey(p.address) === sk && zipOk(p.zip) && p.status !== "insp_sold");
        if (hit) {
          const nowIso = new Date().toISOString();
          const log = Array.isArray(hit.status_log) ? [...hit.status_log] : [];
          log.push({ at: nowIso, from: hit.status, to: "insp_sold", by: salesRepName || "rep", via: "signing sync" });
          await fetch(`${SBU}/rest/v1/canvass_prospects?id=eq.${hit.id}`, { method: "PATCH", headers: { ...sbh, Prefer: "return=minimal" }, body: JSON.stringify({ status: "insp_sold", status_updated_at: nowIso, status_by: salesRepName || null, jn_job_id: jobId, status_log: log }) });
          await fetch(`${SBU}/rest/v1/canvass_activity`, { method: "POST", headers: { ...sbh, Prefer: "return=minimal" }, body: JSON.stringify({ pin_id: hit.id, rep_name: salesRepName || null, kind: "status", from_status: hit.status, to_status: "insp_sold" }) }).catch(() => {});
          console.log("Harvest pin flipped to sold (server-side):", hit.id, hit.address);
        }
      }
    } catch (e) { console.warn("Harvest pin flip failed (non-fatal):", e.message); }

    console.log("=== JN Sync Complete ===");
    console.log("Contact:", contactId, contactAction, "| Job:", jobId, "| Status:", status, "| File:", fileResult, "| Agreement uploaded:", agreementUploaded, "| Linked existing:", linkedExisting, "| DB linked:", dbLinked);
    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        contactId, contactAction, jobId, status, fileResult, linkedExisting, dbLinked,
        // Explicit agreement outcome — the client and any catch-net can act
        // on these instead of assuming success:true means the doc landed.
        agreementExpected, agreementUploaded, agreementMissing, agreementFailed,
      }),
    };
  } catch (err) {
    console.error("=== JN Sync ERROR ===", err.message);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};