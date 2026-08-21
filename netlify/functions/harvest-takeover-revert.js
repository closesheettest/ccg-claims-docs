// netlify/functions/harvest-takeover-revert.js
//
// Put back doors that an IQ scan took over.
//
// The IQ-always-wins rule reopens a door whatever it used to be. If the field
// says the map has gone mad, this puts those exact pins back to what they were
// — not a guess, and not a rollback of anything else (Neal, 2026-08-21).
//
//   GET  ?since=<ISO|YYYY-MM-DD>            → DRY RUN: what would be put back
//   GET  ?since=…&apply=1                   → put them back
//   GET  ?run=<ISO>&apply=1                 → just that one sync run
//   GET  ?status=1                          → what's been taken over lately
//
// Only rows not already reverted are touched, and each is marked reverted_at as
// it goes, so running it twice can't double-apply. A pin whose status has moved
// on since the takeover (a rep worked it) is LEFT ALONE and reported — putting
// it back would undo the rep's own work, which is the thing we're protecting.
//
// Requires sql/harvest_takeovers.sql. Env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY.

const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const sb = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" };

export const handler = async (event) => {
  if (!SB_URL || !SB_KEY) return json(500, { ok: false, error: "env missing" });
  const qp = event.queryStringParameters || {};
  const apply = /^(1|true|yes)$/i.test(String(qp.apply || ""));

  try {
    if (/^(1|true|yes)$/i.test(String(qp.status || ""))) {
      const rows = await sbGet(`harvest_takeovers?select=run_at,source,prev_status,new_status,reverted_at&order=run_at.desc&limit=2000`);
      const runs = {}; const prev = {};
      for (const r of rows) {
        const k = String(r.run_at).slice(0, 16);
        runs[k] = (runs[k] || 0) + 1;
        prev[r.prev_status || "(none)"] = (prev[r.prev_status || "(none)"] || 0) + 1;
      }
      return json(200, { ok: true, total: rows.length, reverted: rows.filter((r) => r.reverted_at).length, by_run: runs, from_status: prev });
    }

    let q = `harvest_takeovers?reverted_at=is.null&select=id,pin_id,prev_status,prev_status_by,prev_status_at,new_status,address,city,run_at&order=run_at.desc&limit=5000`;
    if (qp.run) q += `&run_at=eq.${encodeURIComponent(qp.run)}`;
    else if (qp.since) q += `&run_at=gte.${encodeURIComponent(qp.since.length === 10 ? `${qp.since}T00:00:00Z` : qp.since)}`;
    else return json(400, { ok: false, error: "since= or run= required (or status=1)" });

    const rows = await sbGet(q);
    if (!rows.length) return json(200, { ok: true, found: 0, note: "Nothing to put back." });

    // Only revert a pin that STILL holds what the takeover gave it. If a rep has
    // worked it since, their call stands.
    const ids = rows.map((r) => r.pin_id);
    const live = {};
    for (let i = 0; i < ids.length; i += 200) {
      for (const p of await sbGet(`canvass_prospects?id=in.(${ids.slice(i, i + 200).join(",")})&select=id,status`)) live[p.id] = p.status;
    }
    const doable = rows.filter((r) => live[r.pin_id] === r.new_status);
    const moved = rows.filter((r) => live[r.pin_id] && live[r.pin_id] !== r.new_status);
    const gone = rows.filter((r) => !live[r.pin_id]);

    if (!apply) {
      return json(200, {
        ok: true, dry_run: true, found: rows.length,
        would_revert: doable.length, skipped_rep_moved_on: moved.length, pin_no_longer_exists: gone.length,
        sample: doable.slice(0, 15).map((r) => ({ address: r.address, city: r.city, back_to: r.prev_status, from: r.new_status })),
      });
    }

    let done = 0;
    for (const r of doable) {
      const ok1 = await patch(`canvass_prospects?id=eq.${r.pin_id}`, {
        status: r.prev_status, status_by: r.prev_status_by || "takeover reverted", status_updated_at: r.prev_status_at || new Date().toISOString(),
      });
      if (!ok1) continue;
      await patch(`harvest_takeovers?id=eq.${r.id}`, { reverted_at: new Date().toISOString() });
      done++;
    }
    // Pins the rep has moved on are closed out too — there is nothing to put
    // back, and leaving them open would re-offer them on every future revert.
    for (const r of moved) await patch(`harvest_takeovers?id=eq.${r.id}`, { reverted_at: new Date().toISOString() });

    return json(200, { ok: true, reverted: done, skipped_rep_moved_on: moved.length, pin_no_longer_exists: gone.length });
  } catch (e) {
    return json(500, { ok: false, error: e.message || "error" });
  }
};

async function sbGet(path) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: sb });
  if (!r.ok) throw new Error(`Supabase ${r.status}: ${(await r.text()).slice(0, 160)}`);
  return r.json();
}
async function patch(path, body) {
  try {
    const r = await fetch(`${SB_URL}/rest/v1/${path}`, { method: "PATCH", headers: { ...sb, Prefer: "return=minimal" }, body: JSON.stringify(body) });
    return r.ok;
  } catch { return false; }
}
function json(statusCode, body) {
  return { statusCode, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }, body: JSON.stringify(body) };
}
