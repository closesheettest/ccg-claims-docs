// netlify/functions/cron-pa-missed-reschedule.js
//
// When a homeowner NO-SHOWS a PA appointment, text + email them a private link to
// reschedule themselves. Detects appointments whose time has passed by a few hours,
// are still "scheduled", have no sign outcome yet, and haven't already been sent a
// reschedule link — then fires pa-reschedule {action:"send"} once each.
// Runs 10am / 2pm / 6pm ET.
//
// Env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, URL

export const config = { schedule: "0 14,18,22 * * *" };

const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const sb = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` };
const BASE = (process.env.URL || process.env.PUBLIC_SITE_URL || "https://free-roof-inspections.netlify.app").replace(/\/$/, "");

function paPending(insp) {
  if (!insp) return true;
  let f = insp.pa_fields || {}; if (typeof f === "string") { try { f = JSON.parse(f); } catch { f = {}; } }
  const signup = String(f.pa_signup || "").toLowerCase();
  if (insp.pa_signed_at || insp.pa_status === "signed" || signup.startsWith("signed")) return false;
  if (insp.pa_status === "refused" || signup.includes("refus") || signup.includes("retail")) return false;
  return true;
}

export const handler = async () => {
  if (!SB_URL || !SB_KEY) return json(500, { ok: false, error: "Missing Supabase env" });
  try {
    const now = Date.now();
    const passedBy = new Date(now - 3 * 3600 * 1000).toISOString();   // missed by ≥ 3h
    const notOlderThan = new Date(now - 14 * 86400 * 1000).toISOString(); // within 2 weeks
    const auth = (await sbGet(`app_settings?key=eq.harvest_admin_token&select=value&limit=1`))[0]?.value || "";

    const appts = await sbGet(
      `pa_appointments?status=eq.scheduled&reschedule_sent_at=is.null` +
      `&start_at=lt.${encodeURIComponent(passedBy)}&start_at=gt.${encodeURIComponent(notOlderThan)}` +
      `&select=id,homeowner_phone,inspection_id&order=start_at.desc&limit=100`,
    );

    let sent = 0, skipped = 0;
    for (const a of appts) {
      // Only nudge if the deal has no sign outcome yet (a true no-show, not a signed/refused deal).
      let insp = null;
      if (a.inspection_id) insp = (await sbGet(`inspections?id=eq.${encodeURIComponent(a.inspection_id)}&select=pa_status,pa_signed_at,pa_fields&limit=1`))[0] || null;
      if (!paPending(insp)) { skipped++; continue; }
      if (!a.homeowner_phone) { skipped++; continue; } // nothing to text; office follows up
      const r = await fetch(`${BASE}/.netlify/functions/pa-reschedule`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "send", appt_id: a.id, auth }),
      }).then((x) => x.json()).catch(() => ({ ok: false }));
      if (r && r.ok && r.sent) sent++; else skipped++;
    }
    return json(200, { ok: true, candidates: appts.length, sent, skipped });
  } catch (e) {
    return json(500, { ok: false, error: e.message || "error" });
  }
};

async function sbGet(path) { const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: sb }); if (!r.ok) return []; return r.json().catch(() => []); }
function json(statusCode, obj) { return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) }; }
