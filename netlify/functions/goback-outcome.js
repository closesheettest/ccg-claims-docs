// netlify/functions/goback-outcome.js
//
// The rep's one-tap answer to "how did the come-back go?".
//
// Nothing in the system ever asked. A go-back review appointment would come and
// go and the deal would sit exactly as it was — the self-scheduler report read
// 4 ran / 1 sold / 0 didn't sell, because the other three had no outcome on them
// at all. Not losses, blanks. That made the close rate a floor, not a number
// (Neal, 2026-08-20). This is the endpoint behind the follow-up text.
//
//   GET  ?rt=<rep harvest token>&i=<inspection_id>
//        → { ok, deal:{ client_name, address, appt_at, result, already } , rep:{ name } }
//   POST { rt, inspection_id, outcome: "sold"|"no_sale"|"ni"|"not_home" }
//        → { ok, recorded }
//
// Gate is the REP's own harvest token, not the shared visit token: the link goes
// out by SMS, and tying it to the rep means the outcome is attributable and the
// shared token never travels in a text. The write itself is delegated to the
// endpoints the map/Visit Hub already use, so there's exactly one code path that
// knows how to push a retail outcome to JobNimbus (including its won-deal guard).
//
// Env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, URL.

const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const sb = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" };
const OUTCOMES = new Set(["sold", "no_sale", "ni", "not_home"]);

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return cors(200, "");
  if (!SB_URL || !SB_KEY) return cors(500, JSON.stringify({ ok: false, error: "env missing" }));
  const base = (process.env.URL || process.env.PUBLIC_SITE_URL || "https://free-roof-inspections.netlify.app").replace(/\/$/, "");

  const qp = event.queryStringParameters || {};
  let body = {};
  if (event.httpMethod === "POST") {
    try { body = JSON.parse(event.body || "{}"); } catch { return cors(400, JSON.stringify({ ok: false, error: "bad JSON" })); }
  }
  const rt = String(body.rt || qp.rt || "").trim();
  const inspectionId = String(body.inspection_id || qp.i || "").trim();
  if (!rt || !inspectionId) return cors(400, JSON.stringify({ ok: false, error: "rt + inspection required" }));

  try {
    // harvest_token is a uuid column, so a mangled token (a truncated SMS link, a
    // copy-paste that grabbed trailing punctuation) makes Postgres 400 before we
    // ever get to compare it. That's still just an invalid link — say so, rather
    // than showing a rep a server error.
    const rep = (await sbGet(`sales_reps?harvest_token=eq.${encodeURIComponent(rt)}&select=name,jobnimbus_id,active&limit=1`).catch(() => []))[0];
    if (!rep) return cors(401, JSON.stringify({ ok: false, error: "This link isn't valid any more." }));

    const insp = (await sbGet(
      `inspections?id=eq.${encodeURIComponent(inspectionId)}` +
      `&select=id,client_name,address,city,result,review_appt_at,retail_outcome,retail_outcome_by,sales_rep_name,cancelled_at&limit=1`,
    ).catch(() => []))[0];
    if (!insp) return cors(404, JSON.stringify({ ok: false, error: "That deal isn't here any more." }));

    if (event.httpMethod !== "POST") {
      return cors(200, JSON.stringify({
        ok: true,
        rep: { name: rep.name },
        deal: {
          client_name: insp.client_name, address: insp.address, city: insp.city,
          result: insp.result, appt_at: insp.review_appt_at,
          // Already answered (by anyone, from any screen) → the page says so
          // instead of letting a rep record a second, conflicting outcome.
          already: insp.retail_outcome && insp.retail_outcome !== "retail_appt" && insp.retail_outcome !== "btr_appt"
            ? { outcome: insp.retail_outcome, by: insp.retail_outcome_by || null } : null,
        },
      }));
    }

    const outcome = String(body.outcome || "").trim();
    if (!OUTCOMES.has(outcome)) return cors(400, JSON.stringify({ ok: false, error: "outcome required" }));

    // Delegate. "Wasn't home" is its own flow — it re-opens the homeowner
    // sequence rather than closing the deal out, which is the whole difference
    // between a no-show and a no-sale.
    const token = await getSetting("visit_token");
    const fn = outcome === "not_home" ? "goback-not-home" : "retail-outcome-set";
    const payload = outcome === "not_home"
      ? { token, inspection_id: inspectionId }
      : { token, inspection_id: inspectionId, outcome, rep_name: rep.name };
    const r = await fetch(`${base}/.netlify/functions/${fn}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
    });
    const out = await r.json().catch(() => ({}));
    if (!r.ok || !out.ok) return cors(r.status || 502, JSON.stringify({ ok: false, error: out.error || "Couldn't record that.", protected: out.protected }));

    return cors(200, JSON.stringify({ ok: true, recorded: outcome }));
  } catch (e) {
    return cors(500, JSON.stringify({ ok: false, error: e.message || "error" }));
  }
};

async function getSetting(key) {
  const rows = await sbGet(`app_settings?key=eq.${encodeURIComponent(key)}&select=value&limit=1`);
  return rows[0]?.value || null;
}
async function sbGet(path) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: sb });
  if (!r.ok) throw new Error(`Supabase ${r.status}`);
  return r.json();
}
function cors(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json", "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    },
    body,
  };
}
