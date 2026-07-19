// netlify/functions/harvest-ping.js
//
// A rep's Harvesting-Map posts their live GPS here (~every 60s) so the office
// "team view" can show where everyone is + a trailing breadcrumb line. Resolves
// the rep from their link token; stores one ping and prunes anything older than
// 6 hours for that rep so the table stays small.
//
//   POST { rt, lat, lng } → { ok }
//
// Env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY

const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { ok: false, error: "POST only" });
  if (!SB_URL || !SB_KEY) return json(500, { ok: false, error: "env missing" });
  let body; try { body = JSON.parse(event.body || "{}"); } catch { return json(400, { ok: false, error: "bad JSON" }); }
  const rt = String(body.rt || "").trim();
  const lat = Number(body.lat), lng = Number(body.lng);
  // `ended` = the rep just CLOSED the map (sent via sendBeacon on pagehide). Stamps
  // this ping so the live team views drop them immediately, not after 15 idle min.
  const ended = body.ended === true;
  if (!UUID.test(rt) || !Number.isFinite(lat) || !Number.isFinite(lng)) return json(400, { ok: false, error: "rt, lat, lng required" });

  const sb = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" };
  const rep = (await sbGet(`sales_reps?harvest_token=eq.${encodeURIComponent(rt)}&select=id,name&limit=1`, sb))[0];
  if (!rep) return json(200, { ok: false });   // unknown link — silently ignore

  try {
    const insert = (row) => fetch(`${SB_URL}/rest/v1/harvest_rep_pings`, {
      method: "POST", headers: { ...sb, Prefer: "return=minimal" }, body: JSON.stringify(row),
    });
    let res = await insert({ rep_id: rep.id, rep_name: rep.name || "Rep", lat, lng, ended });
    // `ended` column not migrated yet → retry without it so pinging never breaks.
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      if (/ended|column/i.test(t)) res = await insert({ rep_id: rep.id, rep_name: rep.name || "Rep", lat, lng });
    }
    // Retain ~45 days so the office can pull a day's route history (the live team
    // view still only queries the last 6h, so this doesn't slow it down). Older
    // than that is dropped so the table can't grow without bound (fire-and-forget).
    const cutoff = new Date(Date.now() - 45 * 24 * 3600 * 1000).toISOString();
    fetch(`${SB_URL}/rest/v1/harvest_rep_pings?rep_id=eq.${rep.id}&at=lt.${encodeURIComponent(cutoff)}`, { method: "DELETE", headers: sb }).catch(() => {});
  } catch { /* non-fatal */ }
  return json(200, { ok: true });
};

async function sbGet(path, sb) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: sb });
  if (!r.ok) return [];
  return r.json().catch(() => []);
}
function json(statusCode, obj) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) };
}
