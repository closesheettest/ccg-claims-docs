// netlify/functions/pa-refused-to-sign.js
//
// Fires when a Public Adjuster taps "Refused to Sign" on a claim they
// own: the PA talked to the homeowner and they do NOT want to go through
// insurance. We turn the deal back into a retail lead and tell the field.
//
// Steps:
//   1. Verify the PA owns the claim (inspections.pa_id === paId).
//   2. Flip it to RETAIL — set inspections.result = "retail" and cache
//      pa_fields.pa_signup = "Refused to Sign", then call
//      process-retail-result to do the full JobNimbus transition
//      (record_type PA→Lead, move to retail location, cf_string_34 =
//      "Retail", cert upload). Same path an inspector's Retail uses.
//   3. Release PA ownership (pa_id = null) so the deal leaves the PA
//      portal and re-enters the retail sales flow.
//   4. Text the sales rep AND that rep's regional manager (resolved by
//      bridging the rep → zone via TMS rep-zones → regional_managers):
//      "The public adjuster talked with the homeowner and they do not
//      want to go through insurance — go set up a retail appointment."
//
// POST body: { inspectionId: "<uuid>", paId: "<pas.id>" }
// Response:  { ok, retail, notified: { rep, manager }, ... }
//
// Required env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY.
//   (JobNimbus + GHL creds live in the functions we call internally.)
//   URL or PUBLIC_SITE_URL — base for internal function calls.

const TMS_REP_ZONES_URL =
  "https://trainingmanagementsys.netlify.app/.netlify/functions/rep-zones";

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return json(405, { ok: false, error: "Method not allowed" });
  }
  const missing = [];
  for (const k of ["VITE_SUPABASE_URL", "VITE_SUPABASE_ANON_KEY"]) {
    if (!process.env[k]) missing.push(k);
  }
  if (missing.length) return json(500, { ok: false, error: `Missing env: ${missing.join(", ")}` });

  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch {
    return json(400, { ok: false, error: "Invalid JSON body" });
  }
  const inspectionId = (body.inspectionId || "").trim();
  const paId = (body.paId || "").trim();
  if (!inspectionId) return json(400, { ok: false, error: "inspectionId required" });

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
  const sbHeaders = {
    apikey: SB_KEY,
    Authorization: `Bearer ${SB_KEY}`,
    "Content-Type": "application/json",
  };
  const base = (process.env.URL || process.env.PUBLIC_SITE_URL || "").replace(/\/$/, "");

  // 1. Load the claim + verify ownership.
  const lookup = await fetch(
    `${SB_URL}/rest/v1/inspections?id=eq.${encodeURIComponent(inspectionId)}` +
      `&select=id,jn_job_id,pa_id,result,pa_fields,client_name,address,city,state,zip,sales_rep_id,sales_rep_name&limit=1`,
    { headers: sbHeaders },
  );
  if (!lookup.ok) {
    return json(500, { ok: false, error: `Could not fetch inspection: ${await lookup.text()}` });
  }
  const insp = (await lookup.json())?.[0];
  if (!insp) return json(404, { ok: false, error: "Inspection not found" });
  if (paId && insp.pa_id && insp.pa_id !== paId) {
    return json(403, { ok: false, error: "This claim belongs to a different PA" });
  }
  if (!insp.jn_job_id) {
    return json(400, { ok: false, error: "No JobNimbus job linked to this record" });
  }

  // 2. Flip to retail + record the PA's answer, and release ownership so
  //    the deal leaves the PA portal. process-retail-result (below) only
  //    reads result + jn_job_id, so clearing pa_id here is safe.
  const mergedFields = { ...(insp.pa_fields || {}), pa_signup: "Refused to Sign" };
  const patch = await fetch(`${SB_URL}/rest/v1/inspections?id=eq.${encodeURIComponent(inspectionId)}`, {
    method: "PATCH",
    headers: { ...sbHeaders, Prefer: "return=minimal" },
    body: JSON.stringify({
      result: "retail",
      pa_fields: mergedFields,
      pa_id: null,
      pa_claimed_at: null,
    }),
  });
  if (!patch.ok) {
    return json(500, { ok: false, error: `Could not update inspection: ${(await patch.text()).slice(0, 200)}` });
  }

  // 3. Full JobNimbus retail transition (best-effort — the deal is
  //    already flagged retail in our DB even if JN hiccups).
  let retail = { ok: false };
  if (base) {
    try {
      const r = await fetch(`${base}/.netlify/functions/process-retail-result`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ inspectionId }),
      });
      retail = await r.json().catch(() => ({ ok: false, error: `status ${r.status}` }));
    } catch (e) {
      retail = { ok: false, error: e.message };
    }
  } else {
    retail = { ok: false, error: "No base URL configured — JN retail transition skipped" };
  }

  // 4. Notify the sales rep + the rep's regional manager.
  const homeowner = insp.client_name || "the homeowner";
  const addr = [insp.address, insp.city, insp.state, insp.zip].filter(Boolean).join(", ");
  const message =
    `🏠 Retail opportunity — ${homeowner}\n\n` +
    `The public adjuster talked with the homeowner and they do NOT want to go through insurance.\n\n` +
    `Please go there and set up a retail appointment.\n\n` +
    `Homeowner: ${homeowner}` +
    (addr ? `\n${addr}` : "");

  // Resolve the rep's phone + JobNimbus id from CCG sales_reps.
  const rep = await resolveRep(SB_URL, sbHeaders, insp.sales_rep_id, insp.sales_rep_name);
  // Resolve the rep's zone (bridged through TMS) → regional manager phone.
  const zone = await resolveZone(SB_URL, sbHeaders, rep, insp.sales_rep_name);
  const manager = zone ? await fetchManager(SB_URL, sbHeaders, zone) : null;

  const notified = { rep: null, manager: null };
  if (base) {
    if (rep?.phone) {
      notified.rep = await sendSms(base, rep.phone, rep.name || insp.sales_rep_name || "Sales Rep", message);
    } else {
      notified.rep = { ok: false, error: "No rep phone on file" };
    }
    if (manager?.phone) {
      notified.manager = await sendSms(base, manager.phone, manager.name || "Manager", message);
    } else {
      notified.manager = { ok: false, error: zone ? `No manager phone for ${zone}` : "Could not resolve rep's zone" };
    }
  }

  return json(200, {
    ok: true,
    inspection_id: inspectionId,
    retail,
    zone: zone || null,
    notified,
  });
};

