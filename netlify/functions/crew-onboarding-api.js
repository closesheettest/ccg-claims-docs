// netlify/functions/crew-onboarding-api.js
//
// Crew (subcontractor) side of onboarding — the /?crew=<token> portal. The
// crew owner: fills contacts + work details + banking + W-9, uploads their
// insurance/license docs, and e-signs the Subcontractor Agreement + W-9. On
// submit we render the signed Agreement PDF + a W-9 PDF into the private
// crew-docs bucket, flip the crew to "submitted", and text/email the office.
//
// Auth = the crew's OWN token (the link we sent). It only ever exposes/edits
// that one crew's row. Sensitive tables are RLS-locked, so this uses the
// SERVICE-ROLE key (same as crew-admin-api).
//
//   POST { token, action, ... }
//     "load"                                   → { crew:safe, documents:[types] }
//     "save"       { patch }                   → save progress (in_progress)
//     "upload_doc" { doc_type, file_name, content_type, data_base64 }
//     "submit"     { sign_name, sign_title?, agreed:true }
//
// Env: VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, PDFSHIFT_API_KEY, URL,
//      ADMIN_ALERT_PHONE, CREW_ONBOARDING_EMAIL (optional).

import { PDFDocument, StandardFonts } from "pdf-lib";
import W9_B64 from "./assets/w9-template-b64.js";

const SB_URL = process.env.VITE_SUPABASE_URL;
const SVC_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const PDFSHIFT_KEY = process.env.PDFSHIFT_API_KEY;
const sb = { apikey: SVC_KEY, Authorization: `Bearer ${SVC_KEY}`, "Content-Type": "application/json" };
const BUCKET = "crew-docs";
const REQUIRED_DOCS = ["general_liability", "workers_comp", "roofing_license"];

