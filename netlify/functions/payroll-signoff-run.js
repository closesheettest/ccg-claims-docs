// netlify/functions/payroll-signoff-run.js
//
// Evening sign-off reminder: each department manager is pinged once their
// department's LAST SHIFT HAS ENDED, to sign off the day that just finished.
//
// Not a fixed hour — the office finishes at 5, the warehouse night crew at 11,
// and an overnight shift finishes the next morning. Each department gets its own
// moment: the latest shift end among its people, plus a short grace period. The
// day being signed is the one those shifts belong to (a shift that runs through
// midnight is filed under the date it started, so the reminder still names the
// right day).
//
// Fires ONCE per department per day. The stamp lives on the approvals row
// (status "open", totals.reminded_at) — no extra table, and signing off
// overwrites it with the real totals. Departments with nothing logged that day
// are skipped, so weekends and shutdowns stay quiet.
//
// This is the WORKER — a plain HTTP function, NOT scheduled. Netlify returns 403
// for a manual call to a scheduled function, so the schedule lives in the thin
// wrapper cron-payroll-signoff, which calls this.
//
//   ?dry=1     show who WOULD be pinged, send nothing
//   ?date=…    pretend it's about that work date
//   ?force=1   ignore the "already reminded" and "nothing logged" guards
//
// Env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, URL.

const SB_URL = process.env.VITE_SUPABASE_URL;
// SERVICE KEY, not the anon key. The anon key ships in the public page bundle,
// so anything it can reach is world-readable — and once RLS is on for the
// payroll tables it can reach nothing here at all. Falls back to anon so this
// deploy is safe BEFORE the service key is set and RLS is enabled.
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_ANON_KEY;
const H = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" };
const TZ = "America/New_York";
const BASE = (process.env.URL || "https://free-roof-inspections.netlify.app").replace(/\/$/, "");
const MAIL_FROM_NAME = "U.S. Shingle Time Cards";

// How long after the last shift ends before the manager is asked to sign.
const GRACE_AFTER_SHIFT = 30;   // minutes
const WINDOW = 600;             // stop chasing this many minutes later (10h)

export const handler = async (event) => {
  const q = event?.queryStringParameters || {};
  const dry = q.dry === "1", force = q.force === "1";
  if (!SB_URL || !SB_KEY) return out(500, { ok: false, error: "Supabase env missing" });

  const now = nowET();
  const nowMin = mins(now.time);

  const [depts, emps, shifts] = await Promise.all([
    get("payroll_departments?active=is.true&select=id,name,manager_employee_id"),
    get("payroll_employees?active=is.true&select=id,first_name,last_name,email,phone,department_id,shift_id,passcode_set_at"),
    get("payroll_shifts?active=is.true&select=*"),
  ]);
  const byShift = Object.fromEntries(shifts.map((s) => [s.id, s]));
  const byId = Object.fromEntries(emps.map((e) => [e.id, e]));

  const pinged = [], skipped = [];
  for (const d of depts) {
    const team = emps.filter((e) => e.department_id === d.id);
    if (!team.length) { skipped.push({ department: d.name, why: "nobody in it" }); continue; }

    // When did this department's day finish, and which day was it?
    const due = q.date ? { work_date: q.date, ended: true } : dayJustFinished(team, byShift, now, nowMin);
    if (!due) { skipped.push({ department: d.name, why: "still on shift — nobody to sign for yet" }); continue; }
    const day = due.work_date;

    const mgr = d.manager_employee_id ? byId[d.manager_employee_id] : null;
    if (!mgr) { skipped.push({ department: d.name, work_date: day, why: "no manager set — office needs to assign one" }); continue; }

    const [appr, entries] = await Promise.all([
      get(`payroll_week_approvals?department_id=eq.${d.id}&week_start=eq.${day}&select=*&limit=1`),
      get(`payroll_time_entries?work_date=eq.${day}&employee_id=in.(${team.map((t) => t.id).join(",")})&select=employee_id,day_type,checked_in_at,recap_at`),
    ]);
    if (appr[0]?.status === "approved") { skipped.push({ department: d.name, work_date: day, why: "already signed off" }); continue; }
    if (appr[0]?.totals?.reminded_at && !force) { skipped.push({ department: d.name, work_date: day, why: "already reminded" }); continue; }
    if (!entries.length && !force) { skipped.push({ department: d.name, work_date: day, why: `nothing logged on ${day}` }); continue; }

    const entryFor = Object.fromEntries(entries.map((e) => [e.employee_id, e]));
    // Never chase somebody who has not even signed in yet — that is an onboarding
    // problem for the office, not something the manager can fix at sign-off time.
    const onboard = team.filter((e) => !e.passcode_set_at).map(nameOf);
    const live = team.filter((e) => e.passcode_set_at);
    const noShow = live.filter((e) => !entryFor[e.id]).map(nameOf);
    const noRecap = live.filter((e) => entryFor[e.id]?.checked_in_at && !entryFor[e.id]?.recap_at).map(nameOf);

    const link = `${BASE}/timecard`;
    const bits = [];
    if (noShow.length) bits.push(`no check-in: ${noShow.slice(0, 6).join(", ")}${noShow.length > 6 ? ` +${noShow.length - 6}` : ""}`);
    if (noRecap.length) bits.push(`no recap: ${noRecap.slice(0, 6).join(", ")}${noRecap.length > 6 ? ` +${noRecap.length - 6}` : ""}`);
    const gaps = bits.length ? ` Gaps - ${bits.join("; ")}.` : " Everyone checked in and recapped.";

    const sms = `US Shingle: ${d.name} is done for ${pretty(day)} - sign off the day.${gaps}\n\n${link.replace(/^https?:\/\//, "")}`;
    const html =
      `<p>Evening ${mgr.first_name},</p>` +
      `<p><b>${d.name}</b> has finished for <b>${pretty(day)}</b>. Payroll runs off what you approve, so please review the day and sign it.</p>` +
      (bits.length
        ? `<p>Worth a look first:</p><ul>${noShow.length ? `<li>Never checked in: <b>${noShow.join(", ")}</b></li>` : ""}${noRecap.length ? `<li>Checked in but no recap: <b>${noRecap.join(", ")}</b></li>` : ""}</ul><p>You can fill those in for them on the sign-off screen.</p>`
        : `<p>Everyone on your team checked in and filed a recap.</p>`) +
      (onboard.length ? `<p style="color:#b45309;">Not signed in to the app yet, so not counted above: <b>${onboard.join(", ")}</b>. The office can resend their invite.</p>` : "") +
      `<p><a href="${BASE}/?mode=timecard" style="display:inline-block;padding:12px 22px;background:#0f2a4a;color:#fff;text-decoration:none;border-radius:8px;font-weight:700;">Review &amp; sign off →</a></p>` +
      `<p style="color:#64748b;font-size:13px;">Open the Team tab, pick ${pretty(day)}, and sign.</p>`;

    if (dry) {
      pinged.push({ department: d.name, work_date: day, shift_ended: due.ended_at || null, manager: nameOf(mgr), phone: mgr.phone || null, email: mgr.email || null, no_checkin: noShow, no_recap: noRecap, not_onboarded: onboard, dry: true });
      continue;
    }
    // Stamp first, so a double invocation can't send twice.
    await upsertApproval(d.id, day, appr[0]);
    const sent = { sms: false, email: false };
    if (mgr.phone) sent.sms = await postOk("ghl-sms", { to: mgr.phone, name: nameOf(mgr), message: sms });
    if (mgr.email) sent.email = await postOk("send-email", { to: mgr.email, subject: `Sign off ${d.name} - ${pretty(day)}`, html, fromName: MAIL_FROM_NAME });
    pinged.push({ department: d.name, work_date: day, manager: nameOf(mgr), no_checkin: noShow, no_recap: noRecap, not_onboarded: onboard, sent });
  }

  return out(200, { ok: true, now, dry, force, pinged, skipped });
};

