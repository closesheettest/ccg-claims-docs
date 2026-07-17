// netlify/functions/harvest-access.js
//
// Records that a rep HAD Harvesting-Map access this month (billing ledger). The
// rep's map calls this once when it opens; the trainee-grant flow also stamps it.
// One row per rep per month — persists even after the person is removed, so a
// one-day trainee still gets billed for that month. Admin/office (no rt) isn't
// logged. Exposed helper stampAccess() is reused by other functions.
//
//   POST { rt } → { ok }
//
// Env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY

const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Upsert one (rep_id, current-month) row. Safe to call repeatedly (dedupes).
export async function stampAccess(sb, repId, repName) {
  if (!SB_URL || !repId) return;
  const month = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" }).slice(0, 7); // YYYY-MM
  try {
    await fetch(`${SB_URL}/rest/v1/harvest_access_months?on_conflict=rep_id,month`, {
      method: "POST",
      headers: { ...sb, Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({ rep_id: repId, rep_name: repName || "Rep", month }),
    });
  } catch { /* non-fatal */ }
}

export const handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { ok: false });
  if (!SB_URL || !SB_KEY) return json(500, { ok: false });
  let body; try { body = JSON.parse(event.body || "{}"); } catch { return json(400, { ok: false }); }
  const rt = String(body.rt || "").trim();
  if (!UUID.test(rt)) return json(200, { ok: false });

  const sb = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" };
  const rep = (await fetch(`${SB_URL}/rest/v1/sales_reps?harvest_token=eq.${encodeURIComponent(rt)}&select=id,name&limit=1`, { headers: sb }).then((r) => (r.ok ? r.json() : [])).catch(() => []))[0];
  if (!rep) return json(200, { ok: false });
  await stampAccess(sb, rep.id, rep.name);
  return json(200, { ok: true });
};

function json(statusCode, obj) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) };
}
