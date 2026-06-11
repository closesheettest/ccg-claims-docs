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
  let company = (await get(`${SB_URL}/rest/v1/pa_companies?token=eq.${encodeURIComponent(token)}&select=id,name,active,address,email,latitude,longitude&limit=1`, sb))[0];
  if (!company) {
    company = (await get(`${SB_URL}/rest/v1/pa_companies?token=eq.${encodeURIComponent(token)}&select=id,name,active&limit=1`, sb))[0];
  }
  if (!company) return cors(404, JSON.stringify({ ok: false, error: "Invalid link" }));
  if (company.active === false) return cors(403, JSON.stringify({ ok: false, error: "This company is inactive — contact U.S. Shingle." }));

  // Active PAs in this company (+ home coords for distance sorting + takeaways).
  // Full select includes max_distance_miles (added by pa_max_distance.sql).
  // If that column isn't there yet, fall back so the page still loads.
  let pas = await get(`${SB_URL}/rest/v1/pas?pa_company_id=eq.${company.id}&select=id,name,active,home_address,latitude,longitude,pa_takeaways,phone,email,max_distance_miles,jn_user_id&order=name.asc`, sb);
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
    const nowIso = new Date().toISOString();
    const patch = paId
      ? { pa_id: paId, pa_claimed_at: nowIso, pa_stage: "active", pa_stage_at: nowIso }
      : { pa_id: null, pa_claimed_at: null };
    // Scope the update to THIS company's pool — a token can't reassign
    // another company's deal.
    const r = await fetch(
      `${SB_URL}/rest/v1/inspections?id=eq.${encodeURIComponent(inspectionId)}&pa_company_id=eq.${company.id}`,
      { method: "PATCH", headers: { ...sb, Prefer: "return=representation" }, body: JSON.stringify(patch) },
    );
    if (!r.ok) return cors(500, JSON.stringify({ ok: false, error: `Assign failed: ${(await r.text()).slice(0, 160)}` }));
    const rows = await r.json().catch(() => []);
    if (!rows.length) return cors(404, JSON.stringify({ ok: false, error: "Deal not found in your company's pool" }));
    return cors(200, JSON.stringify({ ok: true }));
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
    // Notification → name/email/phone ONLY (what JobNimbus needs).
    const msg =
      `🧰 New PA to add in JobNimbus — from ${company.name}.\n` +
      `Add this person as a JN user, typed EXACTLY as shown so it auto-links:\n` +
      `Name: ${name}\nEmail: ${email}\nPhone: ${phone}`;
    await notifyJnAdmins(base, msg);
    return cors(200, JSON.stringify({ ok: true }));
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

  // action "load": every open homeowner in this company's pool.
  const deals = await get(
    `${SB_URL}/rest/v1/inspections?pa_company_id=eq.${company.id}` +
      `&cancelled_at=is.null&or=(pa_stage.is.null,pa_stage.neq.dead)` +
      `&select=id,client_name,address,city,state,zip,county,signed_at,mobile,latitude,longitude,pa_id,pa_stage,pa_opened_at,pa_notes_log,correction_needed,pa_company_at` +
      `&order=signed_at.desc&limit=500`,
    sb,
  );
  const paName = {};
  for (const p of pas) paName[p.id] = p.name;
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
      mobile: d.mobile || null,
      pa_id: d.pa_id || null,
      pa_name: d.pa_id ? (paName[d.pa_id] || "Assigned") : null,
      status,
      touched,
      opened: !!d.pa_opened_at,
      correction_needed: !!d.correction_needed,
      last_note: lastNote ? lastNote.text : null,
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
    },
    pas: pas.map((p) => ({ id: p.id, name: p.name, active: p.active, phone: p.phone || null, email: p.email || null, home_address: p.home_address || null, max_distance_miles: typeof p.max_distance_miles === "number" ? p.max_distance_miles : null, lat: typeof p.latitude === "number" ? p.latitude : null, lng: typeof p.longitude === "number" ? p.longitude : null, in_jn: !!p.jn_user_id, ready_to_activate: !!p.jn_user_id && p.active === false })),
    deals: shaped,
  }));
};

async function get(url, headers) {
  const r = await fetch(url, { headers });
  if (!r.ok) { console.warn(`query ${r.status}: ${(await r.text().catch(() => "")).slice(0, 160)}`); return []; }
  return await r.json().catch(() => []);
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
