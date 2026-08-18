// netlify/functions/goback-book.js
//
// Backend for the homeowner's come-back-review booking page (?mode=gobackbook&t=<token>),
// the {link} in the Auto-Schedule-After-Inspection texts. Scoped entirely by the
// inspection's goback_token — the homeowner never sees an internal id.
//
//   POST { action:"load",  t }              → { ok, insp:{name,full,address,rep} }
//   POST { action:"slots", t }              → { ok, slots:[{start_at,label}] }
//   POST { action:"book",  t, start_at }    → { ok, booked }  (sets review_appt_at, drops a
//                                              JN appointment on the rep, texts the rep,
//                                              which stops the text sequence)
//
// Env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, JOBNIMBUS_API_KEY, URL

const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const sb = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" };
const JN_BASE = "https://app.jobnimbus.com/api1";
const JN_KEY = process.env.JOBNIMBUS_API_KEY;
const ORIGIN = (process.env.URL || "https://free-roof-inspections.netlify.app").replace(/\/$/, "");
// Company come-back hours by ET weekday (0=Sun). Mirrors the map's COMPANY_HOURS.
const HOURS = { 0: [], 1: [11, 14, 17, 19], 2: [11, 14, 17, 19], 3: [11, 14, 17, 19], 4: [11, 14, 17, 19], 5: [9, 12, 15], 6: [9, 12] };

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return cors(200, "");
  if (event.httpMethod !== "POST") return cors(405, JSON.stringify({ ok: false, error: "POST only" }));
  try {
    const body = JSON.parse(event.body || "{}");
    const action = String(body.action || "").trim();
    const t = String(body.t || "").trim();
    if (!t) return cors(400, JSON.stringify({ ok: false, error: "This link is missing its code — use the link from your text." }));
    const insp = (await sbGet(`inspections?goback_token=eq.${encodeURIComponent(t)}&select=id,client_name,address,city,state,zip,mobile,sales_rep_name,sales_rep_id,jn_job_id,review_appt_at,goback_opened_at,result&limit=1`))[0];
    if (!insp) return cors(404, JSON.stringify({ ok: false, error: "We couldn't find your inspection — please contact the office." }));

    // OPENED — stamp the first time the homeowner actually lands on their booking
    // page. "Contacted" only says a message left the building; this says they read
    // it and clicked. The gap between the two is the interesting number: opened and
    // did NOT book is a warm homeowner sitting there for a rep to call, and a rep
    // chasing those beats a rep chasing everyone. First open only — never overwrite,
    // so it stays the moment they first showed interest.
    if (!insp.goback_opened_at) {
      fetch(`${SB_URL}/rest/v1/inspections?id=eq.${encodeURIComponent(insp.id)}`, {
        method: "PATCH", headers: { ...sb, Prefer: "return=minimal" },
        body: JSON.stringify({ goback_opened_at: new Date().toISOString() }),
      }).catch(() => { /* never block the homeowner's page on analytics */ });
    }

    if (action === "load") {
      const first = (insp.client_name || "").trim().split(/\s+/)[0] || "there";
      return cors(200, JSON.stringify({ ok: true, insp: { name: first, full: insp.client_name || "", address: [insp.address, insp.city].filter(Boolean).join(", "), rep: insp.sales_rep_name || "your rep", booked_at: insp.review_appt_at || null } }));
    }
    if (action === "slots") {
      return cors(200, JSON.stringify({ ok: true, slots: buildSlots() }));
    }
    if (action === "book") {
      const startIso = String(body.start_at || "").trim();
      const startMs = Date.parse(startIso);
      if (!startMs || Number.isNaN(startMs)) return cors(400, JSON.stringify({ ok: false, error: "Pick a time first." }));
      if (insp.review_appt_at) return cors(200, JSON.stringify({ ok: true, already: true, booked: { start_at: insp.review_appt_at } }));
      // 1) Stamp the review appt — this is what STOPS the text sequence.
      await sbPatch(`inspections?id=eq.${encodeURIComponent(insp.id)}`, { review_appt_at: new Date(startMs).toISOString() });
      // 2) Drop a real JN Appointment on the rep so it lands on their calendar —
      //    the whole point is that a manager can SEE the rep is busy and doesn't
      //    hand them a company appointment on top of it.
      //
      //    This was missing `type: "task"` and `date_end`, and never looked at the
      //    response, so JN quietly took nothing and four booked homeowners never
      //    appeared on a calendar (Neal, 2026-08-18). Payload now matches
      //    damage-to-retail's, which does work.
      let apptWarning = null;
      try {
        if (JN_KEY && insp.jn_job_id) {
          const r = await createApptTask(insp, startMs);
          if (!r.ok) apptWarning = r.error;
        }
      } catch (e) { apptWarning = e.message || "JobNimbus appointment failed"; }
      // 3) Text the rep so they know it's on the calendar (best-effort).
      try {
        const rep = insp.sales_rep_id ? (await sbGet(`sales_reps?jobnimbus_id=eq.${encodeURIComponent(insp.sales_rep_id)}&select=phone,name&limit=1`))[0] : null;
        if (rep && rep.phone) {
          const when = new Date(startMs).toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
          await fetch(`${ORIGIN}/.netlify/functions/ghl-sms`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ to: rep.phone, name: rep.name || "Rep", message: `${insp.client_name || "A homeowner"} booked their come-back review for ${when} — ${[insp.address, insp.city].filter(Boolean).join(", ")}. It's on your JobNimbus + map.` }) });
        }
      } catch { /* best-effort */ }
      return cors(200, JSON.stringify({ ok: true, booked: { start_at: new Date(startMs).toISOString() }, appt_warning: apptWarning }));
    }
    return cors(400, JSON.stringify({ ok: false, error: `Unknown action: ${action}` }));
  } catch (e) {
    return cors(500, JSON.stringify({ ok: false, error: e.message || "error" }));
  }
};

