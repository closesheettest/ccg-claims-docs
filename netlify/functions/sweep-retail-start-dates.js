// netlify/functions/sweep-retail-start-dates.js
//
// One-off cleanup for the 7/2 Start-Date backfill bug.
//
// That backfill filled missing Start Dates by setting date_start = Sold Date
// for any deal that had a Sold Date but a blank Start Date. It did NOT exclude
// RETAIL (Lead) deals — but retail deals are supposed to have a blank Start
// Date until the RETAIL VISIT books an appointment (retail-task-create sets it
// to the appt time). So dead retail no-sales (e.g. Kieth Lopez) got their Start
// Date set back to the old insurance Sold Date and wrongly reappear on the
// weekly "sold this week" report.
//
// This finds retail deals whose JN date_start EXACTLY equals cf_date_5 (the
// backfill's fingerprint) and nulls date_start. A genuine retail-visit Start
// Date differs from the Sold Date, so it is left untouched. Insurance/PA deals
// are never touched (we only null jobs whose JN record_type is "Lead").
//
//   GET  /.netlify/functions/sweep-retail-start-dates             → DRY RUN (no writes)
//   GET  /.netlify/functions/sweep-retail-start-dates?apply=1     → null date_start in JN
//   optional ?limit=250 (JN-call cap per run) &offset=0 (paging)
//
// Env: JOBNIMBUS_API_KEY, VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY.

const JN_BASE = "https://app.jobnimbus.com/api1";
const JN_KEY = process.env.JOBNIMBUS_API_KEY;
const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const sb = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` };
const jnH = { Authorization: `bearer ${JN_KEY}`, "Content-Type": "application/json" };
const CONCURRENCY = 10;

exports.handler = async (event) => {
  if (!JN_KEY || !SB_URL || !SB_KEY) return json(500, { ok: false, error: "Missing env" });
  const qp = (event && event.queryStringParameters) || {};
  const apply = ["1", "true", "yes"].includes(String(qp.apply || "").toLowerCase());
  const limit = Math.min(Math.max(parseInt(qp.limit, 10) || 250, 1), 400);
  const offset = Math.max(parseInt(qp.offset, 10) || 0, 0);

  try {
    // Retail inspections that have a JN job — the only deals this can touch.
    const rows = await sbGet(
      `inspections?result=eq.retail&cancelled_at=is.null&jn_job_id=not.is.null` +
      `&select=id,client_name,address,city,sales_rep_name,jn_job_id&order=result_at.desc.nullslast` +
      `&limit=${limit}&offset=${offset}`
    );

    const flagged = [];
    const skipped = { no_start: 0, start_ne_sold: 0, not_lead: 0, jn_error: 0 };

    for (let i = 0; i < rows.length; i += CONCURRENCY) {
      const batch = rows.slice(i, i + CONCURRENCY);
      await Promise.all(batch.map(async (r) => {
        const jn = await jnGet(`jobs/${r.jn_job_id}`);
        if (!jn) { skipped.jn_error++; return; }
        const start = Number(jn.date_start) || 0;
        const sold = Number(jn.cf_date_5) || Number(jn["Sold Date"]) || 0;
        const isLead = String(jn.record_type_name || "").toLowerCase() === "lead";
        if (!start) { skipped.no_start++; return; }        // nothing to clear
        if (!isLead) { skipped.not_lead++; return; }        // safety: never touch PA/insurance
        if (!sold || start !== sold) { skipped.start_ne_sold++; return; } // real retail-visit date — leave it
        flagged.push({
          jnid: r.jn_job_id,
          name: r.client_name || jn.name || "—",
          address: [r.address, r.city].filter(Boolean).join(", "),
          rep: r.sales_rep_name || null,
          status: jn.status_name || null,
          start_date: ymd(start),
          sold_date: ymd(sold),
          jn_url: `https://app.jobnimbus.com/job/${r.jn_job_id}`,
        });
      }));
    }

    let applied = 0, applyErrors = [];
    if (apply) {
      for (const f of flagged) {
        const ok = await jnPutClearStart(f.jnid);
        if (ok) applied++;
        else applyErrors.push(f.name);
      }
    }

    return json(200, {
      ok: true,
      mode: apply ? "APPLIED" : "DRY RUN — nothing written",
      scanned: rows.length,
      offset, limit,
      more: rows.length === limit ? `re-run with ?offset=${offset + limit}${apply ? "&apply=1" : ""}` : null,
      flagged_count: flagged.length,
      applied,
      apply_errors: applyErrors,
      skipped,
      flagged,
    });
  } catch (e) {
    return json(500, { ok: false, error: e.message || "error" });
  }
};

async function jnGet(path) {
  for (let a = 0; a < 3; a++) {
    try {
      const r = await fetch(`${JN_BASE}/${path}`, { headers: jnH });
      if (r.ok) return await r.json().catch(() => null);
      if (r.status < 500) return null;           // 4xx — don't retry
    } catch { /* transient — retry */ }
    await sleep(300 * (a + 1));
  }
  return null;
}

// Nulling date_start is idempotent, so a transient retry is safe.
async function jnPutClearStart(jnid) {
  for (let a = 0; a < 3; a++) {
    try {
      const r = await fetch(`${JN_BASE}/jobs/${encodeURIComponent(jnid)}`, {
        method: "PUT", headers: jnH, body: JSON.stringify({ jnid, date_start: null }),
      });
      if (r.ok) return true;
      if (r.status < 500) return false;
    } catch { /* retry */ }
    await sleep(400 * (a + 1));
  }
  return false;
}

async function sbGet(path) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: sb });
  if (!r.ok) return [];
  return r.json().catch(() => []);
}
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
function ymd(sec) {
  return new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" })
    .format(new Date(sec * 1000));
}
function json(status, obj) {
  return {
    statusCode: status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" },
    body: JSON.stringify(obj),
  };
}
