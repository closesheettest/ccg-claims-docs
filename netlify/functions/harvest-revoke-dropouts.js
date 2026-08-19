// Expire the harvest link of anyone who has left training.
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
//   GET  ?dry=1      → who WOULD be revoked, changes nothing   (default)
//   GET  ?confirm=1  → actually revoke
//
// Only ever touches people whose CCG level is 'trainee'. An active sales rep is
// never revoked, whatever TMS says, so a mis-set training flag can't cut off a
// working rep.
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

    const droppedJn = new Set(), droppedName = new Set(), activeName = new Set(), activeJn = new Set();
    for (const r of rz.reps) {
      const nn = normName(r.name);
      if (r.dropped_out) { if (r.jobnimbus_id) droppedJn.add(String(r.jobnimbus_id)); if (nn) droppedName.add(nn); }
      // A currently-active sales rep is off limits no matter what else is set.
      if (r.active === true && r.dropped_out !== true) { if (r.jobnimbus_id) activeJn.add(String(r.jobnimbus_id)); if (nn) activeName.add(nn); }
    }

    const reps = await sbGet(`sales_reps?harvest_token=not.is.null&harvest_level=eq.trainee&select=id,name,jobnimbus_id,harvest_token,harvest_level`);
    const hit = [];
    for (const r of reps || []) {
      const nn = normName(r.name);
      const isDropped = (r.jobnimbus_id && droppedJn.has(String(r.jobnimbus_id))) || droppedName.has(nn);
      const isActive = (r.jobnimbus_id && activeJn.has(String(r.jobnimbus_id))) || activeName.has(nn);
      if (isDropped && !isActive) hit.push(r);
    }

    if (!confirm) {
      return json(200, { ok: true, dry_run: true, would_revoke: hit.length, reps: hit.map((r) => ({ name: r.name, id: r.id })) });
    }

    const done = [], failed = [];
    for (const r of hit) {
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
