// netlify/functions/payroll-signoff-run.js
//
// Morning nudge for the DAY that just finished.
//
//   8:00 AM ET daily  →  every department manager whose YESTERDAY is still
//                        unsigned gets a text + email with their sign-off link,
//                        naming anyone who never checked in or never filed a
//                        recap. A second pass at 11 AM re-pings whoever still
//                        hasn't signed.
//
// A department with no activity at all yesterday (a weekend, a shutdown) is
// skipped, so nobody gets chased for a day nothing happened.
//
// Sending reuses the app's own ghl-sms + send-email functions, same as crew
// onboarding. Employees are never texted here — the manager chases their own
// team, which is how the office asked for it.
//
// This is the WORKER — a plain HTTP function, NOT scheduled. Netlify returns 403
// for a manual call to a scheduled function, so the schedule lives in the thin
// wrapper cron-payroll-signoff, which calls this.
//
// Manual run:  GET /.netlify/functions/payroll-signoff-run?dry=1   (shows who
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

  const day = q.date || addDays(todayET(), -1);          // the day that just finished

  const [depts, emps, approvals, entries] = await Promise.all([
    get("payroll_departments?active=is.true&select=id,name,manager_employee_id"),
    get("payroll_employees?active=is.true&select=id,first_name,last_name,email,phone,department_id"),
    get(`payroll_week_approvals?week_start=eq.${day}&select=department_id,status`),
    get(`payroll_time_entries?work_date=eq.${day}&select=employee_id,day_type,checked_in_at,recap_at`),
  ]);
  const signed = new Set(approvals.filter((a) => a.status === "approved").map((a) => a.department_id));
  const byId = Object.fromEntries(emps.map((e) => [e.id, e]));
  const entryFor = Object.fromEntries(entries.map((e) => [e.employee_id, e]));

  const pinged = [], skipped = [];
  for (const d of depts) {
    if (signed.has(d.id)) { skipped.push({ department: d.name, why: "already signed off" }); continue; }
    const mgr = d.manager_employee_id ? byId[d.manager_employee_id] : null;
    if (!mgr) { skipped.push({ department: d.name, why: "no manager set — office needs to assign one" }); continue; }
    const team = emps.filter((e) => e.department_id === d.id);

    // Nothing logged by anyone: a weekend or a day off for that department.
    const touched = team.filter((e) => entryFor[e.id]);
    if (!touched.length && !force) { skipped.push({ department: d.name, why: `nothing logged on ${day} — nobody to sign for` }); continue; }

    const noShow = team.filter((e) => !entryFor[e.id]).map((e) => `${e.first_name} ${e.last_name}`.trim());
    const noRecap = team
      .filter((e) => entryFor[e.id]?.checked_in_at && !entryFor[e.id]?.recap_at)
      .map((e) => `${e.first_name} ${e.last_name}`.trim());

    const link = `${BASE}/?mode=timecard`;
    const bits = [];
    if (noShow.length) bits.push(`no check-in: ${noShow.slice(0, 6).join(", ")}${noShow.length > 6 ? ` +${noShow.length - 6}` : ""}`);
    if (noRecap.length) bits.push(`no recap: ${noRecap.slice(0, 6).join(", ")}${noRecap.length > 6 ? ` +${noRecap.length - 6}` : ""}`);
    const gaps = bits.length ? ` Gaps — ${bits.join("; ")}.` : " Everyone checked in and recapped.";

    // No URL in the text — US carriers block links on *.netlify.app (error
    // 30007). The email below carries the link.
    const sms = `US Shingle: ${d.name} hours for ${pretty(day)} need your sign-off.${gaps} Open your time card app to sign.`;
    const html =
      `<p>Good morning ${mgr.first_name},</p>` +
      `<p><b>${d.name}</b> hours for <b>${pretty(day)}</b> are waiting on your sign-off. Payroll runs off what you approve, so please review the day and sign it.</p>` +
      (bits.length
        ? `<p>Worth a look first:</p><ul>${noShow.length ? `<li>Never checked in: <b>${noShow.join(", ")}</b></li>` : ""}${noRecap.length ? `<li>Checked in but no recap: <b>${noRecap.join(", ")}</b></li>` : ""}</ul><p>You can fill those in for them on the sign-off screen.</p>`
        : `<p>Everyone on your team checked in and filed a recap.</p>`) +
      `<p><a href="${link}" style="display:inline-block;padding:12px 22px;background:#0f2a4a;color:#fff;text-decoration:none;border-radius:8px;font-weight:700;">Review &amp; sign off →</a></p>` +
      `<p style="color:#64748b;font-size:13px;">Open the Team tab, pick ${pretty(day)}, and sign.</p>`;

    if (dry) { pinged.push({ department: d.name, work_date: day, manager: `${mgr.first_name} ${mgr.last_name}`.trim(), phone: mgr.phone || null, email: mgr.email || null, no_checkin: noShow, no_recap: noRecap, dry: true }); continue; }
    const sent = { sms: false, email: false };
    if (mgr.phone) sent.sms = await postOk("ghl-sms", { to: mgr.phone, name: `${mgr.first_name} ${mgr.last_name}`.trim(), message: sms });
    if (mgr.email) sent.email = await postOk("send-email", { to: mgr.email, subject: `Sign off ${d.name} — ${pretty(day)}`, html });
    pinged.push({ department: d.name, work_date: day, manager: `${mgr.first_name} ${mgr.last_name}`.trim(), no_checkin: noShow, no_recap: noRecap, sent });
  }

  return out(200, { ok: true, work_date: day, dry, force, pinged, skipped });
};

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