// Crew-editable columns only (never rates/owner/status/token/signing).
const SAVE_FIELDS = [
  "install_contact_name", "install_contact_email", "install_contact_phone",
  "crew_lead_name", "crew_lead_email", "crew_lead_phone",
  "preferred_area", "crew_size", "dump_trailers", "roofing_types",
  "bank_name", "bank_routing", "bank_account", "account_name", "company_ein",
  "account_address", "additional_info", "license_number",
  "w9_name", "w9_business_name", "w9_tax_classification", "w9_llc_class",
  "w9_exempt_payee_code", "w9_fatca_code", "w9_address", "w9_city_state_zip",
  "w9_tin_type", "w9_tin",
];

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return cors(200, "");
  if (event.httpMethod !== "POST") return cors(405, JSON.stringify({ ok: false, error: "POST only" }));
  if (!SB_URL) return cors(500, JSON.stringify({ ok: false, error: "Supabase URL missing" }));
  if (!SVC_KEY) return cors(500, JSON.stringify({ ok: false, error: "Add SUPABASE_SERVICE_ROLE_KEY to Netlify env (Supabase → Project Settings → API → service_role)." }));

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { return cors(400, JSON.stringify({ ok: false, error: "bad JSON" })); }
  const token = String(body.token || "").trim();
  if (!token) return cors(400, JSON.stringify({ ok: false, error: "token required" }));
  const action = String(body.action || "").trim();

  // Office-side countersign uses the GLOBAL office token + crew_id (not the
  // crew's private link token) — handled before the crew-token lookup.
  if (action === "office_countersign") {
    try { return await officeCountersign(token, body); }
    catch (e) { return cors(500, JSON.stringify({ ok: false, error: e.message || "error" })); }
  }

  const crew = (await sbGet(`crews?token=eq.${encodeURIComponent(token)}&select=*&limit=1`))[0];
  if (!crew) return cors(404, JSON.stringify({ ok: false, error: "This onboarding link isn't valid. Ask US Shingle to resend it." }));
  try {
    if (action === "load") {
      const docs = await sbGet(`crew_documents?crew_id=eq.${encodeURIComponent(crew.id)}&select=doc_type,file_name,uploaded_at&order=uploaded_at`);
      return cors(200, JSON.stringify({ ok: true, crew: crewForCrew(crew), documents: docs }));
    }

    if (action === "save") {
      if (crew.status === "submitted" || crew.status === "approved") return cors(409, JSON.stringify({ ok: false, error: "Already submitted." }));
      const patch = {};
      for (const k of SAVE_FIELDS) if (k in (body.patch || {})) patch[k] = clean(body.patch[k], k);
      if (crew.status === "invited") { patch.status = "in_progress"; }
      if (!Object.keys(patch).length) return cors(200, JSON.stringify({ ok: true, saved: 0 }));
      const r = await fetch(`${SB_URL}/rest/v1/crews?id=eq.${encodeURIComponent(crew.id)}`, { method: "PATCH", headers: { ...sb, Prefer: "return=minimal" }, body: JSON.stringify(patch) });
      return cors(r.ok ? 200 : 500, JSON.stringify({ ok: r.ok, saved: Object.keys(patch).length }));
    }

    if (action === "upload_doc") {
      if (crew.status === "submitted" || crew.status === "approved") return cors(409, JSON.stringify({ ok: false, error: "Already submitted." }));
      const docType = String(body.doc_type || "").trim();
      if (!["general_liability", "workers_comp", "roofing_license", "exemption_cert", "other"].includes(docType)) return cors(400, JSON.stringify({ ok: false, error: "bad doc_type" }));
      const b64 = String(body.data_base64 || "").replace(/^data:[^,]*,/, "");
      if (!b64) return cors(400, JSON.stringify({ ok: false, error: "no file data" }));
      const buffer = Buffer.from(b64, "base64");
      if (!buffer.length) return cors(400, JSON.stringify({ ok: false, error: "empty file" }));
      if (buffer.length > 15 * 1024 * 1024) return cors(413, JSON.stringify({ ok: false, error: "File too large (15MB max)." }));
      const safeName = (String(body.file_name || `${docType}.pdf`)).replace(/[^a-zA-Z0-9._-]/g, "_").slice(-80);
      const path = `${crew.id}/${docType}_${Date.now()}_${safeName}`;
      const ct = String(body.content_type || "application/octet-stream");
      const up = await fetch(`${SB_URL}/storage/v1/object/${BUCKET}/${path}`, {
        method: "POST", headers: { apikey: SVC_KEY, Authorization: `Bearer ${SVC_KEY}`, "Content-Type": ct, "x-upsert": "true" }, body: buffer,
      });
      if (!up.ok) return cors(502, JSON.stringify({ ok: false, error: `upload ${up.status}: ${(await up.text()).slice(0, 160)}` }));
      // One current file per type: drop older rows of the same type, then insert.
      await fetch(`${SB_URL}/rest/v1/crew_documents?crew_id=eq.${encodeURIComponent(crew.id)}&doc_type=eq.${encodeURIComponent(docType)}`, { method: "DELETE", headers: { ...sb, Prefer: "return=minimal" } }).catch(() => {});
      await fetch(`${SB_URL}/rest/v1/crew_documents`, { method: "POST", headers: { ...sb, Prefer: "return=minimal" }, body: JSON.stringify({ crew_id: crew.id, doc_type: docType, file_path: path, file_name: safeName, content_type: ct }) });
      return cors(200, JSON.stringify({ ok: true, doc_type: docType, file_name: safeName }));
    }

    if (action === "submit") {
      if (crew.status === "submitted" || crew.status === "approved") return cors(409, JSON.stringify({ ok: false, error: "Already submitted." }));
      const signName = String(body.sign_name || "").trim();
      const signatureData = String(body.signature_data || "");
      if (!body.agreed) return cors(400, JSON.stringify({ ok: false, error: "You must check the box agreeing to the terms." }));
      if (!signName) return cors(400, JSON.stringify({ ok: false, error: "Type your printed name." }));
      if (!signatureData.startsWith("data:image")) return cors(400, JSON.stringify({ ok: false, error: "Draw your signature before submitting." }));
      if (!crew.w9_name || !crew.w9_tin) return cors(400, JSON.stringify({ ok: false, error: "Complete the W-9 (name + SSN/EIN) before submitting." }));
      const docs = await sbGet(`crew_documents?crew_id=eq.${encodeURIComponent(crew.id)}&select=doc_type`);
      const have = new Set(docs.map((d) => d.doc_type));
      const missing = REQUIRED_DOCS.filter((d) => !have.has(d));
      if (missing.length) return cors(400, JSON.stringify({ ok: false, error: `Upload required documents first: ${missing.map(labelDoc).join(", ")}.` }));

      const nowIso = new Date().toISOString();
      const ip = (event.headers["x-nf-client-connection-ip"] || event.headers["x-forwarded-for"] || "").split(",")[0].trim() || null;
      const signTitle = String(body.sign_title || "").trim() || "Owner";
      const signed = { ...crew, subcontractor_sign_name: signName, subcontractor_sign_title: signTitle, subcontractor_signed_at: nowIso, subcontractor_sign_ip: ip, signature_data: signatureData };

      // Render + store the signed Agreement PDF and the W-9 PDF (best-effort:
      // never lose the submission if PDFShift hiccups — we still record it).
      let agreementPath = null, w9Path = null, pdfErr = null;
      // W-9 — fill the OFFICIAL IRS form so it keeps the government look
      // (pdf-lib, no PDFShift needed).
      try {
        const wPdf = await fillW9Pdf(signed);
        w9Path = await storefile(`${crew.id}/w9_${Date.now()}.pdf`, wPdf);
      } catch (e) { pdfErr = "w9: " + (e.message || "fill error"); }
      // Agreement — HTML → PDF via PDFShift.
      try {
        if (PDFSHIFT_KEY) {
          const aPdf = await renderPdf(agreementHtml(signed));
          agreementPath = await storefile(`${crew.id}/agreement_${Date.now()}.pdf`, aPdf);
        } else { pdfErr = (pdfErr ? pdfErr + "; " : "") + "PDFSHIFT_API_KEY not set (agreement)"; }
      } catch (e) { pdfErr = (pdfErr ? pdfErr + "; " : "") + "agreement: " + (e.message || "pdf error"); }

      const patch = {
        status: "submitted", submitted_at: nowIso,
        subcontractor_sign_name: signName, subcontractor_sign_title: signTitle,
        subcontractor_signed_at: nowIso, subcontractor_sign_ip: ip,
        agreement_pdf_path: agreementPath, w9_pdf_path: w9Path,
      };
      const r = await fetch(`${SB_URL}/rest/v1/crews?id=eq.${encodeURIComponent(crew.id)}`, { method: "PATCH", headers: { ...sb, Prefer: "return=minimal" }, body: JSON.stringify(patch) });
      if (!r.ok) return cors(500, JSON.stringify({ ok: false, error: `save ${r.status}` }));
      // Persist the drawn signature separately (best-effort) so the agreement can
      // be regenerated with both signatures at countersign — tolerant of the
      // subcontractor_signature column not existing yet.
      await fetch(`${SB_URL}/rest/v1/crews?id=eq.${encodeURIComponent(crew.id)}`, { method: "PATCH", headers: { ...sb, Prefer: "return=minimal" }, body: JSON.stringify({ subcontractor_signature: signatureData }) }).catch(() => {});

      await notifyOffice(crew, signName, pdfErr);
      return cors(200, JSON.stringify({ ok: true, pdf_error: pdfErr }));
    }

    return cors(400, JSON.stringify({ ok: false, error: `Unknown action: ${action}` }));
  } catch (e) {
    return cors(500, JSON.stringify({ ok: false, error: e.message || "error" }));
  }
};

