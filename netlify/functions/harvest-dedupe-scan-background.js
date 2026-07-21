// netlify/functions/harvest-dedupe-scan-background.js
//
// On-demand scan for DUPLICATE JobNimbus homeowner contacts created by the
// harvest self-gen flow's old last-name-first bug (e.g. a "Rising Brian" twin of
// the real "Brian Rising"). It groups harvest-created contacts by phone, pulls
// every contact sharing that phone (the correct twin is often a different source),
// and flags clusters whose names are the same set of tokens in a different order.
//
// READ-ONLY on JobNimbus. It NEVER merges or deletes — JN has no safe merge API
// and a merge is irreversible, so the actual merge stays a human action in JN.
// Results are written to Supabase app_settings['harvest_dupe_scan'] for review.
//
// Trigger:  GET /.netlify/functions/harvest-dedupe-scan-background?secret=<CRON_SECRET>&since=2026-06-01
// Read out: app_settings where key = 'harvest_dupe_scan'  (value is JSON)

const JN_BASE = "https://app.jobnimbus.com/api1";
const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const JN_KEY = process.env.JOBNIMBUS_API_KEY;
const sb = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" };
const jh = { Authorization: `bearer ${JN_KEY}`, "Content-Type": "application/json" };

const SOURCES = ["Self Generated", "Harvesting"]; // harvest flows that create JN contacts
const CAP = 900;          // sharded date-split threshold (stay under JN's paging ceiling)
const MAX_PHONES = 2000;  // runaway guard

const digits = (s) => String(s || "").replace(/\D/g, "");
const phone10 = (s) => { const d = digits(s); return d.length >= 10 ? d.slice(-10) : ""; };
// Same PERSON regardless of token order: lowercase, strip punctuation, sort tokens.
const sig = (name) => String(name || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean).sort().join(" ");
const nameOf = (c) => c.display_name || `${c.first_name || ""} ${c.last_name || ""}`.trim();
const phoneOf = (c) => phone10(c.mobile_phone || c.home_phone || c.work_phone);

async function jnGet(path) {
  try { const r = await fetch(`${JN_BASE}/${path}`, { headers: jh }); return r.ok ? await r.json() : {}; }
  catch { return {}; }
}
async function writeSetting(key, obj) {
  await fetch(`${SB_URL}/rest/v1/app_settings?on_conflict=key`, {
    method: "POST", headers: { ...sb, Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ key, value: JSON.stringify(obj), updated_at: new Date().toISOString() }),
  }).catch(() => {});
}

// Recursive date-sharded pull so we never blow past JN's from/size paging ceiling.
async function sharded(must, lo, hi, onRow) {
  const filterFor = (gte, lte) => encodeURIComponent(JSON.stringify({ must: [...must, { range: { date_created: { gte, lte } } }] }));
  const countOf = async (gte, lte) => { const d = await jnGet(`contacts?size=1&filter=${filterFor(gte, lte)}`); return Number(d.count || 0); };
  const drain = async (gte, lte) => {
    for (let p = 0; p < 200; p++) {
      const d = await jnGet(`contacts?size=100&from=${p * 100}&filter=${filterFor(gte, lte)}`);
      const rows = d.results || d.contacts || [];
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
    await rec(gte, mid); await rec(mid + 1, lte);
  };
  await rec(lo, hi);
}

async function jobsFor(contactId) {
  const f = encodeURIComponent(JSON.stringify({ must: [{ term: { "primary.id": contactId } }] }));
  const d = await jnGet(`jobs?size=10&filter=${f}`);
  return (d.results || d.jobs || []).map((j) => ({ id: j.jnid || j.id, name: j.name || j.display_name || "", status: j.status_name || "" }));
}

// Keeper = the contact with the most jobs; tie → a non-"Self Generated" source
// (the original record, not the harvest twin); tie → whichever came first.
function pickKeeper(grp) {
  return [...grp].sort((a, b) => {
    const jd = (b.jobs?.length || 0) - (a.jobs?.length || 0);
    if (jd) return jd;
    const as = a.source === "Self Generated" ? 1 : 0, bs = b.source === "Self Generated" ? 1 : 0;
    return as - bs;
  })[0];
}
function dedupeById(arr) { const seen = new Set(); return arr.filter((c) => c.id && !seen.has(c.id) && seen.add(c.id)); }

export const handler = async (event) => {
  const p = event.queryStringParameters || {};
  if (process.env.CRON_SECRET && p.secret !== process.env.CRON_SECRET) {
    return { statusCode: 401, body: "unauthorized" };
  }
  const started = new Date().toISOString();
  const sinceSec = Math.floor(Date.parse(`${p.since || "2026-06-01"}T00:00:00-04:00`) / 1000);
  const nowSec = Math.floor(Date.now() / 1000);

  await writeSetting("harvest_dupe_scan", { ok: false, status: "running", started });

  // 1. Pull harvest-created candidate contacts.
  const cands = [];
  for (const src of SOURCES) {
    await sharded([{ match_phrase: { source_name: src } }], sinceSec, nowSec, (c) => {
      const id = c.jnid || c.id; if (!id) return;
      cands.push({ id, name: nameOf(c), phone: phoneOf(c), addr: (c.address_line1 || "").trim(), source: c.source_name || src });
    });
  }

  // 2. For each phone a candidate uses, pull ALL contacts on that phone and flag
  //    clusters that are the same name-signature under 2+ different contact ids.
  const phones = [...new Set(cands.map((c) => c.phone).filter(Boolean))].slice(0, MAX_PHONES);
  const clusters = [];
  for (const ph of phones) {
    const d = await jnGet(`contacts?search=${ph}&size=25`);
    const rows = (d.results || d.contacts || [])
      .map((c) => ({ id: c.jnid || c.id, name: nameOf(c), phone: phoneOf(c), addr: (c.address_line1 || "").trim(), source: c.source_name || "" }))
      .filter((c) => c.id && c.phone === ph);
    const bySig = {};
    for (const c of rows) { const s = sig(c.name); if (!s) continue; (bySig[s] = bySig[s] || []).push(c); }
    for (const s of Object.keys(bySig)) {
      const grp = dedupeById(bySig[s]);
      if (grp.length < 2) continue; // no twin → not a duplicate
      for (const c of grp) c.jobs = await jobsFor(c.id);
      const keep = pickKeeper(grp);
      clusters.push({
        phone: ph,
        address: keep.addr || (grp.find((g) => g.addr) || {}).addr || "",
        keep: { id: keep.id, name: keep.name, source: keep.source, jobs: keep.jobs },
        merge_in: grp.filter((c) => c.id !== keep.id).map((c) => ({ id: c.id, name: c.name, source: c.source, jobs: c.jobs })),
      });
    }
  }

  const out = {
    ok: true, status: "done", generated_at: started, finished: new Date().toISOString(),
    since: p.since || "2026-06-01", scanned_candidates: cands.length, phones_checked: phones.length,
    cluster_count: clusters.length, dupe_count: clusters.reduce((n, c) => n + c.merge_in.length, 0),
    clusters,
  };
  await writeSetting("harvest_dupe_scan", out);
  return { statusCode: 200, body: JSON.stringify({ ok: true, wrote: "app_settings.harvest_dupe_scan", clusters: clusters.length, dupes: out.dupe_count }) };
};
