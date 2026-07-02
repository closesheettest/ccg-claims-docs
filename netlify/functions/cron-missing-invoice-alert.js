// netlify/functions/cron-missing-invoice-alert.js
//
// Weekly heads-up to PAYROLL (Sam) about manager-pay deals that can't be paid
// yet because no invoice has been created in JobNimbus. The manager override is
// paid on the TOTAL INVOICED amount (the record of truth) — a rep's estimate /
// budget number can be wrong — so any sold deal with NO invoice needs one built
// before pay is calculated.
//
// Window: "this week's manager pay" = LAST completed Mon–Sun week's SOLD deals
// (pay always runs on the prior week's sales). For each sold deal we look up its
// JobNimbus invoices (invoice.related → job); a deal with zero invoices is
// flagged. One email lists them all.
//
// Schedule: Wednesday morning, 9 AM ET (DST-safe — see the ET-hour gate). A
// manual GET runs it any time for testing (bypasses the gate).
//
// Recipient: MANAGER_PAY_INVOICE_EMAIL (default sammd@shingleusa.com).
//
// Env: JOBNIMBUS_API_KEY, URL (for send-email), MANAGER_PAY_INVOICE_EMAIL?

import { fetchSoldJobs } from "./_appt-conversion.js";

const JN_BASE = "https://app.jobnimbus.com/api1";
const JN_KEY = process.env.JOBNIMBUS_API_KEY;
const TZ = "America/New_York";
const TO_EMAIL = process.env.MANAGER_PAY_INVOICE_EMAIL || "sammd@shingleusa.com";

export const handler = async (event) => {
  const isManual = (event.httpMethod === "GET" || event.httpMethod === "POST") && !!event.headers;
  // Scheduled fire is DST-safe: the toml runs us at 13:00 AND 14:00 UTC Wed, and
  // we only proceed at ET-local 9 AM (EDT: 13Z; EST: 14Z) → exactly one/week.
  const etHour = Number(new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "2-digit", hour12: false }).format(new Date()).replace(/\D/g, ""));
  if (!isManual && etHour !== 9) {
    return json(200, { ok: true, skipped: `ET hour ${etHour} ≠ 9`, alerted: false });
  }
  if (!JN_KEY) return json(500, { ok: false, error: "Missing JOBNIMBUS_API_KEY" });

  try {
    const { start, end, label } = lastWeekET();
    const startSec = Math.floor(start.getTime() / 1000), endSec = Math.floor(end.getTime() / 1000);

    const [soldJobs, invByJob] = await Promise.all([
      fetchSoldJobs(JN_KEY, startSec, endSec),
      fetchInvoiceMap(),
    ]);

    const missing = [];
    for (const j of soldJobs) {
      const id = j.jnid || j.id;
      const inv = invByJob.get(id);
      if (inv && inv.count > 0) continue; // has an invoice → fine
      missing.push({
        name: (j.primary && j.primary.name) || j.name || "—",
        rep: String(j.sales_rep_name || "").trim() || "(no rep)",
        sold: fmtDate(soldDateSec(j)),
        amount: saleAmount(j),
        jnid: id,
      });
    }
    missing.sort((a, b) => a.rep.localeCompare(b.rep) || a.name.localeCompare(b.name));

    const base = process.env.URL || process.env.DEPLOY_URL || "https://free-roof-inspections.netlify.app";
    const { subject, html } = compose(label, soldJobs.length, missing);
    // ?dry=1 → compute + return the would-be email but DON'T send (safe verify).
    const dry = !!(event.queryStringParameters && (event.queryStringParameters.dry || event.queryStringParameters.test));
    if (dry) return json(200, { ok: true, dry: true, week: label, sold: soldJobs.length, missing: missing.length, subject, missing_rows: missing, to: TO_EMAIL });
    let sent = false;
    try {
      const r = await fetch(`${base}/.netlify/functions/send-email`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to: [TO_EMAIL], subject, html }),
      });
      sent = r.ok;
      if (!r.ok) console.warn("send-email returned", r.status, (await r.text()).slice(0, 200));
    } catch (e) { console.warn("send-email threw:", e.message); }

    return json(200, { ok: true, week: label, sold: soldJobs.length, missing: missing.length, missing_names: missing.map((m) => m.name), alerted: sent });
  } catch (e) {
    return json(500, { ok: false, error: e.message || "error" });
  }
};

// ── Invoices → job map (active, non-archived invoices summed per job) ──────────
async function fetchInvoiceMap() {
  const headers = { Authorization: `bearer ${JN_KEY}`, "Content-Type": "application/json" };
  const byJob = new Map();
  for (let from = 0; from < 50000; from += 100) {
    const r = await fetch(`${JN_BASE}/invoices?size=100&from=${from}`, { headers });
    if (!r.ok) break;
    const d = await r.json().catch(() => ({}));
    const rows = d.results || [];
    for (const iv of rows) {
      if (iv.is_active === false || iv.is_archived === true) continue;
      const rel = (iv.related || []).find((x) => x.type === "job");
      if (!rel) continue;
      const e = byJob.get(rel.id) || { total: 0, count: 0 };
      e.total += Number(iv.total) || 0;
      e.count += 1;
      byJob.set(rel.id, e);
    }
    if (rows.length < 100) break;
  }
  return byJob;
}