// ── What the crew's own portal sees: their info + the READ-ONLY rates ────────
function crewForCrew(c) {
  const out = { id: c.id, status: c.status, owner_first: c.owner_first, owner_last: c.owner_last, company_name: c.company_name, rates: c.rates };
  for (const k of SAVE_FIELDS) out[k] = c[k] ?? null;
  return out;
}
function clean(v, k) {
  if (k === "crew_size" || k === "dump_trailers") { const n = parseInt(v, 10); return Number.isFinite(n) ? n : null; }
  const s = v == null ? null : String(v).trim();
  return s === "" ? null : s;
}

// ── Storage + PDFShift ──────────────────────────────────────────────────────
async function storefile(path, base64) {
  const buffer = Buffer.from(base64, "base64");
  const up = await fetch(`${SB_URL}/storage/v1/object/${BUCKET}/${path}`, {
    method: "POST", headers: { apikey: SVC_KEY, Authorization: `Bearer ${SVC_KEY}`, "Content-Type": "application/pdf", "x-upsert": "true" }, body: buffer,
  });
  if (!up.ok) throw new Error(`store ${up.status}: ${(await up.text()).slice(0, 120)}`);
  return path;
}
// Fill the official IRS Form W-9 with the crew's data + stamp the e-signature,
// so the saved W-9 keeps the real government layout. Returns base64.
async function fillW9Pdf(c) {
  const pdf = await PDFDocument.load(Buffer.from(W9_B64, "base64"));
  const form = pdf.getForm();
  const helv = await pdf.embedFont(StandardFonts.Helvetica);
  const P = "topmostSubform[0].Page1[0].";
  const B = P + "Boxes3a-b_ReadOrder[0].";
  const set = (name, val) => { try { const f = form.getTextField(name); f.setText(String(val == null ? "" : val)); f.setFontSize(9); } catch { /* field absent */ } };
  const check = (name) => { try { form.getCheckBox(name).check(); } catch { /* */ } };

  set(P + "f1_01[0]", c.w9_name);
  set(P + "f1_02[0]", c.w9_business_name);
  set(P + "f1_05[0]", c.w9_exempt_payee_code);
  set(P + "f1_06[0]", c.w9_fatca_code);
  set(P + "Address_ReadOrder[0].f1_07[0]", c.w9_address);
  set(P + "Address_ReadOrder[0].f1_08[0]", c.w9_city_state_zip);

  // Line 3a — federal tax classification (check exactly one).
  const cls = String(c.w9_tax_classification || "").toLowerCase();
  if (cls.includes("individual") || cls.includes("sole")) check(B + "c1_1[0]");
  else if (cls.includes("c corp")) check(B + "c1_1[1]");
  else if (cls.includes("s corp")) check(B + "c1_1[2]");
  else if (cls.includes("partnership")) check(B + "c1_1[3]");
  else if (cls.includes("trust") || cls.includes("estate")) check(B + "c1_1[4]");
  else if (cls === "llc" || cls.includes("limited liability")) { check(B + "c1_1[5]"); set(B + "f1_03[0]", c.w9_llc_class); }
  else if (cls) { check(B + "c1_1[6]"); set(B + "f1_04[0]", c.w9_tax_classification); }

  // Part I — SSN (3-2-4) or EIN (2-7).
  const digits = String(c.w9_tin || "").replace(/\D/g, "");
  if (c.w9_tin_type === "ein") {
    set(P + "f1_14[0]", digits.slice(0, 2));
    set(P + "f1_15[0]", digits.slice(2, 9));
  } else {
    set(P + "f1_11[0]", digits.slice(0, 3));
    set(P + "f1_12[0]", digits.slice(3, 5));
    set(P + "f1_13[0]", digits.slice(5, 9));
  }

  // Stamp the e-signature + date on the "Sign Here" line (no form field there).
  try {
    const page = pdf.getPage(0);
    const dt = new Date(c.subcontractor_signed_at || Date.now());
    const dateStr = `${dt.getMonth() + 1}/${dt.getDate()}/${dt.getFullYear()}`;
    let drew = false;
    if (c.signature_data && String(c.signature_data).startsWith("data:image")) {
      try {
        const png = await pdf.embedPng(Buffer.from(String(c.signature_data).replace(/^data:image\/\w+;base64,/, ""), "base64"));
        const w = 145, h = Math.min((png.height / png.width) * w, 24);
        page.drawImage(png, { x: 128, y: 196, width: w, height: h });   // on the "Sign Here" line
        drew = true;
      } catch { /* fall back to typed */ }
    }
    if (!drew && c.subcontractor_sign_name) {
      const sigFont = await pdf.embedFont(StandardFonts.HelveticaOblique);
      page.drawText(String(c.subcontractor_sign_name), { x: 130, y: 204, size: 12, font: sigFont });
    }
    page.drawText(dateStr, { x: 470, y: 205, size: 11, font: helv });
  } catch { /* signature stamp best-effort */ }

  try { form.updateFieldAppearances(helv); } catch { /* */ }
  try { form.flatten(); } catch { /* leave fillable if flatten unsupported */ }
  const out = await pdf.save();
  return Buffer.from(out).toString("base64");
}

