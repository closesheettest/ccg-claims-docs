// netlify/functions/restore-job-owner.js
//
// THROWAWAY one-off: restore JN job mpilxs4y28egpnhkeedmva7 (Jane Ann Davis)
// to its exact pre-test owners + sales rep after the manager-reassign-deal
// controlled test. Hardcoded values + confirm gate so it can't touch anything
// else. Delete this file after running.
//
// POST { confirm: "RESTORE" }

const JN_BASE = "https://app.jobnimbus.com/api1";
const JN_KEY = process.env.JOBNIMBUS_API_KEY;
const jnHeaders = { Authorization: `bearer ${JN_KEY}`, "Content-Type": "application/json" };

const JNID = "mpilxs4y28egpnhkeedmva7";
const RESTORE = {
  owners: [{ id: "af3ddcebe41f465289b3e0be1ca8f02f" }, { id: "e5f08ef017a34ce9888b6b226cc4af0e" }],
  sales_rep: "af3ddcebe41f465289b3e0be1ca8f02f",
  sales_rep_name: "Jerry Weitsz",
};

export const handler = async (event) => {
  if (event.httpMethod !== "POST") return j(405, { ok: false, error: "POST only" });
  if (!JN_KEY) return j(500, { ok: false, error: "JOBNIMBUS_API_KEY not set" });
  let body; try { body = JSON.parse(event.body || "{}"); } catch { return j(400, { ok: false, error: "bad JSON" }); }
  if (body.confirm !== "RESTORE") return j(403, { ok: false, error: 'pass confirm:"RESTORE"' });
  try {
    const r = await fetch(`${JN_BASE}/jobs/${JNID}`, { method: "PUT", headers: jnHeaders, body: JSON.stringify(RESTORE) });
    const t = await r.text();
    if (!r.ok) return j(502, { ok: false, error: `JN ${r.status}: ${t.slice(0, 200)}` });
    return j(200, { ok: true, restored: RESTORE });
  } catch (e) { return j(500, { ok: false, error: e.message }); }
};

function j(s, b) { return { statusCode: s, headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) }; }
