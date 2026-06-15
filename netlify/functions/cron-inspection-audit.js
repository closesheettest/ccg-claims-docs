// netlify/functions/cron-inspection-audit.js
//
// Daily safety audit for inspections. Catches the failure modes behind the
// Bastos/Barley mess EARLY — the morning after — while they're still fixable:
//
//   1. NO PHOTOS    — a damage/no_damage/retail result (recent) with zero
//                     photos in BOTH the DB array AND Storage. Means the
//                     inspector's photos never reached the server at all
//                     (incremental upload should now prevent this; this is the
//                     backstop alarm). Lost results are exempt (no photos ok).
//   2. SHARED JOB   — two DIFFERENT homeowners pointing at the same jn_job_id
//                     (the neighbor mis-link signature). Whole table, cheap.
//   3. ADDR MISMATCH— a recent inspection whose street number doesn't match its
//                     JN job's address (linked to the wrong/neighbor job).
//
// Admin (ADMIN_ALERT_PHONE + extra recipients) is texted a roll-up ONLY when
// something is flagged — no daily noise when clean.
//
// Schedule: daily. Manual GET = dry run (no SMS) unless ?send=1.
// Env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, JOBNIMBUS_API_KEY,
//      ADMIN_ALERT_PHONE, URL.

const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const JN_KEY = process.env.JOBNIMBUS_API_KEY;
const JN_BASE = "https://app.jobnimbus.com/api1";
const BUCKET = "signed-documents";
const sb = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" };
const jnHeaders = { Authorization: `bearer ${JN_KEY}`, "Content-Type": "application/json" };

const RECENT_DAYS = 14; // window for the photo + address checks

export const handler = async (event) => {
  if (!SB_URL || !SB_KEY) return json(500, { ok: false, error: "Supabase env missing" });
  const qp = (event && event.queryStringParameters) || {};
  const isManual = event && event.httpMethod === "GET";
  // Scheduled runs send; manual runs are a dry run unless ?send=1.
  const willSend = isManual ? ["1", "true", "yes"].includes(String(qp.send || "").toLowerCase()) : true;
  const base = process.env.URL || process.env.DEPLOY_URL || process.env.PUBLIC_SITE_URL || "";

  try {
    const cutoff = new Date(Date.now() - RECENT_DAYS * 864e5).toISOString();
    const rows = await sbGet(`inspections?cancelled_at=is.null&select=id,client_name,address,result,jn_job_id,inspection_photos,signed_at,inspector_id&limit=5000`);

    // ── 1. NO PHOTOS (recent, non-lost, empty array AND empty storage) ──
    const noPhotos = [];
    for (const r of rows) {
      if (!isRecent(r.signed_at, cutoff)) continue;
      if (!["damage", "no_damage", "retail"].includes(String(r.result || ""))) continue;
      const arr = Array.isArray(r.inspection_photos) ? r.inspection_photos : [];
      if (arr.length > 0) continue;
      if ((await countStoragePhotos(r.id)) > 0) continue;
      if (JN_KEY && r.jn_job_id && (await jnHasPhotos(r.jn_job_id))) continue; // photos on the JN job — not a no-photo case
      noPhotos.push(r);
    }

    // ── 2. SHARED JOB (whole table — different homeowners on one jn_job_id) ──
    const byJob = {};
    for (const r of rows) { if (r.jn_job_id) (byJob[r.jn_job_id] = byJob[r.jn_job_id] || []).push(r); }
    const sharedJob = [];
    for (const jnid of Object.keys(byJob)) {
      const list = byJob[jnid];
      const names = new Set(list.map((r) => normName(r.client_name)));
      if (names.size > 1) sharedJob.push({ jnid, list });
    }

    // ── 3. ADDRESS MISMATCH (recent linked inspections vs their JN job) ──
    const addrMismatch = [];
    if (JN_KEY) {
      const recentLinked = rows.filter((r) => r.jn_job_id && isRecent(r.signed_at, cutoff));
      const BATCH = 6;
      for (let i = 0; i < recentLinked.length; i += BATCH) {
        const chunk = recentLinked.slice(i, i + BATCH);
        const jobs = await Promise.all(chunk.map((r) => getJobAddr(r.jn_job_id)));
        chunk.forEach((r, k) => {
          const j = jobs[k];
          if (!j) { addrMismatch.push({ ...r, why: "JN job not found", jobAddr: null, jobName: null }); return; }
          const a = numOf(r.address), b = numOf(j.addr);
          if (a && b && a !== b) addrMismatch.push({ ...r, why: "street # mismatch", jobAddr: j.addr, jobName: j.name });
        });
      }
    }

    // resolve inspector names for the no-photo flags (who to chase)
    if (noPhotos.length) {
      const ids = [...new Set(noPhotos.map((r) => r.inspector_id).filter(Boolean))];
      const insp = {};
      for (const id of ids) {
        const got = await sbGet(`inspectors?id=eq.${encodeURIComponent(id)}&select=name,phone&limit=1`);
        if (got[0]) insp[id] = got[0];
      }
      noPhotos.forEach((r) => { const d = insp[r.inspector_id]; r.inspector_name = d?.name || "(unknown inspector)"; r.inspector_phone = d?.phone || null; });
    }

    const total = noPhotos.length + sharedJob.length + addrMismatch.length;
    const notified = [];
    if (willSend && base && total > 0) {
      const recipients = dedupe(String(process.env.ADMIN_ALERT_PHONE || "").split(","));
      for (const to of recipients) {
        const r = await sendSms(base, to, adminMessage(noPhotos, sharedJob, addrMismatch));
        notified.push({ to, ok: r.ok, error: r.error });
      }
    }

    return json(200, {
      ok: true,
      checked: rows.length,
      window_days: RECENT_DAYS,
      sent: willSend && total > 0,
      counts: { no_photos: noPhotos.length, shared_job: sharedJob.length, addr_mismatch: addrMismatch.length },
      no_photos: noPhotos.map((r) => ({ client: (r.client_name || "").trim(), address: r.address, result: r.result, inspector: r.inspector_name, inspector_phone: r.inspector_phone, id: r.id })),
      shared_job: sharedJob.map((s) => ({ jnid: s.jnid, rows: s.list.map((r) => ({ client: (r.client_name || "").trim(), address: r.address, result: r.result, id: r.id })) })),
      addr_mismatch: addrMismatch.map((r) => ({ client: (r.client_name || "").trim(), insp_address: r.address, job_address: r.jobAddr, job_name: r.jobName, why: r.why, id: r.id, jnid: r.jn_job_id })),
      notified,
    });
  } catch (e) {
    return json(500, { ok: false, error: e.message || "error" });
  }
};

