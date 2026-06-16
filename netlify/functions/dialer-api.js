// netlify/functions/dialer-api.js
//
// Backend for the standalone Power Dialer — a fast call queue for working the
// DAMAGE leads. Reps/office staff open /?dialer=<token>, the queue hands them
// one homeowner at a time (claimed so two callers never get the same person),
// they tap-to-dial, log a one-tap outcome, and it advances to the next.
//
// The queue auto-seeds from inspections (result=damage, has a mobile, not
// cancelled) that aren't in the queue yet — so new damage leads flow in.
//
// Dispositions:
//   reached / not_interested / bad_number / do_not_call → DONE (won't resurface)
//   no_answer  → retry in 3h     left_vm → retry tomorrow     callback → at the
//   chosen time. Retries come back into the pool when their next_attempt_at hits.
//
// Concurrency: claim_next_lead() (SQL, FOR UPDATE SKIP LOCKED) hands each caller
// a distinct lead; a claim left untouched 15 min is auto-released.
//
// Actions (POST { action, token, ... }):
//   'stats'       → seed + { counts, recent }
//   'next'        { caller }                      → claim & return the next lead
//   'disposition' { lead_id, caller, disposition, notes?, callback_at? }
//   'release'     { lead_id }                     → put a lead back in the pool
//
// Token: app_settings key 'dialer_token'. Env: VITE_SUPABASE_URL,
// VITE_SUPABASE_ANON_KEY.

const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const sb = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" };

const DONE = ["reached", "not_interested", "bad_number", "do_not_call"];
const RETRY = { no_answer: 3 * 3600e3, left_vm: 24 * 3600e3 }; // ms until retry

// county → zone (context label only; same map as the zone reports)
const ZONE_COUNTIES = {
  "Zone 1": ["Nassau", "Duval", "Baker", "Union", "Bradford", "Clay", "St. Johns", "Putnam", "Flagler", "Alachua", "Levy", "Marion", "Sumter", "Lake", "Seminole", "Volusia"],
  "Zone 2": ["Pasco", "Hillsborough", "Polk", "Osceola", "Indian River", "Highlands", "Citrus", "Hernando"],
  "Zone 3": ["Pinellas", "Manatee", "Sarasota", "Charlotte", "Lee", "Collier", "Monroe", "Hardee", "DeSoto", "Glades", "Hendry", "St. Lucie", "Okeechobee"],
  "Zone 4": ["Martin", "Palm Beach", "Broward", "Miami-Dade"],
};
function normCounty(s) { return String(s || "").toLowerCase().replace(/\bcounty\b/g, "").replace(/[^a-z0-9]+/g, " ").trim(); }
const COUNTY_ZONE = (() => { const m = {}; for (const [z, cs] of Object.entries(ZONE_COUNTIES)) for (const c of cs) m[normCounty(c)] = z; return m; })();
function countyToZone(county, lat) {
  const n = normCounty(county);
  if (!n) return null;
  if (n === "brevard" || n === "orange") return (lat != null && lat >= 28.55) ? "Zone 1" : "Zone 2";
  return COUNTY_ZONE[n] || null;
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return cors(200, "");
  if (event.httpMethod !== "POST") return cors(405, JSON.stringify({ ok: false, error: "POST only" }));
  if (!SB_URL || !SB_KEY) return cors(500, JSON.stringify({ ok: false, error: "Supabase env missing" }));

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { return cors(400, JSON.stringify({ ok: false, error: "bad JSON" })); }
  const action = String(body.action || "").trim();
  const token = String(body.token || "").trim();
  if (!token) return cors(400, JSON.stringify({ ok: false, error: "token required" }));

  // Validate the dialer token.
  const want = await getSetting("dialer_token");
  if (!want || token !== want) return cors(401, JSON.stringify({ ok: false, error: "Invalid link" }));

  try {
    if (action === "stats") {
      const seeded = await seedQueue();
      const counts = await counts_();
      return cors(200, JSON.stringify({ ok: true, seeded, counts }));
    }

    if (action === "next") {
      const caller = String(body.caller || "").trim() || "Caller";
      const rows = await rpc("claim_next_lead", { p_caller: caller });
      const lead = Array.isArray(rows) ? rows[0] : (rows || null);
      if (!lead) return cors(200, JSON.stringify({ ok: true, lead: null, message: "Queue empty" }));
      return cors(200, JSON.stringify({ ok: true, lead }));
    }

    if (action === "disposition") {
      const id = String(body.lead_id || "").trim();
      const caller = String(body.caller || "").trim() || "Caller";
      const disp = String(body.disposition || "").trim();
      const notes = String(body.notes || "").slice(0, 1000);
      if (!id || !disp) return cors(400, JSON.stringify({ ok: false, error: "lead_id and disposition required" }));

      const nowMs = Date.now();
      const patch = { disposition: disp, notes: notes || null, last_called_at: new Date(nowMs).toISOString(), claimed_by: null, claimed_at: null, updated_at: new Date(nowMs).toISOString() };
      patch.attempts = await bumpAttempts(id);
      if (DONE.includes(disp)) {
        patch.status = "done";
      } else if (disp === "callback") {
        patch.status = "new";
        patch.callback_at = body.callback_at || null;
        patch.next_attempt_at = body.callback_at || new Date(nowMs + 3600e3).toISOString();
      } else {
        patch.status = "new";
        patch.next_attempt_at = new Date(nowMs + (RETRY[disp] || 3600e3)).toISOString();
      }
      await patchLead(id, patch);
      await logCall(id, caller, disp, notes);
      return cors(200, JSON.stringify({ ok: true }));
    }

    if (action === "release") {
      const id = String(body.lead_id || "").trim();
      if (!id) return cors(400, JSON.stringify({ ok: false, error: "lead_id required" }));
      await patchLead(id, { status: "new", claimed_by: null, claimed_at: null, next_attempt_at: new Date().toISOString(), updated_at: new Date().toISOString() });
      return cors(200, JSON.stringify({ ok: true }));
    }

    return cors(400, JSON.stringify({ ok: false, error: `Unknown action: ${action}` }));
  } catch (e) {
    return cors(500, JSON.stringify({ ok: false, error: e.message || "error" }));
  }
};

