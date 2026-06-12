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
// Source of truth for ACTIVE FIELD SALES REPS — the TMS roster (excludes
// non-field staff + inactive reps, and carries phones). CCG's sales_reps table
// includes non-reps, so we don't use it for William's picker.
const REP_ZONES_URL = "https://trainingmanagementsys.netlify.app/.netlify/functions/rep-zones";

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

  const reps = await fetchActiveReps();
  // Append a safe Test Rep at the bottom so the trainer flow can be dry-run.
  // Its phone = the saved test number (admin Training Report), so any text
  // goes to you, never a real rep.
  reps.push({ id: TEST_REP_ID, name: TEST_REP_NAME, phone: (await readSetting("training_test_phone")) || null });

  const picks = await sbGet(`ride_alongs?ride_date=eq.${date}&select=rep_id,rep_name,confirmed,start_time,end_time,decline_reason,refused_to_ride,text_sent_at&limit=500`);

  // Each rep's most recent PRIOR ride-along date (ignore the day being edited),
  // so William can see who he hasn't taken out in a while.
  const hist = await sbGet(`ride_alongs?select=rep_id,ride_date&order=ride_date.desc&limit=5000`);
  const lastByRep = {};
  for (const h of hist) {
    if (h.ride_date === date) continue;
    const id = String(h.rep_id);
    if (!lastByRep[id]) lastByRep[id] = h.ride_date;
  }
  for (const r of reps) r.last = lastByRep[r.id] || null;

  return cors(200, JSON.stringify({ ok: true, date, reps, picks }));
}

const NONE_ID = "__none__"; // sentinel rep_id for a "no one rode" day

async function doSave(body) {
  if (!(await validTrainer(body.token))) return cors(403, JSON.stringify({ ok: false, error: "Invalid or expired link" }));
  const date = normDate(body.date) || todayET();
  const noneReason = (body.noneReason || "").trim();
  const repIds = Array.isArray(body.repIds) ? body.repIds.map(String) : [];

  const existing = await sbGet(`ride_alongs?ride_date=eq.${date}&select=id,rep_id,text_sent_at,refused_to_ride&limit=500`);

  // ── "No one rode" day: clear non-texted rows, log a single reason row ──
  if (noneReason) {
    const del = existing.filter((e) => !e.text_sent_at).map((e) => e.id);
    for (const id of del) await fetch(`${SB_URL}/rest/v1/ride_alongs?id=eq.${id}`, { method: "DELETE", headers: sb });
    await fetch(`${SB_URL}/rest/v1/ride_alongs`, {
      method: "POST", headers: { ...sb, Prefer: "return=minimal" },
      body: JSON.stringify([{ ride_date: date, rep_id: NONE_ID, rep_name: "No one rode", rep_phone: null, confirm_token: crypto.randomUUID(), decline_reason: noneReason }]),
    });
    return cors(200, JSON.stringify({ ok: true, date, none: true }));
  }

  const repMap = {};
  for (const r of await fetchActiveReps()) repMap[r.id] = { name: r.name, phone: r.phone, zone: r.zone };
  repMap[TEST_REP_ID] = { name: TEST_REP_NAME, phone: (await readSetting("training_test_phone")) || null, zone: null };

  const existingByRep = {};
  for (const e of existing) existingByRep[String(e.rep_id)] = e;
  // Picking real reps cancels any prior "no one rode" entry for the day.
  if (existingByRep[NONE_ID]) await fetch(`${SB_URL}/rest/v1/ride_alongs?ride_date=eq.${date}&rep_id=eq.${NONE_ID}`, { method: "DELETE", headers: sb });

  // Insert newly-checked reps (skip ones already logged for the day). If a rep
  // was previously marked "wouldn't ride" and is now checked as rode, flip it
  // back to a normal pending ride.
  const toInsert = [];
  for (const rid of repIds) {
    const ex = existingByRep[rid];
    if (ex) {
      if (ex.refused_to_ride) {
        await fetch(`${SB_URL}/rest/v1/ride_alongs?id=eq.${ex.id}`, { method: "PATCH", headers: { ...sb, Prefer: "return=minimal" }, body: JSON.stringify({ refused_to_ride: false, confirmed: null, decline_reason: null, text_sent_at: null }) });
      }
      continue;
    }
    const r = repMap[rid];
    if (!r) continue;
    toInsert.push({ ride_date: date, rep_id: rid, rep_name: r.name, rep_phone: r.phone || null, confirm_token: crypto.randomUUID() });
  }
  let texted = 0;
  if (toInsert.length) {
    await fetch(`${SB_URL}/rest/v1/ride_alongs`, { method: "POST", headers: { ...sb, Prefer: "return=minimal" }, body: JSON.stringify(toInsert) });
    // Back-dated days (logging LAST WEEK) get the confirm text RIGHT AWAY so we
    // can collect answers now. Today's picks wait for tomorrow's 9:30 AM cron.
    if (date < todayET()) {
      for (const row of toInsert) {
        if (!row.rep_phone) continue;
        if (await sendConfirmSms(row)) {
          await fetch(`${SB_URL}/rest/v1/ride_alongs?confirm_token=eq.${encodeURIComponent(row.confirm_token)}`, { method: "PATCH", headers: { ...sb, Prefer: "return=minimal" }, body: JSON.stringify({ text_sent_at: new Date().toISOString() }) });
          texted++;
        }
      }
    }
  }

  // ── "Tried but they wouldn't ride" — trainer-reported refusals ──
  // No confirm text is sent (William is reporting it himself). Stored as
  // confirmed=false + refused_to_ride=true + his note in decline_reason.
  const refusals = Array.isArray(body.refusals) ? body.refusals.filter((x) => x && x.repId) : [];
  const refusedIds = new Set(refusals.map((x) => String(x.repId)));
  for (const x of refusals) {
    const rid = String(x.repId);
    const note = (x.note || "").trim() || null;
    const ex = existingByRep[rid];
    const wasRefused = !!(ex && ex.refused_to_ride); // already a refusal → don't re-text the manager
    const r = repMap[rid];
    if (ex) {
      await fetch(`${SB_URL}/rest/v1/ride_alongs?id=eq.${ex.id}`, { method: "PATCH", headers: { ...sb, Prefer: "return=minimal" }, body: JSON.stringify({ refused_to_ride: true, confirmed: false, decline_reason: note, text_sent_at: ex.text_sent_at || new Date().toISOString() }) });
    } else {
      if (!r) continue;
      await fetch(`${SB_URL}/rest/v1/ride_alongs`, { method: "POST", headers: { ...sb, Prefer: "return=minimal" }, body: JSON.stringify([{ ride_date: date, rep_id: rid, rep_name: r.name, rep_phone: r.phone || null, confirm_token: crypto.randomUUID(), refused_to_ride: true, confirmed: false, decline_reason: note, text_sent_at: new Date().toISOString() }]) });
    }
    // Newly-flagged refusal → text the rep's regional manager.
    if (!wasRefused && r) await notifyManagerOfRefusal(r, note);
  }

  // Remove un-checked reps — but only if they haven't been texted yet
  // (don't delete a row a rep may already be confirming). Refused reps stay.
  const keep = new Set([...repIds, ...refusedIds]);
  const toDelete = existing.filter((e) => !keep.has(String(e.rep_id)) && !e.text_sent_at).map((e) => e.id);
  for (const id of toDelete) {
    await fetch(`${SB_URL}/rest/v1/ride_alongs?id=eq.${id}`, { method: "DELETE", headers: sb });
  }

  return cors(200, JSON.stringify({ ok: true, date, added: toInsert.length, removed: toDelete.length, texted, refused: refusals.length }));
}

