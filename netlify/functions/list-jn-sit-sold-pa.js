// netlify/functions/list-jn-sit-sold-pa.js
//
// Queries JobNimbus LIVE for every job currently at status_name
// "Sit Sold PA" — the records still on the OLD PA's plate. Our
// local jn_status column doesn't reliably mirror JN's status (the
// sync only writes it when setting "Lost"), so we have to ask JN
// itself.
//
// Returns a flat list of jobs with the fields the Sit Sold PA
// report needs to render. Cross-references our inspections table
// to enrich with sales_rep_name, mobile, email, signed_at, and
// our internal inspection.id (so deep-link to the row works).
//
// POST or GET — no body. JN paginates at size=50 by default; we
// fetch all pages until we get fewer than `size` results back.
//
// Required env: JOBNIMBUS_API_KEY, VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY.

const JN_BASE = "https://app.jobnimbus.com/api1";
const PAGE_SIZE = 100;
const MAX_PAGES = 20; // 2000 jobs cap — safety against runaway loop

exports.handler = async (event) => {
  const missing = [];
  for (const k of ["JOBNIMBUS_API_KEY", "VITE_SUPABASE_URL", "VITE_SUPABASE_ANON_KEY"]) {
    if (!process.env[k]) missing.push(k);
  }
  if (missing.length) return json(500, { ok: false, error: `Missing env: ${missing.join(", ")}` });

  const JN_KEY = process.env.JOBNIMBUS_API_KEY;
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;

  const jnHeaders = { Authorization: `bearer ${JN_KEY}`, "Content-Type": "application/json" };
  const sbHeaders = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` };

  // 1. Pull all "Sit Sold PA" jobs from JN. Filter by exact status_name.
  const filter = JSON.stringify({ must: [{ term: { status_name: "Sit Sold PA" } }] });
  const jobs = [];
  let from = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = `${JN_BASE}/jobs?filter=${encodeURIComponent(filter)}&size=${PAGE_SIZE}&from=${from}`;
    let res;
    try {
      res = await fetch(url, { headers: jnHeaders });
    } catch (e) {
      return json(502, { ok: false, error: `JN fetch failed: ${e.message}`, pages_fetched: page });
    }
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      return json(res.status, {
        ok: false,
        error: `JN ${res.status} on page ${page}`,
        detail: txt.slice(0, 300),
        pages_fetched: page,
      });
    }
    const data = await res.json().catch(() => ({}));
    const pageJobs = data.results || data.jobs || data.items || [];
    jobs.push(...pageJobs);
    if (pageJobs.length < PAGE_SIZE) break; // last page
    from += PAGE_SIZE;
  }

  // 2. For each job, pull useful display fields.
  const slimJobs = jobs.map((j) => ({
    jnid: j.jnid || j.id,
    job_number: j.number || j.job_number || null,
    job_name: j.name || j.display_name || "(no name)",
    address_line1: j.address_line1 || "",
    city: j.city || "",
    state: j.state_text || "",
    zip: j.zip || "",
    cf_string_34: j.cf_string_34 || "",            // damage/no_damage/retail
    sales_rep_name: j.sales_rep_name || "",
    date_created: j.date_created || null,           // unix seconds
    date_status_change: j.date_status_change || null,
    primary_contact_id: j.primary?.id || null,
    primary_contact_name: j.primary?.name || "",
  }));

  // 3. Enrich with our local inspection row when one exists. Skip if
  //    no jobs (empty IN clause errors out on PostgREST).
  const jnIds = slimJobs.map((j) => j.jnid).filter(Boolean);
  let enrichmentByJnId = {};
  if (jnIds.length) {
    // PostgREST `in.(...)` filter — chunk to avoid URL length limits.
    const chunks = [];
    for (let i = 0; i < jnIds.length; i += 100) chunks.push(jnIds.slice(i, i + 100));
    for (const chunk of chunks) {
      const inList = chunk.map((id) => `"${id}"`).join(",");
      try {
        const r = await fetch(
          `${SB_URL}/rest/v1/inspections?select=id,client_name,mobile,email,signed_at,sales_rep_name,result,jn_job_id&jn_job_id=in.(${encodeURIComponent(inList)})`,
          { headers: sbHeaders },
        );
        if (r.ok) {
          const rows = await r.json().catch(() => []);
          for (const row of rows) {
            if (row.jn_job_id) enrichmentByJnId[row.jn_job_id] = row;
          }
        }
      } catch {}
    }
  }

  const rows = slimJobs.map((j) => {
    const e = enrichmentByJnId[j.jnid] || {};
    return {
      jn_job_id: j.jnid,
      job_number: j.job_number,
      job_name: j.job_name,
      client_name: e.client_name || j.primary_contact_name || "",
      address: j.address_line1,
      city: j.city,
      state: j.state,
      zip: j.zip,
      mobile: e.mobile || "",
      email: e.email || "",
      sales_rep_name: e.sales_rep_name || j.sales_rep_name || "",
      result: e.result || (j.cf_string_34 || "").toLowerCase().replace(" ", "_"),
      signed_at: e.signed_at || (j.date_created ? new Date(j.date_created * 1000).toISOString() : null),
      date_status_change: j.date_status_change ? new Date(j.date_status_change * 1000).toISOString() : null,
      inspection_id: e.id || null,
      in_local_db: !!e.id,
    };
  });

  // Sort by signed_at desc (or date_status_change desc as fallback).
  rows.sort((a, b) => {
    const aT = new Date(a.signed_at || a.date_status_change || 0).getTime();
    const bT = new Date(b.signed_at || b.date_status_change || 0).getTime();
    return bT - aT;
  });

  return json(200, {
    ok: true,
    count: rows.length,
    pages_fetched: Math.min(MAX_PAGES, Math.ceil(jobs.length / PAGE_SIZE)),
    rows,
  });
};

function json(status, body) {
  return {
    statusCode: status,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}