// Pull damage leads (with a mobile) not yet in the queue and insert them.
async function seedQueue() {
  const existing = await sbGet(`call_queue?select=inspection_id&limit=20000`);
  const have = new Set(existing.map((r) => r.inspection_id).filter(Boolean));
  const damage = await sbGet(`inspections?result=eq.damage&cancelled_at=is.null&mobile=not.is.null&select=id,client_name,mobile,address,city,county,latitude&limit=10000`);
  const rows = [];
  for (const r of damage) {
    if (have.has(r.id)) continue;
    const phone = String(r.mobile || "").trim();
    if (!phone) continue;
    rows.push({
      inspection_id: r.id,
      client_name: (r.client_name || "").trim() || "(no name)",
      phone,
      address: [r.address, r.city].filter(Boolean).join(", "),
      zone: countyToZone(r.county, r.latitude),
      status: "new",
    });
  }
  if (!rows.length) return 0;
  // Insert in chunks; ignore dup conflicts on inspection_id.
  for (let i = 0; i < rows.length; i += 500) {
    await fetch(`${SB_URL}/rest/v1/call_queue?on_conflict=inspection_id`, {
      method: "POST", headers: { ...sb, Prefer: "resolution=ignore-duplicates,return=minimal" }, body: JSON.stringify(rows.slice(i, i + 500)),
    });
  }
  return rows.length;
}

async function counts_() {
  const nowIso = new Date().toISOString();
  const ready = await countRows(`status=eq.new&next_attempt_at=lte.${encodeURIComponent(nowIso)}`);
  const scheduled = await countRows(`status=eq.new&next_attempt_at=gt.${encodeURIComponent(nowIso)}`);
  const claimed = await countRows(`status=eq.claimed`);
  const done = await countRows(`status=eq.done`);
  const total = await countRows(`id=not.is.null`);
  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
  const callsToday = await countLog(`called_at=gte.${encodeURIComponent(todayStart.toISOString())}`);
  return { ready, scheduled, claimed, done, total, calls_today: callsToday };
}

// ── tiny REST helpers ───────────────────────────────────────────────
async function getSetting(key) {
  const rows = await sbGet(`app_settings?key=eq.${encodeURIComponent(key)}&select=value&limit=1`);
  return rows[0]?.value || null;
}
async function rpc(fn, args) {
  const r = await fetch(`${SB_URL}/rest/v1/rpc/${fn}`, { method: "POST", headers: sb, body: JSON.stringify(args) });
  if (!r.ok) throw new Error(`rpc ${fn} ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json().catch(() => null);
}
async function bumpAttempts(id) {
  const rows = await sbGet(`call_queue?id=eq.${encodeURIComponent(id)}&select=attempts&limit=1`);
  return (rows[0]?.attempts || 0) + 1;
}
async function patchLead(id, fields) {
  const r = await fetch(`${SB_URL}/rest/v1/call_queue?id=eq.${encodeURIComponent(id)}`, {
    method: "PATCH", headers: { ...sb, Prefer: "return=minimal" }, body: JSON.stringify(fields),
  });
  if (!r.ok) throw new Error(`patch ${r.status}`);
}
async function logCall(inspectionId, caller, disposition, notes) {
  // call_log keys off the queue row id we pass as lead context via inspection lookup
  const rows = await sbGet(`call_queue?id=eq.${encodeURIComponent(inspectionId)}&select=inspection_id&limit=1`);
  await fetch(`${SB_URL}/rest/v1/call_log`, {
    method: "POST", headers: { ...sb, Prefer: "return=minimal" },
    body: JSON.stringify({ queue_id: inspectionId, inspection_id: rows[0]?.inspection_id || null, caller, disposition, notes: notes || null }),
  });
}
async function sbGet(path) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: sb });
  if (!r.ok) return [];
  return r.json().catch(() => []);
}
async function countRows(filter) {
  const r = await fetch(`${SB_URL}/rest/v1/call_queue?${filter}&select=id`, { headers: { ...sb, Prefer: "count=exact", Range: "0-0" } });
  return parseCount(r);
}
async function countLog(filter) {
  const r = await fetch(`${SB_URL}/rest/v1/call_log?${filter}&select=id`, { headers: { ...sb, Prefer: "count=exact", Range: "0-0" } });
  return parseCount(r);
}
function parseCount(r) {
  const cr = r.headers.get("content-range") || "";
  const m = cr.match(/\/(\d+)$/);
  return m ? parseInt(m[1], 10) : 0;
}

function cors(status, body) {
  return { statusCode: status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" }, body };
}
