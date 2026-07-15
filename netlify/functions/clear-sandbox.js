// netlify/functions/clear-sandbox.js
//
// Wipes every training/practice ("sandbox") signing record — the button the
// office taps after in-classroom training to reset. Only ever touches rows
// flagged sandbox=true, so real signings/deals are never at risk. Practice runs
// never create inspections or JobNimbus deals (finalize-remote-signing skips
// them), so deleting the pending_signings rows is a full cleanup.
//
// POST {} → { ok, deleted }
//
// Env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY

export const handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { ok: false, error: "Method not allowed" });
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
  if (!SB_URL || !SB_KEY) return json(500, { ok: false, error: "Missing Supabase env" });
  const sb = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" };

  const r = await fetch(`${SB_URL}/rest/v1/pending_signings?sandbox=eq.true`, {
    method: "DELETE",
    headers: { ...sb, Prefer: "return=representation" },
  });
  if (!r.ok) return json(500, { ok: false, error: `delete failed: ${(await r.text()).slice(0, 200)}` });
  const rows = await r.json().catch(() => []);
  return json(200, { ok: true, deleted: Array.isArray(rows) ? rows.length : 0 });
};

function json(statusCode, obj) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) };
}
