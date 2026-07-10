// netlify/functions/pa-company-api.js
//
// Token-gated API for a PA COMPANY's admin screen (/?pa_company=<token>).
// The company admin sees a master list of every homeowner routed to their
// company's pool and assigns each one to one of their active PAs.
//
// POST body:
//   { token, action: "load" }
//       → { ok, company:{name}, pas:[{id,name,active}], deals:[…] }
//   { token, action: "assign", inspectionId, paId }   // paId "" = unassign
//       → { ok }
//
// Security: everything is gated by the company's token (pa_companies.token).
// Assign verifies the deal belongs to THIS company and the PA is one of THIS
// company's active PAs — a token can't touch another company's data.
//
// Required env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY.

const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return cors(200, "");
  if (event.httpMethod !== "POST") return cors(405, JSON.stringify({ ok: false, error: "Method not allowed" }));
  if (!SB_URL || !SB_KEY) return cors(500, JSON.stringify({ ok: false, error: "Missing Supabase env" }));
  const sb = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" };
  const base = (process.env.URL || process.env.DEPLOY_URL || process.env.PUBLIC_SITE_URL || "https://free-roof-inspections.netlify.app").replace(/\/$/, "");

  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch { return cors(400, JSON.stringify({ ok: false, error: "Bad JSON" })); }
  const token = (body.token || "").trim();
  const action = (body.action || "load").trim();
  if (!token) return cors(400, JSON.stringify({ ok: false, error: "token required" }));

  // Validate token → company.
  // Try the full select (office fields). If those columns don't exist yet
  // (migration not run), that 400s → get() returns []; fall back to the
  // base columns so the page still works. Office fields just stay null
  // until pa_company_office_and_audit_label.sql is run.
  let company = (await get(`${SB_URL}/rest/v1/pa_companies?token=eq.${encodeURIComponent(token)}&select=id,name,active,address,email,latitude,longitude,homeowner_confirm_enabled,homeowner_confirm_sms,homeowner_confirm_email_subject,homeowner_confirm_email_body&limit=1`, sb))[0]
    || (await get(`${SB_URL}/rest/v1/pa_companies?token=eq.${encodeURIComponent(token)}&select=id,name,active,address,email,latitude,longitude&limit=1`, sb))[0]
    || (await get(`${SB_URL}/rest/v1/pa_companies?token=eq.${encodeURIComponent(token)}&select=id,name,active&limit=1`, sb))[0];
  if (!company) return cors(404, JSON.stringify({ ok: false, error: "Invalid link" }));
  if (company.active === false) return cors(403, JSON.stringify({ ok: false, error: "This company is inactive — contact U.S. Shingle." }));

  // Active PAs in this company (+ home coords for distance sorting + takeaways).
  // Full select includes max_distance_miles (added by pa_max_distance.sql).
  // If that column isn't there yet, fall back so the page still loads.
  let pas = await get(`${SB_URL}/rest/v1/pas?pa_company_id=eq.${company.id}&select=id,name,active,home_address,latitude,longitude,pa_takeaways,phone,email,max_distance_miles,zones,jn_user_id,google_connected_at,google_email&order=name.asc`, sb);
  // PA languages — separate + tolerant of the pas.languages column not existing yet.
  try {
    const lg = await get(`${SB_URL}/rest/v1/pas?pa_company_id=eq.${company.id}&select=id,languages`, sb);
    const m = {}; for (const x of lg) m[x.id] = x.languages;
    for (const p of pas) if (Array.isArray(m[p.id])) p.languages = m[p.id];
  } catch { /* column not added yet */ }
  if (!pas.length) {
    pas = await get(`${SB_URL}/rest/v1/pas?pa_company_id=eq.${company.id}&select=id,name,active,home_address,latitude,longitude,pa_takeaways,phone,email,jn_user_id&order=name.asc`, sb);
  }

  // Scorecard for THIS company's PAs only — same metrics as the master admin
  // report, scoped so a company never sees another company's numbers.
  if (action === "scorecard") {
    const ids = pas.map((p) => p.id);
    let byPa = {};
    if (ids.length) {
      const inList = `(${ids.map((id) => `"${id}"`).join(",")})`;
      const deals = await get(
        `${SB_URL}/rest/v1/inspections?result=eq.damage&pa_id=in.${encodeURIComponent(inList)}` +
          `&select=pa_id,pa_stage,pa_opened_at,pa_notes_log,pa_fields,cancelled_at,pa_claimed_at,pa_signed_at&limit=5000`,
        sb,
      );
      for (const r of deals) {
        const b = (byPa[r.pa_id] = byPa[r.pa_id] || { open: 0, working: 0, signed: 0, lost: 0, dead: 0, handled: 0, _days: [] });
        b.handled++;
        if (r.cancelled_at) { b.lost++; continue; }
        if (r.pa_stage === "dead") { b.dead++; continue; }
        b.open++;
        const signed = r.pa_fields?.pa_signup === "Signed";
        const working = !!r.pa_opened_at || (Array.isArray(r.pa_notes_log) && r.pa_notes_log.length > 0);
        if (signed) {
          b.signed++;
          if (r.pa_claimed_at && r.pa_signed_at) {
            const d = (new Date(r.pa_signed_at).getTime() - new Date(r.pa_claimed_at).getTime()) / 86400000;
            if (Number.isFinite(d) && d >= 0) b._days.push(d);
          }
        } else if (working) b.working++;
      }
    }
    const pctOf = (n, d) => (d > 0 ? Math.round((n / d) * 100) : 0);
    const rows = pas.filter((p) => p.active).map((p) => {
      const b = byPa[p.id] || { open: 0, working: 0, signed: 0, lost: 0, dead: 0, handled: 0, _days: [] };
      const taken = p.pa_takeaways || 0;
      const denom = b.handled + taken;
      return {
        id: p.id, name: p.name, assigned: b.open, working: b.working,
        avgDaysToSign: b._days.length ? Math.round(b._days.reduce((s, n) => s + n, 0) / b._days.length) : null,
        denom, signPct: pctOf(b.signed, denom), lostPct: pctOf(b.lost, denom), takenPct: pctOf(taken, denom),
      };
    }).sort((a, b) => (b.assigned - a.assigned) || a.name.localeCompare(b.name));
    return cors(200, JSON.stringify({ ok: true, company: { name: company.name }, rows }));
  }

  if (action === "assign") {
    const inspectionId = (body.inspectionId || "").trim();
    const paId = (body.paId || "").trim();
    if (!inspectionId) return cors(400, JSON.stringify({ ok: false, error: "inspectionId required" }));
    if (paId && !pas.some((p) => p.id === paId && p.active)) {
      return cors(400, JSON.stringify({ ok: false, error: "That PA isn't an active member of this company" }));
    }
    // A deal belongs to THIS company if it's still in the company pool
    // (pa_company_id) OR it's already assigned to one of the company's PAs —
    // pa_company_id gets NULLED once a PA claims/books it, so a scope on
    // pa_company_id alone would miss every already-assigned deal (the bug that
    // made re-assigning silently fail).
    const insp = (await get(`${SB_URL}/rest/v1/inspections?id=eq.${encodeURIComponent(inspectionId)}&select=id,pa_id,pa_company_id&limit=1`, sb))[0];
    if (!insp) return cors(404, JSON.stringify({ ok: false, error: "Deal not found" }));
    const ours = insp.pa_company_id === company.id || pas.some((p) => p.id === insp.pa_id);
    if (!ours) return cors(403, JSON.stringify({ ok: false, error: "That deal isn't in your company" }));
    const nowIso = new Date().toISOString();
    const patch = paId
      ? { pa_id: paId, pa_claimed_at: nowIso, pa_stage: "active", pa_stage_at: nowIso }
      : { pa_id: null, pa_claimed_at: null };
    const r = await fetch(
      `${SB_URL}/rest/v1/inspections?id=eq.${encodeURIComponent(inspectionId)}`,
      { method: "PATCH", headers: { ...sb, Prefer: "return=minimal" }, body: JSON.stringify(patch) },
    );
    if (!r.ok) return cors(500, JSON.stringify({ ok: false, error: `Assign failed: ${(await r.text()).slice(0, 160)}` }));
    // Move any scheduled appointment for this deal to the new PA too, so the
    // appointment (and its follow-ups/notifications) follows the reassignment.
    if (paId) await fetch(`${SB_URL}/rest/v1/pa_appointments?inspection_id=eq.${encodeURIComponent(inspectionId)}&status=eq.scheduled`, { method: "PATCH", headers: { ...sb, Prefer: "return=minimal" }, body: JSON.stringify({ pa_id: paId }) }).catch(() => {});
    return cors(200, JSON.stringify({ ok: true }));
  }

  // action "appts": THIS company's upcoming scheduled appointments, flagging
  // duplicates (same homeowner booked more than once) so the admin can fix them.
  if (action === "appts") {
    const paIds = pas.map((p) => p.id);
    if (!paIds.length) return cors(200, JSON.stringify({ ok: true, appts: [] }));
    const inList = `(${paIds.map((id) => `"${id}"`).join(",")})`;
    const rows = await get(`${SB_URL}/rest/v1/pa_appointments?status=eq.scheduled&pa_id=in.${encodeURIComponent(inList)}&select=id,pa_id,homeowner_name,homeowner_phone,address,start_at,inspection_id&order=start_at`, sb);
    const nameOf = {}; for (const p of pas) nameOf[p.id] = p.name;
    const dupKey = (r) => (r.homeowner_phone || "").replace(/\D/g, "").slice(-10) || (r.homeowner_name || "").trim().toLowerCase();
    const seen = {}; for (const r of rows) { const k = dupKey(r); if (k) seen[k] = (seen[k] || 0) + 1; }
    const appts = rows.map((r) => ({ id: r.id, pa_id: r.pa_id, pa_name: nameOf[r.pa_id] || null, homeowner_name: r.homeowner_name, homeowner_phone: r.homeowner_phone, address: r.address, start_at: r.start_at, inspection_id: r.inspection_id, duplicate: (seen[dupKey(r)] || 0) > 1 }));
    return cors(200, JSON.stringify({ ok: true, appts, pas: pas.filter((p) => p.active).map((p) => ({ id: p.id, name: p.name })) }));
  }

  // action "reassign_appt": move an appointment (and its deal) to a different PA.
  if (action === "reassign_appt") {
    const apptId = (body.apptId || "").trim();
    const paId = (body.paId || "").trim();
    if (!apptId || !paId) return cors(400, JSON.stringify({ ok: false, error: "apptId and paId required" }));
    if (!pas.some((p) => p.id === paId && p.active)) return cors(400, JSON.stringify({ ok: false, error: "That PA isn't an active member of this company" }));
    const appt = (await get(`${SB_URL}/rest/v1/pa_appointments?id=eq.${encodeURIComponent(apptId)}&select=id,pa_id,inspection_id&limit=1`, sb))[0];
    if (!appt || !pas.some((p) => p.id === appt.pa_id)) return cors(404, JSON.stringify({ ok: false, error: "That appointment isn't in your company" }));
    await fetch(`${SB_URL}/rest/v1/pa_appointments?id=eq.${encodeURIComponent(apptId)}`, { method: "PATCH", headers: { ...sb, Prefer: "return=minimal" }, body: JSON.stringify({ pa_id: paId, pa_company_id: company.id }) });
    if (appt.inspection_id) await fetch(`${SB_URL}/rest/v1/inspections?id=eq.${encodeURIComponent(appt.inspection_id)}`, { method: "PATCH", headers: { ...sb, Prefer: "return=minimal" }, body: JSON.stringify({ pa_id: paId }) });
    return cors(200, JSON.stringify({ ok: true }));
  }

  // action "cancel_appt": remove a duplicate appointment.
  if (action === "cancel_appt") {
    const apptId = (body.apptId || "").trim();
    if (!apptId) return cors(400, JSON.stringify({ ok: false, error: "apptId required" }));
    const appt = (await get(`${SB_URL}/rest/v1/pa_appointments?id=eq.${encodeURIComponent(apptId)}&select=id,pa_id&limit=1`, sb))[0];
    if (!appt || !pas.some((p) => p.id === appt.pa_id)) return cors(404, JSON.stringify({ ok: false, error: "That appointment isn't in your company" }));
    await fetch(`${SB_URL}/rest/v1/pa_appointments?id=eq.${encodeURIComponent(apptId)}`, { method: "PATCH", headers: { ...sb, Prefer: "return=minimal" }, body: JSON.stringify({ status: "cancelled", notes: "Duplicate — removed by company admin" }) });
    return cors(200, JSON.stringify({ ok: true }));
  }

  // action "availability": TEAM master calendar — every active PA's 2-hour slot
  // grid for the next 7 days, each cell open / booked (with homeowner) / off.
  if (action === "availability") {
    // Only PAs who've LINKED their Google Calendar appear — so if a company
    // doesn't see one of their PAs here, it means that PA still needs to connect.
    const activePas = pas.filter((p) => p.active && p.google_connected_at);
    const ids = activePas.map((p) => p.id);
    if (!ids.length) return cors(200, JSON.stringify({ ok: true, pas: [], days: [] }));
    const inList = `(${ids.map((id) => `"${id}"`).join(",")})`;
    const nowMs = Date.now();
    const appts = await get(`${SB_URL}/rest/v1/pa_appointments?status=eq.scheduled&pa_id=in.${encodeURIComponent(inList)}&start_at=gte.${encodeURIComponent(new Date(nowMs - 864e5).toISOString())}&select=pa_id,start_at,end_at,homeowner_name&limit=5000`, sb);
    const apptByPa = {}; for (const a of appts) (apptByPa[a.pa_id] = apptByPa[a.pa_id] || []).push([Date.parse(a.start_at), Date.parse(a.end_at), a.homeowner_name]);
    const blocks = await get(`${SB_URL}/rest/v1/pa_slot_blocks?pa_id=in.${encodeURIComponent(inList)}&select=pa_id,weekday,start_min&limit=20000`, sb);
    const blockedByPa = {}; for (const b of blocks) (blockedByPa[b.pa_id] = blockedByPa[b.pa_id] || new Set()).add(`${b.weekday}:${b.start_min}`);
    let dateBlocks = []; try { dateBlocks = (await get(`${SB_URL}/rest/v1/pa_date_blocks?pa_id=in.${encodeURIComponent(inList)}&select=pa_id,date,start_min&limit=20000`, sb)) || []; } catch { /* table not set up */ }
    const dateBlockedByPa = {}; for (const b of dateBlocks) (dateBlockedByPa[b.pa_id] = dateBlockedByPa[b.pa_id] || new Set()).add(`${b.date}:${b.start_min}`);

    // Real Google free/busy for each linked PA over the 7-day window — so "open"
    // reflects their actual calendar (outside claims blocked out), not just ours.
    const busyByPa = {};
    if (CA_GCAL_ID && CA_GCAL_SECRET) {
      const tokRows = await get(`${SB_URL}/rest/v1/pas?id=in.${encodeURIComponent(inList)}&google_refresh_token=not.is.null&select=id,google_refresh_token`, sb);
      const minIso = new Date(nowMs).toISOString();
      const maxIso = new Date(nowMs + 7 * 864e5).toISOString();
      await Promise.all((tokRows || []).map(async (t) => {
        const busy = await caGoogleFreeBusy(t.google_refresh_token, minIso, maxIso);
        if (busy && busy.length) busyByPa[t.id] = busy;
      }));
    }

    const days = [];
    for (let d = 0; d < 7; d++) {
      const { y, mo, day, weekday } = caEtDateParts(nowMs + d * 864e5);
      const times = CA_SLOT_TIMES[weekday] || [];
      if (!times.length) continue;
      const dateStr = `${y}-${String(mo).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      const label = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric" }).format(new Date(nowMs + d * 864e5));
      const slots = times.map((s) => {
        const startMs = caEtToUtcMs(y, mo, day, s), endMs = startMs + 120 * 60000;
        const cells = {};
        for (const p of activePas) {
          if (startMs <= nowMs) { cells[p.id] = { s: "past" }; continue; }
          const ap = (apptByPa[p.id] || []).find(([as, ae]) => startMs < ae && endMs > as);
          if (ap) { cells[p.id] = { s: "booked", who: ap[2] || "" }; continue; }
          if ((blockedByPa[p.id] || new Set()).has(`${weekday}:${s}`) || (dateBlockedByPa[p.id] || new Set()).has(`${dateStr}:${s}`)) { cells[p.id] = { s: "off" }; continue; }
          if ((busyByPa[p.id] || []).some(([bs, be]) => startMs < be && endMs > bs)) { cells[p.id] = { s: "off" }; continue; } // busy on their Google Calendar
          cells[p.id] = { s: "open" };
        }
        return { t: caSlotLabel(s), cells };
      });
      days.push({ date: dateStr, label, slots });
    }
    return cors(200, JSON.stringify({ ok: true, pas: activePas.map((p) => ({ id: p.id, name: p.name })), days }));
  }

  // action "update_pa": the company admin edits one of their own adjusters
  // (contact info, home address, max travel distance, active). Coords are
  // sent by the client, which geocodes the address via geocode-place when it
  // changes — so distance-based assigning keeps working.
  if (action === "update_pa") {
    const paId = (body.paId || "").trim();
    if (!paId || !pas.some((p) => p.id === paId)) {
      return cors(400, JSON.stringify({ ok: false, error: "That PA isn't a member of this company" }));
    }
    const p = body.patch || {};
    const patch = {};
    if (p.name !== undefined) { const v = String(p.name || "").trim(); if (v) patch.name = v; }
    if (p.phone !== undefined) patch.phone = String(p.phone || "").trim() || null;
    if (p.email !== undefined) patch.email = String(p.email || "").trim() || null;
    if (p.home_address !== undefined) patch.home_address = String(p.home_address || "").trim() || null;
    if (p.active !== undefined) patch.active = !!p.active;
    if (p.max_distance_miles !== undefined) {
      const n = Number(p.max_distance_miles);
      patch.max_distance_miles = Number.isFinite(n) && n > 0 ? Math.round(n) : null;
    }
    if (p.latitude !== undefined) patch.latitude = typeof p.latitude === "number" ? p.latitude : null;
    if (p.longitude !== undefined) patch.longitude = typeof p.longitude === "number" ? p.longitude : null;
    if (Object.keys(patch).length === 0) return cors(400, JSON.stringify({ ok: false, error: "Nothing to update" }));
    patch.info_updated_at = new Date().toISOString();
    const r = await fetch(
      `${SB_URL}/rest/v1/pas?id=eq.${encodeURIComponent(paId)}&pa_company_id=eq.${company.id}`,
      { method: "PATCH", headers: { ...sb, Prefer: "return=representation" }, body: JSON.stringify(patch) },
    );
    if (!r.ok) return cors(500, JSON.stringify({ ok: false, error: `Update failed: ${(await r.text()).slice(0, 160)}` }));
    const rows = await r.json().catch(() => []);
    if (!rows.length) return cors(404, JSON.stringify({ ok: false, error: "PA not found in your company" }));
    // Languages written separately (best-effort) so the core edit still works
    // before the pas.languages column exists.
    if (Array.isArray(p.languages)) {
      await fetch(`${SB_URL}/rest/v1/pas?id=eq.${encodeURIComponent(paId)}&pa_company_id=eq.${company.id}`, { method: "PATCH", headers: { ...sb, Prefer: "return=minimal" }, body: JSON.stringify({ languages: sanitizeLangs(p.languages) }) }).catch(() => {});
    }
    return cors(200, JSON.stringify({ ok: true }));
  }

  // action "add_pa": company admin adds a NEW adjuster. We can't create a
  // JobNimbus user via API, so we create the PA here (inactive, no jn_user_id
  // yet, tied to THIS company) and text whoever manages JN to add them —
  // EXACTLY as spelled — so the 5-min linker (cron-link-pending-pas) can
  // match the new JN user back to this PA by email.
  if (action === "add_pa") {
    const name = String(body.name || "").trim();
    const email = String(body.email || "").trim().toLowerCase();
    const phone = String(body.phone || "").trim();
    const homeAddress = String(body.home_address || "").trim();
    const maxN = Number(body.max_distance_miles);
    const maxDist = Number.isFinite(maxN) && maxN > 0 ? Math.round(maxN) : null;
    const lat = typeof body.latitude === "number" ? body.latitude : null;
    const lng = typeof body.longitude === "number" ? body.longitude : null;
    // Everything except max distance is required (so the company admin never
    // has to come back and edit). The JobNimbus notification still only
    // carries name/email/phone — address & distance are ours, not JN's.
    if (!name) return cors(400, JSON.stringify({ ok: false, error: "Name is required." }));
    if (!/^\S+@\S+\.\S+$/.test(email)) return cors(400, JSON.stringify({ ok: false, error: "A valid email is required — it's how we link them to the U.S. Shingle system." }));
    if (!phone) return cors(400, JSON.stringify({ ok: false, error: "Phone is required." }));
    if (!homeAddress) return cors(400, JSON.stringify({ ok: false, error: "Home address is required." }));
    const dupe = await get(`${SB_URL}/rest/v1/pas?pa_company_id=eq.${company.id}&email=eq.${encodeURIComponent(email)}&select=id&limit=1`, sb);
    if (dupe.length) return cors(409, JSON.stringify({ ok: false, error: "You already added someone with that email." }));
    const row = { name, email, phone, home_address: homeAddress, latitude: lat, longitude: lng, pa_company_id: company.id, active: false };
    if (maxDist != null) row.max_distance_miles = maxDist;
    const ins = await fetch(`${SB_URL}/rest/v1/pas`, {
      method: "POST", headers: { ...sb, Prefer: "return=minimal" }, body: JSON.stringify(row),
    });
    if (!ins.ok) return cors(500, JSON.stringify({ ok: false, error: `Couldn't add: ${(await ins.text()).slice(0, 160)}` }));
    // Notification → name/email/phone ONLY (what JobNimbus needs) + a link to
    // the copy-paste queue page (no mistyping → email matches → auto-links).
    const queueLink = `${base}/?jn_queue=jnq_7Kx2pV9mQ4sR1bN8wL3`;
    const msg =
      `🧰 New PA to add in JobNimbus — from ${company.name}.\n` +
      `Name: ${name}\nEmail: ${email}\nPhone: ${phone}\n` +
      `Tip: open the queue and copy-paste so the email matches exactly, then tap Completed:\n${queueLink}`;
    await notifyJnAdmins(base, msg);
    return cors(200, JSON.stringify({ ok: true }));
  }

  // action "resend_link": re-send one of THEIR adjusters their PRIVATE
  // portal link (?mode=pa&pa=<id>). Use when they need the link again or
  // never got it. Scoped to this company's PAs.
  if (action === "resend_link") {
    const paId = (body.paId || "").trim();
    const target = pas.find((p) => p.id === paId);
    if (!target) return cors(400, JSON.stringify({ ok: false, error: "That PA isn't in your company." }));
    if (!target.email && !target.phone) return cors(400, JSON.stringify({ ok: false, error: "No email or phone on file — add one via Edit first." }));
    try {
      const r = await fetch(`${base}/.netlify/functions/send-pa-app-invite`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paId, channel: "auto" }),
      });
      const out = await r.json().catch(() => ({}));
      if (!r.ok || !out.ok) return cors(502, JSON.stringify({ ok: false, error: out.error || "Couldn't send the link." }));
      return cors(200, JSON.stringify({ ok: true, channel_used: out.channel_used || "auto" }));
    } catch (e) {
      return cors(500, JSON.stringify({ ok: false, error: e.message || "Network error sending link." }));
    }
  }

  // action "send_gcal_link": text one of THIS company's PAs their one-tap
  // "Connect Google Calendar" link, so the admin can onboard their team's
  // calendars from the portal.
  if (action === "send_gcal_link") {
    const paId = (body.paId || "").trim();
    const target = pas.find((p) => p.id === paId);
    if (!target) return cors(400, JSON.stringify({ ok: false, error: "That PA isn't in your company." }));
    if (!target.phone) return cors(400, JSON.stringify({ ok: false, error: "No mobile on file — add one via Edit first." }));
    const link = `${base}/.netlify/functions/pa-gcal-connect?pa_id=${encodeURIComponent(paId)}`;
    const msg = `Connect your Google Calendar for U.S. Shingle scheduling so you're only booked when you're free (your events stay private): ${link}`;
    try {
      const r = await fetch(`${base}/.netlify/functions/ghl-sms`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to: target.phone, name: target.name || "Adjuster", message: msg }),
      });
      if (!r.ok) return cors(502, JSON.stringify({ ok: false, error: "Couldn't send the text." }));
      return cors(200, JSON.stringify({ ok: true, channel: "sms" }));
    } catch (e) {
      return cors(500, JSON.stringify({ ok: false, error: e.message || "Network error sending link." }));
    }
  }

  // action "activate_pa": company admin flips one of THEIR adjusters live —
  // only once the PA is in JobNimbus (jn_user_id set). Sends the portal invite.
  if (action === "activate_pa") {
    const paId = (body.paId || "").trim();
    const target = pas.find((p) => p.id === paId);
    if (!target) return cors(400, JSON.stringify({ ok: false, error: "That PA isn't in your company." }));
    if (!target.jn_user_id) return cors(400, JSON.stringify({ ok: false, error: "They haven't been approved by U.S. Shingle yet — wait for the green “Ready” status." }));
    const upd = await fetch(`${SB_URL}/rest/v1/pas?id=eq.${encodeURIComponent(paId)}&pa_company_id=eq.${company.id}`, {
      method: "PATCH", headers: { ...sb, Prefer: "return=minimal" }, body: JSON.stringify({ active: true }),
    });
    if (!upd.ok) return cors(500, JSON.stringify({ ok: false, error: `Activate failed: ${(await upd.text()).slice(0, 160)}` }));
    try {
      await fetch(`${base}/.netlify/functions/send-pa-app-invite`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paId, channel: "auto" }),
      });
    } catch { /* invite is best-effort */ }
    return cors(200, JSON.stringify({ ok: true }));
  }

  // action "save_homeowner_confirm": the company writes the confirmation text
  // the homeowner gets when an appointment is booked. Scoped to this company.
  if (action === "save_homeowner_confirm") {
    const payload = {
      homeowner_confirm_enabled: !!body.enabled,
      homeowner_confirm_sms: String(body.sms || "").slice(0, 500) || null,
      homeowner_confirm_email_subject: String(body.email_subject || "").slice(0, 200) || null,
      homeowner_confirm_email_body: String(body.email_body || "").slice(0, 2000) || null,
    };
    const upd = await fetch(`${SB_URL}/rest/v1/pa_companies?id=eq.${company.id}`, {
      method: "PATCH", headers: { ...sb, Prefer: "return=minimal" }, body: JSON.stringify(payload),
    });
    if (!upd.ok) return cors(500, JSON.stringify({ ok: false, error: `Save failed: ${(await upd.text()).slice(0, 160)}` }));
    return cors(200, JSON.stringify({ ok: true }));
  }

  // action "load": every open homeowner the company should see — their POOL
  // (pa_company_id) PLUS every deal currently assigned to one of their PAs.
  // Booking (rep Damage visit or PA self-schedule) sets pa_company_id=null, so
  // without the pa_id pass those booked deals would vanish from the company view.
  const sel = `select=id,client_name,address,city,state,zip,county,signed_at,mobile,email,jn_job_id,latitude,longitude,pa_id,pa_company_id,pa_stage,pa_opened_at,pa_notes_log,correction_needed,pa_company_at,spanish_only,cancelled_at`;
  const dealMap = {};
  for (const d of (await get(`${SB_URL}/rest/v1/inspections?pa_company_id=eq.${company.id}&${sel}&order=signed_at.desc&limit=500`, sb)) || []) dealMap[d.id] = d;
  const paIdList = pas.map((p) => p.id);
  if (paIdList.length) {
    const inList = `(${paIdList.map((id) => `"${id}"`).join(",")})`;
    for (const d of (await get(`${SB_URL}/rest/v1/inspections?pa_id=in.${encodeURIComponent(inList)}&${sel}&order=signed_at.desc&limit=500`, sb)) || []) dealMap[d.id] = d;
  }
  // Drop cancelled + dead, then newest-signed first.
  const deals = Object.values(dealMap)
    .filter((d) => !d.cancelled_at && d.pa_stage !== "dead")
    .sort((a, b) => String(b.signed_at || "").localeCompare(String(a.signed_at || "")));
  const paName = {};
  for (const p of pas) paName[p.id] = p.name;
  // Scheduled PA appointment time per deal — so the company sees WHEN each visit
  // is when assigning an adjuster. Earliest scheduled appt per inspection.
  const apptByInsp = {};
  const dealIds = deals.map((d) => d.id);
  if (dealIds.length) {
    const inIds = `(${dealIds.map((id) => `"${id}"`).join(",")})`;
    const appts = (await get(`${SB_URL}/rest/v1/pa_appointments?inspection_id=in.${encodeURIComponent(inIds)}&status=eq.scheduled&select=inspection_id,start_at&order=start_at.asc&limit=2000`, sb)) || [];
    for (const a of appts) { if (a.inspection_id && !apptByInsp[a.inspection_id]) apptByInsp[a.inspection_id] = a.start_at; }
  }
  const now = Date.now();
  const shaped = (deals || []).map((d) => {
    const notes = Array.isArray(d.pa_notes_log) ? d.pa_notes_log : [];
    const lastNote = notes.length ? notes[notes.length - 1] : null;
    const touched = !!d.pa_opened_at || notes.length > 0;
    const sinceMs = d.pa_company_at ? now - new Date(d.pa_company_at).getTime() : null;
    const staleHrs = sinceMs != null ? Math.floor(sinceMs / 3600000) : null;
    let status = "new";
    if (d.pa_stage === "no_contact") status = "no_contact";
    else if (d.pa_id && touched) status = "working";
    else if (d.pa_id) status = "assigned";
    return {
      id: d.id,
      name: d.client_name || "(no name)",
      address: [d.address, d.city, d.state, d.zip].filter(Boolean).join(", "),
      county: d.county || null,
      lat: typeof d.latitude === "number" ? d.latitude : null,
      lng: typeof d.longitude === "number" ? d.longitude : null,
      signed_at: d.signed_at,
      appt_at: apptByInsp[d.id] || null,
      mobile: d.mobile || null,
      pa_id: d.pa_id || null,
      pa_name: d.pa_id ? (paName[d.pa_id] || "Assigned") : null,
      status,
      touched,
      opened: !!d.pa_opened_at,
      correction_needed: !!d.correction_needed,
      spanish_only: !!d.spanish_only,
      last_note: lastNote ? lastNote.text : null,
      notes_log: notes,
      jn_job_id: d.jn_job_id || null,
      email: d.email || null,
      stale_hours: staleHrs,
    };
  });

  return cors(200, JSON.stringify({
    ok: true,
    company: {
      name: company.name,
      address: company.address || null,
      email: company.email || null,
      lat: typeof company.latitude === "number" ? company.latitude : null,
      lng: typeof company.longitude === "number" ? company.longitude : null,
      homeowner_confirm_enabled: !!company.homeowner_confirm_enabled,
      homeowner_confirm_sms: company.homeowner_confirm_sms || "",
      homeowner_confirm_email_subject: company.homeowner_confirm_email_subject || "",
      homeowner_confirm_email_body: company.homeowner_confirm_email_body || "",
    },
    pas: pas.map((p) => ({ id: p.id, name: p.name, active: p.active, phone: p.phone || null, email: p.email || null, home_address: p.home_address || null, max_distance_miles: typeof p.max_distance_miles === "number" ? p.max_distance_miles : null, zones: Array.isArray(p.zones) ? p.zones : [], languages: Array.isArray(p.languages) && p.languages.length ? p.languages : ["english"], lat: typeof p.latitude === "number" ? p.latitude : null, lng: typeof p.longitude === "number" ? p.longitude : null, in_jn: !!p.jn_user_id, ready_to_activate: !!p.jn_user_id && p.active === false })),
    deals: shaped,
  }));
};

