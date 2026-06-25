// netlify/functions/manager-reassign-deal.js
//
// Reassign a departed rep's deal from the Regional Manager dashboard. The
// manager picks an "Assign Rep" (the person who'll now work it) and a
// "Sales Rep" (who gets the credit), then this writes both to JobNimbus:
//   • ASSIGN REP  → ADDED to the job's owners / "Assigned To" (JN allows
//     more than one — we keep anyone already on it and append, deduped).
//   • SALES REP   → REPLACES the job's sales_rep (+ sales_rep_name).
//
// Called cross-origin from the TMS regional-manager dashboard (same open-CORS
// pattern as the zone-* report feeds it sits next to). Validates that the JN
// ids passed are real active reps (from the TMS roster) so a stray call can't
// write garbage onto a job.
//
// POST { jnid, assigneeId?, salesRepId? }  (at least one of the two)
// → { ok, jnid, owners, sales_rep, sales_rep_name }
//
// Env: JOBNIMBUS_API_KEY.

const JN_BASE = "https://app.jobnimbus.com/api1";
const JN_KEY = process.env.JOBNIMBUS_API_KEY;
const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const REP_ZONES_URL = "https://trainingmanagementsys.netlify.app/.netlify/functions/rep-zones";
const jnHeaders = { Authorization: `bearer ${JN_KEY}`, "Content-Type": "application/json" };

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return cors(200, "");
  if (event.httpMethod !== "POST") return cors(405, JSON.stringify({ ok: false, error: "POST only" }));
  if (!JN_KEY) return cors(500, JSON.stringify({ ok: false, error: "JOBNIMBUS_API_KEY not set" }));

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { return cors(400, JSON.stringify({ ok: false, error: "bad JSON" })); }
  const jnid = String(body.jnid || "").trim();
  const assigneeId = String(body.assigneeId || "").trim();
  const salesRepId = String(body.salesRepId || "").trim();
  const kind = String(body.kind || "").trim();        // back_to_retail | no_damage | no_sit
  const customer = String(body.customer || "").trim();
  const address = String(body.address || "").trim();
  const zone = String(body.zone || "").trim();
  if (!jnid) return cors(400, JSON.stringify({ ok: false, error: "jnid required" }));
  if (!assigneeId && !salesRepId) return cors(400, JSON.stringify({ ok: false, error: "pick an assign rep and/or sales rep" }));

  // Validate the rep ids against the active TMS roster (name lookup for the
  // sales_rep_name we write). Rejects anything that isn't a current rep.
  const reps = await fetchActiveReps();
  const byId = {};
  for (const r of reps) if (r.jobnimbus_id) byId[r.jobnimbus_id] = r;
  if (assigneeId && !byId[assigneeId]) return cors(400, JSON.stringify({ ok: false, error: "assign rep is not a current active rep" }));
  if (salesRepId && !byId[salesRepId]) return cors(400, JSON.stringify({ ok: false, error: "sales rep is not a current active rep" }));

  try {
    // 1. Read the job's current owners so we APPEND (not clobber) the assignee.
    const jr = await fetch(`${JN_BASE}/jobs/${encodeURIComponent(jnid)}`, { headers: jnHeaders });
    if (!jr.ok) return cors(502, JSON.stringify({ ok: false, error: `JN job fetch ${jr.status}` }));
    const job = await jr.json();
    const existing = Array.isArray(job.owners) ? job.owners.filter((o) => o && o.id).map((o) => ({ id: o.id })) : [];

    const patch = {};
    if (assigneeId) {
      const owners = existing.slice();
      if (!owners.some((o) => o.id === assigneeId)) owners.push({ id: assigneeId });
      patch.owners = owners;
    }
    if (salesRepId) {
      patch.sales_rep = salesRepId;
      patch.sales_rep_name = byId[salesRepId].name;
    }

    const pr = await fetch(`${JN_BASE}/jobs/${encodeURIComponent(jnid)}`, {
      method: "PUT", headers: jnHeaders, body: JSON.stringify(patch),
    });
    const text = await pr.text();
    if (!pr.ok) return cors(502, JSON.stringify({ ok: false, error: `JN update ${pr.status}: ${text.slice(0, 200)}` }));

    // Keep our Supabase inspections row in sync so the back-to-retail / no-damage
    // reports (which group by inspections.sales_rep_name) re-group this deal
    // under the NEW sales rep — moving it out of the departed-rep section into
    // the active rep's group on the next load. (No-sits reads JN directly, so
    // that one's already handled by the JN write above.)
    if (salesRepId && SB_URL && SB_KEY) {
      try {
        await fetch(`${SB_URL}/rest/v1/inspections?jn_job_id=eq.${encodeURIComponent(jnid)}`, {
          method: "PATCH",
          headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json", Prefer: "return=minimal" },
          body: JSON.stringify({ sales_rep_id: salesRepId, sales_rep_name: byId[salesRepId].name }),
        });
      } catch { /* report still reflects the JN side; non-fatal */ }
    }

    // Text the rep who'll work it (the assignee; fall back to the sales rep)
    // with a context-specific hype message — "Sam just assigned you a …".
    let texted = false;
    const recipient = byId[assigneeId] || byId[salesRepId] || null;
    if (recipient && recipient.phone) {
      const mgr = await managerName(zone);
      const message = buildAssignMsg(kind, mgr, customer, address);
      const base = process.env.URL || process.env.DEPLOY_URL || process.env.PUBLIC_SITE_URL || "";
      if (base) {
        try {
          const r = await fetch(`${base}/.netlify/functions/ghl-sms`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ to: recipient.phone, name: recipient.name, message }),
          });
          texted = r.ok;
        } catch { /* SMS best-effort */ }
      }
    }

    return cors(200, JSON.stringify({
      ok: true,
      jnid,
      owners: patch.owners ? patch.owners.map((o) => byId[o.id]?.name || o.id) : undefined,
      sales_rep: patch.sales_rep_name || undefined,
      texted,
      textedRep: recipient?.name,
    }));
  } catch (e) {
    return cors(500, JSON.stringify({ ok: false, error: e.message || "error" }));
  }
};

