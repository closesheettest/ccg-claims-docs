// netlify/functions/pa-schedule-api.js
//
// Powers appointment scheduling from the Power Dialer. PAs set recurring weekly
// availability (pa_availability) in their portal; this turns that into concrete
// open 2-hour slots ACROSS ALL PAs (soonest first), and books one — which:
//   • creates the appointment (pa_appointments)
//   • REASSIGNS the homeowner to whichever PA's slot was booked (inspections.
//     pa_id → that PA, claimed/active) — even if they were assigned elsewhere
//   • marks the dialer lead done ("appointment_set")
//   • texts the PA and the PA's company (and emails the company if on file)
//
// Token: app_settings 'dialer_token' (same link the dialer uses).
//
// Actions (POST { action, token, ... }):
//   'slots'  { days? }                       → { slots:[{ start_at, end_at,
//              pa_id, pa_name, pa_company_id, pa_company_name, label }] }
//   'book'   { pa_id, start_at, inspection_id?, homeowner_name, homeowner_phone,
//              address, booked_by, notes? }   → { ok, appointment }
//
// Env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, plus URL for the SMS relay.

const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const sb = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" };
const SLOT_MIN = 120;       // 2-hour appointments
const HORIZON_DAYS = 14;    // how far out to offer slots
const MAX_MI = 100;         // hide PAs farther than this from an in-person appt

// Fixed grid of designated 2-hour appointment START times (hour, ET) per
// weekday (0=Sun … 6=Sat). EVERY PA is available for ALL of these by default;
// they only mark the ones they CAN'T do (stored in pa_slot_blocks).
const WD_HOURS = {
  1: [9, 11, 13, 15, 17, 19], 2: [9, 11, 13, 15, 17, 19], 3: [9, 11, 13, 15, 17, 19],
  4: [9, 11, 13, 15, 17, 19], 5: [9, 11, 13, 15, 17, 19],
  6: [9, 11, 13, 15],
};
const SLOT_TIMES_MIN = Object.fromEntries(Object.entries(WD_HOURS).map(([wd, hrs]) => [wd, hrs.map((h) => h * 60)]));

// ── PA coverage zones: TWO coasts, the state split down the middle by longitude.
// West of SPLIT_LNG = West Coast (Gulf + panhandle); east = East Coast (Atlantic).
// Separate from the 4 sales zones in all-no-sits.js. Combined with a hard 100-mi
// cap, a PA is offered an appt only on a coast they cover AND within their radius.
const SPLIT_LNG = -81.5;
function lngToZone(lng) { return (lng == null || !Number.isFinite(+lng)) ? null : (+lng < SPLIT_LNG ? "West Coast" : "East Coast"); }

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return cors(200, "");
  if (event.httpMethod !== "POST") return cors(405, JSON.stringify({ ok: false, error: "POST only" }));
  if (!SB_URL || !SB_KEY) return cors(500, JSON.stringify({ ok: false, error: "Supabase env missing" }));

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { return cors(400, JSON.stringify({ ok: false, error: "bad JSON" })); }
  const action = String(body.action || "").trim();
  const token = String(body.token || "").trim();
  if (!token) return cors(400, JSON.stringify({ ok: false, error: "token required" }));
  // Accept the dialer's token OR the public visit-hub token (rep Damage flow).
  const [wantDialer, wantVisit] = await Promise.all([getSetting("dialer_token"), getSetting("visit_token")]);
  if (token !== wantDialer && token !== wantVisit) return cors(401, JSON.stringify({ ok: false, error: "Invalid link" }));

  try {
    if (action === "slots") {
      const days = Math.min(Math.max(parseInt(body.days, 10) || HORIZON_DAYS, 1), 30);
      // Homeowner location (for distance) + zone (for PA coverage) — from the
      // inspection, or passed direct.
      let home = null, apptZone = null;
      const inspId = String(body.inspection_id || "").trim();
      if (inspId) {
        const r = (await sbGet(`inspections?id=eq.${encodeURIComponent(inspId)}&select=latitude,longitude&limit=1`))[0];
        if (r && r.latitude != null && r.longitude != null) home = { lat: +r.latitude, lng: +r.longitude };
      }
      if (!home && body.lat != null && body.lng != null) home = { lat: +body.lat, lng: +body.lng };
      if (home) apptZone = lngToZone(home.lng);                          // coast by longitude
      if (!apptZone && body.zone) apptZone = String(body.zone).trim();   // optional explicit override
      // pa_id → restrict to ONE PA's own open slots (the PA self-scheduler shows
      // only their availability; the rep booker omits pa_id to see every PA).
      const onlyPaId = String(body.pa_id || "").trim() || null;
      return cors(200, JSON.stringify({ ok: true, slots: await buildSlots(days, home, apptZone, onlyPaId) }));
    }
    if (action === "book") return await book(body);
    return cors(400, JSON.stringify({ ok: false, error: `Unknown action: ${action}` }));
  } catch (e) {
    return cors(500, JSON.stringify({ ok: false, error: e.message || "error" }));
  }
};

