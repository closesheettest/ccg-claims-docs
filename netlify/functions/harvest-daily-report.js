// netlify/functions/harvest-daily-report.js
//
// The Daily report, counted from the MAP rather than from a tally.
//
// It used to read app_settings.harvest_sync_daily — a counter bumped at the
// moment pins were inserted and never decremented. So 20 Aug read "43 IQ / 44
// added" while 24 of those pins were actually on the map: the rest had been
// deleted later the same day as duplicates, or reconciled away when their
// JobNimbus contact stopped qualifying. Two numbers, both defensible, one
// screen — which is just confusing (Neal, 2026-08-21).
//
// So this counts what is THERE. The drill-down and the row can no longer
// disagree, because they now count the same thing.
//
//   GET ?days=14
//   → { ok, days:[{ day, iq, fb, ai, nosit, added }] }
//
// Counts, not rows: one day in this window is the 1.27M inspection-lead mass
// load, and fetching it would fall over.
//
// Env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY.

const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const sbH = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` };

// list_name is what the sync stamps on a pin it creates.
// Every list a pin can arrive on, so the row adds up to the whole day. The
// last two aren't the sync's doing — a rep dropped them — but leaving them out
// made the row say 21 while the breakdown under it said 24, and a report whose
// own numbers disagree is a report nobody trusts (Neal, 2026-08-21).
const SOURCES = [
  ["iq", "JN Instant Quote"],
  ["fb", "JN Facebook"],
  ["ai", "JN AI Bot"],
  ["nosit", "JN No-Sits"],
  ["selfgen", "Self-Generated"],
  ["referral", "Referral"],
];

export const handler = async (event) => {
  if (!SB_URL || !SB_KEY) return json(500, { ok: false, error: "env missing" });
  const n = Math.min(Math.max(parseInt((event.queryStringParameters || {}).days, 10) || 14, 1), 30);

  // Eastern days, newest first.
  const today = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
  const days = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(today.getTime() - i * 86400000);
    days.push(d.toISOString().slice(0, 10));
  }

  try {
    const out = await Promise.all(days.map(async (day) => {
      const start = `${day}T04:00:00Z`;
      const end = `${new Date(Date.parse(`${day}T12:00:00Z`) + 86400000).toISOString().slice(0, 10)}T04:00:00Z`;
      const counts = await Promise.all(SOURCES.map(([, list]) => countOf(
        `canvass_prospects?created_at=gte.${encodeURIComponent(start)}&created_at=lt.${encodeURIComponent(end)}` +
        `&list_name=eq.${encodeURIComponent(list)}&select=id`,
      )));
      const row = { day };
      SOURCES.forEach(([k], i) => { row[k] = counts[i]; });
      row.added = counts.reduce((a, b) => a + b, 0);
      return row;
    }));
    return json(200, { ok: true, days: out });
  } catch (e) {
    return json(500, { ok: false, error: e.message || "error" });
  }
};

async function countOf(path) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, {
    headers: { ...sbH, Prefer: "count=exact", "Range-Unit": "items", Range: "0-0" },
  });
  if (!r.ok) return 0;
  const cr = r.headers.get("content-range") || "";
  const n = Number(String(cr).split("/")[1]);
  return Number.isFinite(n) ? n : 0;
}
function json(statusCode, body) {
  return { statusCode, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }, body: JSON.stringify(body) };
}
