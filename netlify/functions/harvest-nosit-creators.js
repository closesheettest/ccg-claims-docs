// netlify/functions/harvest-nosit-creators.js
//
// Report: who CREATED the "No Sit- Need to Reschedule" jobs in JobNimbus. Pulls every
// job in that status, resolves each job's creator (created_by → JN user name), and
// groups by creator with a per-job detail list.
//
//   GET → { ok, status, total, creators:[{ name, count }], jobs:[{ creator, customer,
//            address, sales_rep, created_ms, appt_ms }] }
//
// Env: JOBNIMBUS_API_KEY

const JN_BASE = "https://app.jobnimbus.com/api1";
const JN_KEY = process.env.JOBNIMBUS_API_KEY;
const NOSIT_STATUS = "No Sit- Need to Reschedule";

export const handler = async (event) => {
  if (!JN_KEY) return json(500, { ok: false, error: "JOBNIMBUS_API_KEY not set" });
  const H = { Authorization: `bearer ${JN_KEY}`, "Content-Type": "application/json" };
  const qp = (event && event.queryStringParameters) || {};
  // Optional created-date window (YYYY-MM-DD). Filters by when the no-sit job was created.
  const fromMs = /^\d{4}-\d{2}-\d{2}$/.test(qp.start || "") ? Date.parse(qp.start + "T00:00:00") : null;
  const toMs = /^\d{4}-\d{2}-\d{2}$/.test(qp.end || "") ? Date.parse(qp.end + "T23:59:59") : null;
  try {
    const [allJobs, users] = await Promise.all([fetchJobsByStatus(H, NOSIT_STATUS), fetchUsers(H)]);
    const jobs = allJobs.filter((j) => {
      const cms = j.date_created ? Number(j.date_created) * 1000 : null;
      if (fromMs && (!cms || cms < fromMs)) return false;
      if (toMs && (!cms || cms > toMs)) return false;
      return true;
    });
    const nameById = {};
    for (const u of users) nameById[u.id || u.jnid] = `${u.first_name || ""} ${u.last_name || ""}`.trim();

    const byCreator = {};
    const rows = jobs.map((j) => {
      const creator = (j.created_by_name && String(j.created_by_name).trim()) || nameById[j.created_by] || "(unknown)";
      byCreator[creator] = (byCreator[creator] || 0) + 1;
      return {
        creator,
        customer: (j.primary && j.primary.name) || j.name || "Homeowner",
        address: [j.address_line1, j.city, j.state_text, j.zip].filter(Boolean).join(", "),
        sales_rep: j.sales_rep_name || "",
        created_ms: j.date_created ? Number(j.date_created) * 1000 : null,
        appt_ms: j.date_start ? Number(j.date_start) * 1000 : null,
      };
    }).sort((a, b) => (b.created_ms || 0) - (a.created_ms || 0));

    const creators = Object.entries(byCreator).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
    return json(200, { ok: true, status: NOSIT_STATUS, total: jobs.length, all_total: allJobs.length, range: { start: qp.start || null, end: qp.end || null }, creators, jobs: rows });
  } catch (e) { return json(500, { ok: false, error: String((e && e.message) || e) }); }
};

async function fetchJobsByStatus(H, status) {
  const all = [];
  const filter = encodeURIComponent(JSON.stringify({ must: [{ match_phrase: { status_name: status } }] }));
  for (let page = 0; page < 40; page++) {
    const r = await fetch(`${JN_BASE}/jobs?size=100&from=${page * 100}&filter=${filter}`, { headers: H });
    if (!r.ok) break;
    const d = await r.json().catch(() => ({}));
    const rows = d.results || d.jobs || [];
    all.push(...rows);
    if (rows.length < 100) break;
  }
  return all;
}
async function fetchUsers(H) {
  const r = await fetch(`${JN_BASE}/account/users`, { headers: H });
  if (!r.ok) return [];
  const d = await r.json().catch(() => ({}));
  return d.users || [];
}
function json(status, body) {
  return { statusCode: status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" }, body: typeof body === "string" ? body : JSON.stringify(body) };
}
