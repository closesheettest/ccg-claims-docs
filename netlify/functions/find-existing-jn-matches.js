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
    `${SB_URL}/rest/v1/inspections?id=eq.${encodeURIComponent(inspectionId)}&select=id,client_name,address,city,state,zip&limit=1`,
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

  // Split client_name. For "Jimmie Mae Alexander", store all alternatives
  // because JN may have the original as first="Jimmie" last="Alexander"
  // OR first="Jimmie Mae" last="Alexander" depending on who entered it.
  const nameParts = clientName.split(/\s+/).filter(Boolean);
  const firstName = nameParts[0] || "";
  const lastName = nameParts[nameParts.length - 1] || "";
  const middleAndLast = nameParts.slice(1).join(" ");

  // 2. Build query list and dedupe.
  //
  // We dropped the bare streetNum query — JN's /contacts?search=1738
  // matched 1738 anywhere in any field (phone, zip, address) and was
  // pulling 20+ unrelated contacts. The combined `lastName streetNum`
  // and `clientName` queries are far more discriminating.
  const queries = Array.from(new Set([
    lastName,
    clientName,
    `${firstName} ${lastName}`.trim(),
    `${lastName} ${streetNum}`.trim(),
  ].filter((q) => q && q.length >= 3)));

  // Pre-compute the address tokens we'll use for relevance filtering
  // below: the street number, the rest of the street as a single
  // lowercased token (e.g. "23rd street"), the zip, and the city.
  const streetRest = address.replace(streetNum, "").trim().toLowerCase();
  const zipNorm = (insp.zip || "").trim().slice(0, 5);
  const cityNorm = (insp.city || "").trim().toLowerCase();
  const lastNameNorm = lastName.toLowerCase();
  const firstNameNorm = firstName.toLowerCase();

  // 3. Fire all searches in parallel.
  const searchResults = await Promise.all(queries.map(async (q) => {
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

  // 4. De-dupe contacts by jnid/id.
  const byId = new Map();
  for (const list of searchResults) {
    for (const c of list) {
      const id = c.jnid || c.id;
      if (!id) continue;
      if (!byId.has(id)) byId.set(id, c);
    }
  }

  // 5. For each contact, fetch their jobs.
  const contactsOut = await Promise.all(Array.from(byId.entries()).map(async ([id, c]) => {
    let jobs = [];
    try {
      const r = await fetch(`${JN_BASE}/jobs?related=${encodeURIComponent(id)}&size=30`, {
        headers: jnHeaders,
      });
      if (r.ok) {
        const data = await r.json().catch(() => ({}));
        const list = data.results || data.jobs || data.items || [];
        jobs = list.map((j) => ({
          jobId: j.jnid || j.id,
          job_name: j.name || j.display_name || "(no name)",
          job_address: [j.address_line1, j.city, j.state_text, j.zip].filter(Boolean).join(", "),
          status_name: j.status_name || null,
          record_type_name: j.record_type_name || null,
        }));
      }
    } catch {}
    return {
      contactId: id,
      contact_name: c.display_name || `${c.first_name || ""} ${c.last_name || ""}`.trim() || "(no name)",
      contact_first: c.first_name || "",
      contact_last: c.last_name || "",
      contact_address: [c.address_line1, c.city, c.state_text, c.zip].filter(Boolean).join(", "),
      contact_zip: c.zip || "",
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
    const allAddrs = [caddr, ...c.jobs.map((j) => (j.job_address || "").toLowerCase())].join(" | ");
    const allNames = [cname, ...c.jobs.map((j) => (j.job_name || "").toLowerCase())].join(" | ");

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
    queries_tried: queries,
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
