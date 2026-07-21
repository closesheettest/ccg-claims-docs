// netlify/functions/list-sms-optouts.js
//
// One-shot report: which people on the leaderboard-blast roster (sales reps +
// regional managers + the daily_leaderboard copy-recipients) have OPTED OUT of
// SMS in GoHighLevel (replied STOP → contact.dnd = true). Opt-out status lives
// only in GHL, not our DB, so we look each roster phone up in GHL.
//
//   GET /.netlify/functions/list-sms-optouts
//   → { ok, checked, opted_out:[{name,phone}], not_found:[...], errors }
//
// Env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, GHL_LOCATION_ID

const GHL_API_KEY = "pit-9c582cb2-5898-4ee6-af39-866eeb0360b8"; // same key ghl-sms.js uses
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID || "";
const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const GHL_HEADERS = { Authorization: `Bearer ${GHL_API_KEY}`, Version: "2021-04-15", "Content-Type": "application/json" };

function normalizePhone(phone) {
  const digits = String(phone || "").replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return digits ? `+${digits}` : "";
}

async function sbGet(path) {
  try {
    const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` } });
    return r.ok ? r.json() : [];
  } catch { return []; }
}

exports.handler = async () => {
  if (!GHL_LOCATION_ID) return json(500, { ok: false, error: "GHL_LOCATION_ID not set" });

  // Same roster the blast texts: active reps + managers + the copy-recipients.
  const reps = await sbGet("sales_reps?select=name,phone,active&limit=1000");
  const mgrs = await sbGet("regional_managers?select=name,phone&limit=200");
  const auto = await sbGet("auto_sms?key=eq.daily_leaderboard&select=recipients&limit=1");
  const extras = (auto[0] && Array.isArray(auto[0].recipients)) ? auto[0].recipients : [];

  const byPhone = new Map();
  const add = (name, phone) => { const p = normalizePhone(phone); if (p && !byPhone.has(p)) byPhone.set(p, name || "Team"); };
  for (const r of reps) if (r.active !== false) add(r.name, r.phone);
  for (const m of mgrs) add(m.name, m.phone);
  for (const e of extras) add(e.name, e.phone);

  const optedOut = [], notFound = [];
  let checked = 0, errors = 0;
  for (const [phone, name] of byPhone) {
    checked++;
    try {
      const res = await fetch(`https://services.leadconnectorhq.com/contacts/?locationId=${GHL_LOCATION_ID}&query=${encodeURIComponent(phone)}`, { headers: GHL_HEADERS });
      if (!res.ok) { errors++; continue; }
      const data = await res.json();
      const c = (data.contacts || [])[0];
      if (!c) { notFound.push({ name, phone }); continue; }
      if (c.dnd === true) optedOut.push({ name, phone });
    } catch { errors++; }
  }

  optedOut.sort((a, b) => a.name.localeCompare(b.name));
  return json(200, { ok: true, checked, opted_out: optedOut, opted_out_count: optedOut.length, not_found_count: notFound.length, not_found: notFound, errors });
};

function json(statusCode, body) {
  return { statusCode, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }, body: JSON.stringify(body) };
}
