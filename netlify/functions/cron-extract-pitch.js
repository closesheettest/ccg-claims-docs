// netlify/functions/cron-extract-pitch.js
//
// Roof PITCH extractor for the Appointments → Sales report. The pitch ratio
// (e.g. "4/12") is NOT a JobNimbus field — it lives inside each job's Roofr
// PDF ("Predominant pitch: 4/12"). This cron, run gently overnight:
//   1. pulls SOLD jobs (last N days),
//   2. skips ones already cached with a pitch,
//   3. finds the Roofr PDF on the job (filename "…, United States.pdf"),
//   4. downloads it (JN /files/{id} → 302 → signed URL),
//   5. parses the predominant pitch with pdf-parse,
//   6. upserts pitch (+ squares / stories) into the `roof_pitch` table.
// The report reads roof_pitch and shows the pitch on each sale.
//
// Throttle-gentle: sequential, ~1.2s between jobs, backs off on 401/429,
// and capped per run (?limit=, default 40) so it never times out — it back-
// fills over a few nights, then only touches new sales.
//
// Modes: GET ?dry=1 (compute + return JSON, write nothing) · ?limit=N · ?days=N
// Env: JOBNIMBUS_API_KEY, VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY.

import { fetchSoldJobs } from "./_appt-conversion.js";
import { extractText, getDocumentProxy } from "unpdf";

const JN_BASE = "https://app.jobnimbus.com/api1";
const JN_KEY = process.env.JOBNIMBUS_API_KEY;
const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const sb = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" };
const jnHeaders = { Authorization: `bearer ${JN_KEY}` };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const handler = async (event) => {
  if (!JN_KEY || !SB_URL || !SB_KEY) return json(500, { ok: false, error: "Missing env (JOBNIMBUS_API_KEY / VITE_SUPABASE_*)" });
  const qp = (event && event.queryStringParameters) || {};
  const dry = qp.dry === "1";
  const limit = Math.min(Number(qp.limit) || 40, 120);
  const days = Number(qp.days) || 120;
  const now = Math.floor(Date.now() / 1000);

  try {
    const sold = await fetchSoldJobs(JN_KEY, now - days * 86400, now);
    // Skip a deal if it already has a pitch, OR it was attempted recently (so a
    // no-PDF/no-pitch deal doesn't get retried forever — but IS re-checked after
    // 2 days, in case the Roofr PDF gets added later).
    const recheck = Number(qp.recheck_days) || 2;
    const cutoff = new Date((now - recheck * 86400) * 1000).toISOString();
    const have = new Set();
    const hr = await fetch(`${SB_URL}/rest/v1/roof_pitch?select=jnid&or=(pitch.not.is.null,checked_at.gte.${encodeURIComponent(cutoff)})`, { headers: sb });
    if (hr.ok) for (const r of await hr.json()) have.add(r.jnid);
    const todo = sold.filter((j) => !have.has(j.jnid || j.id)).slice(0, limit);

    const results = [];
    for (const j of todo) {
      const jid = j.jnid || j.id;
      const F = fieldMap(j);
      const rec = {
        jnid: jid, pitch: null, roofr_file: null, status: "",
        squares_pitch: num(F["# of Squares (Pitch)"]),
        squares_flat: num(F["# of Squares (Flat)"]),
        stories: F["# of Stories"] || null,
      };
      try {
        const pdf = await findRoofrPdf(jid);
        if (!pdf) rec.status = "no_pdf";
        else {
          rec.roofr_file = pdf.filename || pdf.name || null;
          const buf = await downloadFile(pdf.jnid || pdf.id);
          if (!buf) rec.status = "dl_fail";
          else {
            const text = await pdfText(buf);
            const m = text.match(/Predominant pitch:?\s*(\d{1,2})\s*\/\s*12/i);
            rec.pitch = m ? `${m[1]}/12` : null;
            rec.status = rec.pitch ? "ok" : "no_pitch";
          }
        }
      } catch (e) {
        rec.status = "error"; rec.err = (e && e.message) || String(e);
      }
      results.push(rec);
      if (!dry) await upsert(rec);
      await sleep(1200); // gentle on JN's rate limit
    }

    const byStatus = results.reduce((m, r) => ((m[r.status] = (m[r.status] || 0) + 1), m), {});
    return json(200, { ok: true, dry, sold: sold.length, attempted: todo.length, byStatus, results: dry ? results : undefined });
  } catch (e) {
    return json(500, { ok: false, error: (e && e.message) || "error" });
  }
};

// The Roofr report on a job = a PDF named by the address ("…, United States.pdf"),
// or any PDF with "roofr" in the name.
async function findRoofrPdf(jid) {
  const flt = encodeURIComponent(JSON.stringify({ must: [{ terms: { "related.id": [jid] } }] }));
  const r = await fetch(`${JN_BASE}/files?size=100&filter=${flt}`, { headers: jnHeaders });
  if (!r.ok) return null;
  const d = await r.json().catch(() => ({}));
  const files = (d.results || d.files || d.data || []).filter((f) => String(f.content_type || "").includes("pdf"));
  return files.find((f) => /united states\.pdf$/i.test(f.filename || f.name || "")) ||
    files.find((f) => /roofr/i.test(f.filename || f.name || "")) || null;
}

// JN serves files via a 302 to a signed CloudFront URL; fetch that WITHOUT the
// auth header. Retry on the API's intermittent 401/429 throttle.
async function downloadFile(fid) {
  for (let a = 0; a < 4; a++) {
    const r = await fetch(`${JN_BASE}/files/${fid}`, { headers: jnHeaders, redirect: "manual" });
    if (r.status >= 300 && r.status < 400) {
      const loc = r.headers.get("location");
      if (!loc) return null;
      const f = await fetch(loc);
      if (!f.ok) return null;
      return Buffer.from(await f.arrayBuffer());
    }
    if (r.status === 401 || r.status === 429) { await sleep(2000 * (a + 1)); continue; }
    return null;
  }
  return null;
}

async function pdfText(buf) {
  const pdf = await getDocumentProxy(new Uint8Array(buf));
  const { text } = await extractText(pdf, { mergePages: true });
  return text || "";
}

async function upsert(rec) {
  const row = {
    jnid: rec.jnid, pitch: rec.pitch, squares_pitch: rec.squares_pitch ?? null,
    squares_flat: rec.squares_flat ?? null, stories: rec.stories ?? null,
    roofr_file: rec.roofr_file ?? null, status: rec.status, checked_at: new Date().toISOString(),
  };
  await fetch(`${SB_URL}/rest/v1/roof_pitch`, {
    method: "POST", headers: { ...sb, Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify(row),
  }).catch(() => {});
}

function fieldMap(job) {
  const m = {};
  for (const [k, v] of Object.entries(job)) { m[k.trim()] = v; const b = k.trim().replace(/^\*|\*$/g, "").trim(); if (!(b in m)) m[b] = v; }
  return m;
}
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }
function json(status, body) { return { statusCode: status, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }; }

export const config = { schedule: "30 8 * * *" }; // 8:30 UTC = 4:30 AM ET, nightly
