// netlify/functions/jn-search-probe.js
//
// READ-ONLY one-off diagnostic. Hits JN's /jobs?search=<term> for a
// hardcoded query, plus a direct GET /jobs/<id> for a known job id,
// and returns the raw response shapes so we can stop guessing about
// JN's search behavior. The find-orphan-signings function's per-name
// JN search is silently false-negativing on records we know exist
// (e.g. Anik clemens, mph7nb8tcpc9y0epb070z0b).
//
// USAGE:
//   GET /.netlify/functions/jn-search-probe
//
// Required env: JOBNIMBUS_API_KEY

const JN_BASE = "https://app.jobnimbus.com/api1";

exports.handler = async (event) => {
  const JN_KEY = process.env.JOBNIMBUS_API_KEY;
  if (!JN_KEY) return json(500, { ok: false, error: "JOBNIMBUS_API_KEY not set" });
  const jnHeaders = {
    Authorization: `bearer ${JN_KEY}`,
    "Content-Type": "application/json",
  };

  // Anik clemens — known orphan, known JN id from the user's CSV.
  const knownJobId = "mph7nb8tcpc9y0epb070z0b";
  const searchTerm = "clemens";

  const out = {
    ok: true,
    knownJobId,
    searchTerm,
    direct_get: null,
    search_50: null,
    search_with_sort_date_start: null,
    search_with_sort_date_updated: null,
    page_2: null,
  };

  // 1. Direct GET — does the job actually exist?
  try {
    const r = await fetch(`${JN_BASE}/jobs/${knownJobId}`, { headers: jnHeaders });
    out.direct_get = {
      status: r.status,
      body: r.ok ? await r.json().catch(() => null) : (await r.text()).slice(0, 400),
    };
  } catch (e) {
    out.direct_get = { error: e.message };
  }

  // 2. Bare /jobs?search=<term>&size=50 — default sort, no filter.
  try {
    const r = await fetch(`${JN_BASE}/jobs?search=${encodeURIComponent(searchTerm)}&size=50`, { headers: jnHeaders });
    const body = r.ok ? await r.json().catch(() => ({})) : null;
    const list = body?.results || body?.jobs || body?.items || [];
    out.search_50 = {
      status: r.status,
      count_returned: list.length,
      contains_known_id: list.some((j) => (j.jnid || j.id) === knownJobId),
      first_5_names: list.slice(0, 5).map((j) => j.name),
      names_containing_term: list.filter((j) => (j.name || "").toLowerCase().includes(searchTerm)).map((j) => ({
        jnid: j.jnid || j.id,
        name: j.name,
        date_start: j.date_start,
      })),
    };
  } catch (e) {
    out.search_50 = { error: e.message };
  }

  // 3. With sort=-date_start.
  try {
    const r = await fetch(`${JN_BASE}/jobs?search=${encodeURIComponent(searchTerm)}&size=50&sort=-date_start`, { headers: jnHeaders });
    const body = r.ok ? await r.json().catch(() => ({})) : null;
    const list = body?.results || body?.jobs || body?.items || [];
    out.search_with_sort_date_start = {
      status: r.status,
      count_returned: list.length,
      contains_known_id: list.some((j) => (j.jnid || j.id) === knownJobId),
      names_containing_term: list.filter((j) => (j.name || "").toLowerCase().includes(searchTerm)).map((j) => ({
        jnid: j.jnid || j.id,
        name: j.name,
        date_start: j.date_start,
      })),
    };
  } catch (e) {
    out.search_with_sort_date_start = { error: e.message };
  }

  // 4. With sort=-date_updated.
  try {
    const r = await fetch(`${JN_BASE}/jobs?search=${encodeURIComponent(searchTerm)}&size=50&sort=-date_updated`, { headers: jnHeaders });
    const body = r.ok ? await r.json().catch(() => ({})) : null;
    const list = body?.results || body?.jobs || body?.items || [];
    out.search_with_sort_date_updated = {
      status: r.status,
      count_returned: list.length,
      contains_known_id: list.some((j) => (j.jnid || j.id) === knownJobId),
      names_containing_term: list.filter((j) => (j.name || "").toLowerCase().includes(searchTerm)).map((j) => ({
        jnid: j.jnid || j.id,
        name: j.name,
        date_start: j.date_start,
      })),
    };
  } catch (e) {
    out.search_with_sort_date_updated = { error: e.message };
  }

  // 5. Page 2 of the bare search to see if pagination expands results.
  try {
    const r = await fetch(`${JN_BASE}/jobs?search=${encodeURIComponent(searchTerm)}&size=50&from=50`, { headers: jnHeaders });
    const body = r.ok ? await r.json().catch(() => ({})) : null;
    const list = body?.results || body?.jobs || body?.items || [];
    out.page_2 = {
      status: r.status,
      count_returned: list.length,
      contains_known_id: list.some((j) => (j.jnid || j.id) === knownJobId),
      names_containing_term: list.filter((j) => (j.name || "").toLowerCase().includes(searchTerm)).map((j) => ({
        jnid: j.jnid || j.id,
        name: j.name,
        date_start: j.date_start,
      })),
    };
  } catch (e) {
    out.page_2 = { error: e.message };
  }

  return json(200, out);
};

function json(status, body) {
  return {
    statusCode: status,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}
