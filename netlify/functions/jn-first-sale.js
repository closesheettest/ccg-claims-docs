// netlify/functions/jn-first-sale.js
//
// Diagnostic: the EARLIEST sold deal (by Sold Date) whose city matches a query
// — e.g. "when was the first Jacksonville sale?".
//
//   GET /.netlify/functions/jn-first-sale?city=Jacksonville
//   → { ok, city, matched, first:{date,customer,address,city,status,sold_sec,jn_url},
//        earliest:[…5] }
//
// Open-CORS. Env: JOBNIMBUS_API_KEY.

const JN_BASE = "https://app.jobnimbus.com/api1";
const JN_KEY = process.env.JOBNIMBUS_API_KEY;
const jnH = { Authorization: `bearer ${JN_KEY}`, "Content-Type": "application/json" };
const SOLD_STATUS_NAMES = [
  "Sit - Sold", "Signed Contract", "Production Review", "Job Prep",
  "Upcoming Installs", "Install Set",
  "Roof Install", "Roof Complete", "Installed", "Paid & Closed", "Check complete",
];
const PAGE_CAP = 90;
const fmtDate = (sec) =>
  new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric", year: "numeric" })
    .format(new Date(sec * 1000));

exports.handler = async (event) => {
  if (!JN_KEY) return cors(500, JSON.stringify({ ok: false, error: "Missing JOBNIMBUS_API_KEY" }));
  const qp = event.queryStringParameters || {};
  const future = qp.future === "1" || qp.future === "true"; // list sold deals with a FUTURE Sold Date
  const q = String(qp.city || "Jacksonville").trim().toLowerCase();
  const nowSec = Math.floor(Date.now() / 1000);
  if (!future && !q) return cors(400, JSON.stringify({ ok: false, error: "city required" }));

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

    const seen = new Set();
    const matches = [];
    for (const jobs of perStatus) {
      for (const j of jobs) {
        const id = j.jnid || j.id;
        if (id && seen.has(id)) continue;
        if (id) seen.add(id);
        const city = String(j.city || "");
        const soldSec = Number(j.cf_date_5) || Number(j["Sold Date"]) || 0;
        if (!soldSec) continue;
        if (future) { if (soldSec <= nowSec) continue; }
        else if (!city.toLowerCase().includes(q)) continue;
        matches.push({
          sold_sec: soldSec,
          date: fmtDate(soldSec),
          customer: (j.primary && j.primary.name) || j.name || "—",
          address: [j.address_line1, j.city].filter(Boolean).join(", "),
          city,
          status: j.status_name || "",
          jn_url: `https://app.jobnimbus.com/job/${id}`,
        });
      }
    }
    matches.sort((a, b) => a.sold_sec - b.sold_sec);
    return cors(200, JSON.stringify({
      ok: true, city: q, matched: matches.length,
      first: matches[0] || null, earliest: matches.slice(0, 5),
    }));
  } catch (e) {
    return cors(500, JSON.stringify({ ok: false, error: e.message || "error" }));
  }
};

function cors(status, body) {
  return { statusCode: status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" }, body };
}
