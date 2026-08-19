// Save (or clear) the gate code on a pin.
//
// Two booked inspections were lost to a gate in a single week — the drive was
// made, the homeowner had signed up, and the roof never got looked at because
// nobody had four digits. Whoever learns the code should be able to put it on
// the pin from wherever they are, so the next person through isn't stuck at the
// same call box (Neal, 2026-08-19).
//
//   POST { inspection_id, gate_code, by }   → save (empty gate_code clears it)
//   GET  ?inspection_id=…                   → read it back
//
// Requires sql/gate_code.sql. Env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY.

const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const sb = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" };

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return cors(200, {});
  if (!SB_URL || !SB_KEY) return cors(500, { ok: false, error: "env missing" });

  try {
    if (event.httpMethod === "GET") {
      const id = (event.queryStringParameters || {}).inspection_id;
      if (!id) return cors(400, { ok: false, error: "inspection_id required" });
      const r = await fetch(`${SB_URL}/rest/v1/inspections?id=eq.${encodeURIComponent(id)}&select=id,gate_code,gate_code_at,gate_code_by&limit=1`, { headers: sb });
      if (!r.ok) return cors(500, { ok: false, error: `read failed (${r.status}) — has sql/gate_code.sql been run?` });
      const rows = await r.json();
      return cors(200, { ok: true, ...(rows[0] || {}) });
    }

    if (event.httpMethod !== "POST") return cors(405, { ok: false, error: "Method Not Allowed" });

    let body;
    try { body = JSON.parse(event.body || "{}"); } catch { return cors(400, { ok: false, error: "bad JSON" }); }
    const id = body.inspection_id;
    if (!id) return cors(400, { ok: false, error: "inspection_id required" });

    // Codes are short. Anything longer is someone pasting directions into the
    // wrong box, so keep it to something a keypad can accept plus a hint.
    const code = String(body.gate_code || "").trim().slice(0, 60);
    const by = String(body.by || "").trim().slice(0, 80) || null;

    const patch = code
      ? { gate_code: code, gate_code_at: new Date().toISOString(), gate_code_by: by }
      : { gate_code: null, gate_code_at: null, gate_code_by: null };

    const r = await fetch(`${SB_URL}/rest/v1/inspections?id=eq.${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { ...sb, Prefer: "return=representation" },
      body: JSON.stringify(patch),
    });
    if (!r.ok) return cors(500, { ok: false, error: `save failed (${r.status}) — has sql/gate_code.sql been run?` });
    const rows = await r.json();
    // PostgREST answers a PATCH that matched nothing with a cheerful 200 and an
    // empty array, so an unknown id would otherwise look like success.
    if (!rows.length) return cors(404, { ok: false, error: "no inspection with that id" });
    return cors(200, { ok: true, gate_code: rows[0].gate_code, gate_code_at: rows[0].gate_code_at, gate_code_by: rows[0].gate_code_by });
  } catch (e) {
    return cors(500, { ok: false, error: e.message || "error" });
  }
};

function cors(status, body) {
  return {
    statusCode: status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
    body: JSON.stringify(body),
  };
}