async function get(url, headers) {
  const r = await fetch(url, { headers });
  if (!r.ok) { console.warn(`query ${r.status}: ${(await r.text().catch(() => "")).slice(0, 160)}`); return []; }
  return await r.json().catch(() => []);
}

// ── Team-availability slot grid helpers (mirror pa-schedule-api) ──
const CA_WD_HOURS = { 1: [9, 11, 13, 15, 17, 19], 2: [9, 11, 13, 15, 17, 19], 3: [9, 11, 13, 15, 17, 19], 4: [9, 11, 13, 15, 17, 19], 5: [9, 11, 13, 15, 17, 19], 6: [9, 11, 13, 15] };
const CA_SLOT_TIMES = Object.fromEntries(Object.entries(CA_WD_HOURS).map(([wd, hrs]) => [wd, hrs.map((h) => h * 60)]));
function caEtDateParts(ms) {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "numeric", day: "numeric", weekday: "short" });
  const p = {}; for (const x of f.formatToParts(new Date(ms))) p[x.type] = x.value;
  const wmap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { y: +p.year, mo: +p.month, day: +p.day, weekday: wmap[p.weekday] };
}
function caEtToUtcMs(y, mo, day, minutes) {
  const hh = Math.floor(minutes / 60), mm = minutes % 60;
  const guess = Date.UTC(y, mo - 1, day, hh, mm);
  const asEt = new Date(new Date(guess).toLocaleString("en-US", { timeZone: "America/New_York" }));
  return guess + (guess - asEt.getTime());
}
function caSlotLabel(min) { const h = Math.floor(min / 60); return `${((h + 11) % 12) + 1} ${h < 12 ? "AM" : "PM"}`; }

