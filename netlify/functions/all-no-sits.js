// netlify/functions/all-no-sits.js
//
// Company-wide "No-sits to re-book" for the Regional Managers admin hub.
// Same source + rule as zone-no-sits, but ACROSS ALL ZONES, grouped by
// zone -> rep -> deal so the office can see every team's no-sit backlog in
// one place.
//
// It also powers a PROGRESS REPORT. The office sets a benchmark ("today's
// numbers") with one tap; from then on every load reports, per team and
// company-wide:
//   started   — how many no-sits were on the list when the benchmark was set
//   moved_off  — benchmark no-sits that are no longer on the list (re-booked)
//   added      — no-sits that appeared AFTER the benchmark
//   current    — what's on the list right now (= started - moved_off + added)
//
// The benchmark is a snapshot of the JN job ids that were no-sits at set
// time, stored per zone in the shared app_settings key/value table
// (key = "nosit_benchmark"). No new table / migration needed.
//
// CORS-open: called from the TMS Regional Managers admin screen.
//
// GET  /.netlify/functions/all-no-sits[?days=90]      → report + progress
// GET  /.netlify/functions/all-no-sits?action=set-benchmark   → freeze today
// GET  /.netlify/functions/all-no-sits?action=clear-benchmark → remove it
//
// Env: JOBNIMBUS_API_KEY, VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY.

const JN_BASE = "https://app.jobnimbus.com/api1";
// include_inactive=1 so a no-sit from a departed rep still resolves to that
// rep's zone (lands in the correct region) instead of falling to Unassigned.
const TMS_REP_ZONES_URL = "https://trainingmanagementsys.netlify.app/.netlify/functions/rep-zones?include_inactive=1";
const JN_KEY = process.env.JOBNIMBUS_API_KEY;
const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const BENCHMARK_KEY = "nosit_benchmark";
const ZONE_ORDER = ["Zone 1", "Zone 2", "Zone 3", "Zone 4"];

// A status is a "no sit" if, stripped to letters/numbers/spaces, it starts
// with "no sit" — but NOT "No Sit - Rescheduled" (already re-booked).
function isNoSit(statusName) {
  const s = String(statusName || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  if (!s.startsWith("no sit")) return false;
  if (s.includes("rescheduled")) return false;
  return true;
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return cors(200, "");
  if (event.httpMethod !== "GET") return cors(405, JSON.stringify({ ok: false, error: "Method Not Allowed" }));
  if (!JN_KEY) return cors(500, JSON.stringify({ ok: false, error: "Missing JOBNIMBUS_API_KEY" }));

  const qp = event.queryStringParameters || {};
  const action = (qp.action || "").trim();
  const days = Math.min(Math.max(parseInt(qp.days, 10) || 90, 7), 365);

  if (action === "statuses") {
    // Diagnostic: distinct JN status names + counts in the window. Handy for
    // tuning which statuses count as "converted back to an appointment".
    const jnHeaders = { Authorization: `bearer ${JN_KEY}`, "Content-Type": "application/json" };
    const sinceSec = Math.floor(Date.now() / 1000) - days * 24 * 60 * 60;
    const jobs = await fetchRecentJobs(jnHeaders, sinceSec);
    const counts = {};
    for (const j of jobs) { const n = j.status_name || "(none)"; counts[n] = (counts[n] || 0) + 1; }
    const list = Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count }));
    return cors(200, JSON.stringify({ ok: true, total_jobs: jobs.length, statuses: list }));
  }

  if (action === "clear-benchmark") {
    await writeBenchmark(null);
    return cors(200, JSON.stringify({ ok: true, cleared: true }));
  }

  // Pull the current no-sits across every zone.
  const current = await pullNoSits(days); // { zones:[...], total, idsByZone }

  if (action === "set-benchmark") {
    const snapshot = { at: new Date().toISOString(), zones: current.idsByZone };
    const saved = await writeBenchmark(snapshot);
    if (!saved) return cors(502, JSON.stringify({ ok: false, error: "Could not save benchmark" }));
    return cors(200, JSON.stringify({ ok: true, benchmark_at: snapshot.at }));
  }

  // Default: report + progress vs the stored benchmark (if any).
  const benchmark = await readBenchmark();
  const progress = benchmark ? computeProgress(benchmark, current.idsByZone) : null;

  return cors(200, JSON.stringify({
    ok: true,
    days,
    total: current.total,
    zones: current.zones,
    benchmark_at: benchmark?.at || null,
    progress,
  }));
};

// ── Pull + group current no-sits across all zones ────────────────────
async function pullNoSits(days) {
  const jnHeaders = { Authorization: `bearer ${JN_KEY}`, "Content-Type": "application/json" };
  const sinceSec = Math.floor(Date.now() / 1000) - days * 24 * 60 * 60;

  const jobs = await fetchRecentJobs(jnHeaders, sinceSec);
  const noSits = jobs.filter((j) => isNoSit(j.status_name));
  const dir = await fetchRepDirectory();

  // zone -> rep -> [deals]
  const byZone = {};
  const idsByZone = {};
  let total = 0;
  for (const j of noSits) {
    const zone = dir(j.sales_rep, j.sales_rep_name)?.zone || "Unassigned";
    const jnid = j.jnid || j.id || `${j.sales_rep_name || ""}|${j.date_start || ""}|${j.name || ""}`;
    total++;
    const rep = (j.sales_rep_name || "").trim() || "(no rep)";
    const customer = j.primary && j.primary.name ? String(j.primary.name).replace(/\s+/g, " ").trim() : "—";
    const address = [j.address_line1, j.city, j.state_text, j.zip].filter(Boolean).join(", ");
    const apptSec = Number(j.date_start);
    const appt = Number.isFinite(apptSec) && apptSec > 0 ? apptSec : null;
    // "Scheduled" = when the JN record was created (when they booked it).
    const createdSec = Number(j.date_created);
    const created = Number.isFinite(createdSec) && createdSec > 0 ? createdSec : null;

    (idsByZone[zone] = idsByZone[zone] || []).push(jnid);
    const zoneBucket = (byZone[zone] = byZone[zone] || {});
    (zoneBucket[rep] = zoneBucket[rep] || []).push({
      jnid,
      customer,
      address,
      appt,
      appt_label: appt ? apptLabel(new Date(appt * 1000)) : "No appt date set",
      scheduled: created,
      scheduled_label: created ? dtLabel(new Date(created * 1000)) : null,
      status: j.status_name || "No Sit",
    });
  }

  const zones = Object.entries(byZone)
    .map(([zone, repMap]) => ({
      zone,
      count: Object.values(repMap).reduce((n, deals) => n + deals.length, 0),
      reps: Object.entries(repMap)
        .map(([rep, deals]) => ({ rep, count: deals.length, deals: deals.sort((a, b) => (b.appt || 0) - (a.appt || 0)) }))
        .sort((a, b) => b.count - a.count || a.rep.localeCompare(b.rep)),
    }))
    .sort(zoneSort);

  return { zones, total, idsByZone };
}

