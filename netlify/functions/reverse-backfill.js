// netlify/functions/reverse-backfill.js
//
// Faithfully REVERSE the 7/2 Start-Date backfill — put every deal it touched
// back to a blank Start Date, "as if it never happened", WITHOUT clobbering any
// value a human has changed since.
//
// The backfill (JN user "Insurance Forms", ~2026-07-01..07-05) filled deals
// that had a Sold Date but a BLANK Start Date by setting date_start = Sold Date.
// So a deal is reversible only if BOTH are true:
//   1. its CURRENT date_start still equals cf_date_5 (Sold Date)   — untouched, and
//   2. its activity feed's MOST-RECENT "Start Date" change is that backfill
//      write (actor ~ "…Forms", in the backfill window, FROM BLANK).
// If a person edited the Start Date after the backfill (e.g. Chad Piester's
// Jan-6 correction), the most-recent Start-Date activity is that human edit —
// so the deal is SKIPPED and left exactly as the person set it.
//
// Reversing = set date_start back to null (its pre-backfill value).
//
//   GET /.netlify/functions/reverse-backfill
//        [?apply=1]                 write the nulls (default: DRY RUN)
//        [&scope=all|nonsold]       all backfill writes, or only ones now in a
//                                   non-sold status (default: all)
//        [&offset=0&limit=45]       chunk the candidate list across calls
//   → { ok, mode, scope, candidates, processed, offset, limit, more,
//        reversible:{sold,nonsold}, reversed, skipped:{…}, deals:[…] }
//
// Open-CORS. Env: JOBNIMBUS_API_KEY.

const JN_BASE = "https://app.jobnimbus.com/api1";
const JN_KEY = process.env.JOBNIMBUS_API_KEY;
const jnH = { Authorization: `bearer ${JN_KEY}`, "Content-Type": "application/json" };

const SOLD_STATUS_NAMES = new Set([
  "Sit - Sold", "Signed Contract", "Production Review", "Job Prep",
  "Upcoming Installs", "Install Set", "Roof Install", "Roof Complete",
  "Installed", "Paid & Closed", "Check complete", "Commission",
  "Upcoming Commissions", "Install Complete - Collect Payment",
  "Sit Sold Insp", "Sit Sold PA", "Sitsold PA", "Roof Started",
  "In Funding", "Holds", "Extras", "Misc Collections Needed", "Waiting on PACE",
]);
const SCAN_PAGE_CAP = 250, SCAN_CONC = 12;   // full-job scan
const BF_MIN = Math.floor(Date.UTC(2026, 5, 30) / 1000);        // Jun 30 2026
const BF_MAX = Math.floor(Date.UTC(2026, 6, 6, 23, 59) / 1000); // Jul 6 2026
const VERIFY_CONC = 10;

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return cors(200, "");
  if (!JN_KEY) return cors(500, JSON.stringify({ ok: false, error: "Missing JOBNIMBUS_API_KEY" }));
  const qp = event.queryStringParameters || {};
  const apply = ["1", "true", "yes"].includes(String(qp.apply || "").toLowerCase());
  const scope = qp.scope === "nonsold" ? "nonsold" : "all";
  const offset = Math.max(parseInt(qp.offset, 10) || 0, 0);
  const limit = Math.min(Math.max(parseInt(qp.limit, 10) || 45, 1), 120);

  try {
    // 1. Candidate set: every job whose date_start still equals its Sold Date.
    const jobs = await scanAllJobs();
    let candidates = [];
    for (const j of jobs) {
      const start = Number(j.date_start) || 0;
      const sold = Number(j.cf_date_5) || Number(j["Sold Date"]) || 0;
      if (start && sold && start === sold) {
        candidates.push({
          jnid: j.jnid || j.id,
          name: (j.primary && j.primary.name) || j.name || "—",
          status: j.status_name || "",
          location: (j.location && j.location.id) || null,
          isSold: SOLD_STATUS_NAMES.has(j.status_name || ""),
          start,
        });
      }
    }
    candidates.sort((a, b) => String(a.jnid).localeCompare(String(b.jnid)));
    const total = candidates.length;
    const slice = candidates.slice(offset, offset + limit);

    // 2. Verify each in the slice against its activity feed.
    const reverseList = [], skipped = { manual_change: 0, not_backfill: 0, no_history: 0, error: 0 };
    for (let i = 0; i < slice.length; i += VERIFY_CONC) {
      const batch = slice.slice(i, i + VERIFY_CONC);
      await Promise.all(batch.map(async (c) => {
        const v = await verifyBackfill(c.jnid);
        if (v === "backfill") reverseList.push(c);
        else if (v in skipped) skipped[v]++;
        else skipped.error++;
      }));
    }

    // 3. Apply (respecting scope) or dry-run.
    const targets = reverseList.filter((c) => scope === "all" || !c.isSold);
    let reversed = 0; const applyErrors = [];
    if (apply) {
      for (let i = 0; i < targets.length; i += VERIFY_CONC) {
        const batch = targets.slice(i, i + VERIFY_CONC);
        const res = await Promise.all(batch.map((c) => jnPutClearStart(c.jnid)));
        res.forEach((ok, k) => { ok ? reversed++ : applyErrors.push(batch[k].name); });
      }
    }

    const soldN = reverseList.filter((c) => c.isSold).length;
    return cors(200, JSON.stringify({
      ok: true,
      mode: apply ? "APPLIED" : "DRY RUN — nothing written",
      scope,
      candidates: total,
      processed: slice.length,
      offset, limit,
      more: offset + limit < total ? `re-run with ?offset=${offset + limit}&scope=${scope}${apply ? "&apply=1" : ""}` : null,
      reversible: { sold: soldN, nonsold: reverseList.length - soldN, total: reverseList.length },
      would_reverse_in_scope: targets.length,
      reversed,
      apply_errors: applyErrors,
      skipped,
      deals: reverseList.map((c) => ({
        jnid: c.jnid, name: c.name, status: c.status,
        channel: c.location === 3 ? "insurance" : c.location === 1 ? "retail" : "other",
        sold_bucket: c.isSold ? "was-sold" : "not-sold",
        start_date: ymd(c.start), jn_url: `https://app.jobnimbus.com/job/${c.jnid}`,
      })),
    }, null, 2));
  } catch (e) {
    return cors(500, JSON.stringify({ ok: false, error: e.message || "error" }));
  }
};