// Text the rep's regional manager that William tried to take them out for
// training but they wouldn't ride. rep → zone (from the TMS roster) →
// regional_managers (CCG) for the manager's phone — same lookup the PA
// "refused to sign" alert uses.
async function notifyManagerOfRefusal(rep, note) {
  const zone = rep && rep.zone;
  if (!zone) return false;
  const rows = await sbGet(`regional_managers?zone=eq.${encodeURIComponent(zone)}&select=name,phone&limit=1`);
  const mgr = rows?.[0];
  if (!mgr || !mgr.phone) return false;
  const base = process.env.URL || process.env.DEPLOY_URL || process.env.PUBLIC_SITE_URL || "";
  if (!base) return false;
  const message = `🚗 Training heads-up: William tried to take ${rep.name} out for field training today, but they wouldn't ride${note ? `. Reason: "${note}"` : "."}`;
  try {
    const r = await fetch(`${base}/.netlify/functions/ghl-sms`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ to: mgr.phone, name: mgr.name, message }) });
    return r.ok;
  } catch { return false; }
}

// Build + send a rep's confirm text now (used for back-dated saves).
async function sendConfirmSms(row) {
  const base = process.env.URL || process.env.DEPLOY_URL || process.env.PUBLIC_SITE_URL || "";
  if (!base) return false;
  const first = (row.rep_name || "").trim().split(/\s+/)[0] || "";
  const link = `${base}/?ridealong=${row.confirm_token}`;
  const message = `Hey${first ? " " + first : ""}! Quick one — did you go out with William for training? Tap to confirm your hours: ${link}`;
  try {
    const r = await fetch(`${base}/.netlify/functions/ghl-sms`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ to: row.rep_phone, name: row.rep_name, message }) });
    return r.ok;
  } catch { return false; }
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
const TEST_REP_ID = "test:rep";
const TEST_REP_NAME = "🧪 Test Rep (dry-run)";

async function readSetting(key) {
  const rows = await sbGet(`app_settings?key=eq.${encodeURIComponent(key)}&select=value&limit=1`);
  const v = rows?.[0]?.value;
  return v == null ? null : (typeof v === "string" ? v : String(v));
}

async function validTrainer(token) {
  if (!token) return false;
  const rows = await sbGet(`app_settings?key=eq.training_link_token&select=value&limit=1`);
  const stored = rows?.[0]?.value;
  if (!stored) return false;
  const s = typeof stored === "string" ? stored : String(stored);
  return s.trim() === String(token).trim();
}

// Active field sales reps from the TMS roster → [{ id, name, phone }].
// id = JobNimbus id when present, else a name slug (stable for the unique key).
async function fetchActiveReps() {
  try {
    const res = await fetch(REP_ZONES_URL);
    if (!res.ok) return [];
    const data = await res.json().catch(() => ({}));
    return (data.reps || [])
      .filter((r) => (r.name || "").trim())
      .map((r) => ({ id: r.jobnimbus_id || ("name:" + slug(r.name)), name: r.name, phone: r.phone || null, zone: r.zone || null }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

function slug(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, "-");
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
