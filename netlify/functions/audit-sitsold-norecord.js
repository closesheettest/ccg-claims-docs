// netlify/functions/audit-sitsold-norecord.js
//
// READ-ONLY. Enriches the daily cron-sitsold-reconcile alert ("N JN jobs at
// Sit Sold Insp with NO inspection record"). For each such job it decides WHY
// there's no record, so the manual "dedupe in JN or create the record" step
// becomes a sorted worklist:
//
//   • record_on_sibling — a matching inspection record EXISTS but is linked to a
//                         DIFFERENT jn_job_id → THIS JN job is a duplicate; the
//                         real one has the record. Action: merge/ignore dupe.
//   • record_unlinked   — a matching record exists with jn_job_id = NULL →
//                         Action: link it to this job (no data missing).
//   • no_record         — no matching inspection record anywhere → genuinely
//                         JN-only (a lead parked at this status, never signed
//                         through our app). Action: create a record or leave it.
//
// Match = same ZIP + same street-number, OR same last name + street-number.
//
//   GET /.netlify/functions/audit-sitsold-norecord
//   → { ok, sit_sold_total, no_record, by_bucket, items:[…] }
//
// Env: JOBNIMBUS_API_KEY, VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY.

const JN_BASE = "https://app.jobnimbus.com/api1";
const JN_KEY = process.env.JOBNIMBUS_API_KEY;
const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const jnH = { Authorization: `bearer ${JN_KEY}`, "Content-Type": "application/json" };
const sb = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` };
const STATUS = "Sit Sold Insp";

exports.handler = async (event) => {
  if (!JN_KEY || !SB_URL || !SB_KEY) return json(500, { ok: false, error: "Missing env" });
  try {
    const jobs = await fetchStatusJobs(STATUS);

    // Map EVERY inspection record on these jnids (incl. cancelled) so we can tell
    // "no record at all" apart from "record exists but is cancelled".
    const jnids = jobs.map((j) => j.jnid || j.id).filter(Boolean);
    const byJnid = {}; // jnid -> {id, result, cancelled}
    for (let i = 0; i < jnids.length; i += 80) {
      const chunk = jnids.slice(i, i + 80).map((x) => `"${x}"`).join(",");
      const got = await sbGet(`inspections?jn_job_id=in.(${encodeURIComponent(chunk)})&select=id,jn_job_id,result,cancelled_at`);
      for (const r of got) {
        const prev = byJnid[r.jn_job_id];
        // Prefer a LIVE (uncancelled) record if there are several on one jnid.
        if (!prev || (prev.cancelled && !r.cancelled_at)) byJnid[r.jn_job_id] = { id: r.id, result: r.result || null, cancelled: !!r.cancelled_at };
      }
    }

    // Candidates = the exact set the daily alert flags: sold, non-lead,
    // non-test, with no LIVE (uncancelled) inspection record on this jnid.
    let testExcluded = 0;
    const candidates = [];
    for (const j of jobs) {
      const id = j.jnid || j.id;
      if (!id) continue;
      const rec = byJnid[id];
      if (rec && !rec.cancelled) continue; // has a live record — fine
      const nm = (j.name || "").trim();
      const rt = String(j.record_type_name || "").trim().toLowerCase();
      const isLead = rt === "lead";
      const isTest = /test/i.test(nm) || /test/.test(rt); // name OR record_type "TEST LEAD"
      const sold = Number(j.cf_date_5 || j["Sold Date"] || 0);
      if (isTest) { testExcluded++; continue; }
      if (isLead || !(sold > 0)) continue;
      candidates.push(j);
    }

    // Diagnose each candidate against the inspections table.
    const items = [];
    const buckets = { cancelled_same_job: 0, record_on_sibling: 0, record_unlinked: 0, no_record: 0 };
    for (const j of candidates) {
      const id = j.jnid || j.id;

      // Direct link first: a record IS on this jnid but cancelled → app cancelled
      // it, JN just still shows Sit Sold Insp (no dupe, no missing data).
      const onJob = byJnid[id];
      if (onJob && onJob.cancelled) {
        buckets.cancelled_same_job++;
        items.push({
          bucket: "cancelled_same_job",
          note: `Record ${onJob.id} is on THIS job but cancelled — app cancelled it; JN status still Sit Sold Insp.`,
          name: (j.name || "").trim(), address: j.address_line1 || "", zip: String(j.zip || "").trim(),
          jnid: id, jn_url: `https://app.jobnimbus.com/job/${id}`,
          match: { id: onJob.id, client: null, address: null, result: onJob.result, cancelled: true, sibling_jn: id, sibling_url: null },
        });
        continue;
      }

      const nm = parseName(j.name);
      const street = String(j.address_line1 || j.address || "").toLowerCase().replace(/\s+/g, " ").trim();
      const num = (street.match(/^\d+/) || [""])[0];
      const zip = String(j.zip || "").trim();
      const lastName = (nm.split(/\s+/).pop() || "").toLowerCase();

      // Pull possible matches: by zip, and by last-name.
      const seen = new Map();
      const collect = (rows) => { for (const r of rows) seen.set(r.id, r); };
      if (zip) collect(await sbGet(`inspections?zip=eq.${encodeURIComponent(zip)}&select=id,client_name,address,zip,jn_job_id,result,cancelled_at`));
      if (lastName.length > 1) collect(await sbGet(`inspections?client_name=ilike.${encodeURIComponent("*" + lastName + "*")}&select=id,client_name,address,zip,jn_job_id,result,cancelled_at&limit=50`));

      let match = null;
      for (const r of seen.values()) {
        const rStreet = String(r.address || "").toLowerCase().replace(/\s+/g, " ").trim();
        const rNum = (rStreet.match(/^\d+/) || [""])[0];
        const rLast = (String(r.client_name || "").trim().split(/\s+/).pop() || "").toLowerCase();
        const numHit = num && rNum && num === rNum && (!zip || !r.zip || zip === String(r.zip).trim());
        const nameHit = lastName.length > 1 && rLast === lastName && num && rNum && num === rNum;
        if (numHit || nameHit) { match = r; break; }
      }

      let bucket, note;
      if (!match) { bucket = "no_record"; note = "No inspection record found by zip+street or last name."; }
      else if (!match.jn_job_id) { bucket = "record_unlinked"; note = `Record ${match.id} exists but has no jn_job_id — link it.`; }
      else if (match.jn_job_id !== id) { bucket = "record_on_sibling"; note = `Record ${match.id} is linked to a DIFFERENT JN job ${match.jn_job_id} — this one is a duplicate.`; }
      else { bucket = "no_record"; note = "Record links to this jnid but wasn't in the linked set (cancelled?)."; }
      buckets[bucket]++;
      items.push({
        bucket, note,
        name: (j.name || "").trim(), address: j.address_line1 || "", zip,
        jnid: id, jn_url: `https://app.jobnimbus.com/job/${id}`,
        match: match ? { id: match.id, client: match.client_name, address: match.address, result: match.result || null, cancelled: !!match.cancelled_at, sibling_jn: match.jn_job_id || null, sibling_url: match.jn_job_id ? `https://app.jobnimbus.com/job/${match.jn_job_id}` : null } : null,
      });
    }

    const order = { record_on_sibling: 0, cancelled_same_job: 1, record_unlinked: 2, no_record: 3 };
    items.sort((a, b) => order[a.bucket] - order[b.bucket]);
    return json(200, { ok: true, sit_sold_total: jobs.length, flagged: candidates.length, test_excluded: testExcluded, by_bucket: buckets, items });
  } catch (e) {
    return json(500, { ok: false, error: e.message || "error" });
  }
};

async function fetchStatusJobs(statusName) {
  const out = [];
  const sinceSec = Math.floor(Date.now() / 1000) - 540 * 24 * 60 * 60;
  const filter = encodeURIComponent(JSON.stringify({ must: [{ match_phrase: { status_name: statusName } }] }));
  for (let page = 0; page < 60; page++) {
    const r = await fetch(`${JN_BASE}/jobs?size=100&from=${page * 100}&sort=-date_updated&date_updated_after=${sinceSec}&filter=${filter}`, { headers: jnH });
    if (!r.ok) break;
    const d = await r.json().catch(() => ({}));
    const list = d.results || d.jobs || [];
    out.push(...list);
    if (list.length < 100) break;
  }
  return out;
}
function parseName(jobName) {
  return String(jobName || "").replace(/^\[TEST[^\]]*\]\s*/i, "").split(" - ")[0].trim();
}
async function sbGet(path) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: sb });
  if (!r.ok) return [];
  return r.json().catch(() => []);
}
function json(status, body) {
  return { statusCode: status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" }, body: JSON.stringify(body) };
}