// ── Rep + zone + manager resolution ─────────────────────────────────

async function resolveRep(SB_URL, headers, salesRepId, salesRepName) {
  const sel = "id,name,phone,jobnimbus_id";
  const get = async (q) => {
    const res = await fetch(`${SB_URL}/rest/v1/sales_reps?${q}&select=${sel}&limit=1`, { headers });
    if (!res.ok) return null;
    return (await res.json().catch(() => []))?.[0] || null;
  };
  let rep = null;
  if (salesRepId) {
    rep = await get(`jobnimbus_id=eq.${encodeURIComponent(salesRepId)}`);
    if (!rep) rep = await get(`id=eq.${encodeURIComponent(salesRepId)}`);
  }
  if (!rep && salesRepName) {
    rep = await get(`name=ilike.${encodeURIComponent(salesRepName)}`);
  }
  return rep;
}

// Bridge the rep → zone the same way zone-leaderboard.js does: TMS
// rep-zones is the source of truth (keyed by JN id + normalized name).
async function resolveZone(SB_URL, headers, rep, fallbackName) {
  let tmsReps = [];
  try {
    const res = await fetch(TMS_REP_ZONES_URL);
    if (res.ok) tmsReps = (await res.json()).reps || [];
  } catch (e) {
    console.warn("TMS rep-zones fetch failed:", e.message || e);
  }
  const zoneByJnId = {};
  const zoneByNormName = {};
  for (const r of tmsReps) {
    if (r.jobnimbus_id) zoneByJnId[r.jobnimbus_id] = r.zone;
    if (r.name) zoneByNormName[normalizeName(r.name)] = r.zone;
  }
  const jnId = rep?.jobnimbus_id;
  const name = rep?.name || fallbackName;
  return (jnId && zoneByJnId[jnId]) || (name && zoneByNormName[normalizeName(name)]) || null;
}

async function fetchManager(SB_URL, headers, zone) {
  const res = await fetch(
    `${SB_URL}/rest/v1/regional_managers?zone=eq.${encodeURIComponent(zone)}&select=zone,name,phone&limit=1`,
    { headers },
  );
  if (!res.ok) return null;
  return (await res.json().catch(() => []))?.[0] || null;
}

async function sendSms(base, to, name, message) {
  try {
    const r = await fetch(`${base}/.netlify/functions/ghl-sms`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to, name, message }),
    });
    const rb = await r.json().catch(() => ({}));
    return { ok: r.ok, to, status: r.status, error: r.ok ? undefined : (rb.error || `status ${r.status}`) };
  } catch (e) {
    return { ok: false, to, error: e.message };
  }
}

// Same normalization as zone-leaderboard.js / manager-records-api.js so
// name variants collapse identically across surfaces.
function normalizeName(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/["“”]([^"“”]*)["“”]/g, "")
    .replace(/'([^']*)'/g, "")
    .replace(/\(([^)]*)\)/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function json(status, body) {
  return {
    statusCode: status,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}
