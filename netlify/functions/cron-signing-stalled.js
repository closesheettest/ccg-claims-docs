// Tell the rep when a signing stalls.
//
// The homeowner opens the agreement, passes the phone code — and then the
// signature never lands. Six signings died exactly there between July 2 and
// August 18 (Stanley McKenzie, Tracie Davenport, Gustavo Soares, Chris Anthony,
// Marco Rocha, Alyse Marrone) and not one was noticed: the final PDF is built on
// the HOMEOWNER'S phone, so a weak signal, an old handset or simply walking away
// ends it, and the only symptom was a line of text on their screen.
//
// Every one of those homeowners had agreed to a free roof inspection. They just
// never got one, and the rep never knew (Neal, 2026-08-19).
//
// So: if a signing has been phone-verified for STALL_MIN minutes and still isn't
// signed, text the rep while they may still be at the door. Once only.
//
//   GET ?dry=1   → who would be texted, sends nothing
//
// Requires sql/signing_stall_alert.sql.
// Env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, ADMIN_ALERT_PHONE (optional).

import { SB_URL, sb, siteBase, json, sendSms } from "./_pending.js";

const STALL_MIN = 15;          // long enough to not fire mid-signature
const GIVE_UP_HOURS = 72;      // matches the link's own lifetime — after that it's dead anyway

export const handler = async (event) => {
  const q = (event && event.queryStringParameters) || {};
  const dry = q.dry === "1";
  const now = Date.now();

  const cutoff = new Date(now - STALL_MIN * 60000).toISOString();
  const floor = new Date(now - GIVE_UP_HOURS * 3600000).toISOString();

  const url = `${SB_URL}/rest/v1/pending_signings` +
    `?status=eq.phone_verified&signed_at=is.null&stall_alert_at=is.null` +
    `&phone_verified_at=lte.${encodeURIComponent(cutoff)}` +
    `&phone_verified_at=gte.${encodeURIComponent(floor)}` +
    `&select=id,token,client_name,address,city,sales_rep_name,sales_rep_id,phone_verified_at,expires_at`;

  let rows;
  try {
    const r = await fetch(url, { headers: sb });
    if (!r.ok) return json(500, { ok: false, error: `read failed (${r.status}) — has sql/signing_stall_alert.sql been run?` });
    rows = await r.json();
  } catch (e) {
    return json(500, { ok: false, error: e.message || "read error" });
  }
  if (!rows.length) return json(200, { ok: true, stalled: 0 });

  // Rep phone numbers, by name — pending_signings only carries the name.
  const names = [...new Set(rows.map((r) => (r.sales_rep_name || "").trim()).filter(Boolean))];
  const phoneByName = {};
  if (names.length) {
    try {
      const inList = names.map((n) => `"${n.replace(/"/g, '')}"`).join(",");
      const rr = await fetch(`${SB_URL}/rest/v1/sales_reps?name=in.(${encodeURIComponent(inList)})&select=name,phone`, { headers: sb });
      if (rr.ok) for (const p of await rr.json()) if (p.phone) phoneByName[p.name] = p.phone;
    } catch { /* fall through — reported as no_phone below */ }
  }

  const sent = [], noPhone = [];
  for (const row of rows) {
    const who = (row.sales_rep_name || "").trim();
    const phone = phoneByName[who];
    const where = [row.address, row.city].filter(Boolean).join(", ");
    const link = `${siteBase()}/?sign=${row.token}`;
    const mins = Math.round((now - Date.parse(row.phone_verified_at)) / 60000);

    if (!phone) { noPhone.push({ name: row.client_name, rep: who }); continue; }

    const msg =
      `⚠️ Signing not finished — ${row.client_name || "homeowner"}${where ? ` (${where})` : ""}. ` +
      `They verified their phone ${mins} min ago but the signature never came through, so there's no inspection on file. ` +
      `Their link still works — have them open it and sign: ${link}`;

    if (dry) { sent.push({ rep: who, phone, client: row.client_name, mins }); continue; }

    const ok = await sendSms(phone, who, msg);
    // Only stamp when the text actually went — otherwise a transient SMS failure
    // would permanently silence the alert for that signing.
    if (ok !== false) {
      await fetch(`${SB_URL}/rest/v1/pending_signings?id=eq.${encodeURIComponent(row.id)}`, {
        method: "PATCH", headers: { ...sb, "Content-Type": "application/json", Prefer: "return=minimal" },
        body: JSON.stringify({ stall_alert_at: new Date().toISOString() }),
      }).catch(() => {});
      sent.push({ rep: who, client: row.client_name, mins });
    }
  }

  return json(200, { ok: true, dry_run: dry || undefined, stalled: rows.length, alerted: sent.length, sent, no_phone: noPhone });
};
