// netlify/functions/sync-inspectors-from-jn.js
//
// Pull the full JN user list and upsert each one as an inspector in our
// Supabase `inspectors` table. Single-source-of-truth model: JN owns
// the inspector identity (name + email + JN user id); we enrich each
// row with home base address/lat/lng + max-miles cap on our side.
//
// Upsert key: jn_user_id. New users get inserted with active=false
// (so they don't show up in routing until manager activates them AND
// they've completed setup). Existing rows have their name + email
// refreshed but NOT their active flag or address/lat/lng — those are
// manager + inspector controlled.
//
// POST (no body needed; optionally { dry_run: true })
// Response: { ok, total_jn_users, inserted, updated, skipped, items: [...] }
//
// Required env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY,
//               JOBNIMBUS_API_KEY.

exports.handler = async (event) => {
  if (event.httpMethod !== "POST" && event.httpMethod !== "GET") {
    return json(405, { ok: false, error: "Method not allowed" });
  }

  const missing = [];
  for (const k of ["VITE_SUPABASE_URL", "VITE_SUPABASE_ANON_KEY", "JOBNIMBUS_API_KEY"]) {
    if (!process.env[k]) missing.push(k);
  }
  if (missing.length) return json(500, { ok: false, error: `Missing env: ${missing.join(", ")}` });

  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch {}
  const dryRun = !!body.dry_run;

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
  const JN_KEY = process.env.JOBNIMBUS_API_KEY;

  // 1. Fetch JN users.
  const jnRes = await fetch("https://app.jobnimbus.com/api1/account/users", {
    headers: { Authorization: `bearer ${JN_KEY}`, "Content-Type": "application/json" },
  });
  if (!jnRes.ok) {
    const detail = await jnRes.text().then((t) => t.slice(0, 300));
    return json(500, { ok: false, error: `JN /users returned ${jnRes.status}`, detail });
  }
  const jnData = await jnRes.json().catch(() => ({}));
  const users = (jnData.users || []).filter((u) => u.is_active !== false);

  // 2. Pull existing inspectors so we can decide insert vs update.
  const sbHeaders = {
    apikey: SB_KEY,
    Authorization: `Bearer ${SB_KEY}`,
    "Content-Type": "application/json",
  };
  const exRes = await fetch(`${SB_URL}/rest/v1/inspectors?select=id,jn_user_id,name,email`, { headers: sbHeaders });
  if (!exRes.ok) {
    return json(500, { ok: false, error: `Could not fetch inspectors: ${await exRes.text()}` });
  }
  const existing = await exRes.json();
  const existingById = new Map(existing.filter((i) => i.jn_user_id).map((i) => [i.jn_user_id, i]));

  const items = [];
  let inserted = 0;
  let updated = 0;
  let skipped = 0;
  for (const u of users) {
    const name = `${u.first_name || ""} ${u.last_name || ""}`.trim();
    if (!name) {
      skipped++;
      items.push({ jn_user_id: u.id, action: "skipped — no name" });
      continue;
    }
    const matched = existingById.get(u.id);
    if (matched) {
      // Refresh name + email only. Don't touch active/address/lat/lng.
      if (!dryRun) {
        const upd = await fetch(`${SB_URL}/rest/v1/inspectors?id=eq.${matched.id}`, {
          method: "PATCH",
          headers: sbHeaders,
          body: JSON.stringify({ name, email: u.email || null }),
        });
        if (!upd.ok) {
          items.push({ jn_user_id: u.id, action: "update_error", detail: (await upd.text()).slice(0, 200) });
          continue;
        }
      }
      updated++;
      items.push({ jn_user_id: u.id, name, action: "updated" });
    } else {
      // Insert new — active=false so routing doesn't include them
      // until manager flips active AND they complete setup.
      if (!dryRun) {
        const ins = await fetch(`${SB_URL}/rest/v1/inspectors`, {
          method: "POST",
          headers: sbHeaders,
          body: JSON.stringify({
            name,
            jn_user_id: u.id,
            email: u.email || null,
            active: false,
          }),
        });
        if (!ins.ok) {
          items.push({ jn_user_id: u.id, action: "insert_error", detail: (await ins.text()).slice(0, 200) });
          continue;
        }
      }
      inserted++;
      items.push({ jn_user_id: u.id, name, action: "inserted (inactive — needs setup)" });
    }
  }

  return json(200, {
    ok: true,
    dry_run: dryRun,
    total_jn_users: users.length,
    inserted,
    updated,
    skipped,
    items,
  });
};

function json(status, body) {
  return {
    statusCode: status,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}
