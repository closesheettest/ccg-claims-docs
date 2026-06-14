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
    if (action === "week") return await doWeek(body);
    if (action === "note") return await doNote(body);
    if (action === "baseline") return await doBaseline(body);
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

  const picks = await sbGet(`ride_alongs?ride_date=eq.${date}&select=rep_id,rep_name,confirmed,start_time,end_time,decline_reason,refused_to_ride,trainer_note,text_sent_at&limit=500`);

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

  // Flag active reps who have NEVER signed a single inspection (all-time) —
  // these reps need to go back out, so William should prioritize them.
  await markNeverSigned(reps);

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

// Week overview: per-day counts for THIS week + NEXT week (Mon–Sun each), so
// William can both review this week and schedule riders for the week ahead.
// Returns weeks:[{weekStart,days:[7]},…]; `days` (this week) kept for back-compat.
async function doWeek(body) {
  if (!(await validTrainer(body.token))) return cors(403, JSON.stringify({ ok: false, error: "Invalid or expired link" }));
  const thisMon = normDate(body.weekStart) || mondayET();
  const nextMon = addDaysISO(thisMon, 7);
  const rangeEnd = addDaysISO(nextMon, 6); // end of next week
  const rows = await sbGet(`ride_alongs?ride_date=gte.${thisMon}&ride_date=lte.${rangeEnd}&select=ride_date,rep_id,refused_to_ride&limit=4000`);
  const byDay = {};
  for (const r of rows) {
    const d = r.ride_date; // baseline rows are dated to the earliest record — out of this window

    const b = (byDay[d] = byDay[d] || { rode: 0, refused: 0, none: 0 });
    if (String(r.rep_id) === NONE_ID) b.none++;
    else if (r.refused_to_ride) b.refused++;
    else b.rode++;
  }
  const weekDays = (start) => {
    const out = [];
    for (let i = 0; i < 7; i++) { const d = addDaysISO(start, i); out.push({ date: d, ...(byDay[d] || { rode: 0, refused: 0, none: 0 }) }); }
    return out;
  };
  const weeks = [
    { weekStart: thisMon, days: weekDays(thisMon) },
    { weekStart: nextMon, days: weekDays(nextMon) },
  ];
  return cors(200, JSON.stringify({ ok: true, weekStart: thisMon, weeks, days: weeks[0].days }));
}

// Baseline: William checks off reps who rode with him BEFORE tracking started.
// We seed each one a ride_along dated to the EARLIEST recorded ride date (our
// benchmark) so they leave "never ridden" and enter the rotation as "due."
// These rows are flagged baseline=true + confirmed=true + text_sent_at set, so
// they never trigger a confirmation text and don't count in the daily totals.
// Real rides logged afterward timestamp normally and move them down the list.
async function doBaseline(body) {
  if (!(await validTrainer(body.token))) return cors(403, JSON.stringify({ ok: false, error: "Invalid or expired link" }));
  const repIds = Array.isArray(body.repIds) ? body.repIds.map(String) : [];
  if (!repIds.length) return cors(400, JSON.stringify({ ok: false, error: "No reps selected" }));

  // Benchmark = the earliest ride date we have on record (today if none yet).
  const earliest = await sbGet(`ride_alongs?rep_id=neq.${NONE_ID}&select=ride_date&order=ride_date.asc&limit=1`);
  const baselineDate = (earliest[0] && earliest[0].ride_date) || todayET();

  const repMap = {};
  for (const r of await fetchActiveReps()) repMap[r.id] = { name: r.name, phone: r.phone };

  // Skip anyone who already has a ride_along (they're not truly "never ridden").
  const inList = repIds.map(encodeURIComponent).join(",");
  const existing = await sbGet(`ride_alongs?rep_id=in.(${inList})&select=rep_id&limit=1000`);
  const have = new Set(existing.map((e) => String(e.rep_id)));

  const toInsert = [];
  for (const rid of repIds) {
    if (have.has(rid)) continue;
    const r = repMap[rid];
    if (!r) continue;
    toInsert.push({ ride_date: baselineDate, rep_id: rid, rep_name: r.name, rep_phone: r.phone || null, confirm_token: crypto.randomUUID(), baseline: true, confirmed: true, text_sent_at: new Date().toISOString() });
  }
  if (toInsert.length) await fetch(`${SB_URL}/rest/v1/ride_alongs`, { method: "POST", headers: { ...sb, Prefer: "return=minimal" }, body: JSON.stringify(toInsert) });
  return cors(200, JSON.stringify({ ok: true, baselineDate, added: toInsert.length }));
}

