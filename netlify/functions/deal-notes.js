// netlify/functions/deal-notes.js
//
// The notes a HUMAN wrote on a deal in JobNimbus, plus its status history.
//
// The deal boards were reading pa_notes_log — our own app-side note log — so a
// card said "No notes on this deal" while JobNimbus held the rep's actual
// write-up. A Sit-No-Sale had "Sit no sale 39.12 sq shingle 13 years old 44
// solar panels, he is currently in court suing…" sitting in JN, and the board
// showed nothing (Neal, 2026-08-21). If you want to know WHY a deal is where it
// is, that note is the answer, and it lives in JN.
//
// Read-only, one job at a time — the boards fetch it when a card is opened, not
// for every deal on load (that would be hundreds of JN calls per page).
//
//   GET ?jnid=<job id>[&all=1]
//   → { ok, jnid, notes:[{ at, by, type, text }], count }
//
// Default keeps what a person would actually read: typed Notes and status
// changes. `all=1` adds the machine chatter (field edits, emails, attachments).
//
// Env: JOBNIMBUS_API_KEY.

const JN_BASE = "https://app.jobnimbus.com/api1";
const JN_KEY = process.env.JOBNIMBUS_API_KEY;
const jnH = { Authorization: `bearer ${JN_KEY}`, "Content-Type": "application/json" };

// JN returns note bodies with HTML in them (emails especially). Nobody wants to
// read markup on a card.
const clean = (s) => String(s || "")
  .replace(/<br\s*\/?>/gi, " ")
  .replace(/<[^>]+>/g, "")
  .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/\s+/g, " ")
  .trim();

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return cors(200, "");
  if (!JN_KEY) return cors(500, JSON.stringify({ ok: false, error: "missing JOBNIMBUS_API_KEY" }));
  const qp = event.queryStringParameters || {};
  const jnid = String(qp.jnid || "").trim();
  if (!jnid) return cors(400, JSON.stringify({ ok: false, error: "jnid required" }));
  const all = /^(1|true|yes)$/i.test(String(qp.all || ""));

  // JN relates an activity to a job through either related.id or primary.id
  // depending on how it was created — try both, same as jn-activity.
  const shapes = [
    { must: [{ term: { "related.id": jnid } }] },
    { must: [{ term: { "primary.id": jnid } }] },
  ];
  let acts = [];
  try {
    for (const f of shapes) {
      const r = await fetch(`${JN_BASE}/activities?filter=${encodeURIComponent(JSON.stringify(f))}&size=100&sort=-date_created`, { headers: jnH });
      if (!r.ok) continue;
      const d = await r.json().catch(() => ({}));
      const list = d.activity || d.activities || d.results || (Array.isArray(d) ? d : []);
      if (list.length) { acts = list; break; }
    }
  } catch (e) {
    return cors(502, JSON.stringify({ ok: false, error: e.message || "JobNimbus unreachable" }));
  }

  const notes = [];
  for (const a of acts) {
    const type = String(a.record_type_name || a.type || "").trim();
    const isNote = /^note$/i.test(type);
    const isStatus = /status changed/i.test(type) || a.is_status_update === true;
    if (!all && !isNote && !isStatus) continue;
    const text = clean(a.note || a.message || a.description || "");
    if (!text) continue;
    notes.push({
      at: a.date_created ? new Date(a.date_created * 1000).toISOString() : null,
      by: a.created_by_name || "(unknown)",
      type: isNote ? "note" : isStatus ? "status" : "other",
      // Status lines read as "Job Updated Archived: No => Yes Status: X => Y" —
      // keep the status half, drop the bookkeeping.
      text: isStatus ? (text.match(/Status:\s*(.+)$/i)?.[1] || text) : text,
    });
  }
  notes.sort((a, b) => new Date(b.at || 0) - new Date(a.at || 0));
  return cors(200, JSON.stringify({ ok: true, jnid, count: notes.length, notes: notes.slice(0, 40) }));
};

function cors(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json", "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type",
    },
    body,
  };
}