// ── Progress: diff current vs benchmark, per zone + company total ─────
function computeProgress(benchmark, currentIdsByZone) {
  const benchZones = benchmark.zones || {};
  const allZones = new Set([...Object.keys(benchZones), ...Object.keys(currentIdsByZone)]);

  const zones = [];
  const totals = { started: 0, moved_off: 0, added: 0, current: 0 };
  for (const zone of allZones) {
    const bench = new Set(benchZones[zone] || []);
    const cur = new Set(currentIdsByZone[zone] || []);
    let moved_off = 0;
    for (const id of bench) if (!cur.has(id)) moved_off++;
    let added = 0;
    for (const id of cur) if (!bench.has(id)) added++;
    const row = { zone, started: bench.size, moved_off, added, current: cur.size };
    zones.push(row);
    totals.started += row.started;
    totals.moved_off += row.moved_off;
    totals.added += row.added;
    totals.current += row.current;
  }
  zones.sort(zoneSort);
  return { total: totals, zones };
}

function zoneSort(a, b) {
  const ai = ZONE_ORDER.indexOf(a.zone), bi = ZONE_ORDER.indexOf(b.zone);
  const ar = ai === -1 ? 99 : ai, br = bi === -1 ? 99 : bi;
  return ar - br || a.zone.localeCompare(b.zone);
}

// ── Benchmark storage (shared app_settings key/value table) ──────────
const sbHeaders = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" };

async function readBenchmark() {
  if (!SB_URL || !SB_KEY) return null;
  try {
    const r = await fetch(
      `${SB_URL}/rest/v1/app_settings?key=eq.${encodeURIComponent(BENCHMARK_KEY)}&select=value&limit=1`,
      { headers: sbHeaders },
    );
    if (!r.ok) return null;
    const rows = await r.json().catch(() => []);
    const v = rows?.[0]?.value;
    if (!v) return null;
    const parsed = typeof v === "string" ? JSON.parse(v) : v;
    return parsed && parsed.zones ? parsed : null;
  } catch {
    return null;
  }
}

async function writeBenchmark(snapshot) {
  if (!SB_URL || !SB_KEY) return false;
  try {
    const r = await fetch(`${SB_URL}/rest/v1/app_settings?on_conflict=key`, {
      method: "POST",
      headers: { ...sbHeaders, Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({
        key: BENCHMARK_KEY,
        value: snapshot ? JSON.stringify(snapshot) : null,
        updated_at: new Date().toISOString(),
      }),
    });
    return r.ok;
  } catch {
    return false;
  }
}

// ── JN + rep-zone helpers (same as zone-no-sits) ─────────────────────
function apptLabel(date) {
  const datePart = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric" }).format(date);
  const hm = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(date);
  if (hm === "00:00" || hm === "24:00") return datePart;
  const timePart = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" }).format(date);
  return `${datePart} · ${timePart}`;
}

// Date + time in Eastern — used for the "scheduled" (record-created) stamp,
// which always carries a real clock time.
function dtLabel(date) {
  return new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(date);
}

async function fetchRecentJobs(jnHeaders, sinceSec) {
  const all = [];
  for (let page = 0; page < 15; page++) {
    const r = await fetch(`${JN_BASE}/jobs?size=100&from=${page * 100}&sort=-date_updated&date_updated_after=${sinceSec}`, { headers: jnHeaders });
    if (!r.ok) break;
    const d = await r.json().catch(() => ({}));
    const rows = d.results || d.jobs || [];
    all.push(...rows);
    if (rows.length < 100) break;
  }
  return all;
}

async function fetchRepDirectory() {
  let reps = [];
  try { const res = await fetch(TMS_REP_ZONES_URL); if (res.ok) reps = (await res.json()).reps || []; }
  catch (e) { console.warn("rep-zones fetch failed:", e.message || e); }
  const byJnId = {}, byName = {};
  for (const r of reps) {
    const entry = { zone: r.zone || null };
    if (r.jobnimbus_id) byJnId[r.jobnimbus_id] = entry;
    if (r.name) byName[normalizeName(r.name)] = entry;
  }
  return (jnId, name) => (jnId && byJnId[jnId]) || byName[normalizeName(name)] || null;
}

function normalizeName(s) {
  return String(s || "").toLowerCase()
    .replace(/["“”]([^"“”]*)["“”]/g, "").replace(/'([^']*)'/g, "").replace(/\(([^)]*)\)/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
}

function cors(status, body) {
  return {
    statusCode: status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
    body,
  };
}
