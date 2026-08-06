// netlify/functions/cron-appt-reverse-sync.js
//
// FAST, STANDALONE appointment reverse-sync — the net that flips a Harvesting Map
// pin to "appt" (or sold / etc.) the moment the office books an appointment in
// JobNimbus. This USED to live at the tail of harvest-sync-iq-background.js, AFTER
// three lead sources are processed and every new lead is Google-geocoded one-by-one
// — so on a busy morning it ran late or got starved, and a company appointment
// could sit as a raw "iq" pin long enough for a passing rep to mark it Not
// Interested (the 1092 Fernlea / Michael Powell case: the appt was on a DIFFERENT
// JN contact than the pin, so only the address net could catch it, and it didn't
// in time). Pulling it into its own light cron that runs every ~10 min, beholden to
// nothing, makes company appointments flip within minutes and drop off the workable
// pins before anyone touches them.
//
// It also lets a booked APPOINTMENT (or sale) override a rep's fresh "not
// interested" — a scheduled appointment is stronger evidence than a drive-by NI —
// which closes the residual race (rep NI's the pin in the <10 min before this runs).
//
//   Schedule: every 10 min, 7 AM–9 PM ET. Also callable by hand (GET/POST).
//   Result → app_settings.harvest_addr_reverse_sync (same key the old net wrote).
//
// Env: JOBNIMBUS_API_KEY, VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY

const JN_BASE = "https://app.jobnimbus.com/api1";
const JN_KEY = process.env.JOBNIMBUS_API_KEY;
const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const CAP = 9500;
const LOOKBACK_DAYS = 90;            // company appts are recent; the heavy 30-min sync backstops older jobs

// Map a JN JOB status_name → map pin status. Mirrors harvest-sync-iq-background.js.
const PIN_RANK = { insp_sold: 6, new_roof: 5, appt: 4, retail: 4, no_sit_reschedule: 3, dead: 2, lost: 2, iq_ni: 1, insp_ni: 1 };
function jobPinStatus(name) {
  const s = String(name || "").toLowerCase();
  if (!s) return null;
  if (s.includes("sold") || s.includes("signed")) return (s.includes("insp") || /\bpa\b/.test(s)) ? "insp_sold" : "appt";
  if (s.includes("new roof")) return "new_roof";
  if (s.includes("refused")) return "iq_ni";
  if (s.includes("no sit") || s.includes("no show") || s.includes("reschedul")) return "no_sit_reschedule";
  if (s.includes("appointment") || s.includes("pending")) return "appt";
  if (s.includes("lost") || s.includes("no sale") || s === "dq" || s.includes("disqualif")) return "lost";
  if (s.includes("btr") || s.includes("stale") || s.includes("credit denial") || s.includes("no info") || s.includes("no response")) return "iq_ni";
  return null;
}
const ADDR_SUF = { street: "st", st: "st", avenue: "ave", ave: "ave", av: "ave", place: "pl", pl: "pl", drive: "dr", dr: "dr", lane: "ln", ln: "ln", court: "ct", ct: "ct", terrace: "ter", terr: "ter", ter: "ter", boulevard: "blvd", blvd: "blvd", road: "rd", rd: "rd", circle: "cir", cir: "cir", trail: "trl", trl: "trl", parkway: "pkwy", pkwy: "pkwy", highway: "hwy", hwy: "hwy", cove: "cv", cv: "cv", point: "pt", pt: "pt", square: "sq", sq: "sq" };
const ADDR_DIR = { north: "n", n: "n", south: "s", s: "s", east: "e", e: "e", west: "w", w: "w", northeast: "ne", ne: "ne", northwest: "nw", nw: "nw", southeast: "se", se: "se", southwest: "sw", sw: "sw" };
function streetKey(address) {
  const s = String(address || "").split(",")[0].toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
  if (!s || !/^\d/.test(s)) return null;
  return s.split(" ").map((t) => ADDR_SUF[t] || ADDR_DIR[t] || t).join(" ");
}
function zip5(z) { return String(z || "").replace(/\D/g, "").slice(0, 5); }
const sbHeaders = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" };