// ── Email body ────────────────────────────────────────────────────────────────
function compose(weekLabel, soldCount, missing) {
  const $ = (n) => "$" + (Math.round(Number(n) || 0)).toLocaleString();
  if (!missing.length) {
    return {
      subject: `Manager pay ${weekLabel}: all invoices in ✅`,
      html: `<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;color:#0f172a">
        <h2>Manager pay — week of ${weekLabel}</h2>
        <p>Good news: all <b>${soldCount}</b> sold deals for this week have an invoice in JobNimbus. Nothing to create — manager pay can be calculated on the invoiced totals.</p>
        <p style="font-size:12px;color:#9ca3af">Automated Wednesday check · U.S. Shingle</p>
      </div>`,
    };
  }
  const rows = missing.map((m) => `
    <tr>
      <td style="padding:8px 10px;border-bottom:1px solid #e5e7eb">${escapeHtml(m.name)}</td>
      <td style="padding:8px 10px;border-bottom:1px solid #e5e7eb">${escapeHtml(m.rep)}</td>
      <td style="padding:8px 10px;border-bottom:1px solid #e5e7eb;white-space:nowrap">${m.sold}</td>
      <td style="padding:8px 10px;border-bottom:1px solid #e5e7eb;text-align:right">${$(m.amount)}</td>
    </tr>`).join("");
  return {
    subject: `Manager pay ${weekLabel}: ${missing.length} invoice${missing.length === 1 ? "" : "s"} needed`,
    html: `<div style="font-family:Arial,sans-serif;max-width:620px;margin:0 auto;color:#0f172a">
      <h2>Manager pay — week of ${weekLabel}</h2>
      <p><b>${missing.length}</b> of <b>${soldCount}</b> sold deals this week have <b>no invoice</b> in JobNimbus yet. Manager override pays on the <b>total invoiced amount</b>, so these can't be calculated until an invoice is created on each job. The dollar figure below is the current estimate/budget amount (not verified — an invoice is the record of truth).</p>
      <table style="border-collapse:collapse;width:100%;font-size:14px">
        <thead><tr style="background:#f1f5f9;text-align:left">
          <th style="padding:8px 10px">Homeowner</th><th style="padding:8px 10px">Rep</th><th style="padding:8px 10px">Sold</th><th style="padding:8px 10px;text-align:right">Est. amount</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <p style="margin-top:14px">Please create the invoice on each job so pay can be finalized on the real numbers.</p>
      <p style="font-size:12px;color:#9ca3af">Automated Wednesday check · U.S. Shingle</p>
    </div>`,
  };
}

// ── Helpers ─────────────────────────────────────────────────────────────────
function saleAmount(j) { return Math.max(Number(j.approved_estimate_total) || 0, Number(j.approved_invoice_total) || 0, Number(j.last_budget_revenue) || 0); }
function soldDateSec(j) { const v = j["Sold Date"] != null ? j["Sold Date"] : j.cf_date_5; const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null; }
function fmtDate(sec) { const n = Number(sec); if (!(n > 0)) return "—"; try { return new Intl.DateTimeFormat("en-US", { timeZone: TZ, month: "numeric", day: "numeric" }).format(new Date(n * 1000)); } catch { return "—"; } }
function escapeHtml(s) { return String(s || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

// Last completed Mon–Sun week in ET (the sales week this week's pay covers).
function lastWeekET() {
  const now = new Date();
  const p = {}; for (const x of new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour12: false, weekday: "short", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now)) p[x.type] = x.value;
  const SUN = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const dowMon = ((SUN[p.weekday] ?? 0) + 6) % 7; // days since Monday
  const mon = addYMD(+p.year, +p.month, +p.day, -dowMon - 7);       // Monday of last week
  const nextMon = addYMD(mon.y, mon.m, mon.d, 7);                    // this Monday
  const start = etMidnightUTC(mon.y, mon.m, mon.d);
  const end = new Date(etMidnightUTC(nextMon.y, nextMon.m, nextMon.d).getTime() - 1000); // Sun 23:59:59
  const label = `${mon.m}/${mon.d}–${sunLabel(end)}`;
  return { start, end, label };
}
function sunLabel(end) { const p = {}; for (const x of new Intl.DateTimeFormat("en-US", { timeZone: TZ, month: "numeric", day: "numeric" }).formatToParts(end)) p[x.type] = x.value; return `${p.month}/${p.day}`; }
function addYMD(y, m, d, delta) { const b = new Date(Date.UTC(y, m - 1, d)); b.setUTCDate(b.getUTCDate() + delta); return { y: b.getUTCFullYear(), m: b.getUTCMonth() + 1, d: b.getUTCDate() }; }
function etMidnightUTC(y, m, d) { const noon = new Date(Date.UTC(y, m - 1, d, 12)); const hp = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "2-digit", hour12: false }).formatToParts(noon); const etHour = Number(hp.find((x) => x.type === "hour").value); return new Date(Date.UTC(y, m - 1, d, 12 - etHour)); }

function json(status, body) { return { statusCode: status, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }; }

// Wednesday (day 3). Fire at 13:00 & 14:00 UTC; the ET-hour gate keeps only the
// 9 AM ET one (EDT=13Z, EST=14Z) → exactly one email per Wednesday, year-round.
export const config = { schedule: "0 13,14 * * 3" };
