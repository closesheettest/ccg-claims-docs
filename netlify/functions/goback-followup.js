// netlify/functions/goback-followup.js
//
// An hour after a come-back review appointment, text + email the rep a link
// that asks how it went: Sold / Didn't sell / Not interested / Wasn't home.
//
// WHY: nothing ever asked. The appointment time would pass, the deal would sit
// untouched, and the self-scheduler report showed 4 ran / 1 sold / 0 didn't
// sell — the other three were blanks, not losses, which made the close rate a
// floor rather than a number (Neal, 2026-08-20). Same shape as the PA appt
// follow-up, which already closed this hole on the adjuster side.
//
// DUE = review_appt_at between 60 minutes and 6 hours ago, no follow-up sent
// yet, no outcome recorded yet, not cancelled. The 6h floor stops a first
// deploy blasting a backlog; the stamp guarantees exactly one send each.
//
//   GET  /.netlify/functions/goback-followup          → DRY RUN (lists who's due)
//   GET  /.netlify/functions/goback-followup?apply=1  → send now
//   The cron wrapper (cron-goback-followup) calls it with apply.
//
// ONE-TIME SETUP (Supabase SQL):
//   ALTER TABLE inspections ADD COLUMN IF NOT EXISTS review_followup_sent_at timestamptz;
//
// Env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, URL.

const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const sb = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" };
// Outcomes that mean "still open" — booking the appointment sets these, so they
// are NOT an answer to how it went.
const OPEN_OUTCOMES = new Set(["", "retail_appt", "btr_appt"]);

export const handler = async (event) => {
  if (!SB_URL || !SB_KEY) return json(500, { ok: false, error: "Missing Supabase env" });
  const qp = (event && event.queryStringParameters) || {};
  const isManual = event && event.httpMethod === "GET";
  const apply = isManual ? ["1", "true", "yes"].includes(String(qp.apply || "").toLowerCase()) : true;

  const base = (process.env.URL || process.env.PUBLIC_SITE_URL || "https://free-roof-inspections.netlify.app").replace(/\/$/, "");
  const nowMs = Date.now();
  const dueBefore = new Date(nowMs - 60 * 60000).toISOString();
  const dueAfter = new Date(nowMs - 6 * 3600000).toISOString();

  try {
    const q =
      `inspections?review_followup_sent_at=is.null&cancelled_at=is.null` +
      `&review_appt_at=lte.${encodeURIComponent(dueBefore)}&review_appt_at=gte.${encodeURIComponent(dueAfter)}` +
      `&select=id,client_name,address,city,result,review_appt_at,retail_outcome,sales_rep_name&order=review_appt_at&limit=200`;
    const res = await fetch(`${SB_URL}/rest/v1/${q}`, { headers: sb });
    if (!res.ok) {
      const t = (await res.text()).slice(0, 200);
      return json(500, {
        ok: false,
        error: /review_followup_sent_at/i.test(t) || res.status === 400
          ? "inspections.review_followup_sent_at is missing — run: ALTER TABLE inspections ADD COLUMN IF NOT EXISTS review_followup_sent_at timestamptz;"
          : `Query failed ${res.status}: ${t}`,
      });
    }
    const all = await res.json().catch(() => []);
    // Already answered → nothing to ask. Filtered here rather than in the query
    // so a NULL retail_outcome still counts as due (PostgREST not.in on a NULL
    // column drops the NULLs, which is exactly the rows we care about most).
    const due = all.filter((i) => OPEN_OUTCOMES.has(String(i.retail_outcome || "")));
    if (!due.length) return json(200, { ok: true, due: 0, sent: 0, note: "Nothing due for a follow-up." });

    // Reps by name — the inspection carries the name, the token lives on the rep.
    const reps = await sbGet(`sales_reps?select=name,phone,email,harvest_token,active`);
    const byName = {};
    for (const r of reps) if (r.name) byName[norm(r.name)] = r;

    const results = [];
    for (const i of due) {
      const rep = byName[norm(i.sales_rep_name)];
      const homeowner = (i.client_name || "").trim() || "your homeowner";
      const first = rep && rep.name ? String(rep.name).trim().split(/\s+/)[0] : "there";
      const row = { inspection: i.id, rep: i.sales_rep_name || "(none)", homeowner, appt_at: i.review_appt_at, sms: false, email: false, skipped: null };

      if (!rep || !rep.harvest_token) row.skipped = rep ? "rep has no link" : "rep not found";
      else if (rep.active === false) row.skipped = "rep inactive";
      else if (apply) {
        const link = `${base}/?mode=gobackresult&rt=${encodeURIComponent(rep.harvest_token)}&i=${encodeURIComponent(i.id)}`;
        const where = [i.address, i.city].filter(Boolean).join(", ");
        const msg = `Hi ${first}, how did the come-back with ${homeowner}${where ? ` (${where})` : ""} go? One tap — sold, didn't sell, not interested, or wasn't home: ${link}`;
        const html =
          `<p>Hi ${first},</p>` +
          `<p>How did your come-back with <b>${esc(homeowner)}</b>${where ? ` at ${esc(where)}` : ""} go?</p>` +
          `<p><a href="${link}" style="display:inline-block;padding:12px 20px;background:#7c3aed;color:#fff;text-decoration:none;border-radius:8px;font-weight:700;">Tell us how it went &rarr;</a></p>` +
          `<p style="color:#64748b;font-size:13px;">One tap: Sold, Didn't sell, Not interested, or Wasn't home. It updates JobNimbus for you.</p>`;
        if (rep.phone) row.sms = await sms(base, rep.phone, rep.name, msg);
        if (rep.email) row.email = await sendEmail(base, rep.email, `How did the come-back go? — ${homeowner}`, html);
      }

      // Stamp even when skipped — there's nothing more this cron can do for that
      // row, and leaving it unstamped means retrying it every 15 min forever.
      if (apply) {
        await fetch(`${SB_URL}/rest/v1/inspections?id=eq.${encodeURIComponent(i.id)}`, {
          method: "PATCH", headers: { ...sb, Prefer: "return=minimal" },
          body: JSON.stringify({ review_followup_sent_at: new Date().toISOString() }),
        }).catch(() => {});
      }
      results.push(row);
    }

    const sent = results.filter((r) => r.sms || r.email).length;
    return json(200, { ok: true, applied: apply, due: due.length, sent, results });
  } catch (e) {
    return json(500, { ok: false, error: e.message || "error" });
  }
};

function norm(s) { return String(s || "").trim().toLowerCase().replace(/\s+/g, " "); }
async function sbGet(path) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: sb });
  if (!r.ok) throw new Error(`Supabase ${r.status}`);
  return r.json();
}
async function sms(base, to, name, message) {
  try {
    const r = await fetch(`${base}/.netlify/functions/ghl-sms`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ to, name, message }),
    });
    const j = await r.json().catch(() => ({}));
    return !!j.success;
  } catch { return false; }
}
async function sendEmail(base, to, subject, html) {
  try {
    const r = await fetch(`${base}/.netlify/functions/send-email`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ to, subject, html }),
    });
    return r.ok;
  } catch { return false; }
}
function esc(s) { return String(s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function json(status, body) {
  return { statusCode: status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }, body: JSON.stringify(body) };
}
