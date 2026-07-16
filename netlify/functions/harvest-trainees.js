// netlify/functions/harvest-trainees.js
//
// This week's field trainees + one-tap "grant Harvesting-Map access & text them
// the link." Trainees live in TMS (not CCG sales_reps); granting access creates
// a CCG sales_reps row tagged harvest_level='trainee' (junior pin visibility)
// with a personal harvest link, then texts it to them. They knock/sign starting
// day 2 until they graduate; when they become active reps the office clears the
// trainee tag.
//
//   GET  → { ok, trainees:[{ name, phone, has_access, link, rep_id }] }
//   POST { action:"grant", name, phone } → { ok, link, sent, rep_id }
//
// Env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, URL/PUBLIC_SITE_URL

const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const TMS_TRAINEES = "https://trainingmanagementsys.netlify.app/.netlify/functions/trainees-this-week";
const last10 = (p) => String(p || "").replace(/\D/g, "").slice(-10);

export const handler = async (event) => {
  if (!SB_URL || !SB_KEY) return json(500, { ok: false, error: "Missing Supabase env" });
  const sb = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" };
  const base = (process.env.URL || process.env.PUBLIC_SITE_URL || "https://free-roof-inspections.netlify.app").replace(/\/$/, "");
  const sbGet = (path) => fetch(`${SB_URL}/rest/v1/${path}`, { headers: sb }).then((r) => (r.ok ? r.json() : [])).catch(() => []);

  // ── POST: grant access to one trainee + text them the link ────────────────
  if (event.httpMethod === "POST") {
    let body; try { body = JSON.parse(event.body || "{}"); } catch { return json(400, { ok: false, error: "bad JSON" }); }
    const name = String(body.name || "").trim();
    const phone = String(body.phone || "").trim();
    if ((body.action || "grant") !== "grant") return json(400, { ok: false, error: "unknown action" });
    if (!phone || last10(phone).length !== 10) return json(400, { ok: false, error: "a valid phone is required" });

    // Reuse an existing sales_reps row for this phone; else create one.
    const existing = (await sbGet(`sales_reps?select=id,name,phone,harvest_token&limit=500`))
      .find((r) => last10(r.phone) === last10(phone));
    let repId, token;
    if (existing) {
      repId = existing.id;
      token = existing.harvest_token || crypto.randomUUID();
      const patch = { harvest_level: "trainee", harvest_token: token };
      if (!existing.name && name) patch.name = name;
      const up = await fetch(`${SB_URL}/rest/v1/sales_reps?id=eq.${encodeURIComponent(repId)}`, { method: "PATCH", headers: { ...sb, Prefer: "return=minimal" }, body: JSON.stringify(patch) });
      if (!up.ok) return json(500, { ok: false, error: (await up.text().catch(() => "")).slice(0, 200) || "update failed" });
    } else {
      token = crypto.randomUUID();
      const ins = await fetch(`${SB_URL}/rest/v1/sales_reps`, { method: "POST", headers: { ...sb, Prefer: "return=representation" }, body: JSON.stringify({ name: name || "Trainee", phone, harvest_token: token, harvest_level: "trainee", active: false }) });
      if (!ins.ok) return json(500, { ok: false, error: (await ins.text().catch(() => "")).slice(0, 200) || "create failed" });
      repId = ((await ins.json().catch(() => []))[0] || {}).id;
    }

    const link = `${base}/?mode=harvest&rt=${token}`;
    // Text them the link.
    let sent = false;
    try {
      const first = (name || "there").split(/\s+/)[0];
      const msg = `Hi ${first}, here's your U.S. Shingle Harvesting Map link for field training — open it to see your doors and knock: ${link}`;
      const r = await fetch(`${base}/.netlify/functions/ghl-sms`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ to: phone, name: name || "Trainee", message: msg }) });
      sent = r.ok;
    } catch { /* link still returned so the office can copy it */ }

    return json(200, { ok: true, link, sent, rep_id: repId });
  }

  // ── GET: this week's trainees + who already has access ────────────────────
  const tms = await fetch(TMS_TRAINEES).then((r) => (r.ok ? r.json() : { trainees: [] })).catch(() => ({ trainees: [] }));
  const weekTrainees = tms.trainees || [];
  // CCG rows already tagged trainee (match by phone → has_access + link).
  const tagged = await sbGet(`sales_reps?harvest_level=eq.trainee&select=id,name,phone,harvest_token`);
  const byPhone = {};
  for (const r of tagged) if (r.harvest_token) byPhone[last10(r.phone)] = r;
  const out = weekTrainees.map((t) => {
    const match = byPhone[last10(t.phone)];
    return {
      name: t.name || `${t.first_name || ""} ${t.last_name || ""}`.trim() || "Trainee",
      phone: t.phone || "",
      has_access: !!match,
      link: match ? `${base}/?mode=harvest&rt=${match.harvest_token}` : "",
      rep_id: match ? match.id : null,
    };
  });
  return json(200, { ok: true, trainees: out });
};

function json(statusCode, obj) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) };
}
