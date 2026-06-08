// netlify/functions/cron-assign-pas.js
//
// Auto-assigns damage deals to Public Adjusters. Replaces the old
// self-claim model: PAs no longer pick deals from a pool — the company
// distributes them automatically, in order, across the active PAs.
//
// Distribution = LEAST-LOADED round-robin (no persistent pointer needed):
// each unassigned eligible deal goes to the active PA who currently has
// the fewest open (non-dead, non-cancelled) deals; ties break by the PA's
// created_at (stable order). With ONE active PA, everything goes to him.
// As deals are assigned within a run, an in-memory tally keeps the spread
// even.
//
// Eligible deal (all must hold):
//   result='damage', pa_id IS NULL, jn_job_id IS NOT NULL,
//   cancelled_at IS NULL, pa_decision_needed=false, signed_at IS NOT NULL.
// Oldest signing first (so the backlog drains in order), capped per run.
//
// On assign: pa_id, pa_claimed_at=now, pa_stage='active', pa_stage_at=now.
//
// On/off: auto_sms row key 'pa_auto_assign' — if it exists with
// enabled=false, this cron no-ops (lets the manager pause auto-assign).
// Default (no row) = ON.
//
// Schedule: every 5 minutes. Required env: VITE_SUPABASE_URL,
// VITE_SUPABASE_ANON_KEY.

const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const PER_RUN = 100; // safety cap on assignments per run

export const handler = async (event) => {
  if (event.httpMethod && event.httpMethod !== "GET" && event.httpMethod !== "POST") {
    return json(405, { ok: false, error: "Method not allowed" });
  }
  if (!SB_URL || !SB_KEY) return json(500, { ok: false, error: "Missing Supabase env" });
  const sb = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" };

  // 0. Respect the manager's pause toggle.
  if (!(await autoAssignEnabled(sb))) {
    return json(200, { ok: true, paused: true, assigned: 0 });
  }

  // 1. Active PAs, stable order (earliest first).
  const pas = await get(`${SB_URL}/rest/v1/pas?select=id,name,created_at&active=eq.true&order=created_at.asc`, sb);
  if (!pas.length) return json(200, { ok: true, assigned: 0, note: "no active PAs" });

  // 2. Current open load per active PA (non-dead, non-cancelled).
  const activeIds = pas.map((p) => p.id);
  const idFilter = `(${activeIds.map((id) => `"${id}"`).join(",")})`;
  const open = await get(
    `${SB_URL}/rest/v1/inspections?select=pa_id&pa_id=in.${encodeURIComponent(idFilter)}` +
      `&cancelled_at=is.null&or=(pa_stage.is.null,pa_stage.neq.dead)`,
    sb,
  );
  const load = {};
  for (const p of pas) load[p.id] = 0;
  for (const r of open) if (r.pa_id in load) load[r.pa_id]++;

  // 3. Eligible unassigned deals, oldest signing first.
  const deals = await get(
    `${SB_URL}/rest/v1/inspections?select=id,client_name,signed_at` +
      `&result=eq.damage&pa_id=is.null&jn_job_id=not.is.null&cancelled_at=is.null` +
      `&pa_decision_needed=eq.false&signed_at=not.is.null` +
      `&order=signed_at.asc&limit=${PER_RUN}`,
    sb,
  );
  if (!deals.length) return json(200, { ok: true, assigned: 0, activePAs: pas.length });

  // 4. Assign each to the least-loaded active PA (tie → earliest PA).
  const nowIso = new Date().toISOString();
  const results = [];
  for (const deal of deals) {
    let pick = pas[0];
    for (const p of pas) if (load[p.id] < load[pick.id]) pick = p;
    const upRes = await fetch(`${SB_URL}/rest/v1/inspections?id=eq.${deal.id}&pa_id=is.null`, {
      method: "PATCH",
      headers: { ...sb, Prefer: "return=representation" },
      body: JSON.stringify({
        pa_id: pick.id,
        pa_claimed_at: nowIso,
        pa_stage: "active",
        pa_stage_at: nowIso,
      }),
    });
    const updated = upRes.ok ? await upRes.json().catch(() => []) : [];
    if (upRes.ok && updated.length) {
      load[pick.id]++;
      results.push({ deal: deal.client_name || deal.id, pa: pick.name });
    }
    // If the row was grabbed elsewhere (pa_id no longer null), updated is [] — skip.
  }

  console.log(`cron-assign-pas: assigned ${results.length}/${deals.length} across ${pas.length} PA(s)`);
  return json(200, { ok: true, activePAs: pas.length, assigned: results.length, results: results.slice(0, 25) });
};

async function autoAssignEnabled(sb) {
  try {
    const rows = await get(`${SB_URL}/rest/v1/auto_sms?key=eq.pa_auto_assign&select=enabled&limit=1`, sb);
    const row = rows[0];
    return !row || row.enabled !== false; // default ON
  } catch {
    return true;
  }
}

async function get(url, headers) {
  const r = await fetch(url, { headers });
  if (!r.ok) {
    console.warn(`query failed ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}`);
    return [];
  }
  return await r.json().catch(() => []);
}

function json(status, body) {
  return { statusCode: status, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

// Netlify v2 scheduled function — every 5 minutes.
export const config = { schedule: "*/5 * * * *" };
