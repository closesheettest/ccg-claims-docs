// netlify/functions/leaderboard-notify.js
//
// Watches the weekly team leaderboards and texts the field when the
// standings move. Two kinds of hype, both company-wide (every active
// sales rep + regional manager), gated by the same auto_sms switch:
//
//   1. NEW STRICT 1st  — a team pulls strictly ahead and takes 1st.
//      ("🦈 SHARKS just took 1st place — 12 signed this week!")
//      Fires only on the INSP (signed inspections) board, only when the
//      leader CHANGES from the last run. Unchanged: silent.
//
//   2. TIE FOR 1st     — two or more teams are dead even at the top
//      (count > 0). ("🤝 IT'S A TIE FOR 1ST! HURRICANE & SitSold …")
//      Fires on BOTH boards (INSP signed + SALES sold), once per new tie
//      — re-fires only if the tied set or the count changes. When the
//      tie breaks, the state clears so the next tie fires fresh.
//
// Sources of truth are the public zone-leaderboard / zone-sales-leaderboard
// functions (same week window + dedup + zone counts the dashboard uses).
// The SMS fan-out is handed to leaderboard-blast-background so a big roster
// can't blow the scheduled function's short timeout.
//
// Trigger:
//   • Netlify scheduled function — every 5 minutes (also in netlify.toml).
//   • Manual GET /.netlify/functions/leaderboard-notify (?dry=1 to detect
//     + report without sending).
//
// State lives in the Supabase leaderboard_state table (id-keyed rows), same
// anon-key REST access every other function here uses. One-time setup SQL:
//
//   create table if not exists leaderboard_state (
//     id text primary key, zone text, team text, count int,
//     week text, updated_at timestamptz default now());
//   grant select, insert, update on leaderboard_state to anon;
//
// (Rows used: 'leader' = INSP strict leader; 'tie_insp' / 'tie_sales' =
// last tie signature per board. New rows are created on first write — no
// migration needed beyond the table above.)
//
// Required env: VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY and URL
// (auto-set by Netlify, base for the internal function calls).

const SB_URL = process.env.VITE_SUPABASE_URL
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY
const AUTO_SMS_KEY = 'leaderboard_hype'

// The boards we watch. `hype` = also fire the strict-1st "took 1st" text
// (kept INSP-only to preserve existing behavior; both boards get tie texts).
const BOARDS = [
  { feed: 'zone-leaderboard',       word: 'signed', leaderStateId: 'leader',       tieStateId: 'tie_insp',  hype: true },
  { feed: 'zone-sales-leaderboard', word: 'sold',   leaderStateId: 'leader_sales', tieStateId: 'tie_sales', hype: false },
]

export const handler = async (event) => {
  const dry = !!(event?.queryStringParameters?.dry)
  const base =
    process.env.URL || process.env.DEPLOY_URL || process.env.PUBLIC_SITE_URL || ''

  // One on/off + extra copy-recipients switch covers both kinds of hype.
  const cfg = await loadAutoSms(AUTO_SMS_KEY)
  if (!cfg.enabled) {
    return json(200, { ok: true, fired: false, reason: 'disabled in auto_sms' })
  }

  const results = []
  for (const board of BOARDS) {
    try {
      results.push(await processBoard(board, { base, dry, cfg }))
    } catch (e) {
      results.push({ feed: board.feed, ok: false, error: e.message || String(e) })
    }
  }
  return json(200, { ok: true, dry, results })
}

// Process one leaderboard: detect a new tie-for-1st (always) and a new
// strict leader (when board.hype), firing the matching company-wide blast.
async function processBoard(board, ctx) {
  const { base, dry, cfg } = ctx

  let lb
  try {
    const r = await fetch(`${base}/.netlify/functions/${board.feed}`)
    lb = await r.json()
    if (!r.ok || !lb?.ok) return { feed: board.feed, ok: false, error: 'feed unavailable' }
  } catch (e) {
    return { feed: board.feed, ok: false, error: `fetch failed: ${e.message}` }
  }

  const zones = (lb.zones || []).slice().sort((a, b) => (b.count || 0) - (a.count || 0))
  const top = zones[0]
  const runner = zones[1]
  const week = lb.week?.start || ''
  const topCount = top ? (top.count || 0) : 0
  const tiedTeams = topCount > 0 ? zones.filter((z) => (z.count || 0) === topCount) : []
  const isTie = tiedTeams.length >= 2
  const hasStrictLeader = !!top && topCount > 0 && (!runner || topCount > (runner.count || 0))

  const out = { feed: board.feed, ok: true, fired: [] }

  // ── 1. Tie for 1st (both boards) ─────────────────────────────────────
  const prevTie = await readState(board.tieStateId)
  const prevSig = prevTie && prevTie.week === week ? (prevTie.zone || '') : ''
  // Signature = the tied teams + the count. Changes if a team joins/leaves
  // the tie or the count moves, so a genuinely new tie re-fires.
  const sig = isTie ? tiedTeams.map((z) => z.zone).sort().join('|') + '@' + topCount : ''
  if (isTie && sig !== prevSig) {
    const message = buildTieMessage(tiedTeams, topCount, board.word)
    if (dry) {
      out.would_tie = message
    } else {
      out.fired.push({ kind: 'tie', blast: await triggerBlast(base, message, cfg.recipients), message })
      await writeState({ id: board.tieStateId, zone: sig, team: null, count: topCount, week })
    }
  } else if (!isTie && prevSig && !dry) {
    // Tie broke — clear so the next tie fires fresh.
    await writeState({ id: board.tieStateId, zone: '', team: null, count: null, week })
  }

  // ── 2. New strict 1st (INSP only, unchanged behavior) ────────────────
  if (board.hype) {
    const prev = await readState(board.leaderStateId)
    const prevZone = prev && prev.week === week ? prev.zone : null
    const changed = hasStrictLeader && top.zone !== prevZone
    const nextState = hasStrictLeader
      ? { id: board.leaderStateId, zone: top.zone, team: top.team, count: topCount, week }
      : { id: board.leaderStateId, zone: prevZone, team: null, count: null, week }
    if (!dry) await writeState(nextState)
    if (changed) {
      const message = buildMessage(top, runner)
      if (dry) out.would_leader = message
      else out.fired.push({ kind: 'leader', blast: await triggerBlast(base, message, cfg.recipients), message })
    }
  }

  return out
}

