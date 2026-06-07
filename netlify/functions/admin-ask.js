// netlify/functions/admin-ask.js
//
// Smart Q&A backend for the Admin Dashboard (/?mode=admin).
//
// Flow:
//   1. Claude (haiku-4-5) classifies the admin's plain-English question
//      into a SAFE, ENUMERATED query plan via a single FORCED tool
//      (answer_plan). Claude never sees the data and never produces a
//      number — it only picks an intent + parameters from fixed enums.
//   2. This function then runs DETERMINISTIC Supabase REST queries based
//      on that plan and computes the exact number itself, templating it
//      into the answer. That makes hallucinated figures structurally
//      impossible.
//
// Question kinds:
//   • data       → compute a count from Supabase + return number/breakdown
//   • navigation → point to the right Manager tool (returns a tool_key the
//                  hub turns into a deep-link)
//   • clarify    → the question was ambiguous; ask one follow-up
//
// Required env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY,
//               ANTHROPIC_API_KEY (without it the function returns a
//               graceful "not configured" so the rest of the hub works).
//
// Raw fetch only (no SDK) — consistent with the other functions here.

const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_MODEL = "claude-haiku-4-5";

const RESULT_VALUES = ["damage", "no_damage", "retail", "lost"];

// Section keys the Manager render switch knows about — the safelist Claude
// may navigate to. Mirrors MANAGER_TILES keys in src/App.jsx.
const TOOL_KEYS = [
  "reps", "review", "thankyou", "sms", "report", "analytics", "dupes", "browseall",
  "team_roles", "inspectors", "assign_inspections", "confirm_results",
  "inspector_routes", "inspector_reports", "lookup", "jnreport", "bulkreport",
  "pamgmt", "public_adjusters", "pa_handoff", "pa_report", "sit_sold_pa_report",
  "security", "autosms",
];

export const handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return json(405, { ok: false, kind: "error", answerText: "Method not allowed." });
  }

  let question = "";
  try { question = String(JSON.parse(event.body || "{}").question || "").trim(); }
  catch { return json(400, { ok: false, kind: "error", answerText: "Invalid request." }); }
  if (!question) return json(400, { ok: false, kind: "error", answerText: "Ask a question first." });
  if (question.length > 500) question = question.slice(0, 500);

  // Graceful fallback when the AI key isn't set — the hub still works.
  if (!ANTHROPIC_KEY) {
    return json(200, {
      ok: false, kind: "unconfigured",
      answerText: "AI search isn't configured on this server yet. Use the tool and report cards above to get where you need to go.",
    });
  }
  if (!SB_URL || !SB_KEY) {
    return json(500, { ok: false, kind: "error", answerText: "Server is missing its database connection." });
  }

  // 1. Classify via forced tool use.
  let plan;
  try {
    plan = await classify(question);
  } catch (e) {
    console.warn("admin-ask classify failed:", e.message);
    return json(200, { ok: false, kind: "error", answerText: "Couldn't interpret that — try rephrasing, or use the tool cards above." });
  }

  try {
    if (plan.kind === "navigation") {
      const key = TOOL_KEYS.includes(plan.tool_key) ? plan.tool_key : null;
      if (!key) {
        return json(200, { ok: true, kind: "clarify", answerText: "I'm not sure which tool that is — try the tool cards above, or rephrase." });
      }
      const label = plan.nav_label || "the right tool";
      return json(200, {
        ok: true, kind: "navigation",
        answerText: `That's in ${label}.`,
        link: { label: `Open ${label}`, section: key },
      });
    }

    if (plan.kind === "clarify") {
      return json(200, { ok: true, kind: "clarify", answerText: plan.clarify_question || "Could you be more specific?" });
    }

    if (plan.kind === "data") {
      return await answerData(plan);
    }

    return json(200, { ok: true, kind: "clarify", answerText: "Could you rephrase that as a question about your records or where to find a tool?" });
  } catch (e) {
    console.warn("admin-ask compute failed:", e.message);
    return json(200, { ok: false, kind: "error", answerText: "Couldn't pull that just now — try again, or use the tool cards above." });
  }
};

