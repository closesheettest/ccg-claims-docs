// netlify/functions/audit-start-dates.js
//
// READ-ONLY audit of the 7/2 Start-Date backfill. Scans EVERY JN job (all
// statuses, straight from JobNimbus — no dependence on the Supabase inspections
// table, which is why yesterday's retail sweep missed referral retail deals
// like Chad Piester) and finds the backfill's damage in one pass.
//
// The backfill's rule was "date_start = Sold Date" for any deal with a Sold
// Date but a blank Start Date. Its fingerprint is date_start === cf_date_5.
//   • On a SOLD-status deal that is CORRECT — JN's weekly report buckets by
//     Start Date and wants it = Sold Date.
//   • On a NON-SOLD deal (dead / no-sale / appointment / inspection-result) it
//     is WRONG — that deal shouldn't carry a Start Date at all, and the stamp
//     makes it reappear on the "sold this week" report.
//
// Retail vs insurance is read from location.id (1 = retail, 3 = insurance) —
// NOT record_type_name, which is "Retail" for almost every job and was the
// faulty signal the earlier sweep relied on.
//
//   GET /.netlify/functions/audit-start-dates
//   → { ok, scanned, truncated, now,
//        fingerprint_in_nonsold:{ total, by_status, deals:[…] },  ← cleanup targets
//        future_start:[…], future_sold:[…],
//        counts, status_distribution }
//
// Open-CORS, no writes. Env: JOBNIMBUS_API_KEY.

const JN_BASE = "https://app.jobnimbus.com/api1";
const JN_KEY = process.env.JOBNIMBUS_API_KEY;
const jnH = { Authorization: `bearer ${JN_KEY}`, "Content-Type": "application/json" };

const SOLD_STATUS_NAMES = new Set([
  "Sit - Sold", "Signed Contract", "Production Review", "Job Prep",
  "Upcoming Installs", "Install Set", "Roof Install", "Roof Complete",
  "Installed", "Paid & Closed", "Check complete",
  "Commission", "Upcoming Commissions", "Install Complete - Collect Payment",
]);
const PAGE_CAP = 250;   // pages of 100 = up to 25k jobs
const CONC = 12;        // parallel pages per round

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return cors(200, "");
  if (!JN_KEY) return cors(500, JSON.stringify({ ok: false, error: "Missing JOBNIMBUS_API_KEY" }));
  const nowSec = Math.floor(Date.now() / 1000);

  const fetchPage = async (p) => {
    const r = await fetch(`${JN_BASE}/jobs?size=100&from=${p * 100}&sort=-date_updated`, { headers: jnH });
    if (!r.ok) return null;
    const d = await r.json().catch(() => ({}));
    return d.results || d.jobs || [];
  };

  try {
    const seen = new Set();
    const jobs = [];
    let truncated = false, done = false;
    for (let base = 0; base < PAGE_CAP && !done; base += CONC) {
      const pages = await Promise.all(Array.from({ length: CONC }, (_, k) => fetchPage(base + k)));
      for (const rows of pages) {
        if (rows === null) continue;
        for (const j of rows) { const id = j.jnid || j.id; if (id && !seen.has(id)) { seen.add(id); jobs.push(j); } }
        if (rows.length < 100) done = true;
      }
      if (base + CONC >= PAGE_CAP && !done) truncated = true;
    }

    const counts = {
      sold_start_eq_sold: 0, nonsold_start_eq_sold: 0,
      start_ne_sold: 0, blank_start: 0, no_sold: 0,
    };
    const statusDist = {};
    const fpByStatus = {};
    const fpDeals = [], futureStart = [], futureSold = [];

    const row = (j, id, start, sold) => ({
      jnid: id,
      name: (j.primary && j.primary.name) || j.name || "—",
      address: [j.address_line1, j.city].filter(Boolean).join(", "),
      rep: j.sales_rep_name || null,
      status: j.status_name || "",
      location: (j.location && j.location.id) || null,
      channel: (j.location && j.location.id) === 3 ? "insurance" : (j.location && j.location.id) === 1 ? "retail" : "other",
      start_date: start ? ymd(start) : null,
      sold_date: sold ? ymd(sold) : null,
      jn_url: `https://app.jobnimbus.com/job/${id}`,
    });

    for (const j of jobs) {
      const id = j.jnid || j.id;
      const start = Number(j.date_start) || 0;
      const sold = Number(j.cf_date_5) || Number(j["Sold Date"]) || 0;
      const status = j.status_name || "(none)";
      const isSold = SOLD_STATUS_NAMES.has(status);
      statusDist[status] = (statusDist[status] || 0) + 1;

      if (start && start > nowSec) futureStart.push(row(j, id, start, sold));
      if (sold && sold > nowSec) futureSold.push(row(j, id, start, sold));

      if (!sold) { counts.no_sold++; continue; }
      if (!start) { counts.blank_start++; continue; }
      if (start === sold) {
        if (isSold) counts.sold_start_eq_sold++;
        else {
          counts.nonsold_start_eq_sold++;
          fpByStatus[status] = (fpByStatus[status] || 0) + 1;
          fpDeals.push(row(j, id, start, sold));
        }
      } else counts.start_ne_sold++;
    }

    fpDeals.sort((a, b) => String(a.start_date).localeCompare(String(b.start_date)));
    futureStart.sort((a, b) => String(a.start_date).localeCompare(String(b.start_date)));
    futureSold.sort((a, b) => String(a.sold_date).localeCompare(String(b.sold_date)));

    return cors(200, JSON.stringify({
      ok: true,
      scanned: seen.size,
      truncated,
      now: ymd(nowSec),
      fingerprint_in_nonsold: { total: fpDeals.length, by_status: fpByStatus, deals: fpDeals },
      future_start: futureStart,
      future_sold: futureSold,
      counts,
      status_distribution: Object.fromEntries(Object.entries(statusDist).sort((a, b) => b[1] - a[1])),
    }, null, 2));
  } catch (e) {
    return cors(500, JSON.stringify({ ok: false, error: e.message || "error" }));
  }
};

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
