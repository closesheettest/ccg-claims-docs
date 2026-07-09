// netlify/functions/audit-duplicate-inspections.js
//
// READ-ONLY. Finds duplicate inspection records — the same homeowner/property
// entered more than once (each copy spawning its own JobNimbus job). Root cause
// example: 2565 SW 8th St signed as zip 33311 ("Elaine Santil") AND 33312
// ("Ilonor Comette") with the SAME phone — the address+zip dedup missed it.
//
// Clusters records that share a PHONE (last-10 digits) OR an ADDRESS (street
// line, zip-independent) via union-find, so a twin caught by either signal
// lands in one group. Reports every cluster with 2+ records.
//
//   GET /.netlify/functions/audit-duplicate-inspections
//        [?since_days=365]   how far back by signed_at (default 365; 0 = all time)
//   → { ok, scanned, clusters_total, live_dupes, clusters:[…] }
//
// live_dupe = a cluster with 2+ NON-cancelled records (a real duplicate still
// needing a merge). Clusters where all-but-one are cancelled are shown but not
// counted as live.
//
// Env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY.

const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const sb = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` };

exports.handler = async (event) => {
  if (!SB_URL || !SB_KEY) return json(500, { ok: false, error: "Missing env" });
  const qp = (event && event.queryStringParameters) || {};
  const sinceDays = qp.since_days != null ? Math.max(parseInt(qp.since_days, 10) || 0, 0) : 365;

  try {
    // 1. Pull all signed inspections (paginated).
    const sinceClause = sinceDays > 0
      ? `&signed_at=gte.${new Date(Date.now() - sinceDays * 864e5).toISOString()}`
      : "";
    const SEL = "id,client_name,mobile,address,city,zip,signed_at,result,jn_job_id,cancelled_at,pa_id";
    const rows = [];
    for (let from = 0; from < 40000; from += 1000) {
      const page = await sbGet(`inspections?select=${SEL}&signed_at=not.is.null${sinceClause}&order=signed_at.desc&limit=1000&offset=${from}`);
      rows.push(...page);
      if (page.length < 1000) break;
    }

    // 2. Union-find over phone + address keys.
    const parent = new Map();
    const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
    const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };
    for (const r of rows) parent.set(r.id, r.id);

    const firstByPhone = new Map(), firstByAddr = new Map();
    for (const r of rows) {
      const pk = phoneKey(r.mobile);
      if (pk) { if (firstByPhone.has(pk)) union(r.id, firstByPhone.get(pk)); else firstByPhone.set(pk, r.id); }
      const ak = addrKey(r.address);
      if (ak) { if (firstByAddr.has(ak)) union(r.id, firstByAddr.get(ak)); else firstByAddr.set(ak, r.id); }
    }

    // 3. Group by cluster root.
    const byRoot = new Map();
    for (const r of rows) { const root = find(r.id); (byRoot.get(root) || byRoot.set(root, []).get(root)).push(r); }

    const clusters = [];
    let live = 0;
    for (const recs of byRoot.values()) {
      if (recs.length < 2) continue;
      const active = recs.filter((r) => !r.cancelled_at);
      const jobs = new Set(recs.map((r) => r.jn_job_id).filter(Boolean));
      const phones = new Set(recs.map((r) => phoneKey(r.mobile)).filter(Boolean));
      const isLive = active.length >= 2;
      if (isLive) live++;
      recs.sort((a, b) => new Date(a.signed_at || 0) - new Date(b.signed_at || 0));
      clusters.push({
        live_dupe: isLive,
        records: recs.length,
        active_records: active.length,
        distinct_jn_jobs: jobs.size,
        shared_phone: phones.size === 1 && phones.values().next().value ? phones.values().next().value : null,
        rows: recs.map((r) => ({
          name: r.client_name, address: r.address, zip: r.zip,
          phone: r.mobile, signed: (r.signed_at || "").slice(0, 10),
          result: r.result || null, cancelled: !!r.cancelled_at, has_pa: !!r.pa_id,
          jn_url: r.jn_job_id ? `https://app.jobnimbus.com/job/${r.jn_job_id}` : null,
        })),
      });
    }
    // Live dupes first, then by size.
    clusters.sort((a, b) => (b.live_dupe - a.live_dupe) || (b.active_records - a.active_records) || (b.records - a.records));

    return json(200, { ok: true, scanned: rows.length, since_days: sinceDays, clusters_total: clusters.length, live_dupes: live, clusters });
  } catch (e) {
    return json(500, { ok: false, error: e.message || "error" });
  }
};

function phoneKey(m) {
  const d = String(m || "").replace(/\D/g, "");
  return d.length >= 10 ? d.slice(-10) : d.length >= 7 ? d.slice(-7) : null;
}
function addrKey(a) {
  const street = String(a || "").split(",")[0].toLowerCase().replace(/\s+/g, " ").trim();
  return /\d/.test(street) && street.length >= 4 ? street : null; // must start-ish with a number
}
async function sbGet(path) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: sb });
  if (!r.ok) return [];
  return r.json().catch(() => []);
}
function json(status, body) {
  return { statusCode: status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" }, body: JSON.stringify(body) };
}