async function renderPdf(html) {
  const res = await fetch("https://api.pdfshift.io/v3/convert/pdf", {
    method: "POST", headers: { "X-API-Key": PDFSHIFT_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ source: html, format: "Letter", use_print: false }),
  });
  if (!res.ok) throw new Error(`PDFShift ${res.status}: ${(await res.text()).slice(0, 160)}`);
  const buf = await res.arrayBuffer();
  if (Buffer.from(buf).slice(0, 5).toString() !== "%PDF-") throw new Error("PDFShift returned non-PDF");
  return Buffer.from(buf).toString("base64");
}

// ── Notify the office that a crew submitted ─────────────────────────────────
async function notifyOffice(crew, signName, pdfErr) {
  const base = (process.env.URL || process.env.PUBLIC_SITE_URL || "https://free-roof-inspections.netlify.app").replace(/\/$/, "");
  const who = `${crew.owner_first || ""} ${crew.owner_last || ""}`.trim() || signName;
  const link = `${base}/?mode=crews`;
  const msg = `✅ Crew onboarding submitted: ${who}${crew.company_name ? ` (${crew.company_name})` : ""} signed the agreement + uploaded docs. Review: ${link}${pdfErr ? ` [PDF note: ${pdfErr}]` : ""}`;
  const phone = process.env.ADMIN_ALERT_PHONE;
  const email = process.env.CREW_ONBOARDING_EMAIL || "nikki@shingleusa.com";
  try { if (phone) await fetch(`${base}/.netlify/functions/ghl-sms`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ to: phone, name: "Office", message: msg }) }); } catch { /* */ }
  try { await fetch(`${base}/.netlify/functions/send-email`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ to: email, subject: `Crew onboarding submitted — ${who}`, html: `<p>${esc(who)}${crew.company_name ? ` (${esc(crew.company_name)})` : ""} completed onboarding and signed the agreement.</p><p><a href="${link}">Open Crew Onboarding →</a></p>` }) }); } catch { /* */ }
}

// ── PDF templates ───────────────────────────────────────────────────────────
function money(v) { return v == null || v === "" ? "By experience" : `$${(+v).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`; }
function fmtDate(iso) { try { return new Date(iso).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" }); } catch { return ""; } }
function esc(s) { return String(s == null ? "" : s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c])); }

const RATE_ROWS = [
  ["shingle", "Shingle", "SQ"], ["screw_down_metal", "Screw Down Metal", "SQ"],
  ["standing_seam_metal", "Standing Seam Metal", "SQ"], ["permalock_aluminum_shingle", "Permalock / Aluminum Shingle", "SQ"],
  ["decra_stone_coated", "Decra / Stone Coated", "SQ"], ["tile", "Tile", ""],
  ["tpo", "TPO", "SQ"], ["base_and_cap", "Base & Cap", "SQ"],
  ["plywood_replacement", "Plywood replacement", "sheet"], ["1xs", "1x's", "LF"],
  ["extra_story", "Extra story", "SQ"], ["extra_layer_shingles", "Extra layer of shingles", "SQ"],
  ["additional_story", "Additional story", "SQ"], ["steep_7_12", "Steep 7/12", "SQ"],
  ["trip_charge", "Trip charge (max 2 per install)", "trip"],
];

