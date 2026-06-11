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

  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch { return cors(400, JSON.stringify({ ok: false, error: "Bad JSON" })); }
  const token = (body.token || "").trim();
  const action = (body.action || "load").trim();
  if (!token) return cors(400, JSON.stringify({ ok: false, error: "token required" }));

  // Validate token → company.
  const companies = await get(`${SB_URL}/rest/v1/pa_companies?token=eq.${encodeURIComponent(token)}&select=id,name,active&limit=1`, sb);
  const company = companies[0];
  if (!company) return cors(404, JSON.stringify({ ok: false, error: "Invalid link" }));
  if (company.active === false) return cors(403, JSON.stringify({ ok: false, error: "This company is inactive — contact U.S. Shingle." }));

  // Active PAs in this company (+ home coords for distance sorting + takeaways).
  const pas = await get(`${SB_URL}/rest/v1/pas?pa_company_id=eq.${company.id}&select=id,name,active,home_address,latitude,longitude,pa_takeaways,phone,email,max_distance_miles&order=name.asc`, sb);

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
    company: { name: company.name },
    pas: pas.map((p) => ({ id: p.id, name: p.name, active: p.active, phone: p.phone || null, email: p.email || null, home_address: p.home_address || null, max_distance_miles: typeof p.max_distance_miles === "number" ? p.max_distance_miles : null, lat: typeof p.latitude === "number" ? p.latitude : null, lng: typeof p.longitude === "number" ? p.longitude : null })),
    deals: shaped,
  }));
};

async function get(url, headers) {
  const r = await fetch(url, { headers });
  if (!r.ok) { console.warn(`query ${r.status}: ${(await r.text().catch(() => "")).slice(0, 160)}`); return []; }
  return await r.json().catch(() => []);
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
