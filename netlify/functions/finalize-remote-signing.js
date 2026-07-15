// netlify/functions/finalize-remote-signing.js
//
// Called by the homeowner's /?sign_insp=<token> page once they've passed the
// phone one-time code, agreed to sign electronically, drawn their signature,
// and their browser has generated the signed PDF (with the audit trail baked
// in). THIS is the moment the deal becomes real — everything below runs
// server-side so a closed tab can't strand it:
//   1. INSERT the inspections row (signed_at set) — mirrors submitInspection.
//   2. archive-signed-docs (durable copy in Supabase Storage).
//   3. jobnimbus-sync (create JN contact/job "Sit Sold Insp", upload the PDF).
//   4. obvious-damage classification fan-out, if the rep flagged it.
//   5. flip the pending_signings row to 'signed' + record consent.
//   6. notify the rep (SMS) + ops (activity email).
//
// POST { token, pdfBase64, audit:{ signedAt, signedIp, signedUserAgent,
//        consentText, consentAt } }
// → { ok, inspection_id, jn_job_id? }
//
// Env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY (+ archive/jobnimbus/email/sms funcs)

import { SB_URL, sb, siteBase, loadByToken, patchByToken, json, sendSms, sendEmail } from "./_pending.js";

export const handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { ok: false, error: "Method not allowed" });
  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch { return json(400, { ok: false, error: "Invalid JSON body" }); }

  const token = (body.token || "").trim();
  const pdfBase64 = body.pdfBase64 || "";
  const audit = body.audit || {};
  if (!token) return json(400, { ok: false, error: "token required" });
  if (!pdfBase64 || pdfBase64.length < 5000) return json(400, { ok: false, error: "signed document missing or too small" });

  const p = await loadByToken(token);
  if (!p) return json(404, { ok: false, error: "invalid link" });
  if (p.status === "signed" && p.inspection_id) {
    // Idempotent: already finalized (double-submit / retry).
    return json(200, { ok: true, inspection_id: p.inspection_id, already: true });
  }
  if (new Date(p.expires_at).getTime() < Date.now()) return json(410, { ok: false, error: "link expired" });
  // Phone gate: require verification unless there was no phone to verify.
  const hadPhone = String(p.mobile || "").replace(/\D/g, "").length >= 10;
  if (hadPhone && !p.phone_verified_at) return json(403, { ok: false, error: "phone not verified" });

  const signedAt = audit.signedAt || new Date().toISOString();

  // SANDBOX (training/practice) and TEST signings never touch the real system:
  // a practice run (sandbox=true) OR a homeowner name containing "Test" /
  // "Testing" / "Tester" creates NO inspection row and NO JobNimbus deal (and so
  // no orphan alerts). We just flip the pending row to signed so the rep still
  // sees the success screen and experiences the full flow.
  if (p.sandbox || /\btest(ing|er)?\b/i.test(p.client_name || "")) {
    const tag = p.sandbox ? "[TRAINING — not saved]" : "[TEST — not pushed to JobNimbus]";
    await patchByToken(token, {
      status: "signed", signed_at: signedAt, inspection_id: null,
      consent_text: (audit.consentText || "I agree to use electronic records and signatures.") + " " + tag,
      consent_at: audit.consentAt || signedAt,
    });
    return json(200, { ok: true, test: !p.sandbox, sandbox: !!p.sandbox, inspection_id: null });
  }

  const classifyResult = p.obvious_damage ? (p.has_insurance === "yes" ? "damage" : "retail") : null;

  // 1. INSERT inspections (mirrors submitInspection's insert).
  const row = {
    client_name: p.client_name, mobile: p.mobile, email: p.email || null,
    address: p.address, city: p.city, state: p.state, zip: p.zip, date: p.date,
    sales_rep_name: p.sales_rep_name || "", sales_rep_id: p.sales_rep_id || "", sales_rep_email: p.sales_rep_email || "",
    original_sales_rep_id: p.sales_rep_id || "", original_sales_rep_name: p.sales_rep_name || "",
    roof_type: p.roof_type || "Shingle", lead_source: p.lead_source || "Inspection", spanish_only: !!p.spanish_only,
    signed_at: signedAt,
    ...(p.review_availability ? { review_availability: p.review_availability } : {}),
    ...(classifyResult ? { result: classifyResult, result_at: signedAt } : {}),
  };
  const insRes = await fetch(`${SB_URL}/rest/v1/inspections`, {
    method: "POST", headers: { ...sb, Prefer: "return=representation" }, body: JSON.stringify(row),
  });
  if (!insRes.ok) {
    const t = await insRes.text();
    // Tolerate the review_availability column not existing — retry without it.
    if (/review_availability/.test(t)) {
      delete row.review_availability;
      const retry = await fetch(`${SB_URL}/rest/v1/inspections`, { method: "POST", headers: { ...sb, Prefer: "return=representation" }, body: JSON.stringify(row) });
      if (!retry.ok) return json(500, { ok: false, error: `insert failed: ${(await retry.text()).slice(0, 200)}` });
      var inserted = (await retry.json().catch(() => []))[0];
    } else {
      return json(500, { ok: false, error: `insert failed: ${t.slice(0, 200)}` });
    }
  } else {
    var inserted = (await insRes.json().catch(() => []))[0];
  }
  const inspectionId = inserted?.id || null;
  if (!inspectionId) return json(500, { ok: false, error: "insert returned no id" });

  const base = siteBase();

  // 2. Archive the signed PDF (awaited + retried — this is the durable copy).
  let archived = false;
  for (let i = 1; i <= 2 && !archived; i++) {
    try {
      const ar = await fetch(`${base}/.netlify/functions/archive-signed-docs`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ inspectionId, pdfs: { insp: { filename: "Free-Roof-Inspection-Agreement.pdf", base64: pdfBase64 } } }),
      });
      const ab = await ar.json().catch(() => ({}));
      archived = ar.ok && (ab.ok === true || (ab.uploaded || 0) > 0);
    } catch { /* retry */ }
    if (!archived && i < 2) await new Promise((r) => setTimeout(r, 1200));
  }

  // 3. JobNimbus sync (creates contact/job, uploads PDF, writes jn_job_id back).
  let jnJobId = null;
  try {
    const jr = await fetch(`${base}/.netlify/functions/jobnimbus-sync`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        leadSource: p.lead_source || "Inspection", docsSignedList: ["insp"],
        homeowner1: p.client_name || "", homeowner2: "",
        phone: p.mobile || "", email: p.email || "",
        address: p.address || "", city: p.city || "", state: p.state || "", zip: p.zip || "",
        salesRepName: p.sales_rep_name || "", salesRepId: p.sales_rep_id || "",
        pdfBase64, pdfFilename: "Free-Roof-Inspection-Agreement.pdf",
        inspectionId,
      }),
    });
    const jd = await jr.json().catch(() => ({}));
    jnJobId = jd.jobId || null;
    // Redundant client-style write-back in case the sync's server-side one missed.
    if (jnJobId) {
      await fetch(`${SB_URL}/rest/v1/inspections?id=eq.${encodeURIComponent(inspectionId)}&jn_job_id=is.null`, {
        method: "PATCH", headers: { ...sb, Prefer: "return=minimal" }, body: JSON.stringify({ jn_job_id: jnJobId, docs_signed: "insp" }),
      }).catch(() => {});
    }
    // 4. Obvious-damage fan-out, once the JN job exists.
    if (classifyResult && jnJobId) {
      const tokRows = await (await fetch(`${SB_URL}/rest/v1/app_settings?key=eq.visit_token&select=value&limit=1`, { headers: sb })).json().catch(() => []);
      const visitTok = tokRows?.[0]?.value;
      fetch(`${base}/.netlify/functions/rep-classify-result`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: visitTok, inspectionId, result: classifyResult, inspectorName: p.sales_rep_name || "" }),
      }).catch(() => {});
    }
  } catch (e) { /* orphan-check cron backstops a failed sync */ }

  // 5. Flip the pending row → signed + record consent.
  await patchByToken(token, {
    status: "signed", signed_at: signedAt, inspection_id: inspectionId,
    consent_text: audit.consentText || "I agree to use electronic records and signatures.",
    consent_at: audit.consentAt || signedAt,
  });

  // 6. Notify the rep (SMS) + ops (activity email).
  const addr = [p.address, p.city, p.state, p.zip].filter(Boolean).join(", ");
  if (p.sales_rep_id) {
    try {
      const repRows = await (await fetch(`${SB_URL}/rest/v1/sales_reps?jobnimbus_id=eq.${encodeURIComponent(p.sales_rep_id)}&select=name,phone&limit=1`, { headers: sb })).json().catch(() => []);
      const repPhone = repRows?.[0]?.phone;
      if (repPhone) await sendSms(repPhone, p.sales_rep_name || "Rep", `✅ ${p.client_name} signed the Free Roof Inspection agreement (${addr}). It's in JobNimbus.`);
    } catch { /* non-fatal */ }
  }
  try {
    const setRows = await (await fetch(`${SB_URL}/rest/v1/app_settings?key=eq.activity_email&select=value&limit=1`, { headers: sb })).json().catch(() => []);
    const activityEmail = setRows?.[0]?.value;
    if (activityEmail) {
      await sendEmail({
        to: [activityEmail],
        subject: `🏠 Inspection Signed (remote) — ${p.client_name} (${p.sales_rep_name || "—"})`,
        html: `<div style="font-family:Arial,sans-serif"><h2 style="margin:0 0 8px">🏠 Free Roof Inspection signed remotely</h2>
          <table style="font-size:14px;color:#374151"><tr><td style="font-weight:700;padding:3px 10px 3px 0">Client:</td><td>${p.client_name}</td></tr>
          <tr><td style="font-weight:700;padding:3px 10px 3px 0">Address:</td><td>${addr}</td></tr>
          <tr><td style="font-weight:700;padding:3px 10px 3px 0">Rep:</td><td>${p.sales_rep_name || "—"}</td></tr>
          <tr><td style="font-weight:700;padding:3px 10px 3px 0">Phone verified:</td><td>${p.phone_verified_number || "(email only)"}</td></tr>
          <tr><td style="font-weight:700;padding:3px 10px 3px 0">Signed at:</td><td>${signedAt}</td></tr>
          <tr><td style="font-weight:700;padding:3px 10px 3px 0">Signer IP:</td><td>${audit.signedIp || "—"}</td></tr></table></div>`,
      });
    }
  } catch { /* non-fatal */ }

  return json(200, { ok: true, inspection_id: inspectionId, jn_job_id: jnJobId, archived });
};
