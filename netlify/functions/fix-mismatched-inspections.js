// netlify/functions/fix-mismatched-inspections.js
//
// ONE-OFF surgical fix for two inspections whose signings were never given
// their own JobNimbus job, so the app auto-linked them to a same-street
// NEIGHBOR's job and uploaded the inspection certificate there:
//
//   • Virginia Barley-Brabham (7442 Canal Dr)  → wrongly on Andre benesz #12178
//   • Teresa Bastos          (4901 NW 1st Way) → wrongly on Gilmar  #12218
//
// Hardcoded to exactly those two inspection IDs (allow-list) so it can't touch
// anything else. Two stages, both POST-only and confirm-gated:
//
//   stage "A" (create + repoint + re-cert):
//     1. create a JN contact + retail inspection job (mirrors the neighbor's
//        own retail job: record_type Lead, status 599 "Sit Sold Insp",
//        location 1 = Retail, source "Inspection", cf_string_34 "Retail")
//     2. repoint inspections.jn_job_id to the new job; clear jn_cert_uploaded_at
//     3. re-run generate-and-upload-insp-report (force) onto the NEW job
//     Additive + safe (worst case: a duplicate cert, easily removed).
//
//   stage "B" (cleanup, dry-run unless apply:true):
//     find the mis-uploaded cert on each NEIGHBOR job by the wrong homeowner's
//     name in the filename and DELETE it. Defaults to a dry run that only
//     lists what it WOULD delete; pass apply:true to actually delete.
//
// Body: { confirm:"FIX-MISMATCH", stage:"A" }            → run stage A
//       { confirm:"FIX-MISMATCH", stage:"B" }            → dry-run cleanup
//       { confirm:"FIX-MISMATCH", stage:"B", apply:true} → delete wrong certs
//
// Env: JOBNIMBUS_API_KEY, VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, URL.

const JN_BASE = "https://app.jobnimbus.com/api1";
const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const JN_KEY = process.env.JOBNIMBUS_API_KEY;

const sb = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" };
const jnHeaders = { Authorization: `bearer ${JN_KEY}`, "Content-Type": "application/json" };

// The two inspections to fix, each with the WRONG neighbor job it's currently
// attached to (used in stage B to find the mis-uploaded cert).
const TARGETS = [
  { inspectionId: "74ecbcc5-2301-43c8-a19b-b86e25e10579", neighborJnid: "mq1dnm965qcv946zfty1zju", neighborLabel: "Andre benesz #12178", wrongNameToken: "Barley" },
  { inspectionId: "6f2463e3-ad77-4ccb-893b-cf5eb0946c7f", neighborJnid: "mq4erp40j9zfhkhxuxgwq4f", neighborLabel: "Gilmar #12218", wrongNameToken: "Bastos" },
];

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { ok: false, error: "POST only" });
  if (!JN_KEY) return json(500, { ok: false, error: "JOBNIMBUS_API_KEY not set" });
  if (!SB_URL || !SB_KEY) return json(500, { ok: false, error: "Supabase env missing" });

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { return json(400, { ok: false, error: "bad JSON" }); }
  if (body.confirm !== "FIX-MISMATCH") return json(403, { ok: false, error: 'pass confirm:"FIX-MISMATCH"' });

  const stage = body.stage === "B" ? "B" : "A";
  try {
    if (stage === "A") return json(200, { ok: true, stage: "A", results: await stageA() });
    return json(200, { ok: true, stage: "B", apply: !!body.apply, results: await stageB(!!body.apply, body.deleteIds) });
  } catch (e) {
    return json(500, { ok: false, error: e.message || "error" });
  }
};

// ── Stage A — create job, repoint, re-cert ──────────────────────────────
async function stageA() {
  const base = process.env.URL || process.env.DEPLOY_URL || process.env.PUBLIC_SITE_URL || "";
  const out = [];
  for (const t of TARGETS) {
    const step = { inspectionId: t.inspectionId };
    try {
      const rows = await sbGet(`inspections?id=eq.${t.inspectionId}&select=id,client_name,address,city,state,zip,email,sales_rep_id,sales_rep_name,signed_at,result,jn_job_id&limit=1`);
      const r = rows[0];
      if (!r) { step.error = "inspection not found"; out.push(step); continue; }
      const name = (r.client_name || "").trim();
      step.client = name;
      const signedUnix = Math.floor(Date.parse(r.signed_at) / 1000) || Math.floor(Date.now() / 1000);

      // 1. contact — reuse one if it already exists by email, else create.
      const contactId = await findOrCreateContact(r, name);
      step.contactId = contactId;

      // 2. job — mirror the neighbor's own RETAIL inspection job.
      const jobPayload = {
        name: `${name} - ${r.address || ""}`.trim(),
        record_type_name: "Lead",
        status: 599,
        status_name: "Sit Sold Insp",
        primary: { id: contactId },
        location: { id: 1 }, // Retail
        source: 38,
        source_name: "Inspection",
        address_line1: r.address || "",
        city: (r.city || "").split(",")[0].trim(),
        state_text: r.state || "",
        zip: r.zip || "",
        sales_rep: r.sales_rep_id || undefined,
        owners: r.sales_rep_id ? [{ id: r.sales_rep_id }] : undefined,
        cf_string_34: "Retail",
        cf_date_5: signedUnix,
        date_start: signedUnix,
      };
      const job = await createJob(jobPayload);
      const newJnid = job.jnid || job.id;
      step.newJnid = newJnid;
      step.oldJnid = r.jn_job_id;

      // 3. repoint the inspection + clear the (wrong) cert stamp.
      await sbPatch(`inspections?id=eq.${t.inspectionId}`, { jn_job_id: newJnid, jn_cert_uploaded_at: null });
      step.repointed = true;

      // 4. re-generate + upload the cert onto the NEW job.
      const gen = await fetch(`${base}/.netlify/functions/generate-and-upload-insp-report`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jnid: newJnid, force: true }),
      });
      const gd = await gen.json().catch(() => ({}));
      step.certGenerated = gen.ok && gd.ok !== false;
      step.certDetail = gd.error || gd.filename || gd.detail || `status ${gen.status}`;
    } catch (e) {
      step.error = e.message;
    }
    out.push(step);
  }
  return out;
}

