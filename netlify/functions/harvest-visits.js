// netlify/functions/harvest-visits.js
//
// A rep's post-inspection GO-BACKS for the Harvesting Map, so scheduled follow-up
// visits show up right alongside fresh doors and can be worked into the day:
//   • damage    → set the PA appointment
//   • no_damage → referrals + send certificate
//   • retail    → schedule a retail options appointment
//
// Resolves the rep from their harvest link, then reuses visit-deal-list (the same
// query the Rep Visit Hub uses) for each bucket so the filtering/exclusions stay
// identical. The client decides which are "due today" from result_task_at /
// review_availability.
//
//   POST { rt, lat?, lng? } → { ok, visits:[{ ...deal, bucket }] }
//
// Env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, URL

const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BUCKETS = ["damage", "no_damage", "retail"];

export const handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { ok: false, error: "POST only" });
  if (!SB_URL || !SB_KEY) return json(500, { ok: false, error: "env missing" });
  let body; try { body = JSON.parse(event.body || "{}"); } catch { return json(400, { ok: false, error: "bad JSON" }); }
  const rt = String(body.rt || "").trim();
  if (!UUID.test(rt)) return json(401, { ok: false, error: "Invalid link" });
  const lat = Number(body.lat), lng = Number(body.lng);

  const sb = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" };
  const sbGet = (path) => fetch(`${SB_URL}/rest/v1/${path}`, { headers: sb }).then((r) => (r.ok ? r.json() : [])).catch(() => []);

  const rep = (await sbGet(`sales_reps?harvest_token=eq.${encodeURIComponent(rt)}&select=name,jobnimbus_id&limit=1`))[0];
  if (!rep) return json(401, { ok: false, error: "Invalid link" });
  if (!rep.jobnimbus_id && !rep.name) return json(200, { ok: true, visits: [] });

  const visitToken = (await sbGet(`app_settings?key=eq.visit_token&select=value&limit=1`))[0]?.value;
  if (!visitToken) return json(200, { ok: true, visits: [], note: "visit_token not set" });

  const base = (process.env.URL || process.env.PUBLIC_SITE_URL || "https://free-roof-inspections.netlify.app").replace(/\/$/, "");
  const call = async (result) => {
    try {
      const r = await fetch(`${base}/.netlify/functions/visit-deal-list`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: visitToken, result, rep_jobnimbus_id: rep.jobnimbus_id || "", rep_name: rep.name || "", lat: isFinite(lat) ? lat : undefined, lng: isFinite(lng) ? lng : undefined }),
      });
      const d = await r.json().catch(() => ({}));
      return (d.deals || []).map((x) => ({ ...x, bucket: result }));
    } catch { return []; }
  };

  const lists = await Promise.all(BUCKETS.map(call));
  const visits = lists.flat();
  return json(200, { ok: true, visits });
};

function json(statusCode, obj) {
  return { statusCode, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }, body: JSON.stringify(obj) };
}