// Google Calendar free/busy for the team-availability grid (busy RANGES only —
// no event details). Returns [[startMs,endMs],…] or null on any failure.
const CA_GCAL_ID = process.env.GOOGLE_CLIENT_ID;
const CA_GCAL_SECRET = process.env.GOOGLE_CLIENT_SECRET;
async function caGoogleAccessToken(refreshToken) {
  try {
    const r = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: CA_GCAL_ID, client_secret: CA_GCAL_SECRET, refresh_token: refreshToken, grant_type: "refresh_token" }).toString(),
    });
    if (!r.ok) return null;
    const d = await r.json().catch(() => ({}));
    return d.access_token || null;
  } catch { return null; }
}
async function caGoogleFreeBusy(refreshToken, minIso, maxIso) {
  try {
    const at = await caGoogleAccessToken(refreshToken);
    if (!at) return null;
    const r = await fetch("https://www.googleapis.com/calendar/v3/freeBusy", {
      method: "POST", headers: { Authorization: `Bearer ${at}`, "Content-Type": "application/json" },
      body: JSON.stringify({ timeMin: minIso, timeMax: maxIso, items: [{ id: "primary" }] }),
    });
    if (!r.ok) return null;
    const d = await r.json().catch(() => ({}));
    const busy = (d.calendars && d.calendars.primary && d.calendars.primary.busy) || [];
    return busy.map((b) => [Date.parse(b.start), Date.parse(b.end)]).filter(([a, b]) => a && b);
  } catch { return null; }
}