// ── Data answers (deterministic compute) ─────────────────────────────
async function answerData(plan) {
  const metric = plan.metric;
  const win = resolveWindow(plan.date_range, plan.custom_start, plan.custom_end);
  const winLabel = windowLabel(plan.date_range);

  switch (metric) {
    case "inspections_signed_by_rep": {
      if (!plan.person_name) return clarify("Which sales rep do you mean?");
      const rows = await pullRepSignedInspections(plan.person_name, win);
      const distinct = distinctNames(rows);
      if (distinct.length > 1) return clarify(`There are multiple reps matching "${plan.person_name}": ${distinct.join(", ")}. Which one?`);
      const n = dedupSignings(rows).length;
      const who = distinct[0] || plan.person_name;
      return data(n, `${who} signed ${n} ${plural(n, "inspection")} ${winLabel}.`, resultBreakdown(rows), "lookup", "Open Record Lookup");
    }

    case "claims_signed_by_rep": {
      if (!plan.person_name) return clarify("Which sales rep do you mean?");
      const enc = encodeURIComponent(plan.person_name);
      let filter = `or=(sales_rep_name.ilike.*${enc}*,signed_by_name.ilike.*${enc}*)&signed_at=not.is.null&cancelled_at=is.null`;
      filter += windowFilter("signed_at", win);
      let rows = await fetchTable("claims", { select: "sales_rep_name,signed_by_name,signed_at", filter, limit: 5000 });
      rows = rows.filter((r) => nameMatches(r.sales_rep_name, plan.person_name) || nameMatches(r.signed_by_name, plan.person_name));
      const n = rows.length;
      return data(n, `${plan.person_name} has ${n} signed ${plural(n, "claim")} ${winLabel}.`, null, "report", "Open Weekly Report");
    }

    case "inspections_by_result": {
      const rf = RESULT_VALUES.includes(plan.result_filter) ? plan.result_filter : "any";
      let filter = `cancelled_at=is.null`;
      if (rf === "any") filter += `&result=not.is.null`;
      else filter += `&result=eq.${rf}`;
      if (plan.person_name) filter += `&sales_rep_name=ilike.*${encodeURIComponent(plan.person_name)}*`;
      filter += windowFilter("result_at", win);
      let rows = await fetchTable("inspections", { select: "result,sales_rep_name,result_at", filter, limit: 5000 });
      if (plan.person_name) rows = rows.filter((r) => nameMatches(r.sales_rep_name, plan.person_name));
      const n = rows.length;
      const whoBit = plan.person_name ? ` for ${plan.person_name}` : "";
      if (rf === "any") {
        return data(n, `There ${n === 1 ? "was" : "were"} ${n} completed ${plural(n, "inspection")}${whoBit} ${winLabel}.`, resultBreakdown(rows), "inspector_reports", "Open Inspector Reports");
      }
      const label = RESULT_LABEL[rf];
      return data(n, `There ${n === 1 ? "was" : "were"} ${n} ${label} ${plural(n, "inspection")}${whoBit} ${winLabel}.`, null, "inspector_reports", "Open Inspector Reports");
    }

    case "inspections_pending": {
      let filter = `signed_at=not.is.null&result=is.null&cancelled_at=is.null`;
      if (plan.person_name) filter += `&sales_rep_name=ilike.*${encodeURIComponent(plan.person_name)}*`;
      filter += windowFilter("signed_at", win);
      let rows = await fetchTable("inspections", { select: "sales_rep_name,signed_at", filter, limit: 5000 });
      if (plan.person_name) rows = rows.filter((r) => nameMatches(r.sales_rep_name, plan.person_name));
      const n = rows.length;
      const whoBit = plan.person_name ? ` for ${plan.person_name}` : "";
      return data(n, `${n} ${plural(n, "inspection")}${whoBit} ${n === 1 ? "is" : "are"} pending a result ${winLabel}.`, null, "lookup", "Open Record Lookup");
    }

    case "inspections_total": {
      let filter = `signed_at=not.is.null&cancelled_at=is.null`;
      filter += windowFilter("signed_at", win);
      const rows = await fetchTable("inspections", { select: "client_name,zip,address,result,result_at,signed_at,jn_status", filter, limit: 5000 });
      const n = dedupSignings(rows).length;
      return data(n, `${n} ${plural(n, "inspection")} ${winLabel}.`, resultBreakdown(rows), "report", "Open Weekly Report");
    }

    case "rep_leaderboard_rank": {
      if (!plan.person_name) return clarify("Whose rank do you want?");
      const w = resolveWindow("this_week");
      let filter = `signed_at=not.is.null&cancelled_at=is.null`;
      filter += windowFilter("signed_at", w);
      const rows = await fetchTable("inspections", { select: "sales_rep_name,client_name,zip,address,result,result_at,signed_at,jn_status", filter, limit: 5000 });
      const deduped = dedupSignings(rows);
      const counts = new Map();
      for (const r of deduped) {
        const k = normalizeName(r.sales_rep_name);
        if (!k) continue;
        counts.set(k, (counts.get(k) || 0) + 1);
      }
      const ranked = [...counts.entries()].map(([k, c]) => ({ k, c })).sort((a, b) => b.c - a.c);
      const target = normalizeName(plan.person_name);
      const idx = ranked.findIndex((r) => r.k === target || r.k.includes(target) || target.includes(r.k));
      if (idx === -1) return data(0, `${plan.person_name} has no signed inspections this week, so they're not on the leaderboard yet.`, null, "inspector_reports", "Open Inspector Reports");
      const rank = idx + 1;
      return data(rank, `${plan.person_name} is #${rank} this week with ${ranked[idx].c} ${plural(ranked[idx].c, "inspection")}.`, null, "inspector_reports", "Open Inspector Reports");
    }

    case "inspections_by_inspector": {
      if (!plan.person_name) return clarify("Which inspector do you mean?");
      const enc = encodeURIComponent(plan.person_name);
      const insp = await fetchTable("inspectors", { select: "id,name", filter: `name=ilike.*${enc}*`, limit: 50 });
      const matched = insp.filter((r) => nameMatches(r.name, plan.person_name));
      if (matched.length === 0) return clarify(`I couldn't find an inspector matching "${plan.person_name}".`);
      if (matched.length > 1) return clarify(`Multiple inspectors match "${plan.person_name}": ${matched.map((m) => m.name).join(", ")}. Which one?`);
      const id = matched[0].id;
      let filter = `inspector_id=eq.${id}&result=not.is.null&cancelled_at=is.null`;
      filter += windowFilter("result_at", win);
      const rows = await fetchTable("inspections", { select: "result,result_at", filter, limit: 5000 });
      const n = rows.length;
      return data(n, `${matched[0].name} completed ${n} ${plural(n, "inspection")} ${winLabel}.`, resultBreakdown(rows), "inspector_reports", "Open Inspector Reports");
    }

    default:
      return clarify("I couldn't tell what to count — try rephrasing your question.");
  }
}

