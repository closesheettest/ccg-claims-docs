// netlify/functions/goback-report.js
//
// The Auto-Schedule-After-Inspection funnel report (shown at the bottom of ?mode=
// gobackschedule): every homeowner the sequence texted, how many texts went out, and
// whether they SELF-SCHEDULED their come-back review (inspections.review_appt_at set).
//
//   GET  → { ok, summary:{ texted, booked, rate }, rows:[{ name, phone, rep, texts,
//            first_sent, last_sent, booked, review_appt_at }] }
//
// Env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY

const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const sb = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` };

export const handler = async () => {
  if (!SB_URL || !SB_KEY) return resp(500, { ok: false, error: "env missing" });
  try {
    const logs = await sbGetAll("goback_text_log?ok=eq.true&select=inspection_id,msg_idx,sent_at&order=sent_at.asc");
    const byInsp = new Map(); // id → { texts, first, last }
    for (const l of logs) {
      const e = byInsp.get(l.inspection_id) || { texts: 0, first: l.sent_at, last: l.sent_at };
      e.texts++; if (l.sent_at < e.first) e.first = l.sent_at; if (l.sent_at > e.last) e.last = l.sent_at;
      byInsp.set(l.inspection_id, e);
    }
    const ids = [...byInsp.keys()];
    if (!ids.length) return resp(200, { ok: true, summary: { texted: 0, booked: 0, rate: 0 }, rows: [] });

    const insps = [];
    for (let i = 0; i < ids.length; i += 200) {
      const chunk = ids.slice(i, i + 200).map((x) => `"${x}"`).join(",");
      insps.push(...await sbGetAll(`inspections?id=in.(${chunk})&select=id,client_name,mobile,sales_rep_name,review_appt_at,result_at`));
    }
    const inspById = Object.fromEntries(insps.map((i) => [i.id, i]));

    let booked = 0;
    const rows = ids.map((id) => {
      const e = byInsp.get(id), i = inspById[id] || {};
      const isBooked = !!i.review_appt_at;
      if (isBooked) booked++;
      return { name: i.client_name || "—", phone: i.mobile || "", rep: i.sales_rep_name || "—", texts: e.texts, first_sent: e.first, last_sent: e.last, booked: isBooked, review_appt_at: i.review_appt_at || null };
    }).sort((a, b) => (b.last_sent || "").localeCompare(a.last_sent || ""));

    const texted = ids.length;
    return resp(200, { ok: true, summary: { texted, booked, rate: texted ? Math.round((booked / texted) * 100) : 0 }, rows });
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
function resp(status, body) { return { statusCode: status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" }, body: JSON.stringify(body) }; }