// Next ~10 days of company slots (ET), future only (≥ 2h from now).
function buildSlots() {
  const out = [];
  const now = Date.now(), minMs = now + 2 * 60 * 60 * 1000;
  for (let d = 0; d < 11 && out.length < 40; d++) {
    const base = new Date(now + d * 24 * 60 * 60 * 1000);
    const p = tzParts(base);
    const wdET = etWeekday(+p.year, +p.month, +p.day);
    for (const h of HOURS[wdET] || []) {
      const dt = etWallToUTC(+p.year, +p.month, +p.day, h, 0);
      if (dt.getTime() < minMs) continue;
      out.push({ start_at: dt.toISOString(), label: dt.toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) });
    }
  }
  return out;
}

async function sbGet(path) { const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: sb }); if (!r.ok) return []; return r.json().catch(() => []); }
async function sbPatch(path, obj) { await fetch(`${SB_URL}/rest/v1/${path}`, { method: "PATCH", headers: { ...sb, Prefer: "return=minimal" }, body: JSON.stringify(obj) }); }
const TZ = "America/New_York";
function tzParts(date) { const dtf = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit" }); const p = {}; for (const x of dtf.formatToParts(date)) p[x.type] = x.value; return p; }
function offsetMs(date) { const p = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(date).reduce((a, x) => (a[x.type] = x.value, a), {}); return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - date.getTime(); }
function etWallToUTC(y, mo, d, h, mi) { const guess = Date.UTC(y, mo - 1, d, h, mi, 0); return new Date(guess - offsetMs(new Date(guess))); }
function etWeekday(y, mo, d) { return new Date(Date.UTC(y, mo - 1, d, 12, 0, 0)).getUTCDay(); }

// One hour, owned by the rep, related to the job. `type: "task"` and a date_end
// are both required for JN to put it on a calendar — without them the POST looks
// accepted and nothing shows up.

// "Come-Back Review Damage" / "Retail" / "No Damage" — a heads-up in the
// calendar entry itself.
const RESULT_LABEL = { damage: "Damage", retail: "Retail", no_damage: "No Damage" };
function apptTitle(insp) {
  const l = RESULT_LABEL[String(insp.result || "").toLowerCase()];
  return l ? `Come-Back Review ${l}` : "Come-Back Review";
}

const APPT_MIN = 60;
async function createApptTask(insp, startMs) {
  const endMs = startMs + APPT_MIN * 60000;
  const body = {
    record_type: 17, record_type_name: "Appointment", type: "task",
    // Put the RESULT in the name so the rep knows what they're walking into
    // before they open anything — a damage go-back and a no-damage go-back are
    // different visits (Neal, 2026-08-18).
    title: `${apptTitle(insp)} — ${insp.client_name || "homeowner"}`,
    date_start: Math.floor(startMs / 1000), date_end: Math.floor(endMs / 1000),
    related: [{ id: insp.jn_job_id, type: "job" }],
    ...(insp.sales_rep_id ? { owners: [{ id: insp.sales_rep_id }] } : {}),
    // JobNimbus hides API-created tasks from the calendar unless told not to.
    // Everything else about these was right — owner, type, times — and they
    // still appeared nowhere, which is exactly what Neal saw when he opened
    // Tim Rush's map and found no 11 AM appointment (2026-08-18).
    hide_from_calendarview: false,
  };
  const r = await fetch(`${JN_BASE}/tasks`, {
    method: "POST",
    headers: { Authorization: `bearer ${JN_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const txt = await r.text();
  if (!r.ok) return { ok: false, error: `JN ${r.status}: ${txt.slice(0, 160)}` };
  let j = {}; try { j = JSON.parse(txt); } catch { /* */ }
  return { ok: true, id: j.jnid || j.id || null };
}

function cors(status, body) { return { statusCode: status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" }, body }; }