async function buildSlots(days, home, apptZone, onlyPaId) {
  const paFilter = onlyPaId ? `id=eq.${encodeURIComponent(onlyPaId)}` : `active=eq.true`;
  const pas = await sbGet(`pas?${paFilter}&select=id,name,pa_company_id,latitude,longitude,max_distance_miles&limit=500`);
  if (!pas.length) return [];
  // PA zone coverage — fetched separately and tolerantly so this works even
  // before the pas.zones column exists (then nobody is zone-filtered). A PA with
  // an empty zones[] covers ALL zones (backward compatible).
  const zonesByPa = {};
  try {
    for (const p of (await sbGet(`pas?active=eq.true&select=id,zones&limit=500`))) {
      if (Array.isArray(p.zones) && p.zones.length) zonesByPa[p.id] = p.zones;
    }
  } catch { /* zones column not added yet — skip zone filtering */ }
  // Distance (mi) from the homeowner to each PA's home base, when both geocoded.
  const distByPa = {};
  for (const p of pas) {
    distByPa[p.id] = (home && p.latitude != null && p.longitude != null)
      ? Math.round(haversineMi(home.lat, home.lng, +p.latitude, +p.longitude)) : null;
  }
  const companyIds = [...new Set(pas.map((p) => p.pa_company_id).filter(Boolean))];
  const companies = companyIds.length
    ? await sbGet(`pa_companies?id=in.(${companyIds.map((x) => `"${x}"`).join(",")})&select=id,name`)
    : [];
  const companyName = {}; for (const c of companies) companyName[c.id] = c.name;

  // Blocked designated slots per PA (absence = available). Key: "weekday:startMin".
  const blocks = await sbGet(`pa_slot_blocks?select=pa_id,weekday,start_min&limit=20000`);
  const blockedByPa = {}; for (const b of blocks) (blockedByPa[b.pa_id] = blockedByPa[b.pa_id] || new Set()).add(`${b.weekday}:${b.start_min}`);

  // DATE-specific blocks per PA — one-off days/slots off (e.g. "off June 2nd
  // 9–11"), layered ON TOP of the weekly pattern. Key: "YYYY-MM-DD:startMin".
  // Tolerant of the pa_date_blocks table not existing yet (treats as none).
  let dateBlocks = [];
  try { dateBlocks = (await sbGet(`pa_date_blocks?select=pa_id,date,start_min&limit=20000`)) || []; } catch { dateBlocks = []; }
  const dateBlockedByPa = {}; for (const b of dateBlocks) (dateBlockedByPa[b.pa_id] = dateBlockedByPa[b.pa_id] || new Set()).add(`${b.date}:${b.start_min}`);

  // Existing scheduled appointments to subtract (overlap check per PA).
  const nowMs = Date.now();
  const appts = await sbGet(`pa_appointments?status=eq.scheduled&start_at=gte.${encodeURIComponent(new Date(nowMs - 864e5).toISOString())}&select=pa_id,start_at,end_at&limit=5000`);
  const apptByPa = {}; for (const a of appts) (apptByPa[a.pa_id] = apptByPa[a.pa_id] || []).push([Date.parse(a.start_at), Date.parse(a.end_at)]);

  const slots = [];
  for (let d = 0; d < days; d++) {
    const { y, mo, day, weekday } = etDateParts(nowMs + d * 864e5);
    const times = SLOT_TIMES_MIN[weekday] || [];
    if (!times.length) continue;
    const dateStr = `${y}-${String(mo).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    for (const pa of pas) {
      // Coverage = on a COAST the PA covers AND within their mile RADIUS of home.
      // Radius is hard-capped at MAX_MI (100) — no PA is ever offered an appt
      // farther than that. Unknown distance (no home geocode) → don't exclude on
      // distance. No coasts picked → distance-only (within their radius).
      const dist = distByPa[pa.id];
      // A PA booking their OWN deal (onlyPaId) sees all their open slots — skip the
      // coast/distance coverage gates the rep-facing booker applies.
      if (!onlyPaId) {
        const radius = Math.min(MAX_MI, (pa.max_distance_miles > 0) ? +pa.max_distance_miles : MAX_MI);
        if (dist != null && dist > radius) continue;             // beyond their radius (≤100 mi)
        const zs = zonesByPa[pa.id];
        if (zs && zs.length && apptZone && !zs.includes(apptZone)) continue;  // wrong coast
      }
      const blocked = blockedByPa[pa.id];
      const dblocked = dateBlockedByPa[pa.id];
      for (const s of times) {
        if (blocked && blocked.has(`${weekday}:${s}`)) continue;   // weekly: PA marked this one off
        if (dblocked && dblocked.has(`${dateStr}:${s}`)) continue;  // date-specific: off this exact date
        const startMs = etToUtcMs(y, mo, day, s);
        const endMs = startMs + SLOT_MIN * 60000;
        if (startMs <= nowMs) continue;                       // no past slots
        const taken = (apptByPa[pa.id] || []).some(([as, ae]) => startMs < ae && endMs > as);
        if (taken) continue;
        slots.push({
          start_at: new Date(startMs).toISOString(),
          end_at: new Date(endMs).toISOString(),
          pa_id: pa.id, pa_name: pa.name,
          pa_company_id: pa.pa_company_id || null,
          pa_company_name: companyName[pa.pa_company_id] || null,
          distance_mi: dist,
          label: etLabel(startMs, endMs),
        });
      }
    }
  }
  // Soonest first; for the same time, the closer PA first (unknown distance last).
  slots.sort((a, b) =>
    Date.parse(a.start_at) - Date.parse(b.start_at) ||
    ((a.distance_mi ?? 1e9) - (b.distance_mi ?? 1e9)) ||
    (a.pa_name || "").localeCompare(b.pa_name || ""));
  return slots.slice(0, 60);
}

// Great-circle distance in miles.
function haversineMi(lat1, lon1, lat2, lon2) {
  const R = 3958.8, toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

async function book(body) {
  const paId = String(body.pa_id || "").trim();
  const startAt = String(body.start_at || "").trim();
  if (!paId || !startAt) return cors(400, JSON.stringify({ ok: false, error: "pa_id and start_at required" }));
  const startMs = Date.parse(startAt);
  if (!startMs) return cors(400, JSON.stringify({ ok: false, error: "bad start_at" }));
  const endMs = startMs + SLOT_MIN * 60000;

  const paRows = await sbGet(`pas?id=eq.${encodeURIComponent(paId)}&select=id,name,phone,email,pa_company_id&limit=1`);
  const pa = paRows[0];
  if (!pa) return cors(400, JSON.stringify({ ok: false, error: "PA not found" }));

  // Re-check the slot is still free (no overlapping scheduled appt for this PA).
  const clash = await sbGet(`pa_appointments?pa_id=eq.${encodeURIComponent(paId)}&status=eq.scheduled&start_at=lt.${encodeURIComponent(new Date(endMs).toISOString())}&end_at=gt.${encodeURIComponent(new Date(startMs).toISOString())}&select=id&limit=1`);
  if (clash.length) return cors(409, JSON.stringify({ ok: false, error: "That slot was just taken — pick another." }));

  const inspectionId = String(body.inspection_id || "").trim() || null;
  const homeowner = String(body.homeowner_name || "").trim();
  const phone = String(body.homeowner_phone || "").trim();
  const address = String(body.address || "").trim();
  const bookedBy = String(body.booked_by || "").trim() || "Dialer";
  const notes = String(body.notes || "").slice(0, 1000) || null;

  // Reschedule (e.g. nobody home): cancel this homeowner's existing scheduled
  // appointment(s) FIRST, so booking the new time is a MOVE, not a second appt.
  if (body.reschedule) {
    const cancelQ = inspectionId
      ? `pa_appointments?inspection_id=eq.${encodeURIComponent(inspectionId)}&status=eq.scheduled`
      : phone ? `pa_appointments?homeowner_phone=eq.${encodeURIComponent(phone)}&status=eq.scheduled` : null;
    if (cancelQ) {
      await fetch(`${SB_URL}/rest/v1/${cancelQ}`, {
        method: "PATCH", headers: { ...sb, Prefer: "return=minimal" },
        body: JSON.stringify({ status: "cancelled", notes: "Rescheduled — nobody home" }),
      }).catch(() => {});
    }
  }

  // Per-HOMEOWNER duplicate guard: if this homeowner already has a scheduled PA
  // appointment (matched by inspection, or by phone when there's no inspection
  // id), don't silently create a second one. Return the existing appt so the rep
  // can change the time or knowingly book anyway (force:true). Skipped on force
  // or reschedule (a reschedule already cancelled the old one above).
  if (!body.force && !body.reschedule) {
    const dupQ = inspectionId
      ? `pa_appointments?inspection_id=eq.${encodeURIComponent(inspectionId)}&status=eq.scheduled&select=id,start_at,pa_id,homeowner_name&order=start_at&limit=1`
      : phone
        ? `pa_appointments?homeowner_phone=eq.${encodeURIComponent(phone)}&status=eq.scheduled&select=id,start_at,pa_id,homeowner_name&order=start_at&limit=1`
        : null;
    if (dupQ) {
      const dup = await sbGet(dupQ);
      if (dup.length) {
        const ex = dup[0];
        const exPa = (await sbGet(`pas?id=eq.${encodeURIComponent(ex.pa_id)}&select=name&limit=1`))[0];
        return cors(200, JSON.stringify({
          ok: false, duplicate: true,
          existing: { id: ex.id, start_at: ex.start_at, pa_name: exPa?.name || null, homeowner_name: ex.homeowner_name || homeowner },
        }));
      }
    }
  }

  // 1. Create the appointment.
  const ins = await fetch(`${SB_URL}/rest/v1/pa_appointments`, {
    method: "POST", headers: { ...sb, Prefer: "return=representation" },
    body: JSON.stringify({
      pa_id: paId, pa_company_id: pa.pa_company_id || null, inspection_id: inspectionId,
      homeowner_name: homeowner, homeowner_phone: phone, address,
      start_at: new Date(startMs).toISOString(), end_at: new Date(endMs).toISOString(),
      booked_by: bookedBy, status: "scheduled", notes,
    }),
  });
  if (!ins.ok) return cors(502, JSON.stringify({ ok: false, error: `insert ${ins.status}: ${(await ins.text()).slice(0, 200)}` }));
  const appointment = (await ins.json().catch(() => []))[0] || null;

  // 2. Reassign the homeowner to the booked PA (even if assigned elsewhere).
  if (inspectionId) {
    const nowIso = new Date().toISOString();
    await fetch(`${SB_URL}/rest/v1/inspections?id=eq.${encodeURIComponent(inspectionId)}`, {
      method: "PATCH", headers: { ...sb, Prefer: "return=minimal" },
      body: JSON.stringify({ pa_id: paId, pa_company_id: null, pa_claimed_at: nowIso, pa_stage: "active", pa_stage_at: nowIso }),
    });
    // 3. Mark the dialer lead handled so it leaves the queue.
    await fetch(`${SB_URL}/rest/v1/call_queue?inspection_id=eq.${encodeURIComponent(inspectionId)}`, {
      method: "PATCH", headers: { ...sb, Prefer: "return=minimal" },
      body: JSON.stringify({ status: "done", disposition: "appointment_set", last_called_at: nowIso, claimed_by: null, claimed_at: null, notes: `Appt ${etLabel(startMs, endMs)} w/ ${pa.name}`, updated_at: nowIso }),
    });
  }

  // 4. Notify the PA + their company + (optionally) the homeowner.
  const base = process.env.URL || process.env.DEPLOY_URL || process.env.PUBLIC_SITE_URL || "";
  const when = etLabel(startMs, endMs);
  const MONITOR_PHONE = "7275037017"; // TEMP: copy Neal so he can confirm delivery — remove when he shuts his off.

  // PA — SMS + email with the details.
  const paApptMsg = `📅 New appointment: ${homeowner || "a homeowner"}${address ? ` — ${address}` : ""} on ${when}.${phone ? ` Homeowner: ${phone}.` : ""} (booked by ${bookedBy})`;
  if (base && pa.phone) await sms(base, pa.phone, pa.name, paApptMsg);
  if (base && pa.email) await email(base, pa.email, "📅 New appointment booked for you", paApptMsg);

  // Company — load once (tolerant of the homeowner-confirm columns not existing
  // yet), notify the admin, and reuse for the homeowner confirmation below.
  let co = null;
  if (pa.pa_company_id) {
    const full = `pa_companies?id=eq.${encodeURIComponent(pa.pa_company_id)}&select=name,admin_name,admin_phone,email,homeowner_confirm_enabled,homeowner_confirm_sms,homeowner_confirm_email_subject,homeowner_confirm_email_body&limit=1`;
    const basic = `pa_companies?id=eq.${encodeURIComponent(pa.pa_company_id)}&select=name,admin_name,admin_phone,email&limit=1`;
    co = (await sbGet(full))[0] || (await sbGet(basic))[0] || null;
    if (co) {
      const coMsg = `📅 Appointment booked for ${pa.name}: ${homeowner || "a homeowner"}${address ? ` — ${address}` : ""} on ${when}.`;
      if (base && co.admin_phone) await sms(base, co.admin_phone, co.admin_name || co.name || "PA Company", coMsg);
      if (base && co.email) await email(base, co.email, `New PA appointment — ${pa.name}`, coMsg);
    }
  }

  // Homeowner confirmation — only when the company turned it on. Company-authored
  // wording with {homeowner} {date} {address} {company} placeholders.
  if (co && co.homeowner_confirm_enabled) {
    const fill = (t) => String(t || "")
      .split("{homeowner}").join(homeowner || "there")
      .split("{date}").join(when).split("{time}").join(when)
      .split("{address}").join(address || "")
      .split("{company}").join(co.name || "");
    const hoSms = fill(co.homeowner_confirm_sms) || `Hi ${homeowner || "there"}, your inspection appointment${address ? ` at ${address}` : ""} is confirmed for ${when}.${co.name ? ` — ${co.name}` : ""}`;
    let hoEmail = null;
    if (inspectionId) hoEmail = ((await sbGet(`inspections?id=eq.${encodeURIComponent(inspectionId)}&select=email&limit=1`))[0] || {}).email || null;
    if (base && phone) await sms(base, phone, homeowner || "Homeowner", hoSms);
    if (base && hoEmail) await email(base, hoEmail, fill(co.homeowner_confirm_email_subject) || "Your appointment is confirmed", fill(co.homeowner_confirm_email_body) || hoSms);
  }

  // Monitor copy — so Neal can confirm notifications are firing (temporary).
  if (base && MONITOR_PHONE) await sms(base, MONITOR_PHONE, "Monitor", `🔔 PA appt set: ${homeowner || "homeowner"} — ${when} w/ ${pa.name}${co ? ` (${co.name})` : ""}. Booked by ${bookedBy}.`);

  return cors(200, JSON.stringify({ ok: true, appointment, reassigned_to: pa.name }));
}

// ── ET date/time helpers (DST-safe, no external tz lib) ─────────────────
function etDateParts(ms) {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "numeric", day: "numeric", weekday: "short" });
  const p = {}; for (const x of f.formatToParts(new Date(ms))) p[x.type] = x.value;
  const wmap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { y: +p.year, mo: +p.month, day: +p.day, weekday: wmap[p.weekday] };
}
// Convert a wall-clock ET (date + minutes from midnight) to a UTC instant.
function etToUtcMs(y, mo, day, minutes) {
  const hh = Math.floor(minutes / 60), mm = minutes % 60;
  const guess = Date.UTC(y, mo - 1, day, hh, mm);
  // What does that UTC instant read as in ET? The delta is the zone offset.
  const asEt = new Date(new Date(guess).toLocaleString("en-US", { timeZone: "America/New_York" }));
  const offset = guess - asEt.getTime();
  return guess + offset;
}
function etLabel(startMs, endMs) {
  const d = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric" }).format(new Date(startMs));
  const t1 = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" }).format(new Date(startMs));
  const t2 = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" }).format(new Date(endMs));
  return `${d}, ${t1}–${t2}`;
}

async function sms(base, to, name, message) {
  try { await fetch(`${base}/.netlify/functions/ghl-sms`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ to, name, message }) }); } catch { /* best-effort */ }
}
async function email(base, to, subject, text) {
  try { await fetch(`${base}/.netlify/functions/send-email`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ to, subject, html: `<p>${text}</p>` }) }); } catch { /* best-effort */ }
}
async function getSetting(key) {
  const rows = await sbGet(`app_settings?key=eq.${encodeURIComponent(key)}&select=value&limit=1`);
  return rows[0]?.value || null;
}
async function sbGet(path) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: sb });
  if (!r.ok) return [];
  return r.json().catch(() => []);
}
function cors(status, body) {
  return { statusCode: status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" }, body };
}
