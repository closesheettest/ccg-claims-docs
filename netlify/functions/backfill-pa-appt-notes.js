// netlify/functions/backfill-pa-appt-notes.js
//
// One-time backfill: for every PA appointment already booked in the app, post
// the deal's audit-trail timeline as a JobNimbus note — the same note that
// pa-schedule-api.book() now posts going forward. Brings existing appointments
// up to the same standard.
//
// Safeguards:
//   • ONE note per JN job (dedup by jn_job_id — reschedules don't double-post).
//   • Idempotent: skips any job that ALREADY has a "📅 PA appointment scheduled"
//     note (so appointments booked after the feature shipped, and any re-run of
//     this backfill, are never double-noted).
//   • Cancelled appointments excluded.
//
//   GET /.netlify/functions/backfill-pa-appt-notes            → DRY RUN
//   GET /.netlify/functions/backfill-pa-appt-notes?apply=1    → post the notes
//   optional ?limit=60&offset=0 (chunk large runs)
//
// Env: JOBNIMBUS_API_KEY, VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY.

const JN_BASE = "https://app.jobnimbus.com/api1";
const JN_KEY = process.env.JOBNIMBUS_API_KEY;
const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const jnH = { Authorization: `bearer ${JN_KEY}`, "Content-Type": "application/json" };
const sb = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` };
const CONC = 6;
const MARKER = "📅 PA appointment scheduled";

exports.handler = async (event) => {
  if (!JN_KEY || !SB_URL || !SB_KEY) return json(500, { ok: false, error: "Missing env" });
  const qp = (event && event.queryStringParameters) || {};
  const apply = ["1", "true", "yes"].includes(String(qp.apply || "").toLowerCase());
  const limit = Math.min(Math.max(parseInt(qp.limit, 10) || 60, 1), 200);
  const offset = Math.max(parseInt(qp.offset, 10) || 0, 0);

  try {
    // 1. All non-cancelled PA appointments with a linked inspection.
    const appts = await sbGet(
      `pa_appointments?status=neq.cancelled&inspection_id=not.is.null` +
      `&select=inspection_id,pa_id,start_at,end_at&order=start_at.desc&limit=5000`
    );

    // 2. One entry per inspection — keep the LATEST appointment for the header.
    const byInsp = new Map();
    for (const a of appts) if (!byInsp.has(a.inspection_id)) byInsp.set(a.inspection_id, a);
    const inspIds = [...byInsp.keys()];
    const pageIds = inspIds.slice(offset, offset + limit);

    // 3. Bulk-load PA names + the inspections' timeline fields.
    const paIds = [...new Set([...byInsp.values()].map((a) => a.pa_id).filter(Boolean))];
    const paName = {};
    for (let i = 0; i < paIds.length; i += 80) {
      const chunk = paIds.slice(i, i + 80).map((x) => `"${x}"`).join(",");
      for (const p of await sbGet(`pas?id=in.(${encodeURIComponent(chunk)})&select=id,name`)) paName[p.id] = p.name;
    }
    const SEL = "id,jn_job_id,client_name,address,signed_at,result,result_at,jn_cert_uploaded_at,pa_opened_at,pa_signed_at,pa_notes_log,cancelled_at,cancel_reason";
    const inspById = {};
    for (let i = 0; i < pageIds.length; i += 60) {
      const chunk = pageIds.slice(i, i + 60).map((x) => `"${x}"`).join(",");
      for (const r of await sbGet(`inspections?id=in.(${encodeURIComponent(chunk)})&select=${SEL}`)) inspById[r.id] = r;
    }

    const posted = [], skipped = { already_noted: 0, no_jn_job: 0, no_inspection: 0 }, errors = [];
    for (let i = 0; i < pageIds.length; i += CONC) {
      const batch = pageIds.slice(i, i + CONC);
      await Promise.all(batch.map(async (inspId) => {
        const r = inspById[inspId];
        if (!r) { skipped.no_inspection++; return; }
        if (!r.jn_job_id) { skipped.no_jn_job++; return; }
        if (await hasMarkerNote(r.jn_job_id)) { skipped.already_noted++; return; }

        const appt = byInsp.get(inspId);
        const note = buildNote(r, apptWindow(appt), paName[appt.pa_id]);
        if (apply) {
          const ok = await postNote(r.jn_job_id, note);
          if (ok) posted.push({ client: r.client_name, jn_url: `https://app.jobnimbus.com/job/${r.jn_job_id}` });
          else errors.push(r.client_name || r.jn_job_id);
        } else {
          posted.push({ client: r.client_name, jn_url: `https://app.jobnimbus.com/job/${r.jn_job_id}` });
        }
      }));
    }

    return json(200, {
      ok: true,
      mode: apply ? "APPLIED" : "DRY RUN — nothing written",
      total_appointments: appts.length,
      distinct_deals: inspIds.length,
      processed: pageIds.length,
      offset, limit,
      more: offset + limit < inspIds.length ? `re-run with ?offset=${offset + limit}${apply ? "&apply=1" : ""}` : null,
      would_post: posted.length,
      skipped,
      errors,
      sample_note: !apply && pageIds.length ? sampleNote(inspById, byInsp, paName, pageIds) : undefined,
      posted: posted.slice(0, 50),
    });
  } catch (e) {
    return json(500, { ok: false, error: e.message || "error" });
  }
};

