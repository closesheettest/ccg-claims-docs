// netlify/functions/cron-sitsold-reconcile.js
//
// Daily safety net for the "JN says needs-inspection but our app already
// finished it" drift (the 42-vs-25 gap). Every JN job still at "Sit Sold Insp"
// is checked against our inspections table:
//
//   • our result is LOST              → re-push (sets JN status = Lost + note)
//   • our result is set (damage/
//     no_damage/retail) but the JN
//     cf_string_34 result is EMPTY    → re-push (stamps result + inspected date)
//   → both self-heal by calling push-result-to-jn, so completed jobs leave the
//     needs-inspection list automatically.
//
// Anything it can't auto-heal — a Sit-Sold-Insp JN job with NO inspections row
// (a duplicate JN job or a true JN-only entry, TEST rows excluded) — is texted
// to ADMIN_ALERT_PHONE so a human can dedupe / create the record.
//
// Schedule: daily. Manual GET = dry run (no JN writes, no SMS) unless ?apply=1.
// Env: JOBNIMBUS_API_KEY, VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY,
//      ADMIN_ALERT_PHONE, URL.

const JN_BASE = "https://app.jobnimbus.com/api1";
const JN_KEY = process.env.JOBNIMBUS_API_KEY;
const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const STATUS = "Sit Sold Insp";
const HEAL_CAP = 40; // max re-pushes per run (JN-call budget guard)
const jnHeaders = { Authorization: `bearer ${JN_KEY}`, "Content-Type": "application/json" };
const sb = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` };

exports.handler = async (event) => {
  if (!JN_KEY || !SB_URL || !SB_KEY) return json(500, { ok: false, error: "Missing env" });
  const qp = (event && event.queryStringParameters) || {};
  const isManual = event && event.httpMethod === "GET";
  const apply = isManual ? ["1", "true", "yes"].includes(String(qp.apply || "").toLowerCase()) : true;
  const base = process.env.URL || process.env.DEPLOY_URL || process.env.PUBLIC_SITE_URL || "";

  try {
    const jobs = await fetchStatusJobs(STATUS);
    const byJnid = {};
    for (const j of jobs) { const id = j.jnid || j.id; if (id) byJnid[id] = j; }
    const jnids = Object.keys(byJnid);

    // Our inspections for those jnids.
    const ourByJnid = {};
    for (let i = 0; i < jnids.length; i += 80) {
      const chunk = jnids.slice(i, i + 80).map((x) => `"${x}"`).join(",");
      const got = await sbGet(`inspections?jn_job_id=in.(${encodeURIComponent(chunk)})&select=id,jn_job_id,client_name,result,cancelled_at`);
      for (const r of got) if (!r.cancelled_at) ourByJnid[r.jn_job_id] = r;
    }

    const toHeal = [];
    const notInApp = [];
    for (const id of jnids) {
      const ours = ourByJnid[id];
      const j = byJnid[id];
      if (!ours) {
        const nm = (j.name || "").trim();
        if (!/test/i.test(nm)) notInApp.push({ jnid: id, name: nm, address: j.address_line1 || "" });
        continue;
      }
      if (!ours.result) continue; // genuinely still needs inspection — leave it
      const cf = (j.cf_string_34 || "").trim();
      // lost → always heal (status must move to Lost); others → heal only if the
      // JN result field never got stamped (that's the stale signature).
      if (ours.result === "lost" || !cf) toHeal.push({ id: ours.id, client: (ours.client_name || "").trim(), result: ours.result });
    }

    const healed = [];
    if (apply && base) {
      for (const h of toHeal.slice(0, HEAL_CAP)) {
        try {
          const r = await fetch(`${base}/.netlify/functions/push-result-to-jn`, {
            method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ inspectionId: h.id }),
          });
          const d = await r.json().catch(() => ({}));
          healed.push({ client: h.client, result: h.result, ok: !!d.jn_updated });
        } catch (e) { healed.push({ client: h.client, result: h.result, ok: false, error: e.message }); }
      }
    }

    // Alert admins about leftovers it couldn't auto-heal.
    let alerted = false;
    if (apply && base && notInApp.length) {
      const lines = [`🔎 Sit-Sold-Insp reconcile: ${notInApp.length} JN job(s) with NO inspection record (dupe or JN-only):`];
      notInApp.slice(0, 8).forEach((n) => lines.push(`• ${n.name}${n.address ? ` — ${n.address}` : ""}`));
      if (notInApp.length > 8) lines.push(`…+${notInApp.length - 8} more`);
      lines.push("", "These won't appear on the inspections map — dedupe in JN or create the record.");
      for (const to of dedupe(String(process.env.ADMIN_ALERT_PHONE || "").split(","))) {
        await sms(base, to, lines.join("\n"));
        alerted = true;
      }
    }

    return json(200, {
      ok: true, dry_run: !apply,
      jn_sit_sold: jnids.length,
      to_heal: toHeal.length, healed_count: healed.length, healed,
      not_in_app: notInApp.length, not_in_app_list: notInApp,
      capped: toHeal.length > HEAL_CAP ? toHeal.length - HEAL_CAP : 0,
      alerted,
    });
  } catch (e) {
    return json(500, { ok: false, error: e.message || "error" });
  }
};

async function fetchStatusJobs(statusName) {
  const out = [];
  const sinceSec = Math.floor(Date.now() / 1000) - 540 * 24 * 60 * 60;
  const filter = encodeURIComponent(JSON.stringify({ must: [{ match_phrase: { status_name: statusName } }] }));
  for (let page = 0; page < 60; page++) {
    const r = await fetch(`${JN_BASE}/jobs?size=100&from=${page * 100}&sort=-date_updated&date_updated_after=${sinceSec}&filter=${filter}`, { headers: jnHeaders });
    if (!r.ok) break;
    const d = await r.json().catch(() => ({}));
    const list = d.results || d.jobs || [];
    out.push(...list);
    if (list.length < 100) break;
  }
  return out;
}
async function sbGet(path) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: sb });
  if (!r.ok) return [];
  return r.json().catch(() => []);
}
async function sms(base, to, message) {
  try { await fetch(`${base}/.netlify/functions/ghl-sms`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ to, name: "Admin", message }) }); } catch { /* */ }
}
function dedupe(a) { return [...new Set(a.map((x) => String(x).trim()).filter(Boolean))]; }
function json(status, body) { return { statusCode: status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }, body: JSON.stringify(body) }; }

exports.config = { schedule: "0 13 * * *" };
