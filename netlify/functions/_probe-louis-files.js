// TEMP read-only probe — list JN files on Louis Calloway's job. DELETE after.
const JN_BASE = "https://app.jobnimbus.com/api1";
const JN_KEY = process.env.JOBNIMBUS_API_KEY;
const JOB = "mrzhc7a9kovuxckfuz766sm";
exports.handler = async () => {
  const H = { Authorization: `bearer ${JN_KEY}`, "Content-Type": "application/json" };
  const out = {};
  try {
    for (const t of [1, 2]) {
      const r = await fetch(`${JN_BASE}/files?related=${JOB}&type=${t}&size=50`, { headers: H });
      const d = r.ok ? await r.json().catch(() => ({})) : { error: r.status };
      out[`type_${t}`] = (d.files || d.results || d.data || []).map((f) => ({ jnid: f.jnid || f.id, filename: f.filename || f.name, date: f.date_created, subject: f.subject }));
    }
  } catch (e) { out.error = String((e && e.message) || e); }
  return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify(out, null, 1) };
};