function buildNote(r, when, paName) {
  const ev = [];
  if (r.signed_at) ev.push({ at: r.signed_at, label: "Inspection agreement signed" });
  if (r.result) ev.push({ at: r.result_at || null, label: `Inspected → ${resultLabel(r.result)}` });
  if (r.jn_cert_uploaded_at) ev.push({ at: r.jn_cert_uploaded_at, label: "Certificate uploaded to JobNimbus" });
  if (r.pa_opened_at) ev.push({ at: r.pa_opened_at, label: "Public adjuster opened the deal" });
  if (r.pa_signed_at) ev.push({ at: r.pa_signed_at, label: "PA signed the homeowner" });
  for (const n of Array.isArray(r.pa_notes_log) ? r.pa_notes_log : []) ev.push({ at: n.at || null, label: n.text || "(note)" });
  if (r.cancelled_at) ev.push({ at: r.cancelled_at, label: `Cancelled${r.cancel_reason ? ` — ${r.cancel_reason}` : ""}` });
  ev.sort((a, b) => new Date(a.at || 0) - new Date(b.at || 0));
  const lines = ev.map((e) => `• ${e.at ? fmtWhen(e.at) : "—"} · ${e.label}`);
  return [`${MARKER} — ${when}${paName ? ` with ${paName}` : ""}`, "", "Deal history:", ...(lines.length ? lines : ["• (no prior activity recorded)"])].join("\n");
}
function sampleNote(inspById, byInsp, paName, pageIds) {
  const r = inspById[pageIds[0]];
  if (!r) return undefined;
  const a = byInsp.get(pageIds[0]);
  return buildNote(r, apptWindow(a), paName[a.pa_id]);
}
function apptWindow(a) {
  if (!a || !a.start_at) return "an appointment";
  const s = new Date(a.start_at), e = a.end_at ? new Date(a.end_at) : null;
  const day = s.toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric" });
  const t = (d) => d.toLocaleString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" });
  return e ? `${day}, ${t(s)}–${t(e)}` : `${day}, ${t(s)}`;
}
async function hasMarkerNote(jnid) {
  try {
    const r = await fetch(`${JN_BASE}/activities?filter=${encodeURIComponent(JSON.stringify({ must: [{ term: { "related.id": jnid } }] }))}&size=100&sort=-date_created`, { headers: jnH });
    if (!r.ok) return false; // can't confirm → treat as not-noted (better a rare dup than skip everything on a JN blip)
    const d = await r.json().catch(() => ({}));
    const acts = d.activity || d.activities || d.results || [];
    return acts.some((a) => String(a.note || a.message || "").includes(MARKER));
  } catch { return false; }
}
async function postNote(jnid, note) {
  try {
    const r = await fetch(`${JN_BASE}/activities`, {
      method: "POST", headers: jnH,
      body: JSON.stringify({ record_type_name: "Note", note, primary: { id: jnid, type: "job" }, related: [{ id: jnid, type: "job" }], is_status_change: false }),
    });
    return r.ok;
  } catch { return false; }
}
function resultLabel(v) {
  return { damage: "Damage found", no_damage: "No damage", retail: "Retail", lost: "Lost" }[String(v || "").toLowerCase()] || String(v || "");
}
function fmtWhen(at) {
  const d = new Date(at);
  if (isNaN(d)) return "—";
  return d.toLocaleString("en-US", { timeZone: "America/New_York", month: "numeric", day: "numeric", year: "2-digit", hour: "numeric", minute: "2-digit" });
}
async function sbGet(path) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: sb });
  if (!r.ok) return [];
  return r.json().catch(() => []);
}
function json(status, body) {
  return { statusCode: status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" }, body: JSON.stringify(body) };
}
