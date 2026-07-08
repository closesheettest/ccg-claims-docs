// netlify/functions/audit-start-dates.js
//
// READ-ONLY audit of the 7/2 Start-Date backfill. Scans EVERY sold JN deal
// (straight from JobNimbus — no dependence on the Supabase inspections table,
// which is why yesterday's retail sweep missed referral retail deals like
// Chad Piester) and reports every Start-Date anomaly in one pass.
//
// The backfill's rule was "date_start = Sold Date" for any sold deal with a
// blank Start Date. Its fingerprint is therefore date_start === cf_date_5.
// That is CORRECT for insurance/PA deals (JN's weekly report buckets by Start
// Date and wants it = Sold Date) but WRONG for retail deals (record_type
// "Lead"), whose Start Date should stay blank until the retail visit books an
// appointment.
//
// Buckets every sold deal into:
//   • future_start          — date_start is in the FUTURE (always wrong)      [listed]
//   • future_sold           — Sold Date itself is in the future (bad source)  [listed]
//   • retail_start_eq_sold  — retail (Lead) with date_start === Sold Date      [listed]
//                             → the backfill fingerprint on retail = cleanup targets
//   • nonretail_start_eq_sold — insurance/PA with start === sold (intended)   [count]
//   • start_ne_sold         — both present but differ (real visit/install date)[count]
//   • blank_start           — sold deal with no Start Date                     [count]
//   • no_sold               — sold-status deal with no Sold Date               [count]
//
//   GET /.netlify/functions/audit-start-dates
//   → { ok, scanned, now, counts, record_types, future_start:[…],
//        future_sold:[…], retail_start_eq_sold:[…], samples:{…} }
//
// Open-CORS, no writes. Env: JOBNIMBUS_API_KEY.

const JN_BASE = "https://app.jobnimbus.com/api1";
const JN_KEY = process.env.JOBNIMBUS_API_KEY;
const jnH = { Authorization: `bearer ${JN_KEY}`, "Content-Type": "application/json" };

const SOLD_STATUS_NAMES = [
  "Sit - Sold", "Signed Contract", "Production Review", "Job Prep",
  "Upcoming Installs", "Install Set",
  "Roof Install", "Roof Complete", "Installed", "Paid & Closed", "Check complete",
];
const PAGE_CAP = 90;

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return cors(200, "");
  if (!JN_KEY) return cors(500, JSON.stringify({ ok: false, error: "Missing JOBNIMBUS_API_KEY" }));
  const nowSec = Math.floor(Date.now() / 1000);

  try {
    const perStatus = await Promise.all(SOLD_STATUS_NAMES.map(async (name) => {
      const filter = encodeURIComponent(JSON.stringify({ must: [{ match_phrase: { status_name: name } }] }));
      const out = [];
      for (let page = 0; page < PAGE_CAP; page++) {
        const r = await fetch(`${JN_BASE}/jobs?size=100&from=${page * 100}&sort=-date_updated&filter=${filter}`, { headers: jnH });
        if (!r.ok) break;
        const d = await r.json().catch(() => ({}));
        const rows = d.results || d.jobs || [];
        out.push(...rows);
        if (rows.length < 100) break;
      }
      return out;
    }));

    const counts = {
      future_start: 0, future_sold: 0, retail_start_eq_sold: 0,
      nonretail_start_eq_sold: 0, start_ne_sold: 0, blank_start: 0, no_sold: 0,
    };
    const recordTypes = {};
    const futureStart = [], futureSold = [], retailEqSold = [];
    const samples = { start_ne_sold: [], blank_start: [] };

    const seen = new Set();
    for (const jobs of perStatus) {
      for (const j of jobs) {
        const id = j.jnid || j.id;
        if (id && seen.has(id)) continue;
        if (id) seen.add(id);

        const start = Number(j.date_start) || 0;
        const sold = Number(j.cf_date_5) || Number(j["Sold Date"]) || 0;
        const rt = String(j.record_type_name || "").trim() || "(none)";
        const isRetail = rt.toLowerCase() === "lead";
        recordTypes[rt] = (recordTypes[rt] || 0) + 1;

        const row = () => ({
          jnid: id,
          name: (j.primary && j.primary.name) || j.name || "—",
          address: [j.address_line1, j.city].filter(Boolean).join(", "),
          rep: j.sales_rep_name || null,
          status: j.status_name || "",
          record_type: rt,
          start_date: start ? ymd(start) : null,
          sold_date: sold ? ymd(sold) : null,
          jn_url: `https://app.jobnimbus.com/job/${id}`,
        });

        if (start && start > nowSec) { counts.future_start++; futureStart.push(row()); }
        if (sold && sold > nowSec) { counts.future_sold++; futureSold.push(row()); }

        if (!sold) { counts.no_sold++; continue; }
        if (!start) { counts.blank_start++; if (samples.blank_start.length < 25) samples.blank_start.push(row()); continue; }

        if (start === sold) {
          if (isRetail) { counts.retail_start_eq_sold++; retailEqSold.push(row()); }
          else counts.nonretail_start_eq_sold++;
        } else {
          counts.start_ne_sold++;
          if (samples.start_ne_sold.length < 25) samples.start_ne_sold.push(row());
        }
      }
    }

    const sortByStart = (a, b) => String(a.start_date).localeCompare(String(b.start_date));
    futureStart.sort(sortByStart); retailEqSold.sort(sortByStart);
    futureSold.sort((a, b) => String(a.sold_date).localeCompare(String(b.sold_date)));

    return cors(200, JSON.stringify({
      ok: true,
      scanned: seen.size,
      now: ymd(nowSec),
      counts,
      record_types: recordTypes,
      future_start: futureStart,
      future_sold: futureSold,
      retail_start_eq_sold: retailEqSold,
      samples,
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