// Manager's name for this zone (regional_managers), for the "<Sam> just
// assigned you…" line. Falls back to a generic phrase.
async function managerName(zone) {
  if (!zone || !SB_URL || !SB_KEY) return "Your manager";
  try {
    const r = await fetch(`${SB_URL}/rest/v1/regional_managers?zone=eq.${encodeURIComponent(zone)}&select=name&limit=1`,
      { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` } });
    const rows = await r.json().catch(() => []);
    return (rows[0] && rows[0].name) || "Your manager";
  } catch { return "Your manager"; }
}

// Context-specific assignment text by report type.
function buildAssignMsg(kind, mgr, customer, address) {
  const who = customer || "a homeowner";
  const at = address ? `, ${address}` : "";
  if (kind === "back_to_retail") return `${mgr} just assigned you a back-to-retail — ${who}${at}. Go get that appointment!`;
  if (kind === "damage") return `${mgr} just assigned you a damage inspection — ${who}${at}. Get out there and help them start their claim!`;
  if (kind === "no_damage") return `${mgr} just assigned you a no-damage — ${who}${at}. Go give them the great news and get referrals — who else can we help?`;
  if (kind === "no_sit") return `${mgr} just assigned you a no-sit to re-book — ${who}${at}. Get it back on the calendar!`;
  return `${mgr} just assigned you a deal — ${who}${at}. Go get it!`;
}

async function fetchActiveReps() {
  try {
    const res = await fetch(REP_ZONES_URL);
    if (!res.ok) return [];
    return (await res.json().catch(() => ({}))).reps || [];
  } catch { return []; }
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
