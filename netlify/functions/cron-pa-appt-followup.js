// netlify/functions/cron-pa-appt-followup.js
//
// One hour after a PA appointment's start time, text + email the adjuster a
// link that opens their portal STRAIGHT ON that homeowner's claim, where the
// "How did the appointment go?" card is waiting (Signed / Refused / Not home /
// Cancelled). Purpose: capture the outcome of every visit without the office
// chasing anyone.
//
// The link is the PA's normal private portal link with a &job=<inspectionId>
// deep-link (PAMobileApp opens that claim's detail on load). If the appointment
// has no linked inspection we just drop them on their claims list.
//
// Due = status 'scheduled', no follow-up sent yet, and the start time was
// between 60 minutes and 3 hours ago (the 3h floor avoids blasting a historical
// backlog on first deploy; the every-15-min cadence + followup_sent_at stamp
// covers everyone in that window exactly once).
//
//   GET  /.netlify/functions/cron-pa-appt-followup            → DRY RUN (lists due)
//   GET  /.netlify/functions/cron-pa-appt-followup?apply=1    → send now
//   Scheduled runs (POST from Netlify) send automatically.
//
// ONE-TIME SETUP (Supabase SQL): add the stamp column —
//   ALTER TABLE pa_appointments ADD COLUMN IF NOT EXISTS followup_sent_at timestamptz;
//
// Env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, URL.

const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const sb = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" };

// Every 15 minutes — a PA hears from us ~60–75 min after the appointment start.
exports.config = { schedule: "*/15 * * * *" };

exports.handler = async (event) => {
  if (!SB_URL || !SB_KEY) return json(500, { ok: false, error: "Missing Supabase env" });
  const qp = (event && event.queryStringParameters) || {};
  const isManual = event && event.httpMethod === "GET";
  const apply = isManual ? ["1", "true", "yes"].includes(String(qp.apply || "").toLowerCase()) : true;

  const base = (process.env.URL || process.env.PUBLIC_SITE_URL || "https://free-roof-inspections.netlify.app").replace(/\/$/, "");
  const nowMs = Date.now();
  const dueBefore = new Date(nowMs - 60 * 60000).toISOString();   // start_at ≤ 60 min ago
  const dueAfter = new Date(nowMs - 3 * 3600000).toISOString();   // …but not older than 3h

  try {
    // Due appointments. Tolerant of the followup_sent_at column not existing yet:
    // if the filtered query 400s, surface a clear setup message.
    const q =
      `pa_appointments?status=eq.scheduled&followup_sent_at=is.null` +
      `&start_at=lte.${encodeURIComponent(dueBefore)}&start_at=gte.${encodeURIComponent(dueAfter)}` +
      `&select=id,pa_id,inspection_id,homeowner_name,start_at&order=start_at&limit=200`;
    const res = await fetch(`${SB_URL}/rest/v1/${q}`, { headers: sb });
    if (!res.ok) {
      const t = (await res.text()).slice(0, 200);
      const needsColumn = /followup_sent_at/i.test(t) || res.status === 400;
      return json(500, {
        ok: false,
        error: needsColumn
          ? "pa_appointments.followup_sent_at is missing — run: ALTER TABLE pa_appointments ADD COLUMN IF NOT EXISTS followup_sent_at timestamptz;"
          : `Query failed ${res.status}: ${t}`,
      });
    }
    const due = await res.json().catch(() => []);
    if (!due.length) return json(200, { ok: true, due: 0, sent: 0, note: "No appointments due for a follow-up." });

    // Load the PAs (name / phone / email / active) in one shot.
    const paIds = [...new Set(due.map((a) => a.pa_id).filter(Boolean))];
    const paMap = {};
    if (paIds.length) {
      const pr = await fetch(`${SB_URL}/rest/v1/pas?id=in.(${paIds.map((x) => `"${x}"`).join(",")})&select=id,name,phone,email,active`, { headers: sb });
      if (pr.ok) for (const p of await pr.json().catch(() => [])) paMap[p.id] = p;
    }

    const results = [];
    for (const a of due) {
      const pa = paMap[a.pa_id];
      const homeowner = (a.homeowner_name || "").trim() || "your homeowner";
      const first = pa && pa.name ? String(pa.name).trim().split(/\s+/)[0] : "there";
      const link = `${base}/?mode=pa&pa=${encodeURIComponent(a.pa_id)}` + (a.inspection_id ? `&job=${encodeURIComponent(a.inspection_id)}` : "");
      const smsMsg = `Hi ${first}, how did your appointment with ${homeowner} go? Tap to set the outcome — Signed, Refused, Not home, or Cancelled: ${link}`;
      const emailHtml =
        `<p>Hi ${first},</p>` +
        `<p>How did your appointment with <b>${escapeHtml(homeowner)}</b> go?</p>` +
        `<p><a href="${link}" style="display:inline-block;padding:12px 20px;background:#0e7490;color:#fff;text-decoration:none;border-radius:8px;font-weight:700;">Set the outcome →</a></p>` +
        `<p style="color:#64748b;font-size:13px;">It opens right on this homeowner — tap Signed, Refused to sign, Not home (reschedule), or Cancelled.</p>`;

      const row = { appointment: a.id, pa: pa ? pa.name : a.pa_id, homeowner, sms: false, email: false, skipped: null };

      if (!pa || !pa.active) {
        row.skipped = pa ? "PA inactive" : "PA not found";
      } else if (apply) {
        if (pa.phone) row.sms = await sms(base, pa.phone, pa.name, smsMsg);
        if (pa.email) row.email = await sendEmail(base, pa.email, `How did your appointment go? — ${homeowner}`, emailHtml);
      }

      // Stamp so it never fires twice (also when skipped — nothing more to do).
      if (apply) {
        await fetch(`${SB_URL}/rest/v1/pa_appointments?id=eq.${encodeURIComponent(a.id)}`, {
          method: "PATCH", headers: { ...sb, Prefer: "return=minimal" },
          body: JSON.stringify({ followup_sent_at: new Date().toISOString() }),
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

async function sms(base, to, name, message) {
  try {
    const r = await fetch(`${base}/.netlify/functions/ghl-sms`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to, name, message }),
    });
    const j = await r.json().catch(() => ({}));
    return !!j.success;
  } catch { return false; }
}
async function sendEmail(base, to, subject, html) {
  try {
    const r = await fetch(`${base}/.netlify/functions/send-email`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to, subject, html }),
    });
    return r.ok;
  } catch { return false; }
}
function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function json(status, body) {
  return { statusCode: status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }, body: JSON.stringify(body) };
}
