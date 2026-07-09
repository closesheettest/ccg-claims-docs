// netlify/functions/cron-assign-pas.js
//
// Auto-assigns damage deals to Public Adjusters. Replaces the old
// self-claim model: PAs no longer pick deals from a pool — the company
// distributes them automatically, in order, across the active PAs.
//
// Distribution = LEAST-LOADED round-robin, measured PER PA but routed to the
// PA's COMPANY POOL. Targets:
//   • each active company (with ≥1 active PA) — weight = its active-PA count,
//   • each independent active PA (no company) — weight 1.
// Each eligible deal goes to the target with the lowest PER-CAPITA load
// (open deals ÷ weight). So a 5-PA company naturally takes ~5× the volume of
// a solo PA, and within a run an in-memory tally keeps the spread even.
//
// Routing on assign:
//   • company target → pa_company_id = company, pa_company_at = now, pa_id
//     stays NULL (that company's admin assigns it to one of their PAs via
//     /?pa_company=<token>).
//   • independent PA target → pa_id, pa_claimed_at, pa_stage='active' (direct,
//     as before).
//
// Eligible deal (all must hold):
//   result='damage', pa_id IS NULL, pa_company_id IS NULL, jn_job_id IS NOT
//   NULL, cancelled_at IS NULL, pa_decision_needed=false, signed_at NOT NULL.
// Oldest signing first (so the backlog drains in order), capped per run.
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

  // 1. Active PAs + active companies.
  const pas = await get(`${SB_URL}/rest/v1/pas?select=id,name,pa_company_id&active=eq.true&order=created_at.asc`, sb);
  if (!pas.length) return json(200, { ok: true, assigned: 0, note: "no active PAs" });
  const companies = await get(`${SB_URL}/rest/v1/pa_companies?select=id,name&active=eq.true`, sb);
  const companyName = {};
  const activeCompanyIds = new Set();
  // Companies that PAUSED scheduling (not set up / trained yet) are skipped for
  // auto-assign — no damage deals route to their PAs until they re-enable.
  // Separate + tolerant query so it works before the scheduling_paused column
  // exists (then: none paused).
  const pausedIds = new Set();
  try { for (const c of (await get(`${SB_URL}/rest/v1/pa_companies?scheduling_paused=eq.true&select=id`, sb)) || []) pausedIds.add(c.id); } catch { /* column not added yet */ }
  for (const c of companies) { companyName[c.id] = c.name; if (!pausedIds.has(c.id)) activeCompanyIds.add(c.id); }

  // 2. Build targets — one per active company (weight = its active-PA count)
  //    + one per independent active PA. PAs in an INACTIVE company are skipped
  //    (deactivating a company pauses its intake).
  const independents = pas.filter((p) => !p.pa_company_id);
  const companyPaCount = {};
  for (const p of pas) if (p.pa_company_id && activeCompanyIds.has(p.pa_company_id)) {
    companyPaCount[p.pa_company_id] = (companyPaCount[p.pa_company_id] || 0) + 1;
  }
  const targets = [];
  for (const cid of Object.keys(companyPaCount)) {
    targets.push({ type: "company", id: cid, name: companyName[cid] || "Company", weight: companyPaCount[cid], load: 0 });
  }
  for (const p of independents) targets.push({ type: "pa", id: p.id, name: p.name, weight: 1, load: 0 });
  if (!targets.length) return json(200, { ok: true, assigned: 0, note: "no active targets (no independents, all companies inactive)" });
  // Bias ties toward bigger pools (nicer initial spread); per-capita keeps it fair after.
  targets.sort((a, b) => b.weight - a.weight);

  // 3. Current open load: company pools (by pa_company_id) + independents (by pa_id).
  const openCompany = await get(
    `${SB_URL}/rest/v1/inspections?select=pa_company_id&pa_company_id=not.is.null&cancelled_at=is.null&or=(pa_stage.is.null,pa_stage.neq.dead)`,
    sb,
  );
  const poolLoad = {};
  for (const r of openCompany) if (r.pa_company_id) poolLoad[r.pa_company_id] = (poolLoad[r.pa_company_id] || 0) + 1;
  const indIds = independents.map((p) => p.id);
  const indLoad = {};
  if (indIds.length) {
    const idFilter = `(${indIds.map((id) => `"${id}"`).join(",")})`;
    const openPa = await get(
      `${SB_URL}/rest/v1/inspections?select=pa_id&pa_id=in.${encodeURIComponent(idFilter)}` +
        `&pa_company_id=is.null&cancelled_at=is.null&or=(pa_stage.is.null,pa_stage.neq.dead)`,
      sb,
    );
    for (const r of openPa) if (r.pa_id) indLoad[r.pa_id] = (indLoad[r.pa_id] || 0) + 1;
  }
  for (const t of targets) t.load = (t.type === "company" ? poolLoad[t.id] : indLoad[t.id]) || 0;

  // 4. Eligible deals — not assigned to a PA AND not already pooled.
  //    pa_stage='dead' is excluded so scrubbed deals (e.g. already filed by
  //    the prior PA) never get pulled back into the pipeline.
  const deals = await get(
    `${SB_URL}/rest/v1/inspections?select=id,client_name,signed_at` +
      `&result=eq.damage&pa_id=is.null&pa_company_id=is.null&jn_job_id=not.is.null&cancelled_at=is.null` +
      `&pa_decision_needed=eq.false&signed_at=not.is.null&or=(pa_stage.is.null,pa_stage.neq.dead)` +
      `&order=signed_at.asc&limit=${PER_RUN}`,
    sb,
  );
  if (!deals.length) return json(200, { ok: true, assigned: 0, targets: targets.length });

  // 5. Route each to the lowest per-capita (load ÷ weight) target.
  const nowIso = new Date().toISOString();
  const results = [];
  for (const deal of deals) {
    let pick = targets[0];
    for (const t of targets) if (t.load / t.weight < pick.load / pick.weight) pick = t;
    const body = pick.type === "company"
      ? { pa_company_id: pick.id, pa_company_at: nowIso }
      : { pa_id: pick.id, pa_claimed_at: nowIso, pa_stage: "active", pa_stage_at: nowIso };
    const upRes = await fetch(
      `${SB_URL}/rest/v1/inspections?id=eq.${deal.id}&pa_id=is.null&pa_company_id=is.null`,
      { method: "PATCH", headers: { ...sb, Prefer: "return=representation" }, body: JSON.stringify(body) },
    );
    const updated = upRes.ok ? await upRes.json().catch(() => []) : [];
    if (upRes.ok && updated.length) {
      pick.load++;
      results.push({ deal: deal.client_name || deal.id, target: pick.name, type: pick.type });
    }
    // If grabbed elsewhere (no longer null), updated is [] — skip.
  }

  console.log(`cron-assign-pas: routed ${results.length}/${deals.length} across ${targets.length} target(s)`);
  return json(200, { ok: true, targets: targets.length, assigned: results.length, results: results.slice(0, 25) });
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
