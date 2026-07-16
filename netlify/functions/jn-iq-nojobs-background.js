// netlify/functions/jn-iq-nojobs-background.js
//
// Audit (background — up to 15 min): how many JobNimbus CONTACTS whose lead
// source is "Instant Quote" have NO job attached.
//
// JobNimbus is Elasticsearch-backed and caps pagination at 10,000 rows, and both
// the IQ contacts (~13.7k) and jobs (~10.2k) exceed that — so we can't just page
// through. Instead we recursively split the date_created window until each slice
// is under the cap, then drain it fully. That gets EVERY row.
//
//   1. Build the set of contact ids that own at least one job (job.primary.id +
//      related contact ids), sharded by date.
//   2. Walk every Instant-Quote contact (sharded by date); count the ones whose
//      id isn't in that set.
// Writes the result to app_settings key "jn_iq_nojobs".
//
//   Trigger: GET/POST /.netlify/functions/jn-iq-nojobs-background → 202
//   Read:    supabase app_settings?key=eq.jn_iq_nojobs
//
// Env: JOBNIMBUS_API_KEY, VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY

const JN_BASE = "https://app.jobnimbus.com/api1";
const JN_KEY = process.env.JOBNIMBUS_API_KEY;
const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const RESULT_KEY = "jn_iq_nojobs";
const SOURCE = "Instant Quote";
const CAP = 9500;                 // split any date window with more rows than this
const START = 1451606400;         // 2016-01-01 — before any JN data

exports.handler = async (event) => {
  const started = new Date().toISOString();
  const H = { Authorization: `bearer ${JN_KEY}`, "Content-Type": "application/json" };
  const NOW = Math.floor(Date.now() / 1000);
  // Optional ?before=YYYY-MM-DD → only count IQ contacts CREATED on/before that
  // date (end of that day, ET). Jobs are still scanned in full, so a contact from
  // April that got a job in June still counts as "has a job".
  const qp = (event && event.queryStringParameters) || {};
  const beforeSec = qp.before ? Math.floor(Date.parse(`${qp.before}T23:59:59-04:00`) / 1000) : NOW;
  try {
    // 1) Every contact id that owns at least one job.
    const withJob = new Set();
    let jobsSeen = 0;
    await sharded(`${JN_BASE}/jobs`, H, [], NOW, (job) => {
      jobsSeen++;
      if (job.primary && job.primary.id) withJob.add(job.primary.id);
      for (const r of job.related || []) if (r && r.id && (r.type === "contact" || !r.type)) withJob.add(r.id);
    });

    // 2) Every Instant-Quote contact → no-job count.
    let total = 0, noJob = 0;
    const sample = [];
    await sharded(`${JN_BASE}/contacts`, H, [{ match_phrase: { source_name: SOURCE } }], beforeSec, (c) => {
      total++;
      if (!withJob.has(c.jnid || c.id)) {
        noJob++;
        if (sample.length < 15) sample.push({
          name: c.display_name || `${c.first_name || ""} ${c.last_name || ""}`.trim(),
          address: [c.address_line1, c.city, c.state_text, c.zip].filter(Boolean).join(", "),
          created: c.date_created ? new Date(Number(c.date_created) * 1000).toISOString().slice(0, 10) : null,
        });
      }
    });

    await writeSetting(RESULT_KEY, {
      ok: true, source: SOURCE,
      created_on_or_before: qp.before || null,
      iq_contacts_total: total,
      iq_contacts_with_job: total - noJob,
      iq_contacts_no_job: noJob,
      jobs_scanned: jobsSeen, contacts_with_any_job: withJob.size,
      sample, started, finished: new Date().toISOString(),
    });
  } catch (e) {
    await writeSetting(RESULT_KEY, { ok: false, error: String(e && e.message || e), started, finished: new Date().toISOString() });
  }
  return { statusCode: 202, body: "" };
};

// Recursively split [gte,lte] on date_created until a window is under the cap,
// then page through it fully. `must` are extra filter clauses (e.g. the source).
async function sharded(base, headers, must, now, onRow) {
  const filterFor = (gte, lte) => encodeURIComponent(JSON.stringify({ must: [...must, { range: { date_created: { gte, lte } } }] }));
  const countOf = async (gte, lte) => {
    const r = await fetch(`${base}?size=1&filter=${filterFor(gte, lte)}`, { headers });
    const d = await r.json().catch(() => ({}));
    return Number(d.count || 0);
  };
  const drain = async (gte, lte) => {
    for (let page = 0; page < 100; page++) {
      const r = await fetch(`${base}?size=100&from=${page * 100}&filter=${filterFor(gte, lte)}`, { headers });
      if (!r.ok) break;
      const d = await r.json().catch(() => ({}));
      const rows = d.results || d.contacts || d.jobs || [];
      if (!rows.length) break;
      rows.forEach(onRow);
      if (rows.length < 100) break;
    }
  };
  const rec = async (gte, lte) => {
    const c = await countOf(gte, lte);
    if (!c) return;
    if (c <= CAP || (lte - gte) <= 86400) { await drain(gte, lte); return; }
    const mid = Math.floor((gte + lte) / 2);
    await rec(gte, mid);
    await rec(mid + 1, lte);
  };
  await rec(START, now);
}

async function writeSetting(key, obj) {
  const H = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" };
  try {
    await fetch(`${SB_URL}/rest/v1/app_settings?on_conflict=key`, {
      method: "POST", headers: H, body: JSON.stringify({ key, value: JSON.stringify(obj), updated_at: new Date().toISOString() }),
    });
  } catch { /* ignore */ }
}
