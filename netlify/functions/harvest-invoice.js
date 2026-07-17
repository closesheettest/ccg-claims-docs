// netlify/functions/harvest-invoice.js
//
// Monthly Harvesting-Map invoice for the office: counts the PEOPLE who had a map
// seat (a personal link) — admins, trainees, and active field reps — and bills
// $40 each. Access-based, not usage: duration / whether they opened it doesn't
// matter. Same roster the office sees on the Rep Links page.
//
//   GET ?admin=<token>[&rate=40]
//   → { ok, month, rate, count, total, people:[{ name, level }] }
//
// Env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY
const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const REP_ZONES_URL = "https://trainingmanagementsys.netlify.app/.netlify/functions/rep-zones?include_inactive=1";

export const handler = async (event) => {
  if (!SB_URL || !SB_KEY) return json(500, { ok: false, error: "env missing" });
  const p = event.queryStringParameters || {};
  const rate = Math.max(0, Number(p.rate) || 40);
  const sbH = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` };
  const sbGet = (path) => fetch(`${SB_URL}/rest/v1/${path}`, { headers: sbH }).then((r) => (r.ok ? r.json() : [])).catch(() => []);

  // Admin only.
  const s = await sbGet(`app_settings?key=eq.harvest_admin_token&select=value&limit=1`);
  if (!p.admin || s[0]?.value !== p.admin) return json(401, { ok: false, error: "admin only" });

  // Which month? default = current (ET). 'YYYY-MM'.
  const curMonth = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" }).slice(0, 7);
  const reqMonth = /^\d{4}-\d{2}$/.test(p.month || "") ? p.month : curMonth;
  const isCurrent = reqMonth === curMonth;

  const norm = (v) => { const x = (v || "").toLowerCase(); return (x === "admin" || x === "senior" || x === "junior" || x === "trainee") ? x : null; };
  const [reps, rz, ledger] = await Promise.all([
    sbGet(`sales_reps?select=id,name,jobnimbus_id,harvest_token,active,harvest_level&order=name`),
    fetch(REP_ZONES_URL).then((r) => (r.ok ? r.json() : { reps: [] })).catch(() => ({ reps: [] })),
    // Everyone the ledger recorded as having access this month (incl. people since removed).
    sbGet(`harvest_access_months?month=eq.${encodeURIComponent(reqMonth)}&select=rep_id,rep_name`),
  ]);
  const zoneLevel = {};
  for (const r of (rz.reps || [])) {
    if (!r.active || !r.jobnimbus_id) continue;
    const lv = (r.rep_level || "").toLowerCase();
    zoneLevel[r.jobnimbus_id] = (lv === "senior" || lv === "junior") ? lv : "junior";
  }

  // Merge two sources, deduped by name:
  //   (a) the LEDGER for the month — anyone who was GIVEN access / opened the map
  //       that month, even if they've since been removed (dropped trainees).
  //   (b) for the CURRENT month, the live roster — people with a seat right now
  //       (covers seats granted before the ledger existed).
  const byName = new Map();
  const add = (name, level) => { const k = String(name || "").trim().toLowerCase(); if (!k) return; if (!byName.has(k) || (level && !byName.get(k).level)) byName.set(k, { name: String(name).trim(), level: level || byName.get(k)?.level || null }); };
  for (const r of (ledger || [])) add(r.rep_name, null);
  if (isCurrent) {
    for (const r of (reps || [])) {
      if (!r.harvest_token) continue;
      const level = norm(r.harvest_level) || (r.jobnimbus_id ? zoneLevel[r.jobnimbus_id] : null);
      if (!level) continue; // seat = has a link AND a level/active-field-rep
      add(r.name, level);
    }
  }
  const people = [...byName.values()].sort((a, b) => String(a.name).localeCompare(String(b.name)));

  const [y, m] = reqMonth.split("-");
  const month = new Date(Number(y), Number(m) - 1, 1).toLocaleString("en-US", { month: "long", year: "numeric" });
  const count = people.length;
  return json(200, { ok: true, month, rate, count, total: count * rate, people });
};

function json(statusCode, obj) {
  return { statusCode, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }, body: JSON.stringify(obj) };
}
