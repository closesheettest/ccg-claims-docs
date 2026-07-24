// netlify/functions/cron-harvest-leadsync.js
//
// Scheduled trigger for the harvest lead sync. Until now the sync
// (harvest-sync-iq-background — pulls JobNimbus Instant Quote / Facebook / AI
// Bot leads onto the DoorDispatcher) ONLY ran when someone manually clicked
// "sync" in the harvest admin, so a lead that came into JN after the last click
// stayed invisible for hours (e.g. a 2 PM Instant Quote lead not showing because
// the last manual sync was 10 AM). This thin cron fires that background sync
// automatically so new leads land on the map same-day.
//
// Netlify scheduled functions can't be "-background" themselves, so this wrapper
// POSTs to the background sync (which returns 202 immediately and then runs to
// completion on its own up to the 15-min background budget) and returns.
//
// Cadence (netlify.toml): every 2 hours, ~7 AM–9 PM ET.

export const config = { schedule: "0 11,13,15,17,19,21,23,1 * * *" };

export const handler = async () => {
  const base = process.env.URL || process.env.DEPLOY_PRIME_URL || process.env.DEPLOY_URL || "";
  try {
    const r = await fetch(`${base}/.netlify/functions/harvest-sync-iq-background`, { method: "POST" });
    return { statusCode: 200, body: JSON.stringify({ ok: true, triggered: true, bg_status: r.status }) };
  } catch (e) {
    return { statusCode: 200, body: JSON.stringify({ ok: false, error: String(e && e.message || e) }) };
  }
};
