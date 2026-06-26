// netlify/functions/cron-sync-repcard-pins.js
//
// WEEKLY: push NEW CCG installs into RepCard as "Installed" map pins, so reps
// canvassing a street can see "we installed your neighbor" + what we put on.
//
// RepCard's API can CREATE but can't dedup/search/delete, so we track pushed
// state on OUR side: installs.repcard_pushed_at. Rows with it NULL get pushed,
// then stamped, so they're never re-created (no duplicates). The installs table
// itself is kept fresh nightly from JobNimbus by cron-sync-installs; new jobs
// arrive with repcard_pushed_at NULL and this picks them up the following week.
//
// ── ONE-TIME SETUP (run once in the CCG Supabase SQL editor) ──
//   ALTER TABLE installs ADD COLUMN IF NOT EXISTS repcard_pushed_at timestamptz;
// Then seed the ~1,539 already-pushed pins so they're NOT re-created:
//   GET /.netlify/functions/cron-sync-repcard-pins?seed=1
//
// ── USAGE ──
//   ?dry_run=1   preview how many NEW installs would push (no writes)
//   ?seed=1      mark ALL current installs as already-pushed (no RepCard writes) — run ONCE
//   (no param)   push new installs to RepCard + stamp them
//   ?force=1     bypass the unseeded-safety guard (only if you mean it)
//
// Runs weekly (Mon ~4 AM ET). Env: REPCARD_API_KEY, VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY.

const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const sb = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" };
const RK = process.env.REPCARD_API_KEY;

// RepCard pin config — locked in 2026-06-26 (see project_repcard_install_pins memory).
// Pins are LEAD type so they show on the canvassing map; owned by Dewayne to match
// the rest of the field leads.
const RC_TYPE = 1;                       // Lead
const RC_STATUS_ID = 4599233;            // "Installed" status (a Lead status, green)
const RC_OWNER_EMAIL = "dewayne@shingleusa.com";
const MAX_PER_RUN = 400;                 // safety cap; real weekly volume is far lower
const SAFETY_GUARD = 600;                // if more than this look "new", assume not seeded → abort

exports.handler = async (event) => {
  if (!RK || !SB_URL || !SB_KEY) return json(500, { ok: false, error: "env missing" });
  const p = (event && event.queryStringParameters) || {};
  const dryRun = isYes(p.dry_run);
  const seed = isYes(p.seed);
  const force = isYes(p.force);

  try {
    // SEED mode: stamp every current install as already-pushed, create nothing.
    // Run once after the ALTER TABLE so the 1,539 existing pins aren't duplicated.
    if (seed) {
      const r = await fetch(`${SB_URL}/rest/v1/installs?repcard_pushed_at=is.null`, {
        method: "PATCH", headers: { ...sb, Prefer: "return=headers-only,count=exact" },
        body: JSON.stringify({ repcard_pushed_at: new Date().toISOString() }),
      });
      if (!r.ok) return json(502, { ok: false, error: `seed ${r.status}: ${(await r.text()).slice(0, 200)}`, hint: "Run: ALTER TABLE installs ADD COLUMN IF NOT EXISTS repcard_pushed_at timestamptz;" });
      const cr = r.headers.get("content-range") || "";
      return json(200, { ok: true, seeded: true, marked_pushed: cr, note: "All current installs marked as already-in-RepCard. Future new installs will sync." });
    }

    // Find NEW installs: have coords, not yet pushed.
    const q = `${SB_URL}/rest/v1/installs?select=jnid,address_line,city,product_type,color,latitude,longitude` +
      `&repcard_pushed_at=is.null&latitude=not.is.null&longitude=not.is.null&limit=${MAX_PER_RUN}`;
    const r = await fetch(q, { headers: sb });
    if (!r.ok) return json(502, { ok: false, error: `read ${r.status}: ${(await r.text()).slice(0, 200)}`, hint: "Did you ALTER TABLE installs ADD COLUMN repcard_pushed_at?" });
    const rows = await r.json();

    if (dryRun) {
      return json(200, { ok: true, dry_run: true, would_push: rows.length, sample: rows.slice(0, 5).map((x) => `${x.product_type} ${x.color || ""} @ ${x.address_line}`) });
    }

    // Safety: a huge batch almost always means the seed step was skipped.
    // Refuse to mass-create duplicates unless explicitly forced.
    if (rows.length > SAFETY_GUARD && !force) {
      return json(409, { ok: false, aborted: true, would_push: rows.length, hint: `That many 'new' installs looks unseeded — run ?seed=1 first (so existing pins aren't duplicated), or ?force=1 if you really mean it.` });
    }

    let pushed = 0, failed = 0;
    for (const row of rows) {
      const prod = (row.product_type || "Install").trim();
      const color = (row.color || "").trim();
      const body = {
        type: RC_TYPE, statusId: RC_STATUS_ID, userEmail: RC_OWNER_EMAIL,
        firstName: prod, lastName: color || "—",
        latitude: row.latitude, longitude: row.longitude,
        address: (row.address_line || "").trim(), city: (row.city || "").trim(), state: "FL",
        notes: `U.S. Shingle install — ${prod}${color ? " · " + color : ""}`,
      };
      let ok = false;
      try {
        const cr = await fetch("https://app.repcard.com/api/customers", {
          method: "POST", headers: { "x-api-key": RK, "Content-Type": "application/json" }, body: JSON.stringify(body),
        });
        ok = cr.ok;
      } catch (e) { ok = false; }
      if (ok) {
        // Stamp it so it's never re-created, even if this run dies mid-way.
        await fetch(`${SB_URL}/rest/v1/installs?jnid=eq.${encodeURIComponent(row.jnid)}`, {
          method: "PATCH", headers: { ...sb, Prefer: "return=minimal" }, body: JSON.stringify({ repcard_pushed_at: new Date().toISOString() }),
        });
        pushed++;
      } else { failed++; }
      await sleep(300);
    }
    return json(200, { ok: true, pushed, failed, scanned: rows.length });
  } catch (e) {
    return json(500, { ok: false, error: e.message || "error" });
  }
};

// Weekly: Monday 08:00 UTC (~4 AM ET).
exports.config = { schedule: "0 8 * * 1" };

function isYes(v) { return /^(1|true|yes)$/i.test(String(v || "")); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function json(status, body) { return { statusCode: status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" }, body: JSON.stringify(body) }; }