// Fan the message out to the whole field via the background blast.
async function triggerBlast(base, message, recipients) {
  try {
    const r = await fetch(`${base}/.netlify/functions/leaderboard-blast-background`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, extraRecipients: recipients }),
    })
    return r.ok || r.status === 202
  } catch (e) {
    console.warn('Blast trigger threw:', e.message || e)
    return false
  }
}

// Per-team flair on the lead line; generic trophy for any unnamed zone.
const LEAD_EMOJI = { SHARKS: '🦈', SQUAD: '💥', HURRICANE: '🌀', SitSold: '🔥' }
// Full https:// so phones reliably turn it into a tappable link.
const DASHBOARD_URL = 'https://us-shingle-rep-dashboard.netlify.app'

// Carrier-safe: one line, no emoji, plain words, one bare-domain link, <160 chars
// (see cron-daily-leaderboard for why emoji-dense multi-line texts get filtered).
const DASH = DASHBOARD_URL.replace(/^https?:\/\//, '')
function buildMessage(top, runner) {
  let msg = `US Shingle: ${top.team} just took 1st with ${top.count} signed this week`
  if (runner && runner.count > 0) msg += `, ${runner.team} right behind at ${runner.count}`
  return `${msg}. Board: ${DASH}`
}

function buildTieMessage(tiedTeams, count, word) {
  const names = tiedTeams.map((z) => z.team)
  const who = names.length === 2 ? names.join(' & ') : names.slice(0, -1).join(', ') + ' & ' + names[names.length - 1]
  return `US Shingle: tie for 1st — ${who} even at ${count} ${word} this week. Board: ${DASH}`
}

// ── Leaderboard state in Supabase (id-keyed single rows) ─────────────
// A read failure / missing row is treated as "no prior state" — worst case
// one extra text, never a crash.

async function readState(id) {
  if (!SB_URL || !SB_KEY) return null
  try {
    const res = await fetch(
      `${SB_URL}/rest/v1/leaderboard_state?id=eq.${encodeURIComponent(id)}&select=zone,week&limit=1`,
      { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` } },
    )
    if (!res.ok) { console.warn('state read failed:', res.status); return null }
    const rows = await res.json().catch(() => [])
    return rows[0] || null
  } catch (e) {
    console.warn('state read threw:', e.message || e)
    return null
  }
}

async function writeState(state) {
  if (!SB_URL || !SB_KEY) return
  try {
    // Upsert on the primary key so each id row is updated in place.
    const res = await fetch(`${SB_URL}/rest/v1/leaderboard_state`, {
      method: 'POST',
      headers: {
        apikey: SB_KEY,
        Authorization: `Bearer ${SB_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify(state),
    })
    if (!res.ok) console.warn('state write failed:', res.status, await res.text().catch(() => ''))
  } catch (e) {
    console.warn('state write threw:', e.message || e)
  }
}

// ── auto_sms registry helper (fail-open) ────────────────────────────
async function loadAutoSms(key) {
  if (!SB_URL || !SB_KEY) return { enabled: true, recipients: [] }
  try {
    const r = await fetch(
      `${SB_URL}/rest/v1/auto_sms?key=eq.${encodeURIComponent(key)}&select=enabled,recipients&limit=1`,
      { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` } },
    )
    if (!r.ok) return { enabled: true, recipients: [] }
    const rows = await r.json().catch(() => [])
    const row = rows[0]
    if (!row) return { enabled: true, recipients: [] }
    const recipients = Array.isArray(row.recipients) ? row.recipients : []
    return { enabled: row.enabled !== false, recipients }
  } catch {
    return { enabled: true, recipients: [] }
  }
}

function json(status, body) {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }
}

// Netlify scheduled function — every 5 minutes. Mirrored in netlify.toml.
export const config = { schedule: '*/5 * * * *' }
