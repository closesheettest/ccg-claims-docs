// netlify/functions/harvest-btr-availability.js
//
// Booked times for a BTR (back-to-retail) appointment being scheduled off an
// inspection pin. Same idea as harvest-availability, but the calendar depends
// on who RUNS the appointment:
//   • normal rep  → the rep's own JobNimbus calendar
//   • William (trainer) → the REGIONAL MANAGER of the home's zone runs it, so
//     we show that manager's calendar (resolved from the pin's lat/lng).
//
//   GET ?rt=<rep token>&pin_id=<pin> → { ok, booked:[epoch ms…], owner_name, is_manager, zone }
//
// Env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, JOBNIMBUS_API_KEY

import { jnFetch } from "./_jn.js";
import { resolveManager } from "./_zone-manager.js";

const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const JN_KEY = process.env.JOBNIMBUS_API_KEY;
const APPT_TASK_TYPES = new Set(["Initial Appointment", "Reset Appointment", "Appointment"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// William Hernandez is the outside inspection TRAINER — he doesn't run retail
// appointments himself, so his BTR bookings go on the zone manager's calendar.
const isTrainer = (name) => String(name || "").trim().toLowerCase() === "william hernandez";

export const handler = async (event) => {
  const p = event.queryStringParameters || {};
  const rt = String(p.rt || "").trim();
  const pinId = String(p.pin_id || "").trim();
  if (!SB_URL || !SB_KEY || !JN_KEY) return json(500, { ok: false, error: "env missing" });
  if (!UUID.test(rt)) return json(200, { ok: true, booked: [] });

  const sbH = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` };
  const sbGet = (path) => fetch(`${SB_URL}/rest/v1/${path}`, { headers: sbH }).then((r) => (r.ok ? r.json() : [])).catch(() => []);

  const rep = (await sbGet(`sales_reps?harvest_token=eq.${encodeURIComponent(rt)}&select=name,jobnimbus_id&limit=1`))[0];
  if (!rep) return json(200, { ok: true, booked: [] });

  // Whose calendar are we checking?
  let ownerJn = rep.jobnimbus_id || null;
  let ownerName = rep.name || "you";
  let isManager = false;
  let zone = null;
  if (isTrainer(rep.name) && pinId) {
    const pin = (await sbGet(`canvass_prospects?id=eq.${encodeURIComponent(pinId)}&select=latitude,longitude,extra&limit=1`))[0];
    const county = pin?.extra?.county || pin?.extra?.County || "";
    const mgr = await resolveManager(Number(pin?.latitude), Number(pin?.longitude), county);
    zone = mgr.zone;
    if (mgr.id) { ownerJn = mgr.id; ownerName = mgr.name; isManager = true; }
  }
  if (!ownerJn) return json(200, { ok: true, booked: [], owner_name: ownerName, is_manager: isManager, zone });

  const nowSec = Math.floor(Date.now() / 1000);
  const endSec = nowSec + 15 * 86400;
  const filter = encodeURIComponent(JSON.stringify({ must: [
    { range: { date_start: { gte: nowSec, lte: endSec } } },
    { term: { "owners.id": ownerJn } },
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
        if (!(t.owners || []).some((o) => String(o.id) === String(ownerJn))) continue;
        const sec = Number(t.date_start) || 0;
        if (sec) booked.push(sec * 1000);
      }
      if (rows.length < 100) break;
    }
  } catch { /* return what we have */ }

  return json(200, { ok: true, booked, owner_name: ownerName, is_manager: isManager, zone });
};

function json(statusCode, obj) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) };
}