// The Subcontractor Agreement clauses (verbatim from the packet).
const AGREEMENT_CLAUSES = [
  ["1. Description of Services.", "Subcontractor will provide the following: equipment, supplies, labor, and services (collectively, the “Services”). All timelines and/or deadlines will be provided prior to performing work. All work will be performed promptly, efficiently, and in a workmanlike manner, in accordance with all applicable local, state, and federal building codes, regulations, and statutes, including the Florida Building Code."],
  ["2. Licensing and Qualification.", "Subcontractor represents and warrants that, at all times during the performance of the Services, it holds and maintains all licenses and registrations required by Florida law, including a valid State of Florida roofing contractor license (certified or registered) under Chapter 489, Florida Statutes, OR that all roofing work will be done under the direct supervision of a properly licensed qualifying contractor. Prior to starting work, Subcontractor shall provide a copy of its current roofing license and number; keep all licenses active and in good standing; notify US Shingle within three (3) business days of any lapse; and consents to DBPR verification. Performing work without proper licensing is a material breach."],
  ["3. Payment for Services.", "US Shingle will pay Subcontractor an agreed-upon price communicated prior to the commencement of work, as described in the Pay Structure. If additional work is needed, Subcontractor must submit clear photos with explanations. Payment is issued on Friday after job completion and submission of the final invoice by Wednesday of the same week; jobs completed after Wednesday are paid the following Friday. Subcontractor must provide final unconditional lien releases upon final payment if requested."],
  ["4. Completion.", "Subcontractor shall complete all Services as agreed, confirms it has reviewed the scope and timeline, and guarantees completion within three days of assignment or the specified dates."],
  ["5. Attire.", "Subcontractor agrees to wear no other contracting companies’ shirts, logos, or branding. US Shingle can provide logo shirts. After a first warning, any staff member on a job site with another company’s branding incurs a $250-per-person fine deducted from that job’s invoice."],
  ["6. Insurance.", "Prior to starting work, Subcontractor must provide a currently dated Certificate of Insurance and maintain, at its own expense, Workers’ Compensation and Commercial General Liability insurance. General Liability limits: minimum $1,000,000 per occurrence / $2,000,000 aggregate, not excluding open roof coverage. Workers’ Compensation must comply with Chapter 440 and cover all roofing-related injury claims. US Shingle must be listed as additional insured on the GL policy, with a waiver of subrogation where permitted. Proof of insurance renewed and submitted on the first business day of each month. Failure results in immediate suspension and possible termination."],
  ["7. Workers’ Compensation Coverage of All Employees.", "Every employee, crew member, and worker Subcontractor brings to a US Shingle jobsite shall be covered by Subcontractor’s Workers’ Compensation policy — no uninsured worker may perform work. Any officer/member claiming a Florida construction-industry exemption must provide a current Certificate of Election to be Exempt (max 3 officers, each 10%+ owner). Upon request, Subcontractor shall provide a worker roster and payroll documentation. If US Shingle becomes liable for any worker’s comp of Subcontractor’s workers, Subcontractor shall reimburse all costs, which US Shingle may deduct from sums owed."],
  ["8. Indemnity and Hold Harmless.", "To the fullest extent permitted by law, Subcontractor shall indemnify, hold harmless, and defend US Shingle and its officers, directors, members, and employees from any claims, liability, damages, and costs (including reasonable attorney’s fees) arising out of the Services, including personal injury, death, or property damage caused in whole or in part by Subcontractor. Per Section 725.06, Florida Statutes, the monetary limitation is the greater of $1,000,000 per occurrence or the total insurance limits required. This does not extend to claims from US Shingle’s gross negligence or willful misconduct, or where US Shingle is solely negligent."],
  ["9. Liens.", "Subcontractor shall indemnify US Shingle and homeowners against all liability for labor/material liens, defend any lien at its own expense, and remove any lien within ten (10) days of written demand. Subcontractor shall comply with Chapter 713 and provide partial and final lien waivers as a condition of payment."],
  ["10. Clean-Up.", "Subcontractor shall keep the worksite clean, and at the end of each day and upon completion remove all debris and run a magnet roller. Failure after verbal notice may result in US Shingle performing clean-up and charging the cost to Subcontractor."],
  ["11. Material Damage and Liability.", "If any crew member damages materials provided for the job, Subcontractor is fully responsible for replacement cost, deducted from the invoice or billed separately."],
  ["12. Property Damage Responsibility.", "Subcontractor is fully responsible for any damage caused by their crew to the homeowner’s property (siding, gutters, landscaping, driveways, structure), and shall repair promptly or reimburse US Shingle. Failure may result in withholding of payment or back charges."],
  ["13. Safety and OSHA Compliance.", "Subcontractor shall comply with all applicable safety requirements and OSHA regulations, including fall protection at 6+ feet, compliant ladders/scaffolding, hazard communication (SDS), PPE, electrical safety/lockout-tagout, training and certification, immediate accident/incident reporting, housekeeping, heat/cold stress monitoring, and emergency preparedness. Subcontractor is solely responsible for all costs of safety violations."],
  ["14. Provision for Inspection.", "Subcontractor shall provide US Shingle access to the worksite for inspection and shall notify US Shingle when an in-progress inspection is needed and submit progress reports as required."],
  ["15. Unforeseen Conditions and Force Majeure.", "Subcontractor is not responsible for reasonable delays from concealed conditions. Performance is excused for events beyond the Parties’ control; the affected Party must give prompt written notice and resume once the condition abates."],
  ["16. Default.", "Material defaults include: failure to make a required payment; insolvency or bankruptcy; levy/seizure/assignment for creditors; failure to deliver the Services in the agreed time and manner; or failure to maintain required licensing or insurance."],
  ["17. Remedies on Default.", "The non-defaulting Party may terminate if a default is not cured within seven (7) days of written notice. US Shingle may suspend or terminate immediately without a cure period for any lapse in required licensing or insurance."],
  ["18. Relationship of the Parties.", "This Agreement does not create a partnership, joint venture, or employment relationship. Both Parties are independent contractors. Subcontractor is solely responsible for its own taxes, licensing, insurance, and obligations to its employees."],
  ["19. Access, Signage Rights, and Design Plans.", "Subcontractor shall have reasonable site access and may not display signage other than what US Shingle assigns. US Shingle’s plans/documents remain its property and must be returned. Homeowner questions should be directed to US Shingle."],
  ["20. Warranty and Repair.", "Subcontractor must remedy any homeowner-reported problem if deemed necessary by US Shingle. Subcontractor is not liable for material defects but is responsible for workmanship. If unavailable within 48 hours to make repairs, US Shingle may incur the cost and back charge Subcontractor."],
  ["21. Notices.", "Notices shall be delivered in person, by certified mail (return receipt requested), or by email, deemed received on delivery or the third day after mailing if not signed for."],
  ["22. Entire Agreement.", "This Agreement, including the Onboarding, Jobsite, Photo, and Pay Structure terms, contains the entire understanding between the Parties and supersedes any prior agreements."],
  ["23. Waiver.", "No waiver of any breach shall be deemed a waiver of any other breach. Acceptance of payment or performance after a breach does not waive any other breach."],
  ["24. Severability and Headings.", "If any provision is deemed invalid, the remaining provisions remain in effect. Headings are for convenience only."],
  ["25. Amendment.", "This Agreement may only be modified in writing signed by both Parties."],
  ["26. Choice of Law and Jurisdiction.", "This Agreement is governed by Florida law; Florida state and federal courts have exclusive jurisdiction. The prevailing Party is entitled to reasonable attorney’s fees and costs."],
  ["27. Assignment.", "Neither Party may assign its rights or obligations without the other Party’s prior written consent."],
  ["28. Binding Effect.", "This Agreement binds and benefits the Parties and their heirs, representatives, successors, and assigns."],
  ["29. Counterparts.", "This Agreement may be executed in counterparts, including electronic and scanned copies, each an original, together one instrument."],
];

