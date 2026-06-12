// netlify/functions/training-api.js
//
// Backs the field-training ride-along feature (CCG):
//   • William's private picker page  /?training=<trainer token>
//   • each rep's confirm page        /?ridealong=<confirm token>
//
// Token-gated, multi-action (same shape as regional-manager-api /
// pa-company-api). The trainer token is a single shared link stored in the
// app_settings key/value table (key 'training_link_token'); each ride_along
// row carries its own per-rep confirm_token.
//
// POST { action, token, ... }:
//   init    (trainer token) → { reps:[{id,name,phone}], date, picks:[...] }
//   save    (trainer token) { date, repIds:[] } → upsert one ride_alongs row
//                            per checked rep; un-checks (not yet texted) removed
//   get     (confirm token) → { rep_name, ride_date, confirmed, start/end }
//   confirm (confirm token) { yes, start, end } → record the rep's answer
//
// Env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY.

const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const sb = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" };

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return cors(200, "");
  if (event.httpMethod !== "POST") return cors(405, JSON.stringify({ ok: false, error: "Method Not Allowed" }));
  if (!SB_URL || !SB_KEY) return cors(500, JSON.stringify({ ok: false, error: "Server misconfigured (missing Supabase env)" }));

  let body;
  try { body = JSON.parse(event.body || "{}"); }
  catch { return cors(400, JSON.stringify({ ok: false, error: "Invalid JSON" })); }
  const action = (body.action || "").trim();

  try {
    if (action === "init") return await doInit(body);
    if (action === "save") return await doSave(body);
    if (action === "get") return await doGet(body);
    if (action === "confirm") return await doConfirm(body);
    return cors(400, JSON.stringify({ ok: false, error: `Unknown action "${action}"` }));
  } catch (e) {
    return cors(500, JSON.stringify({ ok: false, error: e.message || "Server error" }));
  }
};

// ── Trainer (William) actions ────────────────────────────────────────
async function doInit(body) {
  if (!(await validTrainer(body.token))) return cors(403, JSON.stringify({ ok: false, error: "Invalid or expired link" }));
  const date = normDate(body.date) || todayET();

  const reps = (await sbGet(`sales_reps?select=id,name,phone,active&order=name.asc&limit=2000`))
    .filter((r) => r.active !== false && (r.name || "").trim())
    .map((r) => ({ id: String(r.id), name: r.name, phone: r.phone || null }));

  const picks = await sbGet(`ride_alongs?ride_date=eq.${date}&select=rep_id,rep_name,confirmed,start_time,end_time,text_sent_at&limit=500`);

  return cors(200, JSON.stringify({ ok: true, date, reps, picks }));
}

async function doSave(body) {
  if (!(await validTrainer(body.token))) return cors(403, JSON.stringify({ ok: false, error: "Invalid or expired link" }));
  const date = normDate(body.date) || todayET();
  const repIds = Array.isArray(body.repIds) ? body.repIds.map(String) : [];

  const repMap = {};
  for (const r of await sbGet(`sales_reps?select=id,name,phone&limit=2000`)) repMap[String(r.id)] = r;

  const existing = await sbGet(`ride_alongs?ride_date=eq.${date}&select=id,rep_id,text_sent_at&limit=500`);
  const existingByRep = {};
  for (const e of existing) existingByRep[String(e.rep_id)] = e;

  // Insert newly-checked reps (skip ones already logged for the day).
  const toInsert = [];
  for (const rid of repIds) {
    if (existingByRep[rid]) continue;
    const r = repMap[rid];
    if (!r) continue;
    toInsert.push({ ride_date: date, rep_id: rid, rep_name: r.name, rep_phone: r.phone || null, confirm_token: crypto.randomUUID() });
  }
  if (toInsert.length) {
    await fetch(`${SB_URL}/rest/v1/ride_alongs`, { method: "POST", headers: { ...sb, Prefer: "return=minimal" }, body: JSON.stringify(toInsert) });
  }

  // Remove un-checked reps — but only if they haven't been texted yet
  // (don't delete a row a rep may already be confirming).
  const keep = new Set(repIds);
  const toDelete = existing.filter((e) => !keep.has(String(e.rep_id)) && !e.text_sent_at).map((e) => e.id);
  for (const id of toDelete) {
    await fetch(`${SB_URL}/rest/v1/ride_alongs?id=eq.${id}`, { method: "DELETE", headers: sb });
  }

  return cors(200, JSON.stringify({ ok: true, date, added: toInsert.length, removed: toDelete.length }));
}

// ── Rep confirm actions ──────────────────────────────────────────────
async function doGet(body) {
  const token = (body.token || "").trim();
  if (!token) return cors(400, JSON.stringify({ ok: false, error: "token required" }));
  const rows = await sbGet(`ride_alongs?confirm_token=eq.${encodeURIComponent(token)}&select=rep_name,ride_date,confirmed,start_time,end_time&limit=1`);
  const row = rows[0];
  if (!row) return cors(404, JSON.stringify({ ok: false, error: "Link not found" }));
  return cors(200, JSON.stringify({ ok: true, rep_name: row.rep_name, ride_date: row.ride_date, confirmed: row.confirmed, start_time: row.start_time, end_time: row.end_time }));
}

async function doConfirm(body) {
  const token = (body.token || "").trim();
  if (!token) return cors(400, JSON.stringify({ ok: false, error: "token required" }));
  const yes = !!body.yes;
  const patch = {
    confirmed: yes,
    start_time: yes ? (body.start || null) : null,
    end_time: yes ? (body.end || null) : null,
    decline_reason: yes ? null : ((body.reason || "").trim() || null),
    responded_at: new Date().toISOString(),
  };
  const r = await fetch(`${SB_URL}/rest/v1/ride_alongs?confirm_token=eq.${encodeURIComponent(token)}`, {
    method: "PATCH", headers: { ...sb, Prefer: "return=minimal" }, body: JSON.stringify(patch),
  });
  if (!r.ok) return cors(502, JSON.stringify({ ok: false, error: "Could not save your answer" }));
  return cors(200, JSON.stringify({ ok: true }));
}

// ── helpers ──────────────────────────────────────────────────────────
async function validTrainer(token) {
  if (!token) return false;
  const rows = await sbGet(`app_settings?key=eq.training_link_token&select=value&limit=1`);
  const stored = rows?.[0]?.value;
  if (!stored) return false;
  const s = typeof stored === "string" ? stored : String(stored);
  return s.trim() === String(token).trim();
}

async function sbGet(path) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: sb });
  if (!r.ok) return [];
  return await r.json().catch(() => []);
}

function normDate(d) {
  const s = String(d || "").slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

function todayET() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

function cors(status, body) {
  return {
    statusCode: status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
    body,
  };
}
