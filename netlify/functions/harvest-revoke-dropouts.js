// Expire the harvest link of anyone who has left — training dropouts AND reps
// who have been offboarded.
//
// A trainee gets a link card from the office setting harvest_level='trainee'.
// Nothing ever cleared it, so four people who dropped out of training days
// earlier still had live links into the map — Agustin Ghersi, Cheryl Nicholas,
// David Serafine and Yolanda Johnson (Neal, 2026-08-19).
//
// The link IS the credential: every harvest function looks the rep up by
// sales_reps.harvest_token, so clearing the token expires access everywhere at
// once rather than needing a check bolted onto eight endpoints. The old token is
// kept in harvest_token_revoked so a returning trainee can be restored rather
// than re-issued (their training results are keyed to it).
//
//   GET  ?dry=1        → who WOULD be revoked, changes nothing   (default)
//   GET  ?confirm=1    → actually revoke
//   GET  ?only=<name>  → restrict to one person (substring, case-insensitive),
//                        for revoking a single leaver without sweeping everyone
//
// TWO KINDS OF LEAVER:
//   • training dropouts   — TMS dropped_out
//   • offboarded reps     — TMS active:false, not in training  (e.g. Hoover
//                           Londono, fired, link still live and "Sent Jul 30")
//
// SAFETY. A revoke is only ever made on a POSITIVE statement from TMS, and never
// when any record for that person says they're active — duplicate trainee rows
// are common (17 at last count), so one stale row must not cut off a working rep.
// Pre-grads read as active:false by design; they are explicitly protected.
//
// Requires sql/harvest_revoke.sql. Env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY.

const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const sb = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" };
const REP_ZONES_URL = "https://trainingmanagementsys.netlify.app/.netlify/functions/rep-zones?include_inactive=1";

const normName = (v) => String(v || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

export const handler = async (event) => {
  if (!SB_URL || !SB_KEY) return json(500, { ok: false, error: "env missing" });
  const q = event.queryStringParameters || {};
  const confirm = q.confirm === "1";

  try {
    const rz = await fetch(REP_ZONES_URL).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    if (!rz || !Array.isArray(rz.reps)) return json(502, { ok: false, error: "could not read the training roster" });
    // If TMS hasn't deployed the dropped_out flag yet, every rep reads as "not
    // dropped" — which would silently revoke nobody. Say so rather than report success.
    if (!rz.reps.some((r) => Object.prototype.hasOwnProperty.call(r, "dropped_out"))) {
      return json(409, { ok: false, error: "rep-zones has no dropped_out field yet — deploy TMS first" });
    }

    const goneJn = new Map(), goneName = new Map(), activeName = new Set(), activeJn = new Set();
    const markGone = (r, why) => {
      const nn = normName(r.name);
      if (r.jobnimbus_id) goneJn.set(String(r.jobnimbus_id), why);
      if (nn) goneName.set(nn, why);
    };
    for (const r of rz.reps) {
      const nn = normName(r.name);
      const inTraining = r.in_training === true || r.pregrad === true;
      if (r.dropped_out) markGone(r, "dropped out of training");
      // Offboarded: TMS says not active, and they're not a pre-grad (who read as
      // active:false purely so the contest and pay skip them).
      else if (r.active === false && !inTraining) markGone(r, "no longer an active rep");
      // Off limits: anyone TMS still calls active, anyone mid-training, and every
      // REGIONAL MANAGER (managed_region set). A manager isn't always flagged as an
      // active selling rep, and cutting a manager's map access would be the worst
      // possible false positive — Neal's rule is active reps, managers, admins and
      // trainees keep their links (2026-08-19).
      if ((r.active === true && !r.dropped_out) || inTraining || r.managed_region) {
        if (r.jobnimbus_id) activeJn.add(String(r.jobnimbus_id));
        if (nn) activeName.add(nn);
      }
    }

    const reps = await sbGet(`sales_reps?harvest_token=not.is.null&select=id,name,jobnimbus_id,harvest_token,harvest_level,harvest_link_sent_at`);
    const hit = [];
    for (const r of reps || []) {
      const nn = normName(r.name);
      // An office 'admin' assignment is deliberate and not a field rep, so it's
      // left alone — those are trainers and staff, not people who get offboarded
      // through the training system.
      if (String(r.harvest_level || "").toLowerCase() === "admin") continue;
      const why = (r.jobnimbus_id && goneJn.get(String(r.jobnimbus_id))) || goneName.get(nn) || null;
      const isActive = (r.jobnimbus_id && activeJn.has(String(r.jobnimbus_id))) || activeName.has(nn);
      // Not mentioned by TMS at all → say nothing, do nothing. Silence is not a
      // statement that someone has left.
      if (why && !isActive) hit.push({ ...r, why });
    }

    // Narrow to one person when asked. Applied AFTER the safety checks, so ?only=
    // can never revoke someone the sweep itself wouldn't have.
    const only = String(q.only || "").trim().toLowerCase();
    const targets = only ? hit.filter((r) => String(r.name || "").toLowerCase().includes(only)) : hit;
    if (only && !targets.length) {
      return json(404, { ok: false, error: `nobody matching "${q.only}" is eligible to be revoked`, candidates: hit.length });
    }

    if (!confirm) {
      return json(200, {
        ok: true, dry_run: true, would_revoke: targets.length,
        reps: targets.map((r) => ({ name: r.name, why: r.why, level: r.harvest_level, link_sent: r.harvest_link_sent_at })),
      });
    }

    const done = [], failed = [];
    for (const r of targets) {
      const res = await fetch(`${SB_URL}/rest/v1/sales_reps?id=eq.${encodeURIComponent(r.id)}`, {
        method: "PATCH",
        headers: { ...sb, Prefer: "return=representation" },
        body: JSON.stringify({
          harvest_token: null,
          harvest_token_revoked: r.harvest_token,
          harvest_revoked_at: new Date().toISOString(),
          harvest_level: null,
        }),
      });
      const rows = res.ok ? await res.json().catch(() => []) : [];
      // PostgREST answers a PATCH that matched nothing with 200 and [] — that is
      // not a revocation, so it must not be counted as one.
      if (res.ok && rows.length) done.push(r.name); else failed.push({ name: r.name, status: res.status });
    }
    return json(200, { ok: true, revoked: done.length, names: done, failed });
  } catch (e) {
    return json(500, { ok: false, error: e.message || "error" });
  }
};

async function sbGet(path) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: sb });
  if (!r.ok) throw new Error(`supabase ${r.status}`);
  return r.json();
}
function json(status, body) {
  return { statusCode: status, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }, body: JSON.stringify(body) };
}
