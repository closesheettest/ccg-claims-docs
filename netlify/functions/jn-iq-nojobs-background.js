// netlify/functions/jn-iq-nojobs-background.js
//
// One-off audit (background — up to 15 min): how many JobNimbus CONTACTS whose
// lead source is "Instant Quote" have NO job attached. Writes the result to
// app_settings key "jn_iq_nojobs" so it can be polled (JN has too much data to
// return synchronously).
//
// Trigger: GET/POST /.netlify/functions/jn-iq-nojobs-background  → 202
// Read:    supabase app_settings?key=eq.jn_iq_nojobs
//
// Env: JOBNIMBUS_API_KEY, VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY

const JN_BASE = "https://app.jobnimbus.com/api1";
const JN_KEY = process.env.JOBNIMBUS_API_KEY;
const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const RESULT_KEY = "jn_iq_nojobs";
const SOURCE = "Instant Quote";

exports.handler = async () => {
  const started = new Date().toISOString();
  try {
    const jnH = { Authorization: `bearer ${JN_KEY}`, "Content-Type": "application/json" };

    // 1) Every contact whose lead source is "Instant Quote".
    const iqContacts = await fetchAll(`${JN_BASE}/contacts`, jnH, { filter: { must: [{ match_phrase: { source_name: SOURCE } }] } });

    // 2) Every job's contact link(s), so we know which contacts HAVE a job.
    //    A job's `primary` is the main contact; `related` can hold co-contacts.
    const withJob = new Set();
    await fetchAll(`${JN_BASE}/jobs`, jnH, {}, (job) => {
      if (job.primary && job.primary.id) withJob.add(job.primary.id);
      for (const r of job.related || []) if (r && r.id && (r.type === "contact" || !r.type)) withJob.add(r.id);
    });

    // 3) IQ contacts with NO job.
    const noJob = iqContacts.filter((c) => !withJob.has(c.jnid || c.id));
    const sample = noJob.slice(0, 15).map((c) => ({
      name: c.display_name || `${c.first_name || ""} ${c.last_name || ""}`.trim(),
      address: [c.address_line1, c.city, c.state_text, c.zip].filter(Boolean).join(", "),
      created: c.date_created ? new Date(Number(c.date_created) * 1000).toISOString().slice(0, 10) : null,
    }));

    await writeSetting(RESULT_KEY, {
      ok: true, source: SOURCE,
      iq_contacts_total: iqContacts.length,
      iq_contacts_with_job: iqContacts.length - noJob.length,
      iq_contacts_no_job: noJob.length,
      jobs_scanned_contacts: withJob.size,
      sample,
      started, finished: new Date().toISOString(),
    });
  } catch (e) {
    await writeSetting(RESULT_KEY, { ok: false, error: String(e && e.message || e), started, finished: new Date().toISOString() });
  }
  return { statusCode: 202, body: "" };
};

// Page through a JN list endpoint. Passes each row to onRow (if given) to avoid
// holding everything; otherwise collects + returns them.
async function fetchAll(url, headers, { filter } = {}, onRow) {
  const out = onRow ? null : [];
  const qs = filter ? `&filter=${encodeURIComponent(JSON.stringify(filter))}` : "";
  for (let page = 0; page < 1000; page++) {
    let r;
    try { r = await fetch(`${url}?size=100&from=${page * 100}${qs}`, { headers }); } catch { break; }
    if (!r.ok) break;
    const d = await r.json().catch(() => ({}));
    const rows = d.results || d.contacts || d.jobs || d.data || [];
    if (!rows.length) break;
    if (onRow) rows.forEach(onRow); else out.push(...rows);
    if (rows.length < 100) break;
  }
  return out;
}

async function writeSetting(key, obj) {
  const H = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" };
  try {
    await fetch(`${SB_URL}/rest/v1/app_settings?on_conflict=key`, {
      method: "POST", headers: H, body: JSON.stringify({ key, value: JSON.stringify(obj), updated_at: new Date().toISOString() }),
    });
  } catch { /* ignore */ }
}