async function sbGetAll(path) {
  const out = [];
  for (let from = 0; from < 400000; from += 1000) {
    const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: { ...sbHeaders, "Range-Unit": "items", Range: `${from}-${from + 999}` } });
    if (!r.ok) break; const b = await r.json().catch(() => []); if (!Array.isArray(b) || !b.length) break; out.push(...b); if (b.length < 1000) break;
  }
  return out;
}
// Date-sharded JN pull (past the 10k pagination cap) — same shape as the sync's.
async function sharded(base, headers, must, lo, hi, onRow) {
  const filterFor = (gte, lte) => encodeURIComponent(JSON.stringify({ must: [...must, { range: { date_created: { gte, lte } } }] }));
  const countOf = async (gte, lte) => { const r = await fetch(`${base}?size=1&filter=${filterFor(gte, lte)}`, { headers }); const d = await r.json().catch(() => ({})); return Number(d.count || 0); };
  const drain = async (gte, lte) => { for (let page = 0; page < 100; page++) { const r = await fetch(`${base}?size=100&from=${page * 100}&filter=${filterFor(gte, lte)}`, { headers }); if (!r.ok) break; const d = await r.json().catch(() => ({})); const rows = d.results || d.jobs || []; if (!rows.length) break; rows.forEach(onRow); if (rows.length < 100) break; } };
  const rec = async (gte, lte) => { const c = await countOf(gte, lte); if (!c) return; if (c <= CAP || (lte - gte) <= 86400) { await drain(gte, lte); return; } const mid = Math.floor((gte + lte) / 2); await rec(gte, mid); await rec(mid + 1, lte); };
  await rec(lo, hi);
}
async function writeSetting(key, obj) {
  try { await fetch(`${SB_URL}/rest/v1/app_settings?on_conflict=key`, { method: "POST", headers: { ...sbHeaders, Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify({ key, value: JSON.stringify(obj), updated_at: new Date().toISOString() }) }); } catch { /* ignore */ }
}

export const handler = async () => {
  if (!JN_KEY || !SB_URL) return { statusCode: 500, body: "env missing" };
  const H = { Authorization: `bearer ${JN_KEY}`, "Content-Type": "application/json" };
  const NOW = Math.floor(Date.now() / 1000);
  const LO = NOW - LOOKBACK_DAYS * 86400;
  const nowIso = new Date().toISOString();
  try {
    // 1) Index recent JN jobs by ADDRESS (streetKey → { zip5 → heaviest pin-status }).
    const jobByAddr = {};
    await sharded(`${JN_BASE}/jobs`, H, [], LO, NOW, (job) => {
      const st = jobPinStatus(job.status_name);
      if (!st) return;
      const sk = streetKey(job.address_line1);
      if (!sk) return;
      const z = zip5(job.zip) || "";
      let bucket = jobByAddr[sk]; if (!bucket) { bucket = {}; jobByAddr[sk] = bucket; }
      if (!(z in bucket) || (PIN_RANK[st] || 0) > (PIN_RANK[bucket[z]] || 0)) bucket[z] = st;
    });

    // 2) Every map pin, keyed by normalized street.
    const streetIdx = new Map();
    for (const p of await sbGetAll("canvass_prospects?latitude=not.is.null&select=id,address,status,zip,status_by,status_updated_at")) {
      const sk = streetKey(p.address); if (!sk) continue;
      let arr = streetIdx.get(sk); if (!arr) { arr = []; streetIdx.set(sk, arr); }
      arr.push(p);
    }

    // A rep's fresh field call (last 7 days) wins over an address guess — EXCEPT a
    // booked appointment / sale beats a rep's "not interested" (that's the exact
    // 1092 Fernlea bug: a rep marked a company-booked door NI). Sync-set / old stay
    // eligible for override.
    const REP_PROTECT_MS = 7 * 24 * 60 * 60 * 1000;
    const NI = new Set(["iq_ni", "insp_ni"]);
    const repProtected = (p) => {
      const by = String(p.status_by || "");
      if (!by || /^JN\b/i.test(by)) return false;
      const t = Date.parse(p.status_updated_at || "");
      return Number.isFinite(t) && (Date.now() - t) < REP_PROTECT_MS;
    };

    const patches = [];
    for (const [sk, arr] of streetIdx) {
      const bucket = jobByAddr[sk]; if (!bucket) continue;
      for (const p of arr) {
        const pz = zip5(p.zip) || "";
        let best = null, bestRank = -1;
        for (const z in bucket) {
          if (z && pz && z !== pz) continue;               // zips must agree when both present
          const rk = PIN_RANK[bucket[z]] || 0;
          if (rk > bestRank) { bestRank = rk; best = bucket[z]; }
        }
        if (!best) continue;
        if (p.status === best) continue;
        if ((PIN_RANK[p.status] || 0) >= bestRank) continue;                 // never downgrade a heavier pin
        const apptBeatsNi = (best === "appt" || best === "insp_sold") && NI.has(p.status);
        if (repProtected(p) && !apptBeatsNi) continue;                       // rep call sticks, unless a booked appt beats their NI
        patches.push(fetch(`${SB_URL}/rest/v1/canvass_prospects?id=eq.${p.id}`, {
          method: "PATCH", headers: { ...sbHeaders, Prefer: "return=minimal" },
          body: JSON.stringify({ status: best, status_by: "JN appt (address match)", status_updated_at: nowIso }),
        }).then((r) => r.ok));
      }
    }
    const restatused = (await Promise.all(patches)).filter(Boolean).length;
    await writeSetting("harvest_addr_reverse_sync", { ok: true, restatused, jobs_by_addr: Object.keys(jobByAddr).length, lookback_days: LOOKBACK_DAYS, finished: nowIso, by: "cron-appt-reverse-sync" });
    return { statusCode: 200, body: JSON.stringify({ ok: true, restatused, jobs_by_addr: Object.keys(jobByAddr).length }) };
  } catch (e) {
    await writeSetting("harvest_addr_reverse_sync", { ok: false, error: String(e && e.message || e), finished: nowIso, by: "cron-appt-reverse-sync" });
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: String(e && e.message || e) }) };
  }
};

// Every 10 min, 7 AM–9 PM ET (matches the lead-sync active window). Netlify reads
// this AND the netlify.toml entry.
export const config = { schedule: "*/10 11-23,0-1 * * *" };
