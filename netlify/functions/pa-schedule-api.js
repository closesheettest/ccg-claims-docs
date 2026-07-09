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
const JN_KEY = process.env.JOBNIMBUS_API_KEY;
const JN_BASE = "https://app.jobnimbus.com/api1";
const GCAL_ID = process.env.GOOGLE_CLIENT_ID;
const GCAL_SECRET = process.env.GOOGLE_CLIENT_SECRET;
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
  // Companies that PAUSED scheduling (not set up / trained yet) → their PAs are
  // offered NO slots until they re-enable. Separate + tolerant query so this
  // works even before the scheduling_paused column exists (then: none paused).
  const pausedCompany = new Set();
  for (const c of await sbGet(`pa_companies?scheduling_paused=eq.true&select=id&limit=500`)) pausedCompany.add(c.id);

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

  // Google Calendar free/busy — for PAs who connected their calendar, pull their
  // BUSY time ranges over the offer window and subtract them, so a rep is never
  // offered a time the PA is busy on their own calendar. We only ever read
  // busy start/end RANGES (the freeBusy API) — never event titles/details, so
  // nothing about the PA's calendar is exposed to the rep. Best-effort: if
  // Google is unreachable for a PA we just don't scrub that PA this run (fail
  // open — better to show availability than none).
  const busyByPa = {};
  if (GCAL_ID && GCAL_SECRET) {
    const tokenByPa = {};
    try { for (const p of await sbGet(`pas?google_refresh_token=not.is.null&select=id,google_refresh_token&limit=500`)) tokenByPa[p.id] = p.google_refresh_token; } catch { /* column not added yet */ }
    const eligible = pas.filter((pa) => tokenByPa[pa.id] && !pausedCompany.has(pa.pa_company_id));
    const minIso = new Date(nowMs).toISOString();
    const maxIso = new Date(nowMs + days * 864e5).toISOString();
    await Promise.all(eligible.map(async (pa) => {
      const busy = await googleFreeBusy(tokenByPa[pa.id], minIso, maxIso);
      if (busy && busy.length) busyByPa[pa.id] = busy;
    }));
  }

  const slots = [];
  for (let d = 0; d < days; d++) {
    const { y, mo, day, weekday } = etDateParts(nowMs + d * 864e5);
    const times = SLOT_TIMES_MIN[weekday] || [];
    if (!times.length) continue;
    const dateStr = `${y}-${String(mo).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    for (const pa of pas) {
      // Company paused scheduling (setup/training not done) → offer nothing.
      if (pausedCompany.has(pa.pa_company_id)) continue;
      // Coverage = within the PA's mile RADIUS of home (hard-capped at MAX_MI,
      // 100). East/West coast zones were removed — it's radius-from-home only.
      // Unknown distance (no home geocode) → don't exclude on distance.
      const dist = distByPa[pa.id];
      // A PA booking their OWN deal (onlyPaId) sees all their open slots — skip the
      // distance coverage gate the rep-facing booker applies.
      if (!onlyPaId) {
        const radius = Math.min(MAX_MI, (pa.max_distance_miles > 0) ? +pa.max_distance_miles : MAX_MI);
        if (dist != null && dist > radius) continue;             // beyond their radius (≤100 mi)
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
        if ((busyByPa[pa.id] || []).some(([bs, be]) => startMs < be && endMs > bs)) continue; // busy on their Google Calendar
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

  const paRows = await sbGet(`pas?id=eq.${encodeURIComponent(paId)}&select=id,name,phone,email,pa_company_id,google_refresh_token&limit=1`);
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
      // Remove the old appointments' Google Calendar events first (best-effort).
      try {
        for (const o of await sbGet(`${cancelQ}&select=id,pa_id,google_event_id`)) {
          if (!o.google_event_id) continue;
          const rt = await paRefreshToken(o.pa_id);
          if (rt) await googleDeleteEvent(rt, o.google_event_id);
        }
      } catch { /* best-effort */ }
      await fetch(`${SB_URL}/rest/v1/${cancelQ}`, {
        method: "PATCH", headers: { ...sb, Prefer: "return=minimal" },
        body: JSON.stringify({ status: "cancelled", notes: "Rescheduled — nobody home" }),
      }).catch(() => {});
    }
  }

  // Per-HOMEOWNER duplicate guard: a rep can't book the same homeowner a second
  // time. Matches an existing SCHEDULED appt by ANY reliable signal — inspection,
  // phone, OR homeowner name + street — so it catches double-books even when the
  // deal has NO phone on file (the Jeanwilson Marseille case). Skipped only on an
  // explicit reschedule (which already cancelled the prior appt above).
  if (!body.reschedule) {
    let dup = null;
    const ors = [];
    if (inspectionId) ors.push(`inspection_id.eq.${encodeURIComponent(inspectionId)}`);
    if (phone) ors.push(`homeowner_phone.eq.${encodeURIComponent(phone)}`);
    if (ors.length) {
      const rows = await sbGet(`pa_appointments?status=eq.scheduled&or=(${ors.join(",")})&select=id,start_at,pa_id,homeowner_name,address&order=start_at&limit=1`);
      if (rows.length) dup = rows[0];
    }
    // Fallback: same homeowner NAME (and same street when we have an address) —
    // the safety net for no-phone / no-inspection bookings.
    if (!dup && homeowner) {
      const nm = homeowner.trim().toLowerCase();
      const street = (address || "").split(",")[0].trim().toLowerCase();
      const like = encodeURIComponent(`*${homeowner.replace(/[%*(),]/g, " ").trim()}*`);
      const rows = await sbGet(`pa_appointments?status=eq.scheduled&homeowner_name=ilike.${like}&select=id,start_at,pa_id,homeowner_name,address&limit=25`);
      dup = rows.find((r) => {
        const rn = (r.homeowner_name || "").trim().toLowerCase();
        const rs = (r.address || "").split(",")[0].trim().toLowerCase();
        return rn === nm || (street && rs && rs === street);
      }) || null;
    }
    if (dup) {
      const exPa = (await sbGet(`pas?id=eq.${encodeURIComponent(dup.pa_id)}&select=name&limit=1`))[0];
      return cors(200, JSON.stringify({
        ok: false, duplicate: true,
        existing: { id: dup.id, start_at: dup.start_at, pa_name: exPa?.name || null, homeowner_name: dup.homeowner_name || homeowner },
      }));
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

  // 1b. Write the appointment onto the PA's Google Calendar (if connected) so it
  // blocks their calendar going forward + they see it. Store the event id so a
  // reschedule/cancel can remove it. Best-effort — never fails the booking.
  if (appointment && pa.google_refresh_token) {
    try {
      const eid = await googleCreateEvent(pa.google_refresh_token, {
        summary: `US Shingle PA appt — ${homeowner || "Homeowner"}`,
        location: address || "",
        description: `Public adjuster appointment.${phone ? `\nHomeowner: ${phone}` : ""}${notes ? `\nNotes: ${notes}` : ""}\nBooked via US Shingle by ${bookedBy}.`,
        startIso: new Date(startMs).toISOString(),
        endIso: new Date(endMs).toISOString(),
      });
      if (eid) await fetch(`${SB_URL}/rest/v1/pa_appointments?id=eq.${encodeURIComponent(appointment.id)}`, {
        method: "PATCH", headers: { ...sb, Prefer: "return=minimal" }, body: JSON.stringify({ google_event_id: eid }),
      });
    } catch { /* best-effort */ }
  }

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
  const whenStart = etStartLabel(startMs);   // exact start time for the homeowner

  // Pull the FULL property address (+ homeowner email) from the inspection so
  // every notification carries street + city + state + zip — the booker's
  // body.address is often just the street.
  let fullAddress = address, hoEmailAddr = null, hoZip = "", hoPhone = phone;
  if (inspectionId) {
    const insp = (await sbGet(`inspections?id=eq.${encodeURIComponent(inspectionId)}&select=address,city,state,zip,email,mobile&limit=1`))[0];
    if (insp) {
      const parts = [insp.address, insp.city, insp.state, insp.zip].filter(Boolean).join(", ");
      if (parts) fullAddress = parts;
      hoEmailAddr = insp.email || null;
      hoZip = insp.zip || "";
      hoPhone = insp.mobile || phone || "";
    }
  }

  // Audit-trail note → JobNimbus. Posts the full deal history (signed →
  // inspected → cert → PA opened → PA notes) plus this new appointment, so the
  // timeline lives in JN's notes, not just our app. Best-effort — never blocks
  // or fails the booking.
  if (inspectionId) { try { await postApptTimelineNote(inspectionId, when, pa.name); } catch { /* best-effort */ } }

  const MONITOR_PHONE = "7275037017"; // TEMP: copy Neal so he can confirm delivery — remove when he shuts his off.

  // PA — SMS + email with the details.
  const paApptMsg = `📅 New appointment: ${homeowner || "a homeowner"}${fullAddress ? ` — ${fullAddress}` : ""} on ${when}.${phone ? ` Homeowner: ${phone}.` : ""} (booked by ${bookedBy})`;
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
      const coMsg = `📅 Appointment booked for ${pa.name}: ${homeowner || "a homeowner"}${fullAddress ? ` — ${fullAddress}` : ""} on ${when}.`;
      if (base && co.admin_phone) await sms(base, co.admin_phone, co.admin_name || co.name || "PA Company", coMsg);
      // Email: labeled fields (the company auto-populates their leads tracker from
      // it), client name in the subject so each notification is distinct.
      const coEmailBody = [
        `Adjuster: ${pa.name}`,
        `Client: ${homeowner || "—"}`,
        `Property address: ${fullAddress || "—"}`,
        `Zip code: ${hoZip || "—"}`,
        `Client phone: ${hoPhone || "—"}`,
        `Client email: ${hoEmailAddr || "—"}`,
        `Appointment: ${when}`,
      ].join("<br>");
      const coSubject = `New PA appointment - ${pa.name} - ${homeowner || "Homeowner"}`;
      if (base && co.email) await email(base, co.email, coSubject, coEmailBody);
    }
  }

  // Homeowner confirmation — only when the company turned it on. Company-authored
  // wording with {homeowner} {date}/{time} {address} {company} placeholders.
  // {time}/{date} resolve to the EXACT START time (not the 2-hour slot window) so
  // the homeowner doesn't think it's a 2-hour appointment.
  if (co && co.homeowner_confirm_enabled) {
    const fill = (t) => String(t || "")
      .split("{homeowner}").join(homeowner || "there")
      .split("{date}").join(whenStart).split("{time}").join(whenStart).split("{when}").join(whenStart)
      .split("{address}").join(fullAddress || "")
      .split("{company}").join(co.name || "");
    const hoSms = fill(co.homeowner_confirm_sms) || `Hi ${homeowner || "there"}, your roof inspection${fullAddress ? ` at ${fullAddress}` : ""} is set for ${whenStart}. The appointment usually takes about 15–45 minutes.${co.name ? ` — ${co.name}` : ""}`;
    if (base && phone) await sms(base, phone, homeowner || "Homeowner", hoSms);
    if (base && hoEmailAddr) await email(base, hoEmailAddr, fill(co.homeowner_confirm_email_subject) || "Your appointment is confirmed", fill(co.homeowner_confirm_email_body) || hoSms);
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
// Exact START time only (for the homeowner — a 2-hour window reads as a 2-hour
// appointment, which it never is). e.g. "Tue, Jul 14 at 3:00 PM".
function etStartLabel(startMs) {
  const d = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric" }).format(new Date(startMs));
  const t = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" }).format(new Date(startMs));
  return `${d} at ${t}`;
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

// Google Calendar free/busy for one PA. Returns [[startMs,endMs],…] of BUSY
// ranges (no event details), or null on any failure (caller fails open).
async function googleFreeBusy(refreshToken, minIso, maxIso) {
  try {
    const at = await googleAccessToken(refreshToken);
    if (!at) return null;
    const r = await fetch("https://www.googleapis.com/calendar/v3/freeBusy", {
      method: "POST",
      headers: { Authorization: `Bearer ${at}`, "Content-Type": "application/json" },
      body: JSON.stringify({ timeMin: minIso, timeMax: maxIso, items: [{ id: "primary" }] }),
    });
    if (!r.ok) return null;
    const d = await r.json().catch(() => ({}));
    const busy = (d.calendars && d.calendars.primary && d.calendars.primary.busy) || [];
    return busy.map((b) => [Date.parse(b.start), Date.parse(b.end)]).filter(([a, b]) => a && b);
  } catch { return null; }
}
async function googleAccessToken(refreshToken) {
  try {
    const r = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: GCAL_ID, client_secret: GCAL_SECRET, refresh_token: refreshToken, grant_type: "refresh_token" }).toString(),
    });
    if (!r.ok) return null;
    const d = await r.json().catch(() => ({}));
    return d.access_token || null;
  } catch { return null; }
}
// Create a timed event on the PA's primary calendar → returns event id or null.
async function googleCreateEvent(refreshToken, ev) {
  try {
    const at = await googleAccessToken(refreshToken);
    if (!at) return null;
    const r = await fetch("https://www.googleapis.com/calendar/v3/calendars/primary/events", {
      method: "POST",
      headers: { Authorization: `Bearer ${at}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        summary: ev.summary,
        location: ev.location || undefined,
        description: ev.description || undefined,
        start: { dateTime: ev.startIso },
        end: { dateTime: ev.endIso },
      }),
    });
    if (!r.ok) return null;
    const d = await r.json().catch(() => ({}));
    return d.id || null;
  } catch { return null; }
}
async function googleDeleteEvent(refreshToken, eventId) {
  try {
    const at = await googleAccessToken(refreshToken);
    if (!at) return;
    await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(eventId)}`, {
      method: "DELETE", headers: { Authorization: `Bearer ${at}` },
    });
  } catch { /* best-effort */ }
}
async function paRefreshToken(paId) {
  const rows = await sbGet(`pas?id=eq.${encodeURIComponent(paId)}&select=google_refresh_token&limit=1`);
  return (rows[0] && rows[0].google_refresh_token) || null;
}

// Post the deal's audit trail (+ this new appointment) as a JobNimbus note.
// Mirrors the timeline built in inspection-lookup.js so JN shows the same story.
async function postApptTimelineNote(inspectionId, when, paName) {
  if (!JN_KEY) return;
  const SEL = "jn_job_id,client_name,address,signed_at,result,result_at,jn_cert_uploaded_at,pa_opened_at,pa_signed_at,pa_notes_log,cancelled_at,cancel_reason";
  const rows = await sbGet(`inspections?id=eq.${encodeURIComponent(inspectionId)}&select=${SEL}&limit=1`);
  const r = rows[0];
  if (!r || !r.jn_job_id) return;

  const ev = [];
  if (r.signed_at) ev.push({ at: r.signed_at, label: "Inspection agreement signed" });
  if (r.result) ev.push({ at: r.result_at || null, label: `Inspected → ${resultLabel(r.result)}` });
  if (r.jn_cert_uploaded_at) ev.push({ at: r.jn_cert_uploaded_at, label: "Certificate uploaded to JobNimbus" });
  if (r.pa_opened_at) ev.push({ at: r.pa_opened_at, label: "Public adjuster opened the deal" });
  if (r.pa_signed_at) ev.push({ at: r.pa_signed_at, label: "PA signed the homeowner" });
  for (const n of Array.isArray(r.pa_notes_log) ? r.pa_notes_log : []) ev.push({ at: n.at || null, label: n.text || "(note)" });
  if (r.cancelled_at) ev.push({ at: r.cancelled_at, label: `Cancelled${r.cancel_reason ? ` — ${r.cancel_reason}` : ""}` });
  ev.sort((a, b) => new Date(a.at || 0) - new Date(b.at || 0));

  const lines = ev.map((e) => `• ${e.at ? fmtWhen(e.at) : "—"} · ${e.label}`);
  const note = [
    `📅 PA appointment scheduled — ${when}${paName ? ` with ${paName}` : ""}`,
    "",
    "Deal history:",
    ...(lines.length ? lines : ["• (no prior activity recorded)"]),
  ].join("\n");

  await fetch(`${JN_BASE}/activities`, {
    method: "POST",
    headers: { Authorization: `bearer ${JN_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      record_type_name: "Note",
      note,
      primary: { id: r.jn_job_id, type: "job" },
      related: [{ id: r.jn_job_id, type: "job" }],
      is_status_change: false,
    }),
  });
}
function resultLabel(v) {
  return { damage: "Damage found", no_damage: "No damage", retail: "Retail", lost: "Lost" }[String(v || "").toLowerCase()] || String(v || "");
}
function fmtWhen(at) {
  const d = new Date(at);
  if (isNaN(d)) return "—";
  return d.toLocaleString("en-US", { timeZone: "America/New_York", month: "numeric", day: "numeric", year: "2-digit", hour: "numeric", minute: "2-digit" });
}
function cors(status, body) {
  return { statusCode: status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" }, body };
}
