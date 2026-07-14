// netlify/functions/get-pending-signing.js
//
// The homeowner's /?sign=<token> page loads its pending record here. Enforces
// the 72h expiry and one-way lifecycle, and stamps the first-open audit
// (timestamp + IP + user-agent). Returns the rep-entered data the page needs
// to render the agreement for review + signing.
//
// POST { token } → { ok, record } | { ok:false, reason:"expired"|"signed"|"canceled"|"not_found" }
//
// Env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY

import { loadByToken, patchByToken, clientIp, json, autosendEnabled } from "./_pending.js";

export const handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { ok: false, error: "Method not allowed" });
  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch { return json(400, { ok: false, error: "Invalid JSON body" }); }
  const token = (body.token || "").trim();
  if (!token) return json(400, { ok: false, error: "token required" });
  // peek = a read that must NOT stamp the "opened" audit — used by the rep's
  // confirmation screen polling for when the HOMEOWNER opens it. Without this,
  // the rep's own poll would falsely mark the link opened.
  const peek = body.peek === true;

  const row = await loadByToken(token);
  if (!row) return json(200, { ok: false, reason: "not_found" });
  if (row.status === "signed") return json(200, { ok: false, reason: "signed" });
  if (row.status === "canceled") return json(200, { ok: false, reason: "canceled" });
  if (new Date(row.expires_at).getTime() < Date.now()) {
    if (row.status !== "expired") await patchByToken(token, { status: "expired" });
    return json(200, { ok: false, reason: "expired" });
  }

  // Stamp the first open (audit trail) — skipped on a peek (rep poll).
  if (!row.opened_at && !peek) {
    await patchByToken(token, {
      opened_at: new Date().toISOString(),
      opened_ip: clientIp(event),
      opened_user_agent: (event.headers || {})["user-agent"] || "",
      status: row.status === "sent" ? "opened" : row.status,
    });
  }

  const hasPhone = String(row.mobile || "").replace(/\D/g, "").length >= 10;
  const hasEmail = /.+@.+\..+/.test(String(row.email || "").trim());
  // Verification mode is chosen PER-SIGNUP by the rep (stored on the row):
  //   "rep_code" = 6-digit code shown on the rep's screen (in-person "Sign now")
  //   "sms"      = code texted/emailed to the homeowner ("Send for signing")
  // Old rows with no stored choice fall back to the global autosend flag.
  const mode = row.delivery_mode || ((await autosendEnabled()) ? "sms" : "rep_code");
  return json(200, {
    ok: true,
    record: {
      token,
      client_name: row.client_name, mobile: row.mobile, email: row.email,
      address: row.address, city: row.city, state: row.state, zip: row.zip, date: row.date,
      roof_type: row.roof_type, lead_source: row.lead_source, spanish_only: row.spanish_only,
      sales_rep_name: row.sales_rep_name, sales_rep_id: row.sales_rep_id, sales_rep_email: row.sales_rep_email,
      obvious_damage: row.obvious_damage, has_insurance: row.has_insurance,
      review_availability: row.review_availability, document_version: row.document_version,
      prepared_by_rep_name: row.prepared_by_rep_name, prepared_at: row.prepared_at,
      sent_channels: row.sent_channels, sent_at: row.sent_at, opened_at: row.opened_at,
      phone_verified_at: row.phone_verified_at, phone_verified_number: row.phone_verified_number,
      status: row.status, has_phone: hasPhone, has_email: hasEmail, has_contact: hasPhone || hasEmail, mode,
    },
  });
};
