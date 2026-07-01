// pa-retail-reasons.js
//
// The editable "why is this going back to retail?" reason list, backed by the
// pa_retail_reasons table (four seeded defaults; PAs can add more).
//
//   GET               → { ok, reasons: [{ id, label }] }   (active, sorted)
//   POST { label }    → adds a reason (idempotent on label), returns { ok, reason }
//
// Used by the PA app's "Send back to retail" reason picker. Uses the anon key
// like the other PA functions.
//
// Required env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY.

const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;

export const handler = async (event) => {
  if (!SB_URL || !SB_KEY) return json(500, { ok: false, error: "Server misconfigured (missing Supabase env)" });
  const H = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" };

  try {
    if (event.httpMethod === "GET") {
      const r = await fetch(
        `${SB_URL}/rest/v1/pa_retail_reasons?select=id,label&active=eq.true&order=sort.asc,label.asc`,
        { headers: H },
      );
      const reasons = r.ok ? await r.json().catch(() => []) : [];
      return json(200, { ok: true, reasons });
    }

    if (event.httpMethod === "POST") {
      const body = safeJson(event.body);
      const label = String(body.label || "").trim();
      if (!label) return json(400, { ok: false, error: "A reason is required" });
      if (label.length > 80) return json(400, { ok: false, error: "Reason is too long (80 characters max)" });
      // Upsert on the unique label so re-adding an existing reason just returns
      // it (and un-hides it if it had been deactivated).
      const r = await fetch(`${SB_URL}/rest/v1/pa_retail_reasons?on_conflict=label`, {
        method: "POST",
        headers: { ...H, Prefer: "resolution=merge-duplicates,return=representation" },
        body: JSON.stringify({ label, sort: 500, active: true }),
      });
      if (!r.ok) return json(500, { ok: false, error: `Couldn't add that reason (${r.status})` });
      const rows = await r.json().catch(() => []);
      return json(200, { ok: true, reason: rows[0] || { label } });
    }

    return json(405, { ok: false, error: "Method not allowed" });
  } catch (e) {
    return json(500, { ok: false, error: e.message || "error" });
  }
};

function safeJson(s) { try { return JSON.parse(s || "{}"); } catch { return {}; } }
function json(statusCode, obj) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) };
}