function agreementHtml(c) {
  const company = c.company_name || `${c.owner_first || ""} ${c.owner_last || ""}`.trim() || "Subcontractor";
  const signedDate = fmtDate(c.subcontractor_signed_at);
  const clauses = AGREEMENT_CLAUSES.map(([h, p]) => `<p class="cl"><b>${esc(h)}</b> ${esc(p)}</p>`).join("");
  const rateRows = RATE_ROWS.map(([k, label, unit]) => `<tr><td>${label}</td><td class="r">${money(c.rates ? c.rates[k] : null)}${unit && c.rates && c.rates[k] != null ? ` / ${unit}` : ""}</td></tr>`).join("");
  const info = (label, val) => (val === null || val === undefined || val === "") ? "" : `<tr><td class="lbl">${label}</td><td>${esc(val)}</td></tr>`;
  const subSig = c.signature_data && String(c.signature_data).startsWith("data:image");
  const usSig = c.us_shingle_signature && String(c.us_shingle_signature).startsWith("data:image");
  const sigCol = (party, img, name, title, date, pending) => `
    <div class="sigcol">
      <div class="party">${party}</div>
      ${img ? `<img class="sigimg" src="${img}" />` : `<div style="height:38px;"></div>`}
      <div class="lb" style="margin-top:2px;"><div class="cap">Signature</div></div>
      <div class="lb"><div class="val">${name || "&nbsp;"}</div><div class="cap">Printed Name</div></div>
      <div class="lb"><div class="val">${title || "&nbsp;"}</div><div class="cap">Title</div></div>
      <div class="lb"><div class="val">${date || "&nbsp;"}</div><div class="cap">Date</div></div>
      ${pending ? `<div class="muted" style="margin-top:6px;">Pending US Shingle countersignature.</div>` : ""}
    </div>`;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    body{font-family:Calibri,Arial,Helvetica,sans-serif;color:#111;font-size:11.5px;line-height:1.5;margin:0;}
    .wrap{padding:44px 52px;}
    .title{text-align:center;margin-bottom:14px;}
    .title .co{font-size:18px;font-weight:800;letter-spacing:.02em;}
    .title .addr{font-size:11px;color:#333;}
    .title .doc{font-size:13.5px;font-weight:700;margin-top:5px;text-transform:uppercase;}
    h2{font-size:12.5px;font-weight:700;margin:16px 0 4px;}
    p{margin:8px 0;text-align:justify;} .cl{margin:7px 0;text-align:justify;}
    table{border-collapse:collapse;width:100%;font-size:11px;margin:5px 0;}
    td{padding:4px 9px;border:1px solid #999;vertical-align:top;}
    td.r{text-align:right;white-space:nowrap;} td.lbl{color:#444;width:40%;}
    .siggrid{display:flex;gap:30px;margin-top:16px;} .sigcol{flex:1;}
    .sigcol .party{font-weight:700;margin-bottom:6px;}
    .sigimg{height:38px;display:block;margin:2px 0 -2px 2px;}
    .lb{margin-top:14px;} .lb .val{min-height:15px;font-weight:600;}
    .lb .cap{border-top:1px solid #111;padding-top:2px;font-size:10px;color:#333;}
    .muted{color:#666;font-size:9.5px;}
  </style></head><body><div class="wrap">
    <div class="title">
      <div class="co">US SHINGLE AND METAL LLC</div>
      <div class="addr">12910 Automobile Blvd, Clearwater, FL 33762</div>
      <div class="doc">Subcontractor Agreement &amp; Onboarding Packet</div>
    </div>
    <p>This Subcontractor Agreement (this "Agreement") is made effective as of <b>${signedDate}</b>, by and between US Shingle and Metal LLC, a Florida limited liability company with its principal place of business at 12910 Automobile Blvd, Clearwater, FL 33762 ("US Shingle") and <b>${esc(company)}</b> ("Subcontractor"). US Shingle and the Subcontractor may be referred to as a Party or collectively as the Parties.</p>
    <h2>Recitals</h2>
    <p>US Shingle has entered into contracts and may continue to enter into contracts with individual homeowners (each an "Original Contract"). Under each Original Contract, US Shingle has agreed to provide roofing, insulation installation, radiant barrier installation, painting, repairs, or other home improvements. US Shingle desires to enter into this Agreement with Subcontractor for a portion of the services contemplated by each Original Contract. Subcontractor is willing to provide such services and represents that it is properly licensed, insured, and qualified to perform roofing work in the State of Florida.</p>
    <h2>Agreement</h2>
    <p>In consideration of the mutual promises contained in this Agreement and other valuable consideration, the Parties agree as follows:</p>
    ${clauses}
    <h2>Pay Structure</h2>
    <p style="margin:4px 0;">We pay per SQ, which includes dump fees when using your own trailer. Price is based on actual SQs — waste NOT included.</p>
    <table><tr><td style="font-weight:700;">Roofing Type / Item</td><td class="r" style="font-weight:700;">Rate</td></tr>${rateRows}</table>
    <h2>Subcontractor Onboarding Information</h2>
    <table>
      ${info("Owner", `${c.owner_first || ""} ${c.owner_last || ""}`.trim())}
      ${info("Company", c.company_name)}
      ${info("Contact for setting up installs", [c.install_contact_name, c.install_contact_phone, c.install_contact_email].filter(Boolean).join(" · "))}
      ${info("Onsite crew lead", [c.crew_lead_name, c.crew_lead_phone, c.crew_lead_email].filter(Boolean).join(" · "))}
      ${info("Preferred area for work", c.preferred_area)}
      ${info("Number of crew members", c.crew_size)}
      ${info("Number of dump trailers", c.dump_trailers)}
      ${info("Type of roofing work performed", c.roofing_types)}
      ${info("License / certification #", c.license_number)}
      ${info("Bank name", c.bank_name)}
      ${info("Wire routing #", c.bank_routing)}
      ${info("Account #", c.bank_account)}
      ${info("Name on account", c.account_name)}
      ${info("Company EIN", c.company_ein)}
      ${info("Address on account", c.account_address)}
    </table>
    <p style="margin-top:14px;">By signing below, each Party acknowledges it has read, understood, and agrees to be bound by this Agreement, including all Onboarding, Jobsite, Photo, and Pay Structure terms.</p>
    <div class="siggrid">
      ${sigCol("SUBCONTRACTOR:", subSig ? c.signature_data : null, esc(c.subcontractor_sign_name || ""), esc(c.subcontractor_sign_title || "Owner"), signedDate, false)}
      ${sigCol("US SHINGLE AND METAL LLC:", usSig ? c.us_shingle_signature : null, usSig ? esc(c.us_shingle_sign_name || "") : "", usSig ? esc(c.us_shingle_sign_title || "US Shingle") : "", usSig && c.us_shingle_signed_at ? fmtDate(c.us_shingle_signed_at) : "", !usSig)}
    </div>
    <div class="muted" style="margin-top:12px;">Electronically signed by the Subcontractor — ${esc(c.subcontractor_sign_name || "")}, IP ${esc(c.subcontractor_sign_ip || "n/a")}, ${esc(c.subcontractor_signed_at || "")}.</div>
  </div></body></html>`;
}

function w9Html(c) {
  const tinKind = c.w9_tin_type === "ein" ? "EIN" : "SSN";
  const row = (label, val) => `<tr><td style="padding:3px 10px;color:#6b7280;width:230px;">${label}</td><td style="padding:3px 10px;font-weight:600;">${esc(val || "—")}</td></tr>`;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    body{font-family:Arial,Helvetica,sans-serif;color:#1f2733;font-size:11px;line-height:1.5;margin:0;}
    .wrap{padding:30px 36px;} h1{font-size:16px;margin:0 0 2px;color:#14213a;} .muted{color:#6b7280;font-size:10px;}
    table{border-collapse:collapse;width:100%;} .sig{margin-top:14px;padding:12px 14px;background:#f8fafc;border:1px solid #d1d5db;border-radius:6px;}
  </style></head><body><div class="wrap">
    <h1>Form W-9 — Request for Taxpayer Identification Number and Certification</h1>
    <div class="muted">Completed for US Shingle and Metal LLC · ${fmtDate(c.subcontractor_signed_at)}</div>
    <table style="margin-top:12px;">
      ${row("1. Name (as shown on your income tax return)", c.w9_name)}
      ${row("2. Business name / disregarded entity", c.w9_business_name)}
      ${row("3. Federal tax classification", c.w9_tax_classification + (c.w9_llc_class ? ` (LLC — ${c.w9_llc_class})` : ""))}
      ${row("4. Exempt payee code", c.w9_exempt_payee_code)}
      ${row("   Exemption from FATCA reporting code", c.w9_fatca_code)}
      ${row("5. Address", c.w9_address)}
      ${row("6. City, state, ZIP", c.w9_city_state_zip)}
      ${row(`Taxpayer Identification Number (${tinKind})`, c.w9_tin)}
    </table>
    <div class="sig">
      <div><b>Certification.</b> Under penalties of perjury, I certify that the number shown is my correct taxpayer identification number, I am not subject to backup withholding, I am a U.S. person, and any FATCA code entered is correct.</div>
      <div style="margin-top:8px;">Signature: <b>${esc(c.subcontractor_sign_name)}</b> &nbsp; Date: ${fmtDate(c.subcontractor_signed_at)}</div>
      <div class="muted" style="margin-top:4px;">Electronically signed — IP ${esc(c.subcontractor_sign_ip || "n/a")} · ${esc(c.subcontractor_signed_at)}</div>
    </div>
  </div></body></html>`;
}

function labelDoc(t) { return { general_liability: "General Liability insurance", workers_comp: "Workers’ Comp insurance", roofing_license: "Roofing license" }[t] || t; }
// Office approves + countersigns: gated by the GLOBAL office token, looks up the
// crew by id, regenerates the Agreement PDF with BOTH signatures, marks approved.
async function officeCountersign(token, body) {
  const [d, v] = await Promise.all([getSetting("dialer_token"), getSetting("visit_token")]);
  if (!token || (token !== d && token !== v)) return cors(401, JSON.stringify({ ok: false, error: "Invalid token" }));
  const crewId = String(body.crew_id || "").trim();
  const signName = String(body.sign_name || "").trim();
  const sigData = String(body.signature_data || "");
  if (!crewId) return cors(400, JSON.stringify({ ok: false, error: "crew_id required" }));
  if (!signName) return cors(400, JSON.stringify({ ok: false, error: "Type your name to countersign." }));
  if (!sigData.startsWith("data:image")) return cors(400, JSON.stringify({ ok: false, error: "Draw the US Shingle signature." }));
  const crew = (await sbGet(`crews?id=eq.${encodeURIComponent(crewId)}&select=*&limit=1`))[0];
  if (!crew) return cors(404, JSON.stringify({ ok: false, error: "crew not found" }));

  const nowIso = new Date().toISOString();
  const signTitle = String(body.sign_title || "").trim() || "US Shingle";
  const signed = { ...crew, signature_data: crew.subcontractor_signature, us_shingle_signature: sigData, us_shingle_sign_name: signName, us_shingle_sign_title: signTitle, us_shingle_signed_at: nowIso };

  // Regenerate the Agreement PDF with both signatures (best-effort).
  let agreementPath = crew.agreement_pdf_path, pdfErr = null;
  try {
    if (PDFSHIFT_KEY) {
      const aPdf = await renderPdf(agreementHtml(signed));
      agreementPath = await storefile(`${crew.id}/agreement_signed_${Date.now()}.pdf`, aPdf);
    } else pdfErr = "PDFSHIFT_API_KEY not set";
  } catch (e) { pdfErr = e.message || "pdf error"; }

  const patch = {
    status: "approved", approved_at: nowIso,
    us_shingle_signed_at: nowIso, us_shingle_sign_name: signName, us_shingle_sign_title: signTitle,
    us_shingle_signature: sigData, agreement_pdf_path: agreementPath,
  };
  const r = await fetch(`${SB_URL}/rest/v1/crews?id=eq.${encodeURIComponent(crew.id)}`, { method: "PATCH", headers: { ...sb, Prefer: "return=minimal" }, body: JSON.stringify(patch) });
  if (!r.ok) return cors(500, JSON.stringify({ ok: false, error: `save ${r.status}` }));
  return cors(200, JSON.stringify({ ok: true, pdf_error: pdfErr }));
}
async function getSetting(key) {
  const rows = await sbGet(`app_settings?key=eq.${encodeURIComponent(key)}&select=value&limit=1`);
  return rows[0] ? rows[0].value : null;
}
async function sbGet(path) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: sb });
  if (!r.ok) return [];
  return r.json().catch(() => []);
}
function cors(status, body) {
  return { statusCode: status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" }, body };
}