async function scanAllJobs() {
  const seen = new Set(), out = [];
  let done = false;
  // Every backfill write bumped date_updated to the backfill day, so a
  // reversible candidate is always updated on/after BF_MIN — scan only that
  // window (far smaller than the full 10k job set, keeps each chunk fast).
  const fetchPage = async (p) => {
    const r = await fetch(`${JN_BASE}/jobs?size=100&from=${p * 100}&sort=-date_updated&date_updated_after=${BF_MIN}`, { headers: jnH });
    if (!r.ok) return null;
    const d = await r.json().catch(() => ({}));
    return d.results || d.jobs || [];
  };
  for (let base = 0; base < SCAN_PAGE_CAP && !done; base += SCAN_CONC) {
    const pages = await Promise.all(Array.from({ length: SCAN_CONC }, (_, k) => fetchPage(base + k)));
    for (const rows of pages) {
      if (rows === null) continue;
      for (const j of rows) { const id = j.jnid || j.id; if (id && !seen.has(id)) { seen.add(id); out.push(j); } }
      if (rows.length < 100) done = true;
    }
  }
  return out;
}

// Returns "backfill" | "manual_change" | "not_backfill" | "no_history" | "error"
async function verifyBackfill(jnid) {
  const acts = await fetchActivities(jnid);
  if (acts === null) return "error";
  // Start-Date change activities, newest first (feed already sorted -date_created).
  const startActs = acts.filter((a) => /start date\s*:/i.test(String(a.note || a.message || "")));
  if (!startActs.length) return "no_history";
  const last = startActs[0];
  const note = String(last.note || last.message || "");
  const by = String(last.created_by_name || last.created_by || "");
  const when = Number(last.date_created) || 0;
  const fromBlank = /start date\s*:\s*=>/i.test(note);      // "Start Date: => X"  (blank before =>)
  const isFormsBot = /form/i.test(by);
  const inWindow = when >= BF_MIN && when <= BF_MAX;
  if (isFormsBot && inWindow && fromBlank) return "backfill";
  if (!isFormsBot) return "manual_change";                  // a person set it last — leave it
  return "not_backfill";
}

async function fetchActivities(jnid) {
  const attempts = [
    `activities?filter=${enc({ must: [{ term: { "related.id": jnid } }] })}&size=100&sort=-date_created`,
    `activities?filter=${enc({ must: [{ term: { "primary.id": jnid } }] })}&size=100&sort=-date_created`,
  ];
  for (const path of attempts) {
    try {
      const r = await fetch(`${JN_BASE}/${path}`, { headers: jnH });
      if (!r.ok) continue;
      const d = await r.json().catch(() => ({}));
      const acts = d.activity || d.activities || d.results || (Array.isArray(d) ? d : []);
      if (acts.length) return acts;
    } catch { /* try next shape */ }
  }
  return [];
}

async function jnPutClearStart(jnid) {
  for (let a = 0; a < 3; a++) {
    try {
      const r = await fetch(`${JN_BASE}/jobs/${encodeURIComponent(jnid)}`, {
        method: "PUT", headers: jnH, body: JSON.stringify({ jnid, date_start: null }),
      });
      if (r.ok) return true;
      if (r.status < 500) return false;
    } catch { /* retry */ }
    await new Promise((res) => setTimeout(res, 400 * (a + 1)));
  }
  return false;
}

const enc = (o) => encodeURIComponent(JSON.stringify(o));
function ymd(sec) {
  return new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" })
    .format(new Date(sec * 1000));
}
function cors(status, body) {
  return {
    statusCode: status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" },
    body,
  };
}
