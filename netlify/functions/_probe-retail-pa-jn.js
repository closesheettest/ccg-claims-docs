// TEMP probe — for the retail deals that still carry a PA stage, pull the LIVE
// JobNimbus record type + result label + location so we can tell whether the rep
// actually converted them Damage → Retail in JN (record_type "Lead", cf_string_34
// "Retail") or they're still insurance/PA jobs mislabeled as retail on our side.
// DELETE after use.
const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const JN_KEY = process.env.JOBNIMBUS_API_KEY;
const JN_BASE = "https://app.jobnimbus.com/api1";
const sb = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" };

export const handler = async () => {
  const rows = await fetch(`${SB_URL}/rest/v1/inspections?result=eq.retail&cancelled_at=is.null&pa_stage=not.is.null&select=id,client_name,jn_job_id,inspection_result,pa_stage,retail_outcome`, { headers: sb }).then((r) => r.json());
  const out = [];
  for (const r of rows) {
    let jn = null;
    if (r.jn_job_id) {
      try {
        const jr = await fetch(`${JN_BASE}/jobs/${encodeURIComponent(r.jn_job_id)}`, { headers: { Authorization: `bearer ${JN_KEY}`, "Content-Type": "application/json" } });
        if (jr.ok) {
          const j = await jr.json();
          jn = { record_type_name: j.record_type_name, status_name: j.status_name, cf_string_34: j.cf_string_34, location: (j.location && (j.location.id ?? j.location)) ?? null, date_start: j.date_start || null };
        } else jn = { error: `HTTP ${jr.status}` };
      } catch (e) { jn = { error: e.message }; }
    }
    out.push({ name: r.client_name, insp: r.inspection_result, pa_stage: r.pa_stage, our_retail_outcome: r.retail_outcome, jn });
  }
  return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ok: true, count: out.length, deals: out }, null, 2) };
};
