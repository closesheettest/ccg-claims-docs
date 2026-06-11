// netlify/functions/reinspect-job.js
//
// "Re-inspect" — for when an inspector shot the WRONG house. Wipes that
// job's photos + result so it reopens for the inspector to redo; the new
// photos + new cert then fully replace the old ones (delete + retake).
//
// What it does:
//   1. Clears the result fields so the job drops back into the inspector's
//      active pool (result IS NULL): result, result_at, lost_reason,
//      pending_confirmation, jn_cert_uploaded_at.
//   2. Empties inspection_photos (the array the cert generator reads) so the
//      regenerated cert can't reuse the wrong-house pics.
//   3. Best-effort deletes the actual photo files from Supabase Storage.
//   4. Posts a Note on the JobNimbus job for the paper trail.
//
// NOTE on JN: the photos already uploaded to the JN job's Files are NOT
// deleted here — JN's API doesn't give us their file ids to target, and we
// don't store them. The regenerated certificate overrides what matters; any
// loose wrong-house photos on the JN job may need a manual delete in JN.
// The note we post flags this.
//
// POST { inspectionId, inspectorId? }
//   inspectorId (optional) — when present, must match the job's inspector_id
//   (so an inspector can only re-open their OWN job). Omit for manager/admin.
// Response: { ok, photos_cleared, jn_note_added }
//
// Required env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, JOBNIMBUS_API_KEY.

const JN_BASE = "https://app.jobnimbus.com/api1";

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { ok: false, error: "Method not allowed" });
  for (const k of ["VITE_SUPABASE_URL", "VITE_SUPABASE_ANON_KEY", "JOBNIMBUS_API_KEY"]) {
    if (!process.env[k]) return json(500, { ok: false, error: `Missing env: ${k}` });
  }

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { return json(400, { ok: false, error: "Invalid JSON" }); }
  const inspectionId = (body.inspectionId || "").trim();
  const inspectorId = (body.inspectorId || "").trim();
  if (!inspectionId) return json(400, { ok: false, error: "inspectionId required" });

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
  const JN_KEY = process.env.JOBNIMBUS_API_KEY;
  const sb = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" };

  // 1. Load the job.
  const r = await fetch(
    `${SB_URL}/rest/v1/inspections?id=eq.${encodeURIComponent(inspectionId)}&select=id,jn_job_id,client_name,inspection_photos,inspector_id,result&limit=1`,
    { headers: sb },
  );
  if (!r.ok) return json(500, { ok: false, error: `Could not load inspection: ${(await r.text()).slice(0, 200)}` });
  const insp = (await r.json())?.[0];
  if (!insp) return json(404, { ok: false, error: "Inspection not found" });

  // Inspector can only re-open their OWN job. Manager/admin omit inspectorId.
  if (inspectorId && insp.inspector_id && insp.inspector_id !== inspectorId) {
    return json(403, { ok: false, error: "This job is assigned to a different inspector." });
  }

  const photos = Array.isArray(insp.inspection_photos) ? insp.inspection_photos : [];

  // 2. Best-effort: delete the photo files from Supabase Storage, grouped by
  //    bucket. Never fail the re-inspect if storage cleanup fails — the row
  //    cleared below is what actually matters for the redo.
  const byBucket = {};
  for (const p of photos) {
    if (!p || !p.path) continue;
    const b = p.bucket || "signed-documents";
    (byBucket[b] = byBucket[b] || []).push(p.path);
  }
  for (const [bucket, paths] of Object.entries(byBucket)) {
    try {
      await fetch(`${SB_URL}/storage/v1/object/${encodeURIComponent(bucket)}`, {
        method: "DELETE",
        headers: sb,
        body: JSON.stringify({ prefixes: paths }),
      });
    } catch (e) { console.warn("storage delete failed:", e.message || e); }
  }

  // 3. Clear the result + photos so the job reopens for the inspector.
  //    inspector_id is KEPT so it stays claimed by the same person.
  const patch = {
    result: null,
    result_at: null,
    lost_reason: null,
    pending_confirmation: false,
    jn_cert_uploaded_at: null,
    inspection_photos: [],
  };
  const up = await fetch(`${SB_URL}/rest/v1/inspections?id=eq.${encodeURIComponent(inspectionId)}`, {
    method: "PATCH",
    headers: { ...sb, Prefer: "return=minimal" },
    body: JSON.stringify(patch),
  });
  if (!up.ok) return json(500, { ok: false, error: `Could not reset inspection: ${(await up.text()).slice(0, 200)}` });

  // 4. Post a JN note for the paper trail (best-effort).
  let jnNoteAdded = false;
  if (insp.jn_job_id) {
    try {
      const note =
        `♻️ Re-inspect: previous ${photos.length} photo${photos.length === 1 ? "" : "s"} cleared (wrong house). ` +
        `Inspector is retaking — a new certificate will replace the old one. ` +
        `If wrong-house photos remain on this job's Files, delete them manually.`;
      const nr = await fetch(`${JN_BASE}/activities`, {
        method: "POST",
        headers: { Authorization: `bearer ${JN_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ record_type_name: "Note", note, primary: { id: insp.jn_job_id, type: "job" } }),
      });
      jnNoteAdded = nr.ok;
    } catch (e) { console.warn("JN note failed:", e.message || e); }
  }

  return json(200, { ok: true, photos_cleared: photos.length, jn_note_added: jnNoteAdded });
};

function json(statusCode, body) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}
