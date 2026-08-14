// netlify/functions/review-verify.js
//
// The regional-manager review-verification queue (feeds the TMS /regional-manager
// page's "Reviews to verify" panel) + the approve/reject action.
//
//   GET  ?zone=Zone%201                          → { ok, zone, reviews:[…today's pending…] }
//   POST { action:"approve"|"reject", id, zone, verified_by } → { ok }
//
// Only reviews SENT TODAY (ET) are actionable — the contest awards the point only on
// same-day verification, so older pending reviews are moot and drop off on their own.
// Rep→zone is resolved via TMS rep-zones (same bridge the contest + team map use), so
// a manager sees only their own team's reviews. Zone-scoped, no secret — same posture
// as the sibling zone-* endpoints the manager page already calls. CORS open.
//
// Env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY

const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const sb = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" };
const TMS_REP_ZONES_URL = "https://trainingmanagementsys.netlify.app/.netlify/functions/rep-zones";

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return cors(200, "");
  if (!SB_URL || !SB_KEY) return cors(500, { ok: false, error: "env missing" });

  try {
    if (event.httpMethod === "GET") {
      const zone = String((event.queryStringParameters || {}).zone || "").trim();
      if (!zone) return cors(400, { ok: false, error: "zone required" });
      const allow = await zoneRepSet(zone);
      // ONLY today's pending reviews (ET). A review can only earn its point if confirmed
      // the SAME DAY it was sent — so once the day is over, an unconfirmed review is dead
      // and drops off this list automatically (no stale rows to accidentally approve).
      const since = etTodayStartISO();
      const rows = await sbGet(
        `review_verifications?status=eq.pending&sent_at=gte.${encodeURIComponent(since)}` +
        `&select=id,rep_name,homeowner_name,homeowner_phone,sent_at&order=sent_at.desc`
      );
      const reviews = rows.filter((r) => allow.has(normalizeName(r.rep_name || "")));
      // Reps often leave the name blank — fill it from JobNimbus by phone (and cache it
      // back) so the manager sees a real homeowner name instead of "Homeowner".
      await enrichNames(reviews);
      return cors(200, { ok: true, zone, reviews });
    }

    if (event.httpMethod === "POST") {
      const body = JSON.parse(event.body || "{}");
      const action = body.action === "reject" ? "reject" : body.action === "approve" ? "approve" : null;
      const id = String(body.id || "").trim();
      const zone = String(body.zone || "").trim();
      if (!action || !id || !zone) return cors(400, { ok: false, error: "action, id, zone required" });

      // Authorize: the review's rep must be on this manager's team.
      const found = await sbGet(`review_verifications?id=eq.${encodeURIComponent(id)}&select=id,rep_name,status&limit=1`);
      const rv = found[0];
      if (!rv) return cors(404, { ok: false, error: "review not found" });
      const allow = await zoneRepSet(zone);
      if (!allow.has(normalizeName(rv.rep_name || ""))) return cors(403, { ok: false, error: "not your team's review" });

      const status = action === "approve" ? "approved" : "rejected";
      const r = await fetch(`${SB_URL}/rest/v1/review_verifications?id=eq.${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { ...sb, Prefer: "return=minimal" },
        body: JSON.stringify({ status, verified_by: String(body.verified_by || "Regional Manager").slice(0, 120), verified_at: new Date().toISOString() }),
      });
      if (!r.ok) return cors(500, { ok: false, error: "update failed" });
      return cors(200, { ok: true, status });
    }

    return cors(405, { ok: false, error: "method" });
  } catch (e) {
    return cors(500, { ok: false, error: e.message || "error" });
  }
};

// zone → Set of normalized rep names on that team (via TMS rep-zones).
async function zoneRepSet(zone) {
  let reps = [];
  try { const res = await fetch(TMS_REP_ZONES_URL); if (res.ok) reps = (await res.json()).reps || []; } catch { /* best-effort */ }
  const set = new Set();
  for (const r of reps) {
    if (!r.name || r.zone !== zone || r.active === false) continue;
    set.add(normalizeName(r.name));
  }
  return set;
}

async function sbGet(path) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: sb });
  if (!r.ok) return [];
  return r.json().catch(() => []);
}

// Fill any missing homeowner_name from JobNimbus (by phone), mutate the rows in place,
// and cache the name back so we never look it up twice. Capped + best-effort.
const JN_KEY = process.env.JOBNIMBUS_API_KEY;
async function enrichNames(reviews) {
  const need = reviews.filter((r) => !r.homeowner_name && r.homeowner_phone).slice(0, 25);
  await Promise.all(need.map(async (r) => {
    const nm = await jnNameByPhone(r.homeowner_phone);
    if (!nm) return;
    r.homeowner_name = nm;
    fetch(`${SB_URL}/rest/v1/review_verifications?id=eq.${encodeURIComponent(r.id)}`, {
      method: "PATCH", headers: { ...sb, Prefer: "return=minimal" }, body: JSON.stringify({ homeowner_name: nm }),
    }).catch(() => {});
  }));
}
async function jnNameByPhone(phone) {
  if (!JN_KEY) return null;
  const d = String(phone || "").replace(/\D/g, "").slice(-10);
  if (d.length !== 10) return null;
  const fmt = `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
  for (const field of ["mobile_phone", "home_phone"]) {
    for (const val of [d, fmt]) {
      try {
        const flt = encodeURIComponent(JSON.stringify({ must: [{ term: { [field]: val } }] }));
        const r = await fetch(`https://app.jobnimbus.com/api1/contacts?size=1&filter=${flt}`, { headers: { Authorization: `bearer ${JN_KEY}` } });
        const j = await r.json().catch(() => ({}));
        const c = (j.results || [])[0];
        if (c) { const nm = c.display_name || `${c.first_name || ""} ${c.last_name || ""}`.trim(); if (nm) return nm; }
      } catch { /* try next */ }
    }
  }
  return null;
}
function normalizeName(s) {
  return String(s || "").toLowerCase()
    .replace(/["“”]([^"“”]*)["“”]/g, "").replace(/'([^']*)'/g, "").replace(/\(([^)]*)\)/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
}
// Start of today in America/New_York, as an ISO instant.
function etTodayStartISO() {
  const now = new Date();
  const dtf = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const p = {}; for (const part of dtf.formatToParts(now)) p[part.type] = part.value;
  const guessUTC = Date.UTC(+p.year, +p.month - 1, +p.day, 0, 0, 0);
  // offset between ET wall-time and UTC at this moment
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  const offset = asUTC - now.getTime();
  return new Date(guessUTC - offset).toISOString();
}
function cors(status, body) {
  return { statusCode: status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" }, body: typeof body === "string" ? body : JSON.stringify(body) };
}
