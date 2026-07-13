// netlify/functions/list-pending-signings.js
//
// Manager/admin read-only list of remote-signing requests that are still OPEN
// (a link is out but not yet signed) so a stray/duplicate one can be voided
// after the fact — e.g. the Labatos case where one link signed and a second
// was left dangling. Backs the "Pending signatures" card in the Admin hub.
//
// GET ?q=<search over name/address>  → { ok, rows:[...] }
//   rows: newest first, status NOT signed/canceled. `expired` flag set when the
//   72h window has passed (still voidable, just already dead for signing).
//
// Env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY

import { SB_URL, sb, json } from "./_pending.js";

const SELECT = [
  "token", "client_name", "address", "city", "state", "zip",
  "mobile", "email", "status", "sales_rep_name", "sales_rep_id",
  "created_at", "sent_at", "opened_at", "expires_at", "resend_count",
  // audit fields (used when auditing a suspicious/late signing)
  "signed_at", "phone_verified_at", "phone_verified_number", "consent_at", "opened_ip", "opened_user_agent", "sent_channels",
].join(",");

export const handler = async (event) => {
  if (event.httpMethod !== "GET") return json(405, { ok: false, error: "Method not allowed" });
  for (const k of ["VITE_SUPABASE_URL", "VITE_SUPABASE_ANON_KEY"]) {
    if (!process.env[k]) return json(500, { ok: false, error: `Missing env: ${k}` });
  }

  const q = (event.queryStringParameters?.q || "").trim();
  const includeAll = event.queryStringParameters?.all === "1"; // audit: include signed/canceled
  // Open = anything not already signed and not already voided/canceled.
  let url = `${SB_URL}/rest/v1/pending_signings?select=${SELECT}` +
    (includeAll ? "" : "&status=not.in.(signed,canceled)") +
    `&order=created_at.desc&limit=200`;
  if (q) {
    const like = `*${encodeURIComponent(q)}*`;
    url += `&or=(client_name.ilike.${like},address.ilike.${like})`;
  }

  const r = await fetch(url, { headers: sb });
  if (!r.ok) return json(500, { ok: false, error: `Query failed: ${(await r.text()).slice(0, 200)}` });
  const raw = await r.json().catch(() => []);
  const now = Date.now();
  const rows = raw.map((x) => ({
    ...x,
    expired: x.expires_at ? new Date(x.expires_at).getTime() < now : false,
  }));

  return json(200, { ok: true, count: rows.length, rows });
};
