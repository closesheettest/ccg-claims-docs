// netlify/functions/retry-jn-sync.js
//
// Admin endpoint to retry JobNimbus sync for an inspection that never got
// a jn_job_id (orphan). Called from App.jsx's "Sync to JN" admin button.
//
// Why: JN sync is fire-and-forget async during homeowner signing. If the
// JN API fails (timeout, rate limit, brief outage), the sync silently fails
// and the homeowner becomes an orphan in our DB. This endpoint lets admins
// manually retry the sync for individual orphans.
//
// USAGE:
//   POST /.netlify/functions/retry-jn-sync
//   Body: { inspectionId: "<supabase id>" }
//
// Returns: { ok: true, jobId: "xxx" } or { error: "..." }

const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;

const sbHeaders = {
  apikey: SB_KEY,
  Authorization: `Bearer ${SB_KEY}`,
  "Content-Type": "application/json",
};

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  let inspectionId;
  try {
    const body = JSON.parse(event.body || "{}");
    inspectionId = body.inspectionId;
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: "Invalid JSON body" }) };
  }
  if (!inspectionId) {
    return { statusCode: 400, body: JSON.stringify({ error: "inspectionId is required" }) };
  }

  console.log("=== retry-jn-sync START for:", inspectionId);

  // 1. Fetch the inspection record
  const sbRes = await fetch(
    `${SB_URL}/rest/v1/inspections?id=eq.${inspectionId}&select=*&limit=1`,
    { headers: sbHeaders }
  );
  if (!sbRes.ok) {
    return { statusCode: 500, body: JSON.stringify({ error: "Could not fetch inspection" }) };
  }
  const rows = await sbRes.json();
  const rec = rows?.[0];
  if (!rec) {
    return { statusCode: 404, body: JSON.stringify({ error: "Inspection not found" }) };
  }
  if (rec.jn_job_id) {
    return { statusCode: 400, body: JSON.stringify({ error: `Already synced to JN (job id: ${rec.jn_job_id})` }) };
  }

  // 2. Also look up matching claim — if they signed all 3 docs, we want JN to know
  const addr = (rec.address || "").trim();
  const zip = (rec.zip || "").trim();
  let docsSigned = rec.docs_signed || "insp";
  try {
    if (addr && zip) {
      const qs = new URLSearchParams({
        select: "docs_signed",
        address: `ilike.${addr}`,
        zip: `eq.${zip}`,
        order: "signed_at.desc",
        limit: "1",
      }).toString();
      const claimRes = await fetch(`${SB_URL}/rest/v1/claims?${qs}`, { headers: sbHeaders });
      if (claimRes.ok) {
        const claimRows = await claimRes.json();
        if (claimRows?.[0]?.docs_signed) {
          docsSigned = claimRows[0].docs_signed;
        }
      }
    }
  } catch (e) { console.warn("Claim lookup failed:", e.message); }
  const docsSignedList = docsSigned.split(",").map(s => s.trim()).filter(Boolean);

  // 3. Call the existing jobnimbus-sync function with the same payload shape
  //    that the live signing flow uses.
  const base = process.env.URL || process.env.BASE_URL || "";
  const syncUrl = `${base}/.netlify/functions/jobnimbus-sync`;
  console.log("Calling:", syncUrl);

  const payload = {
    leadSource: rec.lead_source || "Inspection",
    docsSignedList,
    homeowner1: rec.client_name || "",
    homeowner2: "",
    phone: rec.mobile || "",
    email: rec.email || "",
    address: rec.address || "",
    city: rec.city || "",
    state: rec.state || "",
    zip: rec.zip || "",
    salesRepName: rec.sales_rep_name || "",
    salesRepId: rec.sales_rep_id || "",
    // No PDF — we don't have it stored. JN job gets created without attachment.
    // If the user wants the PDF attached, they can regenerate and attach manually.
  };

  let jnResult;
  try {
    const r = await fetch(syncUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    jnResult = await r.json().catch(() => ({}));
    console.log("JN sync result:", r.status, jnResult);
    if (!r.ok) {
      return { statusCode: 500, body: JSON.stringify({ error: "JN sync failed", detail: jnResult }) };
    }
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: "JN sync error", detail: e.message }) };
  }

  if (!jnResult.jobId) {
    return { statusCode: 500, body: JSON.stringify({ error: "JN sync returned no jobId", detail: jnResult }) };
  }

  // 4. Save the new jn_job_id + docs_signed back to our inspection record
  const updateRes = await fetch(
    `${SB_URL}/rest/v1/inspections?id=eq.${inspectionId}`,
    {
      method: "PATCH",
      headers: { ...sbHeaders, Prefer: "return=representation" },
      body: JSON.stringify({ jn_job_id: jnResult.jobId, docs_signed: docsSigned }),
    }
  );
  if (!updateRes.ok) {
    return { statusCode: 500, body: JSON.stringify({ error: "Could not save jn_job_id", detail: await updateRes.text() }) };
  }

  return {
    statusCode: 200,
    body: JSON.stringify({ ok: true, jobId: jnResult.jobId, docsSigned }),
  };
};