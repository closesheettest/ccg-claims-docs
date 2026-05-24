// netlify/functions/find-orphan-signings.js
//
// READ-ONLY diagnostic. Finds inspections signed in a date range that
// have NO matching JN job — i.e. records where the JN sync's first
// step (create the job) silently failed. Different from records that
// have a JN job but a missing jn_job_id back-write — those still
// exist on the JN side; orphans don't.
//
// USAGE:
//   GET /.netlify/functions/find-orphan-signings
//   GET /.netlify/functions/find-orphan-signings?from=2026-05-18&to=2026-05-25
//
// Default window = last 7 days. Dates are signed_at (exclusive `to`).
//
// Required env: JOBNIMBUS_API_KEY, VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY

const JN_BASE = "https://app.jobnimbus.com/api1";

exports.handler = async (event) => {
  const JN_KEY = process.env.JOBNIMBUS_API_KEY;
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
  const missing = [];
  if (!JN_KEY) missing.push("JOBNIMBUS_API_KEY");
  if (!SB_URL) missing.push("VITE_SUPABASE_URL");
  if (!SB_KEY) missing.push("VITE_SUPABASE_ANON_KEY");
  if (missing.length) return json(500, { ok: false, error: `Missing env: ${missing.join(", ")}` });

  const qs = event.queryStringParameters || {};
  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const from = qs.from || sevenDaysAgo.toISOString().slice(0, 10);
  const to = qs.to || new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const sbHeaders = {
    apikey: SB_KEY,
    Authorization: `Bearer ${SB_KEY}`,
  };
  const jnHeaders = {
    Authorization: `bearer ${JN_KEY}`,
    "Content-Type": "application/json",
  };

  // 1. Pull every inspection signed in the window.
  const cols = "id,client_name,city,sales_rep_name,signed_at,result,jn_job_id,address,zip";
  const sbUrl = `${SB_URL}/rest/v1/inspections?signed_at=gte.${from}&signed_at=lt.${to}&select=${cols}&order=signed_at.desc`;
  const sbRes = await fetch(sbUrl, { headers: sbHeaders });
  if (!sbRes.ok) {
    return json(500, { ok: false, error: `Supabase: ${(await sbRes.text()).slice(0, 300)}` });
  }
  const signings = await sbRes.json();

  // 2. For each, search JN by last name. If anything in JN matches the
  //    full name (case-insensitive substring), it's NOT an orphan. If
  //    JN returns zero matches, it IS an orphan.
  const orphans = [];
  const checked = [];
  for (const s of signings) {
    if (s.jn_job_id) {
      checked.push({ ...s, in_jn: true, reason: "has jn_job_id" });
      continue;
    }
    const name = (s.client_name || "").trim();
    if (!name) {
      checked.push({ ...s, in_jn: null, reason: "no client_name" });
      continue;
    }
    const parts = name.split(/\s+/).filter(Boolean);
    const firstName = (parts[0] || "").toLowerCase();
    const lastName = (parts[parts.length - 1] || "").toLowerCase();
    const term = lastName.length >= 3 ? lastName : name;
    try {
      const r = await fetch(`${JN_BASE}/jobs?search=${encodeURIComponent(term)}&size=50`, { headers: jnHeaders });
      const body = r.ok ? await r.json().catch(() => ({})) : {};
      const raw = body.results || body.jobs || body.items || [];
      let jobs = raw.filter((j) => (j.name || "").toLowerCase().includes(lastName));
      if (firstName && firstName !== lastName) {
        const tight = jobs.filter((j) => (j.name || "").toLowerCase().includes(firstName));
        if (tight.length > 0) jobs = tight;
      }
      if (jobs.length === 0) {
        orphans.push({
          client_name: s.client_name,
          city: s.city,
          sales_rep_name: s.sales_rep_name,
          signed_at: s.signed_at,
          result: s.result,
          address: s.address,
          zip: s.zip,
          inspection_id: s.id,
        });
        checked.push({ ...s, in_jn: false, reason: "no JN match" });
      } else {
        checked.push({ ...s, in_jn: true, reason: `JN match (${jobs.length} candidate${jobs.length === 1 ? "" : "s"})` });
      }
    } catch (e) {
      checked.push({ ...s, in_jn: null, reason: `JN error: ${e.message}` });
    }
  }

  return json(200, {
    ok: true,
    window: { from, to },
    summary: {
      total_signings: signings.length,
      already_linked: checked.filter((c) => c.in_jn && c.reason === "has jn_job_id").length,
      found_in_jn_via_search: checked.filter((c) => c.in_jn && c.reason !== "has jn_job_id").length,
      orphans: orphans.length,
      errors: checked.filter((c) => c.in_jn === null).length,
    },
    orphans,
  });
};

function json(status, body) {
  return {
    statusCode: status,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}