// Trainer's end-of-day note on how it went with a rep.
async function doNote(body) {
  if (!(await validTrainer(body.token))) return cors(403, JSON.stringify({ ok: false, error: "Invalid or expired link" }));
  const date = normDate(body.date);
  const repId = String(body.repId || "");
  const note = (body.note || "").trim() || null;
  if (!date || !repId) return cors(400, JSON.stringify({ ok: false, error: "date + repId required" }));
  const r = await fetch(`${SB_URL}/rest/v1/ride_alongs?ride_date=eq.${date}&rep_id=eq.${encodeURIComponent(repId)}`, {
    method: "PATCH", headers: { ...sb, Prefer: "return=minimal" }, body: JSON.stringify({ trainer_note: note }),
  });
  if (!r.ok) return cors(502, JSON.stringify({ ok: false, error: "Could not save note" }));
  return cors(200, JSON.stringify({ ok: true }));
}

// Monday (ET) of the current week, YYYY-MM-DD.
function mondayET() {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const get = (t) => parts.find((p) => p.type === t)?.value;
  const DOW = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const dow = DOW[get("weekday")] ?? 0;
  const d = new Date(`${get("year")}-${get("month")}-${get("day")}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - (dow === 0 ? 6 : dow - 1));
  return d.toISOString().slice(0, 10);
}
function addDaysISO(ymd, n) {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
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
    const ZONE_ORDER = ["Zone 1", "Zone 2", "Zone 3", "Zone 4"];
    const zr = (z) => { const i = ZONE_ORDER.indexOf(z || ""); return i === -1 ? 98 : i; };
    return (data.reps || [])
      .filter((r) => (r.name || "").trim())
      .map((r) => ({ id: r.jobnimbus_id || ("name:" + slug(r.name)), name: r.name, phone: r.phone || null, zone: r.zone || null, county: r.county || null }))
      // Sort by team (zone), then county, then name — unknown/no-zone reps last.
      .sort((a, b) => zr(a.zone) - zr(b.zone) || (a.zone || "~").localeCompare(b.zone || "~") || (a.county || "~").localeCompare(b.county || "~") || a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

function slug(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, "-");
}

// Mutates `reps`, setting r.neverSigned = true on any active rep with ZERO
// signed inspections all-time (cancelled excluded). Matches a rep to the
// inspections table the same way the leaderboard does — bridge the TMS rep
// (JN id / name) → CCG sales_reps id, then check both sales_rep_id and
// sales_rep_name — so a name variant alone can't falsely flag a real signer.
async function markNeverSigned(reps) {
  const insp = await sbGet(`inspections?cancelled_at=is.null&select=sales_rep_id,sales_rep_name&limit=10000`);
  const signedIds = new Set();
  const signedNames = new Set();
  for (const r of insp) {
    if (r.sales_rep_id != null && r.sales_rep_id !== "") signedIds.add(String(r.sales_rep_id));
    if (r.sales_rep_name) signedNames.add(normName(r.sales_rep_name));
  }
  const ccg = await sbGet(`sales_reps?select=id,name,jobnimbus_id&limit=2000`);
  const ccgIdByJn = {};
  const ccgIdByName = {};
  for (const s of ccg) {
    if (s.jobnimbus_id) ccgIdByJn[String(s.jobnimbus_id)] = String(s.id);
    if (s.name) ccgIdByName[normName(s.name)] = String(s.id);
  }
  for (const r of reps) {
    if (r.id === TEST_REP_ID) { r.neverSigned = false; continue; }
    const nn = normName(r.name);
    const jn = String(r.id).startsWith("name:") ? null : String(r.id);
    const ccgId = (jn && ccgIdByJn[jn]) || ccgIdByName[nn] || null;
    const hasSigned = (ccgId && signedIds.has(ccgId)) || signedNames.has(nn);
    r.neverSigned = !hasSigned;
  }
}

// Same name normalization the leaderboard / weekly report use, so variants
// ('James "Jimmy" Bates' → 'james bates') collapse identically.
function normName(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/["“”]([^"“”]*)["“”]/g, "")
    .replace(/'([^']*)'/g, "")
    .replace(/\(([^)]*)\)/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
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