function adminMessage(noPhotos, sharedJob, addrMismatch) {
  const lines = ["🔎 Inspection audit found issues:"];
  if (noPhotos.length) {
    lines.push(`\n📷 NO PHOTOS on server (${noPhotos.length}):`);
    noPhotos.slice(0, 5).forEach((r) => lines.push(`• ${(r.client_name || "").trim()} — ${r.address} (${r.result}) — inspector ${r.inspector_name}${r.inspector_phone ? " " + r.inspector_phone : ""}`));
    if (noPhotos.length > 5) lines.push(`…+${noPhotos.length - 5} more`);
  }
  if (sharedJob.length) {
    lines.push(`\n🔗 TWO HOMEOWNERS ON ONE JOB (${sharedJob.length}):`);
    sharedJob.slice(0, 5).forEach((s) => lines.push(`• ${s.list.map((r) => (r.client_name || "").trim()).join(" + ")}`));
    if (sharedJob.length > 5) lines.push(`…+${sharedJob.length - 5} more`);
  }
  if (addrMismatch.length) {
    lines.push(`\n📍 WRONG JOB / ADDRESS (${addrMismatch.length}):`);
    addrMismatch.slice(0, 5).forEach((r) => lines.push(`• ${(r.client_name || "").trim()} ${r.address} → ${r.jobName || r.why}`));
    if (addrMismatch.length > 5) lines.push(`…+${addrMismatch.length - 5} more`);
  }
  return lines.join("\n");
}

// ── helpers ──────────────────────────────────────────────────────────
async function countStoragePhotos(inspectionId) {
  try {
    const res = await fetch(`${SB_URL}/storage/v1/object/list/${BUCKET}`, {
      method: "POST", headers: sb,
      body: JSON.stringify({ prefix: `inspection-photos/${inspectionId}/`, limit: 5 }),
    });
    if (!res.ok) return 0;
    const objs = await res.json().catch(() => []);
    return (Array.isArray(objs) ? objs : []).filter((o) => o && o.name && /\.(jpe?g|png|webp|heic)$/i.test(o.name)).length;
  } catch { return 0; }
}

// Does the JN job have photos (Files type=2)? If so it's not a no-photo case.
// Fail-safe: on error return true so we never falsely flag an unchecked job.
async function jnHasPhotos(jnid) {
  try {
    const r = await fetch(`${JN_BASE}/files?related=${encodeURIComponent(jnid)}&type=2&size=3`, { headers: jnHeaders });
    if (!r.ok) return true;
    const d = await r.json().catch(() => ({}));
    const files = d.files || d.results || d.items || [];
    return Array.isArray(files) && files.length > 0;
  } catch { return true; }
}

async function getJobAddr(jnid) {
  try {
    const r = await fetch(`${JN_BASE}/jobs/${encodeURIComponent(jnid)}`, { headers: jnHeaders });
    if (!r.ok) return null;
    const j = await r.json().catch(() => null);
    if (!j) return null;
    return { addr: j.address_line1 || "", name: j.name || "" };
  } catch { return null; }
}

async function sendSms(base, to, message) {
  try {
    const r = await fetch(`${base}/.netlify/functions/ghl-sms`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ to, name: "Admin", message }),
    });
    return { ok: r.ok };
  } catch (e) { return { ok: false, error: e.message }; }
}

async function sbGet(path) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: sb });
  if (!r.ok) return [];
  return r.json().catch(() => []);
}

function isRecent(iso, cutoff) { return iso && iso >= cutoff; }
function numOf(a) { const m = String(a || "").trim().match(/^(\d+)/); return m ? m[1] : ""; }
function normName(x) { return String(x || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(); }
function dedupe(a) { return [...new Set(a.map((x) => String(x).trim()).filter(Boolean))]; }
function json(status, b) { return { statusCode: status, headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) }; }

export const config = { schedule: "0 17 * * *" };
