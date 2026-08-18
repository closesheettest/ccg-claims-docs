// netlify/functions/cron-payroll-signoff.js
//
// Monday-morning nudge for the payroll week that just closed.
//
//   8:00 AM ET Monday  →  every department manager whose LAST week is still
//                         unsigned gets a text + email with their sign-off link,
//                         and anyone on their team who never marked their week
//                         done is named in it.
//   A second pass at the config's signoff_deadline_hour (default 11 AM ET)
//   re-pings only the managers who still haven't signed.
//
// Sending reuses the app's own ghl-sms + send-email functions, same as crew
// onboarding. Employees are never texted here — the manager chases their own
// team, which is how the office asked for it.
//
// Manual run:  GET /.netlify/functions/cron-payroll-signoff?dry=1   (shows who
// WOULD be pinged without sending), or ?force=1 to send off-schedule.
//
// Env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, URL.

const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const H = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" };
const TZ = "America/New_York";
const BASE = (process.env.URL || "https://free-roof-inspections.netlify.app").replace(/\/$/, "");

export const handler = async (event) => {
  const q = event?.queryStringParameters || {};
  const dry = q.dry === "1", force = q.force === "1";
  if (!SB_URL || !SB_KEY) return out(500, { ok: false, error: "Supabase env missing" });

  const ws = addDays(weekStart(todayET()), -7);          // the week that just closed
  const we = addDays(ws, 6);

  const [depts, emps, approvals, submits] = await Promise.all([
    get("payroll_departments?active=is.true&select=id,name,manager_employee_id"),
    get("payroll_employees?active=is.true&select=id,first_name,last_name,email,phone,department_id"),
    get(`payroll_week_approvals?week_start=eq.${ws}&select=department_id,status`),
    get(`payroll_week_submits?week_start=eq.${ws}&select=employee_id`),
  ]);
  const signed = new Set(approvals.filter((a) => a.status === "approved").map((a) => a.department_id));
  const submitted = new Set(submits.map((s) => s.employee_id));
  const byId = Object.fromEntries(emps.map((e) => [e.id, e]));

  const pinged = [], skipped = [];
  for (const d of depts) {
    if (signed.has(d.id)) { skipped.push({ department: d.name, why: "already signed off" }); continue; }
    const mgr = d.manager_employee_id ? byId[d.manager_employee_id] : null;
    if (!mgr) { skipped.push({ department: d.name, why: "no manager set — office needs to assign one" }); continue; }
    const team = emps.filter((e) => e.department_id === d.id);
    const nudge = team.filter((e) => !submitted.has(e.id)).map((e) => `${e.first_name} ${e.last_name}`.trim());

    const link = `${BASE}/?mode=timecard`;
    const range = `${pretty(ws)}–${pretty(we)}`;
    const missing = nudge.length ? ` Still waiting on: ${nudge.slice(0, 8).join(", ")}${nudge.length > 8 ? ` +${nudge.length - 8} more` : ""}.` : " Everyone on your team has marked their week done.";
    const sms = `US Shingle payroll: ${d.name} hours for ${range} need your sign-off this morning.${missing} Sign off: ${link}`;
    const html =
      `<p>Good morning ${mgr.first_name},</p>` +
      `<p><b>${d.name}</b> hours for <b>${range}</b> are waiting on your sign-off. Payroll runs off what you approve, so please review the week and sign it this morning.</p>` +
      `<p>${nudge.length ? `Team members who haven't marked their week done yet: <b>${nudge.join(", ")}</b>. You can fill their days in for them on the sign-off screen.` : `Everyone on your team has marked their week done.`}</p>` +
      `<p><a href="${link}" style="display:inline-block;padding:12px 22px;background:#0f2a4a;color:#fff;text-decoration:none;border-radius:8px;font-weight:700;">Review &amp; sign off →</a></p>` +
      `<p style="color:#64748b;font-size:13px;">Or open ${link} and go to the Team tab.</p>`;

    if (dry) { pinged.push({ department: d.name, manager: `${mgr.first_name} ${mgr.last_name}`.trim(), phone: mgr.phone || null, email: mgr.email || null, waiting_on: nudge, dry: true }); continue; }
    const sent = { sms: false, email: false };
    if (mgr.phone) sent.sms = await postOk("ghl-sms", { to: mgr.phone, name: `${mgr.first_name} ${mgr.last_name}`.trim(), message: sms });
    if (mgr.email) sent.email = await postOk("send-email", { to: mgr.email, subject: `Sign off ${d.name} hours — week of ${pretty(ws)}`, html });
    pinged.push({ department: d.name, manager: `${mgr.first_name} ${mgr.last_name}`.trim(), waiting_on: nudge, sent });
  }

  return out(200, { ok: true, week_start: ws, week_end: we, dry, force, pinged, skipped });
};

// Netlify reads this too; netlify.toml carries the same cadence (this project
// registers crons from the toml — the in-file config alone has not been enough).
export const config = { schedule: "0 12,15 * * 1" };   // 8 AM + 11 AM ET Mondays

async function postOk(fn, body) {
  try {
    const r = await fetch(`${BASE}/.netlify/functions/${fn}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return r.ok;
  } catch { return false; }
}
async function get(path) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: H });
  if (!r.ok) return [];
  return r.json().catch(() => []);
}
function todayET() { return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()); }
function asDate(s) { return new Date(`${s}T12:00:00Z`); }
function addDays(s, n) { const d = asDate(s); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function weekStart(s) { const dow = asDate(s).getUTCDay(); return addDays(s, dow === 0 ? -6 : 1 - dow); }
function pretty(s) { const [y, m, d] = s.split("-"); return `${+m}/${+d}`; }
function out(status, body) { return { statusCode: status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }, body: JSON.stringify(body) }; }
