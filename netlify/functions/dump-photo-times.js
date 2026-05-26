// netlify/functions/dump-photo-times.js
//
// READ-ONLY. For each classified inspection in a date window, dumps
// the photo captured_at times so admin can compare with result_at
// and figure out when each inspection actually happened.
//
// USAGE:
//   GET /.netlify/functions/dump-photo-times?from=2026-05-19&to=2026-05-26
//
// Required env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY

exports.handler = async (event) => {
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
  if (!SB_URL || !SB_KEY) return json(500, { ok: false, error: "Missing env" });

  const qs = event.queryStringParameters || {};
  const now = new Date();
  const defaultFrom = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);
  const from = qs.from || defaultFrom.toISOString().slice(0, 10);
  const to = qs.to || new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const url =
    `${SB_URL}/rest/v1/inspections` +
    `?result=in.(damage,no_damage,retail)` +
    `&result_at=gte.${from}` +
    `&result_at=lt.${to}` +
    `&cancelled_at=is.null` +
    `&select=id,client_name,result,result_at,inspection_photos` +
    `&order=result_at.desc` +
    `&limit=200`;
  const r = await fetch(url, {
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
  });
  if (!r.ok) return json(500, { ok: false, error: `Supabase: ${(await r.text()).slice(0, 300)}` });
  const rows = await r.json();

  const out = rows.map((row) => {
    const photos = Array.isArray(row.inspection_photos) ? row.inspection_photos : [];
    const captureMs = [];
    for (const p of photos) {
      if (!p?.captured_at) continue;
      const ms = new Date(p.captured_at).getTime();
      if (!Number.isNaN(ms)) captureMs.push(ms);
    }
    let earliest = null, latest = null;
    if (captureMs.length > 0) {
      earliest = new Date(Math.min(...captureMs)).toISOString();
      latest = new Date(Math.max(...captureMs)).toISOString();
    }
    return {
      client_name: row.client_name,
      result: row.result,
      result_at: row.result_at,
      photo_count: photos.length,
      photos_with_captured_at: captureMs.length,
      earliest_capture: earliest,
      latest_capture: latest,
      // Diagnostic: difference between earliest photo and result_at
      gap_hours_earliest_to_result: earliest
        ? Math.round((new Date(row.result_at).getTime() - new Date(earliest).getTime()) / (1000 * 60 * 60) * 10) / 10
        : null,
    };
  });

  return json(200, { ok: true, window: { from, to }, total: out.length, records: out });
};

function json(status, body) {
  return { statusCode: status, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}
