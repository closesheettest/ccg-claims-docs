// netlify/functions/harvest-availability.js
//
// Returns the appointment times a rep ALREADY has booked in JobNimbus over the
// next two weeks, so the pin scheduler only offers times they're actually free.
//
//   GET ?rt=<rep token> → { ok, booked:[<epoch ms>, ...] }
//
// Env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, JOBNIMBUS_API_KEY

import { jnFetch } from "./_jn.js";

const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const JN_KEY = process.env.JOBNIMBUS_API_KEY;
const APPT_TASK_TYPES = new Set(["Initial Appointment", "Reset Appointment", "Appointment"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const handler = async (event) => {
  const p = event.queryStringParameters || {};
  const rt = String(p.rt || "").trim();
  if (!SB_URL || !SB_KEY || !JN_KEY) return json(500, { ok: false, error: "env missing" });
  if (!UUID.test(rt)) return json(200, { ok: true, booked: [] });

  const sbH = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` };
  const reps = await fetch(`${SB_URL}/rest/v1/sales_reps?harvest_token=eq.${encodeURIComponent(rt)}&select=jobnimbus_id&limit=1`, { headers: sbH })
    .then((r) => (r.ok ? r.json() : [])).catch(() => []);
  const jn = reps[0]?.jobnimbus_id;
  if (!jn) return json(200, { ok: true, booked: [] });

  const nowSec = Math.floor(Date.now() / 1000);
  const endSec = nowSec + 15 * 86400; // ~2 weeks out (matches the scheduler horizon)
  const filter = encodeURIComponent(JSON.stringify({ must: [
    { range: { date_start: { gte: nowSec, lte: endSec } } },
    { term: { "owners.id": jn } },
  ] }));

  const booked = [];
  try {
    for (let page = 0; page < 5; page++) {
      const r = await jnFetch(JN_KEY, `tasks?size=100&from=${page * 100}&filter=${filter}`);
      if (!r.ok) break;
      const d = await r.json().catch(() => ({}));
      const rows = d.results || d.tasks || d.data || [];
      for (const t of rows) {
        if (!APPT_TASK_TYPES.has(t.record_type_name)) continue;
        // Confirm it's this rep's (in case the owner filter is lenient).
        const owns = (t.owners || []).some((o) => String(o.id) === String(jn));
        if (!owns) continue;
        const sec = Number(t.date_start) || 0;
        if (sec) booked.push(sec * 1000);
      }
      if (rows.length < 100) break;
    }
  } catch { /* JN unreachable → just offer all slots (fail open) */ }

  return json(200, { ok: true, booked });
};

function json(statusCode, obj) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) };
}
