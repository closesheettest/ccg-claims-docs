// netlify/functions/goback-report.js
//
// The Auto-Schedule-After-Inspection funnel report (shown at the bottom of ?mode=
// gobackschedule): every homeowner the sequence texted, how many texts went out, and
// whether they SELF-SCHEDULED their come-back review (inspections.review_appt_at set).
//
//   GET ?period=today|week|lastweek|30d|all   (default: 30d)
//     → { ok, period, summary:{ texted, opened, booked, rate, open_rate, warm },
//         rows:[{ name, phone, rep, texts, first_sent, last_sent, opened_at,
//                 booked, review_appt_at }] }
//
//   OPENED is the number that matters most day to day: contacted only says a
//   message left the building. Opened-but-not-booked ("warm") is a homeowner who
//   read it, clicked, looked at the times — and stopped. That's a call worth
//   making, and it's a much shorter list than "everyone we texted".
//
// Env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY

const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const sb = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` };

// Rep → zone/team, so the report can be read by team without anyone having to
// remember who's on what. Names come from the TMS rep-zones feed, matched
// loosely because our sales_rep_name can carry extra spacing or a second
// surname (see the rep-name matching gotcha).
const ZONE_TEAMS = { "Zone 1": "SQUAD", "Zone 2": "SitSold", "Zone 3": "SHARKS", "Zone 4": "HURRICANE" };
const normName = (s) => String(s || "").toLowerCase().replace(/[^a-z ]+/g, " ").replace(/\s+/g, " ").trim();
async function repZones() {
  try {
    const r = await fetch("https://trainingmanagementsys.netlify.app/.netlify/functions/rep-zones?include_inactive=1");
    if (!r.ok) return {};
    const reps = (await r.json()).reps || [];
    const m = {};
    for (const x of reps) {
      if (!x.name || !x.zone) continue;
      m[normName(x.name)] = x.zone;
    }
    return m;
  } catch { return {}; }
}


export const handler = async (event) => {
  const period = String(((event && event.queryStringParameters) || {}).period || "30d").trim();
  if (!SB_URL || !SB_KEY) return resp(500, { ok: false, error: "env missing" });
  try {
    const since = periodStart(period);   // null = all time
    const zones = await repZones();
    const logs = await sbGetAll("goback_text_log?ok=eq.true&select=inspection_id,msg_idx,sent_at&order=sent_at.asc");
    const byInsp = new Map(); // id → { texts, first, last }
    for (const l of logs) {
      const e = byInsp.get(l.inspection_id) || { texts: 0, first: l.sent_at, last: l.sent_at };
      e.texts++; if (l.sent_at < e.first) e.first = l.sent_at; if (l.sent_at > e.last) e.last = l.sent_at;
      byInsp.set(l.inspection_id, e);
    }
    // Bucket by the FIRST message — a homeowner belongs to the week we first
    // reached them, not to whichever follow-up happens to land inside the window.
    for (const [id, e] of [...byInsp]) {
      if (since && e.first < since.from) byInsp.delete(id);
      else if (since && since.to && e.first >= since.to) byInsp.delete(id);
    }
    const ids = [...byInsp.keys()];
    if (!ids.length) return resp(200, { ok: true, period, summary: { texted: 0, opened: 0, booked: 0, rate: 0, open_rate: 0, warm: 0 }, rows: [] });

    const insps = [];
    for (let i = 0; i < ids.length; i += 200) {
      const chunk = ids.slice(i, i + 200).map((x) => `"${x}"`).join(",");
      // goback_opened_at is a newer column (sql/goback_opened.sql). PostgREST
      // rejects the WHOLE query for one unknown column, which returned zero
      // inspections and rendered every homeowner as "—". Ask for it, and fall
      // back to the same query without it so a pre-migration database still
      // shows names — it just can't show opens yet.
      const SEL = "id,client_name,mobile,sales_rep_name,review_appt_at,result_at";
      let chunkRows = await sbGetAll(`inspections?id=in.(${chunk})&select=${SEL},goback_opened_at`);
      if (!chunkRows.length) chunkRows = await sbGetAll(`inspections?id=in.(${chunk})&select=${SEL}`);
      insps.push(...chunkRows);
    }
    const inspById = Object.fromEntries(insps.map((i) => [i.id, i]));

    let booked = 0, opened = 0, warm = 0;
    const rows = ids.map((id) => {
      const e = byInsp.get(id), i = inspById[id] || {};
      const isBooked = !!i.review_appt_at;
      const isOpen = !!i.goback_opened_at;
      if (isBooked) booked++;
      if (isOpen) opened++;
      if (isOpen && !isBooked) warm++;
      const zone = zones[normName(i.sales_rep_name)] || null;
      return {
        name: i.client_name || "—", phone: i.mobile || "", rep: i.sales_rep_name || "—",
        zone, team: zone ? (ZONE_TEAMS[zone] || zone) : null,
        texts: e.texts, first_sent: e.first, last_sent: e.last,
        opened_at: i.goback_opened_at || null, booked: isBooked, review_appt_at: i.review_appt_at || null,
      };
    })
      // Grouped by rep, and inside a rep the WARM ones first — the whole point is
      // to hand a rep their own short call list, not a wall of names.
      .sort((a, b) =>
        (a.team || "zzz").localeCompare(b.team || "zzz") ||
        (a.rep || "").localeCompare(b.rep || "") ||
        (Number(b.opened_at && !b.booked) - Number(a.opened_at && !a.booked)) ||
        (b.last_sent || "").localeCompare(a.last_sent || ""));

    const texted = ids.length;
    return resp(200, {
      ok: true, period,
      summary: {
        texted, opened, booked, warm,
        rate: texted ? Math.round((booked / texted) * 100) : 0,
        open_rate: texted ? Math.round((opened / texted) * 100) : 0,
      },
      rows,
    });
  } catch (e) {
    return resp(500, { ok: false, error: e.message || "error" });
  }
};

async function sbGetAll(path) {
  const out = [];
  for (let from = 0; from < 100000; from += 1000) {
    const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: { ...sb, "Range-Unit": "items", Range: `${from}-${from + 999}` } });
    if (!r.ok) break;
    const rows = await r.json().catch(() => []);
    out.push(...rows);
    if (rows.length < 1000) break;
  }
  return out;
}
// Period windows in ET. `to` is exclusive; null `to` means "up to now".
function periodStart(period) {
  const nowEt = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
  const day = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
  const iso = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString();
  if (period === "all") return null;
  if (period === "today") return { from: iso(day(nowEt)), to: null };
  if (period === "week" || period === "lastweek") {
    const mon = day(nowEt);
    mon.setDate(mon.getDate() - ((mon.getDay() + 6) % 7));           // Monday of this week
    if (period === "week") return { from: iso(mon), to: null };
    const prev = new Date(mon); prev.setDate(prev.getDate() - 7);
    return { from: iso(prev), to: iso(mon) };
  }
  const d = new Date(nowEt.getTime() - 30 * 86400000);
  return { from: iso(day(d)), to: null };                            // 30d default
}

function resp(status, body) { return { statusCode: status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" }, body: JSON.stringify(body) }; }