// ── Stage B — inspect / remove documents on the neighbor jobs ────────────
// Dry-run (apply falsey): lists EVERY document on each neighbor job with its
// filename + created date + id, so we can identify the mis-uploaded cert by
// eye (filenames may carry the neighbor's name, not the homeowner's, because
// the original cert generator picked whichever row shared the job id).
// To delete: pass { stage:"B", apply:true, deleteIds:["<file jnid>", …] } —
// only those exact file ids are removed.
async function stageB(apply, deleteIds) {
  const out = [];
  const wantDelete = new Set((deleteIds || []).map(String));
  for (const t of TARGETS) {
    const step = { neighbor: t.neighborLabel, neighborJnid: t.neighborJnid };
    try {
      const r = await fetch(`${JN_BASE}/files?related=${encodeURIComponent(t.neighborJnid)}&type=1&size=50`, { headers: jnHeaders });
      const d = await r.json().catch(() => ({}));
      const files = d.files || d.results || d.items || [];
      step.documents = files.map((f) => ({
        jnid: f.jnid || f.id,
        filename: f.filename,
        description: f.description,
        date_created: f.date_created,
        created_et: f.date_created ? new Date(f.date_created * 1000).toLocaleString("en-US", { timeZone: "America/New_York" }) : null,
      }));
      if (apply && wantDelete.size) {
        step.deleted = [];
        for (const f of files) {
          const fid = String(f.jnid || f.id);
          if (!wantDelete.has(fid)) continue;
          const del = await fetch(`${JN_BASE}/files/${encodeURIComponent(fid)}`, { method: "DELETE", headers: jnHeaders });
          const body = await del.text().catch(() => "");
          step.deleted.push({ jnid: fid, filename: f.filename, status: del.status, ok: del.ok, body: body.slice(0, 150) });
        }
      } else {
        step.dryRun = true;
      }
    } catch (e) {
      step.error = e.message;
    }
    out.push(step);
  }
  return out;
}

// ── helpers ──────────────────────────────────────────────────────────
async function findOrCreateContact(r, name) {
  const parts = name.split(/\s+/);
  const first = parts[0] || name;
  const last = parts.slice(1).join(" ") || "";
  // Try to reuse an existing contact (search by email, then name).
  for (const q of [r.email, name].filter(Boolean)) {
    try {
      const res = await fetch(`${JN_BASE}/contacts?search=${encodeURIComponent(q)}&size=10`, { headers: jnHeaders });
      const d = await res.json().catch(() => ({}));
      const list = d.results || d.contacts || d.items || [];
      const hit = list.find((c) => (c.email || "").toLowerCase() === (r.email || "").toLowerCase() && r.email) ||
                  list.find((c) => (c.display_name || "").trim().toLowerCase() === name.toLowerCase());
      if (hit) return hit.jnid || hit.id;
    } catch { /* fall through to create */ }
  }
  const payload = {
    first_name: first, last_name: last, display_name: name,
    email: r.email || "", address_line1: r.address || "",
    city: (r.city || "").split(",")[0].trim(), state_text: r.state || "", zip: r.zip || "",
  };
  try { const c = await createContact(payload); return c.jnid || c.id; }
  catch (e) {
    if (String(e.message).toLowerCase().includes("duplicate")) {
      payload.display_name = `${name} [${Date.now()}]`;
      const c = await createContact(payload); return c.jnid || c.id;
    }
    throw e;
  }
}

async function createContact(payload) {
  const res = await fetch(`${JN_BASE}/contacts`, { method: "POST", headers: jnHeaders, body: JSON.stringify(payload) });
  const text = await res.text();
  if (!res.ok) throw new Error(`create contact ${res.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text);
}
async function createJob(payload) {
  const res = await fetch(`${JN_BASE}/jobs`, { method: "POST", headers: jnHeaders, body: JSON.stringify(payload) });
  const text = await res.text();
  if (!res.ok) throw new Error(`create job ${res.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text);
}
async function sbGet(path) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: sb });
  if (!r.ok) return [];
  return r.json().catch(() => []);
}
async function sbPatch(path, patch) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { method: "PATCH", headers: { ...sb, Prefer: "return=minimal" }, body: JSON.stringify(patch) });
  if (!r.ok) throw new Error(`supabase patch ${r.status}`);
}
function json(status, b) { return { statusCode: status, headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) }; }