// Text whoever's subscribed to the TMS "pa_needs_jn_add" notification event
// (managed on TMS → Settings → Notifications). Reads the TMS Supabase with
// its PUBLIC publishable key (anon SELECT on notification_recipients is
// allowed — same one the TMS frontend uses), so no env/secret setup. Sends
// via the existing ghl-sms function. Best-effort.
const TMS_SB_URL = "https://yfmzktvmlfeqcubnvhxr.supabase.co";
const TMS_SB_KEY = "sb_publishable_Nfr-w2esI_2JoBwBXOWpIg_rWJWkBrN";
async function notifyJnAdmins(base, message) {
  try {
    const r = await fetch(
      `${TMS_SB_URL}/rest/v1/notification_recipients?select=name,phone,email,notify_via_sms,notify_via_email&active=eq.true&subscribed_events=cs.%7B%22pa_needs_jn_add%22%7D`,
      { headers: { apikey: TMS_SB_KEY, Authorization: `Bearer ${TMS_SB_KEY}` } },
    );
    const rows = r.ok ? await r.json().catch(() => []) : [];
    const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.55;color:#1e293b">${message.replace(/\n/g, "<br>")}</div>`;
    for (const x of rows || []) {
      // Send on each channel the subscriber has on + a value for.
      if (x.notify_via_sms !== false && x.phone) {
        await fetch(`${base}/.netlify/functions/ghl-sms`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ to: x.phone, name: x.name || "JN admin", message }),
        }).catch(() => {});
      }
      if (x.notify_via_email !== false && x.email) {
        await fetch(`${base}/.netlify/functions/send-email`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ to: x.email, subject: "New PA to add in JobNimbus", html }),
        }).catch(() => {});
      }
    }
  } catch (e) { console.warn("notifyJnAdmins failed:", e.message || e); }
}

// Keep only known language codes; default to English so a PA is never empty.
function sanitizeLangs(arr) {
  const allow = ["english", "spanish", "portuguese", "other"];
  const out = Array.isArray(arr) ? [...new Set(arr.map((x) => String(x).toLowerCase().trim()).filter((x) => allow.includes(x)))] : [];
  return out.length ? out : ["english"];
}
function cors(status, body) {
  return {
    statusCode: status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
    body,
  };
}
