// netlify/functions/leaderboard-notify.js
//
// Watches the weekly team leaderboard and, when a *new* team takes
// strict 1st place, texts every active sales rep + regional manager a
// hype message ("🦈 SHARKS just took 1st place …"). The idea is field
// reps feel the standings move in real time and push to retake the lead.
//
// How it decides to fire:
//   • Reuses the public zone-leaderboard function (single source of
//     truth for the week window + dedup + zone counts) instead of
//     re-deriving them here.
//   • "Strict 1st" = top team has count > 0 AND is strictly ahead of
//     the runner-up. A tie at the top does NOT count as taking 1st, so
//     we never fire on ambiguous standings.
//   • Fires only when the strict leader *changes* from the last run.
//     Extending an existing lead is silent. The previous leader is
//     remembered in Netlify Blobs (no DB table needed). The stored
//     value is week-stamped, so Monday's reset starts fresh and the
//     first team to pull ahead that week fires a "took 1st".
//
// The actual SMS fan-out is handed to leaderboard-blast-background so a
// big roster can't blow the scheduled function's short timeout.
//
// Trigger:
//   • Netlify scheduled function — every 5 minutes (also declared in
//     netlify.toml).
//   • Manual GET /.netlify/functions/leaderboard-notify for debugging;
//     add ?dry=1 to detect + report without sending.
//
// Required env: VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY (used by the
// leaderboard fn it calls) and URL (auto-set by Netlify, base for the
// internal function calls).

import { getStore } from '@netlify/blobs'

const STORE = 'leaderboard'
const KEY = 'leader'

export const handler = async (event) => {
  const dry = !!(event?.queryStringParameters?.dry)
  const base =
    process.env.URL || process.env.DEPLOY_URL || process.env.PUBLIC_SITE_URL || ''

  // 1. Pull current standings from the public leaderboard fn.
  let lb
  try {
    const r = await fetch(`${base}/.netlify/functions/zone-leaderboard`)
    lb = await r.json()
    if (!r.ok || !lb?.ok) {
      return json(502, { ok: false, error: 'zone-leaderboard unavailable', detail: lb })
    }
  } catch (e) {
    return json(502, { ok: false, error: `Could not reach zone-leaderboard: ${e.message}` })
  }

  const zones = lb.zones || []
  const top = zones[0]
  const runner = zones[1]
  const week = lb.week?.start || ''
  const hasStrictLeader = !!top && top.count > 0 && (!runner || top.count > runner.count)

  // 2. Read the remembered leader (week-stamped). Different week ⇒ treat
  //    as no prior leader so the first strict lead of the week fires.
  const store = getStore(STORE)
  let prev = null
  try {
    prev = await store.get(KEY, { type: 'json' })
  } catch (e) {
    console.warn('Blobs read failed (treating as no prior leader):', e.message || e)
  }
  const prevZone = prev && prev.week === week ? prev.zone : null

  const changed = hasStrictLeader && top.zone !== prevZone

  // 3. Persist current state. On a strict leader, store it. On a tie /
  //    all-zero, keep this week's prior leader but reset across weeks.
  const nextState = hasStrictLeader
    ? { zone: top.zone, team: top.team, count: top.count, week }
    : { zone: prevZone, week }
  if (!dry) {
    try { await store.setJSON(KEY, nextState) }
    catch (e) { console.warn('Blobs write failed:', e.message || e) }
  }

  if (!changed) {
    return json(200, {
      ok: true,
      fired: false,
      leader: hasStrictLeader ? top.team : null,
      prevLeader: prevZone,
      reason: !hasStrictLeader ? 'no strict leader (tie or zero)' : 'leader unchanged',
    })
  }

  // 4. New leader — compose the hype message and hand off the blast.
  const message = buildMessage(top, runner)

  if (dry) {
    return json(200, { ok: true, fired: false, dry: true, would_send: message })
  }

  let blastOk = false
  try {
    const r = await fetch(`${base}/.netlify/functions/leaderboard-blast-background`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message }),
    })
    blastOk = r.ok || r.status === 202
    if (!blastOk) console.warn('Blast trigger returned', r.status)
  } catch (e) {
    console.warn('Blast trigger threw:', e.message || e)
  }

  return json(200, {
    ok: true,
    fired: true,
    leader: top.team,
    prevLeader: prevZone,
    blast_triggered: blastOk,
    message,
  })
}

// Per-team flair on the lead line; generic trophy for any unnamed zone.
const LEAD_EMOJI = { SHARKS: '🦈', SQUAD: '💥' }
// Full https:// so phones reliably turn it into a tappable link — SMS
// can't hide a URL behind "click here" text the way email can.
const DASHBOARD_URL = 'https://us-shingle-rep-dashboard.netlify.app'

function buildMessage(top, runner) {
  const lead = LEAD_EMOJI[top.team] || '🏆'
  const lines = [
    `${lead} ${top.team} just took 1st place — ${top.count} signed this week!`,
  ]
  if (runner && runner.count > 0) {
    lines.push(`🥈 ${runner.team} right behind at ${runner.count}.`)
  }
  lines.push('Who’s next?!')
  lines.push(`👉 Click here for the full details: ${DASHBOARD_URL}`)
  return lines.join('\n')
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