async function pullRepSignedInspections(name, win) {
  const enc = encodeURIComponent(name);
  let filter = `sales_rep_name=ilike.*${enc}*&signed_at=not.is.null&cancelled_at=is.null`;
  filter += windowFilter("signed_at", win);
  const rows = await fetchTable("inspections", {
    select: "sales_rep_name,client_name,zip,address,result,result_at,signed_at,jn_status",
    filter, limit: 5000,
  });
  return rows.filter((r) => nameMatches(r.sales_rep_name, name));
}

// Per-result counts for a breakdown chip row (only when there's variety).
function resultBreakdown(rows) {
  const b = {};
  for (const r of rows || []) {
    const v = (r.result || "").toLowerCase();
    if (RESULT_VALUES.includes(v)) b[v] = (b[v] || 0) + 1;
  }
  return Object.keys(b).length > 1 ? b : null;
}

// ── Response builders ────────────────────────────────────────────────
function data(number, answerText, breakdown, section, linkLabel) {
  const out = { ok: true, kind: "data", number, answerText };
  if (breakdown) out.breakdown = breakdown;
  if (section) out.link = { label: linkLabel || "Open tool", section };
  return json(200, out);
}
function clarify(text) {
  return json(200, { ok: true, kind: "clarify", answerText: text });
}

// ── Anthropic classify (forced single tool) ──────────────────────────
const RESULT_LABEL = { damage: "Damage", no_damage: "No Damage", retail: "Retail", lost: "Lost" };

