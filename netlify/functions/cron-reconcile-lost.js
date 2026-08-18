// netlify/functions/cron-reconcile-lost.js
//
// Backstop: every job JobNimbus calls LOST should be cancelled on our side.
//
// inspection-checker already flows JN "Lost" into cancelled_at, but it finds
// jobs by RECENCY — date_updated in the last 60 days, capped at 5 pages of 100.
// Once more than 500 jobs are touched in that window, anything updated earlier
// falls off the bottom and is never looked at again. Nine deals marked Lost
// between April and June sat uncancelled for months that way, counting as retail
// inspections in the submission report and missing from its Cancelled box
// (found 2026-08-18).
//
// This asks the opposite question — "which jobs are Lost?" — so the answer
// doesn't depend on when they were last touched. ~300 jobs, bounded and cheap.
// The checker stays the fast path (15 min); this is the net underneath it.
//
//   GET ?secret=<CRON_SECRET>[&dry_run=1]
//
// Env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, JOBNIMBUS_API_KEY, CRON_SECRET

const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const JN_BASE = "https://app.jobnimbus.com/api1";
const JN_KEY = process.env.JOBNIMBUS_API_KEY;
const sb = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" };
const jnH = { Authorization: `bearer ${JN_KEY}`, "Content-Type": "application/json" };

export const config = { schedule: "20 10 * * *" };   // 6:20 AM ET daily

export const handler = async (event) => {
  const q = (event && event.queryStringParameters) || {};
  // Scheduled invocations have no httpMethod; a manual GET needs the secret.
  if (event && event.httpMethod && process.env.CRON_SECRET && q.secret !== process.env.CRON_SECRET) {
    return json(401, { ok: false, error: "Unauthorized" });
  }
  if (!SB_URL || !SB_KEY || !JN_KEY) return json(500, { ok: false, error: "env missing" });
  const dryRun = q.dry_run === "1";

  try {
    // 1. Every job JN currently calls Lost.
    const lostIds = new Set();
    const filter = encodeURIComponent(JSON.stringify({ must: [{ term: { status_name: "Lost" } }] }));
    for (let page = 0; page < 10; page++) {
      const r = await fetch(`${JN_BASE}/jobs?size=100&from=${page * 100}&filter=${filter}`, { headers: jnH });
      if (!r.ok) break;
      const d = await r.json().catch(() => ({}));
      const list = d.results || d.jobs || d.data || [];
      for (const j of list) { const id = j.jnid || j.id; if (id) lostIds.add(id); }
      if (list.length < 100) break;
    }
    if (!lostIds.size) return json(200, { ok: true, lost_in_jn: 0, cancelled: 0 });

    // 2. Ours that aren't cancelled yet. Chunked — the id list is long.
    const ids = [...lostIds];
    const stale = [];
    for (let i = 0; i < ids.length; i += 60) {
      const inList = ids.slice(i, i + 60).map((x) => `"${x}"`).join(",");
      const rows = await sbGet(
        `inspections?jn_job_id=in.(${encodeURIComponent(inList)})&cancelled_at=is.null` +
        `&select=id,client_name,jn_job_id,result,sales_rep_name,original_sales_rep_name`,
      );
      stale.push(...rows);
    }

    if (dryRun) {
      return json(200, {
        ok: true, dry_run: true, lost_in_jn: lostIds.size, would_cancel: stale.length,
        rows: stale.map((r) => ({ client: r.client_name, result: r.result, rep: r.original_sales_rep_name || r.sales_rep_name })),
      });
    }

    const now = new Date().toISOString();
    let done = 0;
    for (const r of stale) {
      const res = await fetch(`${SB_URL}/rest/v1/inspections?id=eq.${encodeURIComponent(r.id)}`, {
        method: "PATCH", headers: { ...sb, Prefer: "return=minimal" },
        body: JSON.stringify({ cancelled_at: now, cancel_reason: "Marked LOST in JobNimbus" }),
      });
      if (res.ok) done++;
    }
    return json(200, { ok: true, lost_in_jn: lostIds.size, cancelled: done, checked: stale.length });
  } catch (e) {
    return json(500, { ok: false, error: e.message || "error" });
  }
};

async function sbGet(path) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: sb });
  if (!r.ok) return [];
  return r.json().catch(() => []);
}
function json(statusCode, body) {
  return { statusCode, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }, body: JSON.stringify(body) };
}