// The department's day is over when EVERY shift its people are on has ended
// (plus a grace period). Returns the work date those shifts belonged to.
function dayJustFinished(team, byShift, now, nowMin) {
  let latestEnd = null, workDate = null;
  for (const e of team) {
    const sh = byShift[e.shift_id];
    if (!sh) continue;
    // Minutes from "now" back to when this person's shift ended.
    const sinceEnd = wrap(nowMin - mins(sh.end_time));
    const ended = sinceEnd >= GRACE_AFTER_SHIFT && sinceEnd <= WINDOW;
    if (!ended) return null;                       // somebody is still on shift
    // Which day did the shift that just ended belong to? Work back from the END
    // moment, not from "now": a 6pm-6am shift ending at 6am is YESTERDAY's day,
    // and an evening shift ending at 11pm is still yesterday's once it's past
    // midnight.
    const endedOn = (nowMin - sinceEnd < 0) ? addDays(now.date, -1) : now.date;
    const wd = crossesMidnight(sh) ? addDays(endedOn, -1) : endedOn;
    if (latestEnd === null || sinceEnd < latestEnd) { latestEnd = sinceEnd; workDate = wd; }
  }
  if (workDate === null) return null;              // nobody has a shift assigned
  return { work_date: workDate, ended_at: latestEnd };
}

async function upsertApproval(deptId, day, existing) {
  await fetch(`${SB_URL}/rest/v1/payroll_week_approvals?on_conflict=department_id,week_start`, {
    method: "POST", headers: { ...H, Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({
      department_id: deptId, week_start: day, status: "open",
      totals: { ...(existing?.totals || {}), reminded_at: new Date().toISOString() },
      updated_at: new Date().toISOString(),
    }),
  }).catch(() => null);
}

// Netlify reads the schedule from the thin wrapper (cron-payroll-signoff).
const nameOf = (e) => `${e.first_name} ${e.last_name}`.trim();
function wrap(m) { return ((m % 1440) + 1440) % 1440; }
function mins(t) { const [h, m] = String(t || "0:0").split(":").map(Number); return (h || 0) * 60 + (m || 0); }
function crossesMidnight(sh) { return String(sh.end_time) <= String(sh.start_time); }
function nowET() {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date()).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}
function addDays(s, n) { const d = new Date(`${s}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function pretty(s) { const [, m, d] = String(s).split("-"); return `${+m}/${+d}`; }

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
function out(status, body) { return { statusCode: status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }, body: JSON.stringify(body) }; }
