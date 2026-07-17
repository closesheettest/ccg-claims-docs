// netlify/functions/harvest-delete-pin.js
//
// Let a rep delete a door THEY self-generated (a mistaken drop, a duplicate, etc.).
// Guard rails, enforced server-side so the client can't be tricked into more:
//   • the pin must be self-generated (list_name 'Self-Generated' / extra.self_generated), and
//   • it must belong to the rep making the request (assigned_rep_id, or extra.created_by_jn).
// Uploaded/synced leads and other reps' pins can never be deleted here.
//
//   POST { rt, pin_id } → { ok }
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
  const pinId = String(body.pin_id || "").trim();
  if (!UUID.test(rt)) return json(401, { ok: false, error: "Invalid link" });
  if (!pinId) return json(400, { ok: false, error: "pin_id required" });

  const sb = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" };
  const sbGet = (path) => fetch(`${SB_URL}/rest/v1/${path}`, { headers: sb }).then((r) => (r.ok ? r.json() : [])).catch(() => []);

  const rep = (await sbGet(`sales_reps?harvest_token=eq.${encodeURIComponent(rt)}&select=id,name,jobnimbus_id&limit=1`))[0];
  if (!rep) return json(401, { ok: false, error: "Invalid link" });

  const pin = (await sbGet(`canvass_prospects?id=eq.${encodeURIComponent(pinId)}&select=id,list_name,assigned_rep_id,extra&limit=1`))[0];
  if (!pin) return json(404, { ok: false, error: "pin not found" });

  const isSelfGen = pin.list_name === "Self-Generated" || !!(pin.extra && typeof pin.extra === "object" && pin.extra.self_generated);
  if (!isSelfGen) return json(403, { ok: false, error: "only self-generated pins can be deleted" });
  const owns = (pin.assigned_rep_id && String(pin.assigned_rep_id) === String(rep.id))
    || (pin.extra?.created_by_jn && rep.jobnimbus_id && String(pin.extra.created_by_jn) === String(rep.jobnimbus_id));
  if (!owns) return json(403, { ok: false, error: "this pin isn't yours to delete" });

  const del = await fetch(`${SB_URL}/rest/v1/canvass_prospects?id=eq.${encodeURIComponent(pinId)}`, { method: "DELETE", headers: { ...sb, Prefer: "return=minimal" } });
  if (!del.ok) return json(500, { ok: false, error: (await del.text().catch(() => "")).slice(0, 200) || "delete failed" });
  return json(200, { ok: true });
};

function json(statusCode, obj) {
  return { statusCode, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }, body: JSON.stringify(obj) };
}
