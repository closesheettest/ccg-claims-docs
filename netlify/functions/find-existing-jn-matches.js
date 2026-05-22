// netlify/functions/find-existing-jn-matches.js
//
// Search JobNimbus broadly for any existing contacts + jobs that
// might match a Supabase inspection record. Returns the results
// for the manager to review BEFORE we ever create a new JN job —
// the "fire and hope" Sync-to-JN flow kept silently duplicating
// records (Jerry Garner, Jimmie Mae Alexander) when JN's own
// duplicate-detection didn't fire.
//
// Strategy: hit JN's /contacts?search= endpoint multiple times
// with different queries (last name alone, street number alone,
// full name, last-name + street-num), de-dupe the results, then
// for each contact fetch their existing jobs at this address.
// Manager picks one to link to, or confirms "create new".
//
// POST body: { inspectionId }
//
// Response:
//   {
//     ok: true,
//     queries_tried: ["Alexander", "1650", ...],
//     contacts: [
//       {
//         contactId, contact_name, contact_address,
//         jobs: [{ jobId, job_name, job_address }]
//       }
//     ]
//   }
//
// Required env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, JOBNIMBUS_API_KEY.

const JN_BASE = "https://app.jobnimbus.com/api1";

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return json(405, { ok: false, error: "Method not allowed" });
  }
  const missing = [];
  for (const k of ["VITE_SUPABASE_URL", "VITE_SUPABASE_ANON_KEY", "JOBNIMBUS_API_KEY"]) {
    if (!process.env[k]) missing.push(k);
  }
  if (missing.length) return json(500, { ok: false, error: `Missing env: ${missing.join(", ")}` });

  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch {
    return json(400, { ok: false, error: "Invalid JSON body" });
  }
  const inspectionId = (body.inspectionId || "").trim();
  if (!inspectionId) return json(400, { ok: false, error: "inspectionId required" });

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
  const JN_KEY = process.env.JOBNIMBUS_API_KEY;
  const sbHeaders = {
    apikey: SB_KEY,
    Authorization: `Bearer ${SB_KEY}`,
  };
  const jnHeaders = {
    Authorization: `bearer ${JN_KEY}`,
    "Content-Type": "application/json",
  };

  // 1. Fetch the inspection's identity fields.
  const inspRes = await fetch(
    `${SB_URL}/rest/v1/inspections?id=eq.${encodeURIComponent(inspectionId)}&select=id,client_name,address,city,state,zip,mobile,email&limit=1`,
    { headers: sbHeaders },
  );
  if (!inspRes.ok) {
    return json(500, { ok: false, error: `Could not fetch inspection: ${await inspRes.text()}` });
  }
  const rows = await inspRes.json();
  const insp = rows?.[0];
  if (!insp) return json(404, { ok: false, error: "Inspection not found" });

  const clientName = (insp.client_name || "").trim();
  const address = (insp.address || "").trim();
  const streetNum = address.split(/\s+/)[0] || "";
  // Phone digits only. JN stores phones in mixed formats (e.g.
  // "(941) 326-9141", "941-326-9141", "9413269141") — searching by
  // bare digits matches any of them. The last 7 digits alone are
  // usually enough to disambiguate within an area code.
  const phoneDigits = (insp.mobile || "").replace(/\D/g, "");
  const phoneLast7 = phoneDigits.slice(-7);
  const email = (insp.email || "").trim().toLowerCase();

  // Split client_name. For "Jimmie Mae Alexander", store all alternatives
  // because JN may have the original as first="Jimmie" last="Alexander"
  // OR first="Jimmie Mae" last="Alexander" depending on who entered it.
  const nameParts = clientName.split(/\s+/).filter(Boolean);
  const firstName = nameParts[0] || "";
  const lastName = nameParts[nameParts.length - 1] || "";
  const middleAndLast = nameParts.slice(1).join(" ");

  // 2. Build query list and dedupe.
  //
  // Two query buckets — one for /contacts?search and one for /jobs?search.
  //
  // We hit BOTH endpoints because JN's API contacts-search is much
  // narrower than the UI's universal search. Contacts-search misses
  // homeowners whose address-only data would have surfaced them in the
  // UI, but the JOB name in JN typically embeds the address (e.g.
  // "Carol Jordan - 1738 23rd Street"), so /jobs?search=1738 finds them.
  //
  // Contact queries stay name-focused (address-only queries against
  // /contacts pull random noise). Job queries include the street
  // number alone because JN's UI clearly indexes job names by it.
  const contactQueries = Array.from(new Set([
    lastName,
    clientName,
    `${firstName} ${lastName}`.trim(),
    `${lastName} ${streetNum}`.trim(),
    // Phone digits — extremely high-signal. JN matches phones across
    // formats by digits, so this finds the homeowner even when name
    // search misses them.
    phoneLast7,
    phoneDigits,
    // Email is also high-signal. Most homeowners have a single email
    // attached to their JN contact.
    email,
  ].filter((q) => q && q.length >= 3)));
  const jobQueries = Array.from(new Set([
    clientName,
    `${firstName} ${lastName}`.trim(),
    `${lastName} ${streetNum}`.trim(),
    streetNum,
  ].filter((q) => q && q.length >= 3)));

  // Pre-compute the address tokens we'll use for relevance filtering
  // below: the street number, the rest of the street as a single
  // lowercased token (e.g. "23rd street"), the zip, and the city.
  const streetRest = address.replace(streetNum, "").trim().toLowerCase();
  const zipNorm = (insp.zip || "").trim().slice(0, 5);
  const cityNorm = (insp.city || "").trim().toLowerCase();
  const lastNameNorm = lastName.toLowerCase();
  const firstNameNorm = firstName.toLowerCase();

  // 3a-precise. Hit /contacts with an Elasticsearch-style `filter`
  //   parameter for EXACT field matches first. JN's bare ?search= is
  //   inconsistent (it missed Carol Jordan even when searching by
  //   her full name + phone + email). The filter param uses JN's
  //   indexed fields directly so an exact email/phone match wins
  //   reliably.
  //
  //   We build a list of single-clause filters and OR them by firing
  //   each as its own request (the API doesn't reliably support `should`
  //   at the top level, so this is the safe shape).
  const filterClauses = [];
  if (email) filterClauses.push({ term: { email } });
  if (phoneDigits && phoneDigits.length >= 7) {
    // JN stores phones with formatting; the indexed value is digits
    // only. Try mobile_phone first, then home_phone as backup.
    filterClauses.push({ term: { mobile_phone: phoneDigits } });
    filterClauses.push({ term: { home_phone: phoneDigits } });
  }
  if (streetNum && address) {
    filterClauses.push({ term: { address_line1: address } });
  }
  if (zipNorm && lastNameNorm) {
    filterClauses.push({
      must: [{ term: { zip: zipNorm } }, { match: { last_name: lastName } }],
    });
  }

  const filterResults = await Promise.all(filterClauses.map(async (clause) => {
    try {
      // Top-level wrapper: bare clauses get wrapped in `must`, clauses
      // that already include `must` are passed through.
      const filterJson = clause.must ? clause : { must: [clause] };
      const url = `${JN_BASE}/contacts?filter=${encodeURIComponent(JSON.stringify(filterJson))}&size=20`;
      const r = await fetch(url, { headers: jnHeaders });
      if (!r.ok) return [];
      const data = await r.json().catch(() => ({}));
      return data.results || data.contacts || data.items || [];
    } catch {
      return [];
    }
  }));

  // 3a. Fire fuzzy CONTACT searches in parallel — backstop for cases
  //     where the precise filter clauses miss (legacy data, formatting
  //     differences).
  const contactSearchResults = await Promise.all(contactQueries.map(async (q) => {
    try {
      const r = await fetch(`${JN_BASE}/contacts?search=${encodeURIComponent(q)}&size=20`, {
        headers: jnHeaders,
      });
      if (!r.ok) return [];
      const data = await r.json().catch(() => ({}));
      return data.results || data.contacts || data.items || [];
    } catch {
      return [];
    }
  }));

  // 3b. Fire JOB searches in parallel. Each hit gets its
  //     primary_contact_id resolved into the contact bucket.
  //
  //     We hit JOBS with both ?search= (fuzzy) AND ?filter= (exact
  //     address_line1 + zip), since job names usually embed the
  //     full address and filter-by-address is reliable.
  const jobFilterClauses = [];
  if (address) jobFilterClauses.push({ term: { address_line1: address } });
  if (zipNorm && streetNum) {
    jobFilterClauses.push({
      must: [{ term: { zip: zipNorm } }, { match: { address_line1: streetNum } }],
    });
  }
  const jobFilterResults = await Promise.all(jobFilterClauses.map(async (clause) => {
    try {
      const filterJson = clause.must ? clause : { must: [clause] };
      const url = `${JN_BASE}/jobs?filter=${encodeURIComponent(JSON.stringify(filterJson))}&size=20`;
      const r = await fetch(url, { headers: jnHeaders });
      if (!r.ok) return [];
      const data = await r.json().catch(() => ({}));
      return data.results || data.jobs || data.items || [];
    } catch {
      return [];
    }
  }));
  const jobFuzzyResults = await Promise.all(jobQueries.map(async (q) => {
    try {
      const r = await fetch(`${JN_BASE}/jobs?search=${encodeURIComponent(q)}&size=20`, {
        headers: jnHeaders,
      });
      if (!r.ok) return [];
      const data = await r.json().catch(() => ({}));
      return data.results || data.jobs || data.items || [];
    } catch {
      return [];
    }
  }));
  const jobSearchResults = [...jobFilterResults, ...jobFuzzyResults];

  // 4a. De-dupe CONTACTS by jnid/id. Precise-filter results come
  //     FIRST so they take priority over the fuzzy-search backstop.
  const byId = new Map();
  for (const list of filterResults) {
    for (const c of list) {
      const id = c.jnid || c.id;
      if (!id) continue;
      if (!byId.has(id)) byId.set(id, c);
    }
  }
  for (const list of contactSearchResults) {
    for (const c of list) {
      const id = c.jnid || c.id;
      if (!id) continue;
      if (!byId.has(id)) byId.set(id, c);
    }
  }

  // 4b. Stash matched jobs by their parent contact id so step 5
  //     can include them without an extra /jobs?related call.
  //     Resolves the contact via primary_contact_id and seeds the
  //     contact into byId if not already there (fetched lazily).
  const jobsByContactId = new Map();
  const jobOnlyContactIds = new Set();
  for (const list of jobSearchResults) {
    for (const j of list) {
      const primary = j.primary || j.primary_contact || {};
      const contactId = primary.id || j.primary_contact_id || j.contact_id;
      if (!contactId) continue;
      if (!jobsByContactId.has(contactId)) jobsByContactId.set(contactId, []);
      jobsByContactId.get(contactId).push(j);
      if (!byId.has(contactId)) jobOnlyContactIds.add(contactId);
    }
  }

  // 4c. For contacts surfaced only via job-search, fetch their
  //     contact record so we have name/address fields to display.
  await Promise.all(Array.from(jobOnlyContactIds).map(async (id) => {
    try {
      const r = await fetch(`${JN_BASE}/contacts/${encodeURIComponent(id)}`, {
        headers: jnHeaders,
      });
      if (!r.ok) return;
      const c = await r.json().catch(() => null);
      if (c && (c.jnid || c.id)) byId.set(c.jnid || c.id, c);
    } catch {}
  }));

  // 5. For each contact, fetch their jobs and merge in any jobs we
  //    already picked up from the /jobs?search calls in step 3b
  //    (those are guaranteed to be the address-matching ones we want
  //    surfaced, so don't lose them if /jobs?related returns a
  //    truncated set).
  const mapJob = (j) => ({
    jobId: j.jnid || j.id,
    job_name: j.name || j.display_name || "(no name)",
    job_address: [j.address_line1, j.city, j.state_text, j.zip].filter(Boolean).join(", "),
    status_name: j.status_name || null,
    record_type_name: j.record_type_name || null,
  });
  const contactsOut = await Promise.all(Array.from(byId.entries()).map(async ([id, c]) => {
    let related = [];
    try {
      const r = await fetch(`${JN_BASE}/jobs?related=${encodeURIComponent(id)}&size=30`, {
        headers: jnHeaders,
      });
      if (r.ok) {
        const data = await r.json().catch(() => ({}));
        const list = data.results || data.jobs || data.items || [];
        related = list.map(mapJob);
      }
    } catch {}
    const fromSearch = (jobsByContactId.get(id) || []).map(mapJob);
    // Merge by jobId, preferring related results (they're the
    // authoritative set per contact). Add search-only jobs after.
    const seen = new Set(related.map((j) => j.jobId));
    const jobs = [...related, ...fromSearch.filter((j) => !seen.has(j.jobId))];
    // Phone digits (combined across all JN phone fields) and email,
    // used by the relevance filter as high-signal match criteria.
    const phoneFields = [c.mobile_phone, c.home_phone, c.work_phone, c.phone].filter(Boolean);
    const contactPhoneDigits = phoneFields.map((p) => String(p).replace(/\D/g, "")).join(" ");
    return {
      contactId: id,
      contact_name: c.display_name || `${c.first_name || ""} ${c.last_name || ""}`.trim() || "(no name)",
      contact_first: c.first_name || "",
      contact_last: c.last_name || "",
      contact_address: [c.address_line1, c.city, c.state_text, c.zip].filter(Boolean).join(", "),
      contact_zip: c.zip || "",
      contact_phone_digits: contactPhoneDigits,
      contact_email: (c.email || "").toLowerCase(),
      jobs,
    };
  }));

  // 6. Filter to RELEVANT matches. Without this, JN was returning 20
  //    contacts where the only thing in common was a phone digit or
  //    zip fragment — useless noise the manager had to scroll past.
  //
  //    A contact is considered relevant if it has any one of:
  //      • Last name match (contact_name or any job_name contains our last name)
  //      • First name match (contact_name contains our first name AND another signal)
  //      • Street number + street name both in contact_address or a job_address
  //      • Zip match AND (city match OR last-name partial)
  //
  //    Anything that misses all of these gets dropped.
  const isRelevant = (c) => {
    const cname = (c.contact_name || "").toLowerCase();
    const caddr = (c.contact_address || "").toLowerCase();
    const czip = (c.contact_zip || "").trim().slice(0, 5);
    const cphone = c.contact_phone_digits || "";
    const cemail = c.contact_email || "";
    const allAddrs = [caddr, ...c.jobs.map((j) => (j.job_address || "").toLowerCase())].join(" | ");
    const allNames = [cname, ...c.jobs.map((j) => (j.job_name || "").toLowerCase())].join(" | ");

    // Strong: phone match (last 7 digits). High-signal — almost
    // impossible to share with another homeowner by accident.
    if (phoneLast7 && phoneLast7.length === 7 && cphone.includes(phoneLast7)) return true;

    // Strong: exact email match.
    if (email && cemail && email === cemail) return true;

    // Strong: last name appears in any name field.
    if (lastNameNorm && lastNameNorm.length >= 3 && allNames.includes(lastNameNorm)) return true;

    // Strong: street number + meaningful street word both appear in
    // some address. Guards against a bare "1738" matching unrelated
    // phone/zip digits.
    if (streetNum && streetRest) {
      const streetWord = streetRest.split(/\s+/).find((w) => w.length >= 3) || "";
      if (streetWord && allAddrs.includes(streetNum) && allAddrs.includes(streetWord)) return true;
    }

    // Medium: zip matches AND (city in address OR first name in any name).
    if (zipNorm && czip && zipNorm === czip) {
      if (cityNorm && allAddrs.includes(cityNorm)) return true;
      if (firstNameNorm && firstNameNorm.length >= 3 && allNames.includes(firstNameNorm)) return true;
    }

    return false;
  };
  const relevant = contactsOut.filter(isRelevant);

  // 7. Sort: contacts whose contact address contains our street number first,
  //    then by number of jobs (more jobs = more likely to be real).
  relevant.sort((a, b) => {
    const aHit = streetNum && a.contact_address.toLowerCase().includes(streetNum.toLowerCase()) ? 1 : 0;
    const bHit = streetNum && b.contact_address.toLowerCase().includes(streetNum.toLowerCase()) ? 1 : 0;
    if (aHit !== bHit) return bHit - aHit;
    return b.jobs.length - a.jobs.length;
  });

  return json(200, {
    ok: true,
    inspection_id: inspectionId,
    inspection: {
      client_name: clientName,
      address,
      city: insp.city,
      zip: insp.zip,
    },
    // Single flat list for the UI label — both contact and job
    // queries fed into the candidate set.
    queries_tried: Array.from(new Set([...contactQueries, ...jobQueries])),
    contact_queries: contactQueries,
    job_queries: jobQueries,
    total_contacts_found: contactsOut.length,
    filtered_out: contactsOut.length - relevant.length,
    contacts: relevant,
  });
};

function json(status, body) {
  return {
    statusCode: status,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}