const SYSTEM_PROMPT = [
  "You translate a roofing/insurance-claims admin's plain-English question into a query plan using the answer_plan tool.",
  "You NEVER state or guess numbers — you only classify intent and extract parameters from the fixed enums. The application computes every figure itself.",
  "",
  "Rules:",
  "- 'How many / count / total / rank / leaderboard' about people or records → kind:'data' with the closest metric.",
  "- 'Where do I / how do I / open / find the tool for…' → kind:'navigation' with the best tool_key plus a short human nav_label.",
  "- If the person, metric, or timeframe is genuinely ambiguous → kind:'clarify' with one specific clarify_question.",
  "- Default date_range to 'all_time' for 'how many … signed' with no timeframe; use 'this_week' only when the question mentions this week or the leaderboard.",
  "- Always choose values from the enums; never invent a metric or tool_key.",
  "",
  "Metric guide:",
  "- inspections_signed_by_rep: how many inspections a SALES REP signed (person_name = the rep).",
  "- claims_signed_by_rep: how many PA claims a sales rep signed.",
  "- inspections_by_result: count by outcome (result_filter damage/no_damage/retail/lost, or any). Optional person_name.",
  "- inspections_pending: signed but no result yet.",
  "- inspections_total: total signed inspections in a window.",
  "- rep_leaderboard_rank: a rep's leaderboard position this week (person_name).",
  "- inspections_by_inspector: inspections COMPLETED by an INSPECTOR (person_name = the inspector).",
  "",
  "Tool guide (tool_key = tool): lookup = Record Lookup & Results (find inspections, record damage/no-damage); report = Weekly Report; analytics = Submission Analytics; inspector_reports = Inspector Reports; reps = Sales Rep Manager; assign_inspections = Assign Inspections; confirm_results = Confirm Results; inspectors = Inspectors roster; public_adjusters = Public Adjusters; pa_report = PA Report; pa_handoff = PA Handoff; pamgmt = PA Management; team_roles = Team Roles; sms = SMS Templates; review = Review Page Text; thankyou = Thank You Pages; security = Security & Notifications; autosms = Auto SMS; browseall = Browse All Records; jnreport = JN Inspection Report; bulkreport = Bulk Inspection Reports; dupes = Find Duplicates.",
].join("\n");

const ANSWER_PLAN_TOOL = {
  name: "answer_plan",
  description: "Interpret the admin's question into a safe, enumerated query plan. NEVER compute or invent numbers — only classify intent and extract parameters.",
  input_schema: {
    type: "object",
    properties: {
      kind: { type: "string", enum: ["data", "navigation", "clarify"] },
      metric: {
        type: "string",
        enum: [
          "inspections_signed_by_rep", "inspections_by_result", "inspections_pending",
          "inspections_total", "rep_leaderboard_rank", "inspections_by_inspector",
          "claims_signed_by_rep",
        ],
      },
      person_name: { type: "string" },
      person_role: { type: "string", enum: ["sales_rep", "inspector", "pa"] },
      result_filter: { type: "string", enum: ["damage", "no_damage", "retail", "lost", "any"] },
      date_range: { type: "string", enum: ["this_week", "last_week", "this_month", "last_30_days", "all_time", "custom"] },
      custom_start: { type: "string" },
      custom_end: { type: "string" },
      tool_key: { type: "string", enum: TOOL_KEYS },
      nav_label: { type: "string" },
      clarify_question: { type: "string" },
    },
    required: ["kind"],
  },
};

async function classify(question) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 512,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: question }],
      tools: [ANSWER_PLAN_TOOL],
      tool_choice: { type: "tool", name: "answer_plan" },
    }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`anthropic ${res.status} ${t.slice(0, 200)}`);
  }
  const dataJson = await res.json();
  const block = (dataJson.content || []).find((b) => b.type === "tool_use");
  if (!block || !block.input) throw new Error("no tool_use in Anthropic response");
  return block.input;
}

// ── Name matching ────────────────────────────────────────────────────
// Collapse nicknames/parentheticals/punctuation so two-surname and
// quoted-nickname reps match. Mirrors manager-records-api.js.
function normalizeName(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/["“”]([^"“”]*)["“”]/g, "")
    .replace(/'([^']*)'/g, "")
    .replace(/\(([^)]*)\)/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function nameMatches(rowName, queryName) {
  const a = normalizeName(rowName);
  const b = normalizeName(queryName);
  if (!a || !b) return false;
  return a.includes(b) || b.includes(a);
}
function distinctNames(rows) {
  const seen = new Map();
  for (const r of rows) {
    const k = normalizeName(r.sales_rep_name);
    if (k && !seen.has(k)) seen.set(k, r.sales_rep_name);
  }
  return [...seen.values()];
}
function plural(n, word) { return n === 1 ? word : word + "s"; }

// ── Supabase REST ────────────────────────────────────────────────────
async function fetchTable(table, { select, filter, order, limit }) {
  let url = `${SB_URL}/rest/v1/${table}?select=${encodeURIComponent(select)}`;
  if (filter) url += `&${filter}`;
  if (order) url += `&order=${encodeURIComponent(order)}`;
  if (limit) url += `&limit=${limit}`;
  const res = await fetch(url, { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` } });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    console.warn(`Supabase ${table} query failed: ${res.status} ${txt.slice(0, 200)}`);
    return [];
  }
  return await res.json().catch(() => []);
}

// ── Signed-inspection dedup — mirrors zone-leaderboard.js / App.jsx so a
//    "total" count equals the app's weekly "submissions" number.
function dedupSignings(rows) {
  const PENDING_STATUSES = new Set(["", "needs inspection", "new lead"]);
  const normKey = (n, zip, addr) => {
    const nn = (n || "").trim().toLowerCase().replace(/\s+/g, " ");
    const z = (zip || "").trim();
    if (z) return `${nn}|zip:${z}`;
    return `${nn}|st:${(addr || "").split(",")[0].trim().toLowerCase().replace(/\s+/g, " ")}`;
  };
  const groupByKey = new Map();
  for (const r of rows || []) {
    const k = normKey(r.client_name, r.zip, r.address);
    const ex = groupByKey.get(k);
    if (!ex) { groupByKey.set(k, r); continue; }
    if (r.result && !ex.result) { groupByKey.set(k, r); continue; }
    if (ex.result && !r.result) continue;
    const tNew = r.result_at ? new Date(r.result_at).getTime() : (r.signed_at ? new Date(r.signed_at).getTime() : 0);
    const tOld = ex.result_at ? new Date(ex.result_at).getTime() : (ex.signed_at ? new Date(ex.signed_at).getTime() : 0);
    if (tNew >= tOld) groupByKey.set(k, r);
  }
  return [...groupByKey.values()];
}

// ── Date windows (America/New_York, DST-safe) — mirrors zone-leaderboard.js
const TZ = "America/New_York";
function tzParts(date) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ, hour12: false, weekday: "short",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const p = {};
  for (const part of dtf.formatToParts(date)) p[part.type] = part.value;
  return p;
}
function offsetMs(date) {
  const p = tzParts(date);
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUTC - date.getTime();
}
function etWallToUTC(y, mo, d, h, mi, s) {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  const off = offsetMs(new Date(guess));
  return new Date(guess - off);
}
function weekRange(now = new Date()) {
  const p = tzParts(now);
  const DOW = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
  const dow = DOW[p.weekday] ?? 0;
  const base = new Date(Date.UTC(+p.year, +p.month - 1, +p.day));
  base.setUTCDate(base.getUTCDate() - dow);
  const start = etWallToUTC(base.getUTCFullYear(), base.getUTCMonth() + 1, base.getUTCDate(), 0, 0, 0);
  const endBase = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate()));
  endBase.setUTCDate(endBase.getUTCDate() + 6);
  const end = etWallToUTC(endBase.getUTCFullYear(), endBase.getUTCMonth() + 1, endBase.getUTCDate(), 23, 59, 59);
  return { start, end };
}

// Returns { startIso, endIso } or null (all-time / unrecognized).
function resolveWindow(range, customStart, customEnd) {
  const now = new Date();
  if (!range || range === "all_time") return null;
  if (range === "this_week") { const { start, end } = weekRange(now); return iso(start, end); }
  if (range === "last_week") {
    const { start, end } = weekRange(now);
    return iso(new Date(start.getTime() - 7 * 86400000), new Date(end.getTime() - 7 * 86400000));
  }
  if (range === "this_month") {
    const p = tzParts(now);
    const start = etWallToUTC(+p.year, +p.month, 1, 0, 0, 0);
    return iso(start, now);
  }
  if (range === "last_30_days") {
    return iso(new Date(now.getTime() - 30 * 86400000), now);
  }
  if (range === "custom") {
    const s = customStart ? new Date(customStart) : null;
    const e = customEnd ? new Date(customEnd) : now;
    if (!s || isNaN(s.getTime())) return null;
    return iso(s, isNaN(e.getTime()) ? now : e);
  }
  return null;
}
function iso(start, end) { return { startIso: start.toISOString(), endIso: end.toISOString() }; }

function windowFilter(field, win) {
  if (!win) return "";
  return `&${field}=gte.${encodeURIComponent(win.startIso)}&${field}=lte.${encodeURIComponent(win.endIso)}`;
}
function windowLabel(range) {
  switch (range) {
    case "this_week": return "this week";
    case "last_week": return "last week";
    case "this_month": return "this month";
    case "last_30_days": return "in the last 30 days";
    case "custom": return "in that range";
    default: return "all time";
  }
}

function json(status, body) {
  return {
    statusCode: status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    body: JSON.stringify(body),
  };
}
