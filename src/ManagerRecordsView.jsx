import React, { useEffect, useMemo, useState } from 'react'

// Zone-scoped Regional Manager records page.
//
// URL: /?manager=<token>  (token comes from the regional_managers table)
//
// Layout (responsive):
//   ┌─ Hi <Manager> — Zone <N> Records ─────────────┐
//   │  Banner explains "you see every deal one of   │
//   │  YOUR reps sold." Background uses the zone's  │
//   │  canonical color so the manager's eye lands   │
//   │  on the right zone instantly.                 │
//   ├───────────────────────────────────────────────┤
//   │  ⏰ Pending Signatures (N)                    │
//   │  Banner-style list of stuck PA-form deals.    │
//   ├───────────────────────────────────────────────┤
//   │  ⚠ How to use this page  (3 bullets)          │
//   ├───────────────────────────────────────────────┤
//   │  Search + filter chips                        │
//   ├───────────────────────────────────────────────┤
//   │  Left: deal list grouped by rep               │
//   │  Right: detail panel for selected deal        │
//   └───────────────────────────────────────────────┘
//
// Phase 1 — read-only. The Push / Cert / Edit buttons render but
// clicking them shows a "Phase 2 will wire this to the real action"
// confirmation that explains what they'd do. We do this so Neal can
// see the layout + flow before we touch any JN-writing code paths.

// Canonical zone palette — must match
//   us-shingle-rep-dashboard/index.html :root vars
//   training-management-system/src/lib/zones.js ZONE_COLORS
// If these three diverge, the rep's eye no longer trusts the colors.
const ZONE_COLORS = {
  'Zone 1': { deep: '#E63946', light: '#fee2e2' },
  'Zone 2': { deep: '#1D6FB8', light: '#dbeafe' },
  'Zone 3': { deep: '#2A9D4A', light: '#d1fae5' },
  'Zone 4': { deep: '#F77F00', light: '#ffedd5' },
}
const NEUTRAL = { deep: '#475569', light: '#e2e8f0' }

// Team names per zone — must match TMS lib/zones.js ZONE_TEAMS.
// When a manager names their team, add the entry here AND in TMS so
// both surfaces show the same label.
const ZONE_TEAMS = {
  'Zone 1': 'SQUAD',
}
// Render zone label as "TEAM (Zone N)" if the zone has a team name,
// else fall back to just "Zone N". Mirrors teamLabel() in TMS.
function teamLabel(zone) {
  if (!zone) return ''
  const team = ZONE_TEAMS[zone]
  return team ? `${team} (${zone})` : zone
}

export default function ManagerRecordsView({ token }) {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [data, setData] = useState(null)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState('all') // 'all' | 'attention' | 'pending'
  const [selectedDealId, setSelectedDealId] = useState(null)
  const [openReps, setOpenReps] = useState({}) // repName → bool

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    fetch('/.netlify/functions/manager-records-api', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'records', token }),
    })
      .then(async (r) => {
        const j = await r.json().catch(() => ({}))
        if (!r.ok || !j.ok) throw new Error(j.error || `Server error (${r.status})`)
        if (!cancelled) {
          setData(j)
          // Auto-open every rep that has an attention-needing deal so
          // the manager doesn't have to expand them manually.
          const open = {}
          for (const [rep, deals] of Object.entries(j.dealsByRep || {})) {
            if (deals.some((d) => isAttention(d))) open[rep] = true
          }
          setOpenReps(open)
        }
      })
      .catch((e) => !cancelled && setError(e.message || 'Failed to load'))
      .finally(() => !cancelled && setLoading(false))
    return () => { cancelled = true }
  }, [token])

  const zoneTheme = data?.manager?.zone
    ? ZONE_COLORS[data.manager.zone] || NEUTRAL
    : NEUTRAL

  // Filter deals by search query + filter chip.
  const filteredDealsByRep = useMemo(() => {
    if (!data?.dealsByRep) return {}
    const q = query.trim().toLowerCase()
    const out = {}
    for (const [rep, deals] of Object.entries(data.dealsByRep)) {
      const keep = deals.filter((d) => {
        if (filter === 'attention' && !isAttention(d)) return false
        if (filter === 'pending' && !isPending(d)) return false
        if (q) {
          const hay = `${d.homeowner_name} ${d.address} ${d.city} ${d.zip}`.toLowerCase()
          if (!hay.includes(q)) return false
        }
        return true
      })
      if (keep.length > 0) out[rep] = keep
    }
    return out
  }, [data, query, filter])

  // Sort reps by count desc, then alphabetical, so the busiest sit on top.
  const sortedReps = useMemo(() => {
    return Object.entries(filteredDealsByRep).sort((a, b) => {
      if (b[1].length !== a[1].length) return b[1].length - a[1].length
      return a[0].localeCompare(b[0])
    })
  }, [filteredDealsByRep])

  const selectedDeal = useMemo(() => {
    if (!selectedDealId || !data?.dealsByRep) return null
    for (const deals of Object.values(data.dealsByRep)) {
      const hit = deals.find((d) => d.id === selectedDealId)
      if (hit) return hit
    }
    return null
  }, [selectedDealId, data])

  // Optimistically fold a successful JN push back into local state so the
  // push-status badges flip the instant the upload finishes (the server
  // stamp persists it for the next reload).
  const patchDeal = (dealId, patch) => {
    setData((prev) => {
      if (!prev?.dealsByRep) return prev
      const dealsByRep = {}
      for (const [rep, deals] of Object.entries(prev.dealsByRep)) {
        dealsByRep[rep] = deals.map((d) => (d.id === dealId ? { ...d, ...patch } : d))
      }
      return { ...prev, dealsByRep }
    })
  }

  if (loading) return <CenterMsg theme={NEUTRAL}>Loading your records…</CenterMsg>
  if (error) return <CenterMsg theme={NEUTRAL} bad>{error}</CenterMsg>
  if (!data) return null

  return (
    <div style={{ minHeight: '100vh', background: '#f8fafc', padding: '16px' }}>
      <div style={{ maxWidth: 1280, margin: '0 auto' }}>

        {/* ─────────── Header ─────────── */}
        <header style={{
          background: zoneTheme.deep,
          color: '#fff',
          borderRadius: 12,
          padding: '18px 22px',
          marginBottom: 14,
          boxShadow: '0 1px 3px rgba(15,23,42,0.1)',
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: 12 }}>
            <div>
              <h1 style={{ fontSize: 24, fontWeight: 800, margin: 0 }}>
                Hi {data.manager.name} — {teamLabel(data.manager.zone)} Records
              </h1>
              <p style={{ margin: '4px 0 0', opacity: 0.9, fontSize: 14 }}>
                You're seeing every deal one of <strong>your</strong> reps sold.
                ({data.totals.deals} deal{data.totals.deals === 1 ? '' : 's'} across{' '}
                {data.totals.reps} rep{data.totals.reps === 1 ? '' : 's'})
              </p>
            </div>
            <Pill label="TEAM" value={teamLabel(data.manager.zone)} bg="#fff" fg={zoneTheme.deep} />
          </div>
        </header>

        {/* ─────────── Pending Signatures banner ─────────── */}
        {data.pendingSignatures.length > 0 && (
          <section style={{
            background: '#fff7ed',
            border: '2px solid #f59e0b',
            borderRadius: 12,
            padding: '14px 18px',
            marginBottom: 14,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
              <span style={{ fontSize: 22 }}>⏰</span>
              <h2 style={{ margin: 0, color: '#7c2d12', fontSize: 17, fontWeight: 800 }}>
                Pending Signatures ({data.pendingSignatures.length})
              </h2>
            </div>
            <p style={{ margin: '0 0 10px', color: '#7c2d12', fontSize: 13 }}>
              Deals where the homeowner signed the inspection but the PA forms
              (LOR / PAC) didn't get signed. Call the homeowner — finish the
              forms — then come back and confirm here.
            </p>
            <ul style={{ margin: 0, paddingLeft: 20, color: '#451a03', fontSize: 13.5 }}>
              {data.pendingSignatures.slice(0, 10).map((d) => (
                <li key={d.id} style={{ marginBottom: 4 }}>
                  <button
                    type="button"
                    onClick={() => setSelectedDealId(d.id)}
                    style={{
                      background: 'none', border: 'none', padding: 0,
                      color: '#7c2d12', textDecoration: 'underline',
                      cursor: 'pointer', fontWeight: 700, fontSize: 13.5,
                    }}
                  >
                    {d.homeowner_name || '(no name)'}
                  </button>
                  <span style={{ opacity: 0.8 }}>
                    {' · '}{d.sales_rep_name || '(rep unknown)'}
                    {' · '}{describeMissingDocs(d)}
                  </span>
                </li>
              ))}
              {data.pendingSignatures.length > 10 && (
                <li style={{ opacity: 0.7, fontStyle: 'italic' }}>
                  + {data.pendingSignatures.length - 10} more — switch to
                  "Pending only" below to see them all.
                </li>
              )}
            </ul>
          </section>
        )}

        {/* ─────────── How-to banner ─────────── */}
        <section style={{
          background: '#eff6ff',
          border: '1px solid #bfdbfe',
          borderRadius: 12,
          padding: '14px 18px',
          marginBottom: 14,
          fontSize: 13.5,
          color: '#1e3a8a',
        }}>
          <strong style={{ display: 'block', marginBottom: 4 }}>⚠ How to use this page</strong>
          <ul style={{ margin: 0, paddingLeft: 22, lineHeight: 1.55 }}>
            <li>Tap a deal in the list to see what's already in JobNimbus on the right.</li>
            <li><strong>Photos missing in JN?</strong> Tap <strong>📸 Send Photos to JN</strong> — re-uploads them.</li>
            <li><strong>No certificate in JN?</strong> Tap <strong>📄 Send Cert to JN</strong> — generates it and uploads.</li>
            <li><strong>Wrong homeowner name or address?</strong> Tap <strong>✏️ Edit Details</strong>.</li>
            <li>If a row has a ⚠ next to it, something needs your attention. If a row has ✅ it's all good — no action needed.</li>
          </ul>
        </section>

        {/* ─────────── Search + filter ─────────── */}
        <section style={{
          background: '#fff', border: '1px solid #e2e8f0', borderRadius: 12,
          padding: 12, marginBottom: 14,
          display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center',
        }}>
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search homeowner, address, zip…"
            style={{
              flex: '1 1 240px', minWidth: 200,
              padding: '8px 12px', border: '1px solid #cbd5e1',
              borderRadius: 8, fontSize: 14, outline: 'none',
            }}
          />
          <FilterChip active={filter === 'all'} onClick={() => setFilter('all')} theme={zoneTheme}>
            All ({data.totals.deals})
          </FilterChip>
          <FilterChip active={filter === 'attention'} onClick={() => setFilter('attention')} theme={zoneTheme}>
            ⚠ Needs attention ({data.totals.needs_attention})
          </FilterChip>
          <FilterChip active={filter === 'pending'} onClick={() => setFilter('pending')} theme={zoneTheme}>
            ⏰ Pending signatures ({data.totals.pending_signatures})
          </FilterChip>
        </section>

        {/* ─────────── Two-column layout (mobile: stacked) ─────────── */}
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 380px)', gap: 14, alignItems: 'start' }}
             className="mgr-grid">
          {/* LEFT — Rep groups */}
          <div>
            {sortedReps.length === 0 ? (
              <div style={{
                background: '#fff', border: '1px dashed #cbd5e1', borderRadius: 12,
                padding: 24, textAlign: 'center', color: '#475569',
              }}>
                No deals match — try clearing the search or switching the filter chip above.
              </div>
            ) : sortedReps.map(([rep, deals]) => {
              const attentionCount = deals.filter(isAttention).length
              const isOpen = openReps[rep] ?? false
              return (
                <section key={rep} style={{
                  background: '#fff', border: '1px solid #e2e8f0', borderRadius: 12,
                  marginBottom: 10, overflow: 'hidden',
                }}>
                  <button
                    type="button"
                    onClick={() => setOpenReps((s) => ({ ...s, [rep]: !isOpen }))}
                    style={{
                      width: '100%', background: '#f8fafc', border: 'none',
                      padding: '12px 16px', textAlign: 'left',
                      display: 'flex', justifyContent: 'space-between',
                      alignItems: 'center', cursor: 'pointer', fontSize: 15,
                    }}
                  >
                    <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <span style={{
                        display: 'inline-block', width: 8, height: 8, borderRadius: 4,
                        background: attentionCount > 0 ? '#f59e0b' : '#10b981',
                      }} />
                      <strong>{rep}</strong>
                      <span style={{ color: '#64748b', fontSize: 13 }}>
                        · {deals.length} deal{deals.length === 1 ? '' : 's'}
                        {attentionCount > 0 && (
                          <> · <span style={{ color: '#b45309', fontWeight: 700 }}>
                            {attentionCount} need{attentionCount === 1 ? 's' : ''} attention
                          </span></>
                        )}
                      </span>
                    </span>
                    <span style={{ fontSize: 18, color: '#64748b' }}>{isOpen ? '▾' : '▸'}</span>
                  </button>

                  {isOpen && (
                    <div>
                      {deals.map((d) => (
                        <DealRow
                          key={d.id}
                          deal={d}
                          selected={d.id === selectedDealId}
                          onSelect={() => setSelectedDealId(d.id)}
                          theme={zoneTheme}
                          token={token}
                          onDealPatch={patchDeal}
                        />
                      ))}
                    </div>
                  )}
                </section>
              )
            })}
          </div>

          {/* RIGHT — Detail panel */}
          <aside style={{
            position: 'sticky', top: 16,
            background: '#fff', border: '1px solid #e2e8f0', borderRadius: 12,
            padding: 16, minHeight: 200, fontSize: 13.5,
          }}>
            {!selectedDeal ? (
              <div style={{ color: '#94a3b8', textAlign: 'center', padding: '40px 8px' }}>
                <div style={{ fontSize: 36, marginBottom: 8 }}>👈</div>
                <p style={{ margin: 0 }}>Tap a deal on the left to see what's in JobNimbus.</p>
              </div>
            ) : (
              <DealDetail deal={selectedDeal} theme={zoneTheme} />
            )}
          </aside>
        </div>

        {/* Responsive stack — at narrow widths, force grid to 1 column */}
        <style>{`
          @media (max-width: 900px) {
            .mgr-grid { grid-template-columns: 1fr !important; }
          }
        `}</style>

        <footer style={{ textAlign: 'center', color: '#94a3b8', fontSize: 11, marginTop: 30 }}>
          U.S. Shingle &amp; Metal — {teamLabel(data.manager.zone)} Manager Records
        </footer>
      </div>
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────
// Sub-components

function DealRow({ deal, selected, onSelect, theme, token, onDealPatch }) {
  const attention = isAttention(deal)
  const pending = isPending(deal)
  const badgeColor = attention ? '#f59e0b' : '#10b981'
  const badgeIcon = attention ? (pending ? '⏰' : '⚠') : '✅'

  // Per-deal push state. busy = which action is running; msg = result.
  const [busy, setBusy] = useState(null) // 'photos' | 'cert' | null
  const [msg, setMsg] = useState(null) // { ok: bool, text }

  const push = jnPushParts(deal)
  // Photos are pushed FROM the inspector record, so we need a real
  // inspection id + a result. Claim-track deals don't carry one.
  const canPushPhotos = deal.source === 'inspection' && !!deal.inspection_result
  // The cert renders from the JN job itself, so it only needs a JN job id.
  const canPushCert = !!deal.jn_job_id

  async function runPhotos(e) {
    e.stopPropagation()
    if (busy) return
    setBusy('photos'); setMsg(null)
    try {
      const r = await pushPhotosToJn(deal)
      const patch = { jn_pushed_at: new Date().toISOString(), jn_job_id: r.jnJobId }
      await stampJn(token, deal.id, patch)
      onDealPatch(deal.id, patch)
      setMsg({
        ok: true,
        text: r.lost
          ? 'Marked Lost in JN — no photos to upload.'
          : `Photos sent: ${r.uploaded} uploaded` +
            (r.alreadyIn ? `, ${r.alreadyIn} already in JN` : '') +
            (r.failed ? `, ${r.failed} failed` : '') + '.',
      })
    } catch (err) {
      setMsg({ ok: false, text: err.message || 'Photo push failed.' })
    } finally {
      setBusy(null)
    }
  }

  async function runCert(e) {
    e.stopPropagation()
    if (busy) return
    setBusy('cert'); setMsg(null)
    try {
      await pushCertToJn(deal)
      const patch = { jn_cert_uploaded_at: new Date().toISOString() }
      await stampJn(token, deal.id, patch)
      onDealPatch(deal.id, patch)
      setMsg({ ok: true, text: 'Certificate generated and uploaded to JobNimbus.' })
    } catch (err) {
      setMsg({ ok: false, text: err.message || 'Cert push failed.' })
    } finally {
      setBusy(null)
    }
  }

  return (
    <div
      style={{
        borderTop: '1px solid #e2e8f0',
        padding: '12px 16px',
        background: selected ? theme.light : '#fff',
        cursor: 'pointer',
      }}
      onClick={onSelect}
    >
      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
        <span style={{ fontSize: 18, color: badgeColor }}>{badgeIcon}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 14, color: '#0f172a' }}>
            {deal.homeowner_name || '(no name on record)'}
          </div>
          {/* At-a-glance JN state badges — one per piece of data the
              manager is responsible for. Each badge has a tone (green
              done / amber pending / red missing / gray n/a) so the
              eye can sweep the column. Hover for the long-form
              meaning. Computed from local data only — no JN API
              calls per row. */}
          <BadgeRow deal={deal} />
          <div style={{ color: '#475569', fontSize: 12.5, marginTop: 6 }}>
            {[deal.address, deal.city, deal.zip].filter(Boolean).join(' · ') || '(no address)'}
          </div>

          {/* Readable per-customer labels: signed date, inspection
              result, PA result, and exactly what's in JobNimbus. */}
          <DealFacts deal={deal} push={push} />

          <div style={{ color: '#64748b', fontSize: 11.5, marginTop: 4 }}>
            {describeDealStatus(deal)}
          </div>

          {/* Action buttons — live JN pushes. */}
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
            <ActionButton
              label={busy === 'photos' ? '⏳ Sending Photos…' : push.photos ? '📸 Re-send Photos to JN' : '📸 Send Photos to JN'}
              onClick={runPhotos}
              disabled={!canPushPhotos || !!busy}
              tone={push.photos ? 'done' : 'primary'}
              title={
                !canPushPhotos
                  ? 'Photos are pushed from the inspector record — not available for this deal.'
                  : 'Re-uploads the inspection photos to the JobNimbus job (skips any already there).'
              }
            />
            <ActionButton
              label={busy === 'cert' ? '⏳ Sending Cert…' : push.cert ? '📄 Re-send Cert to JN' : '📄 Send Cert to JN'}
              onClick={runCert}
              disabled={!canPushCert || !!busy}
              tone={push.cert ? 'done' : 'primary'}
              title={
                !canPushCert
                  ? 'This deal isn’t in JobNimbus yet — send photos first to create the job.'
                  : 'Generates the roof inspection certificate PDF and uploads it to the JobNimbus job.'
              }
            />
            <StubButton
              label="✏️ Edit Details"
              caption="Fix homeowner name, address, or phone if it was typed wrong."
              what="An edit form for correcting the homeowner's name, address, or phone is coming soon. For now, ping the office to fix a typo."
            />
          </div>

          {msg && (
            <div
              style={{
                marginTop: 8, fontSize: 12, fontWeight: 600,
                padding: '6px 10px', borderRadius: 8,
                background: msg.ok ? '#dcfce7' : '#fee2e2',
                color: msg.ok ? '#166534' : '#991b1b',
                border: `1px solid ${msg.ok ? '#86efac' : '#fca5a5'}`,
              }}
            >
              {msg.ok ? '✓ ' : '✗ '}{msg.text}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// Readable label grid the manager scans per customer.
function DealFacts({ deal, push }) {
  const rows = [
    ['Signed', deal.signed_at ? fmtDate(deal.signed_at) : 'Not signed yet'],
    ['Inspection', deal.inspection_result || '—'],
    ['PA result', paResultLabel(deal)],
    ['In JobNimbus', jnPushLabel(push)],
  ]
  return (
    <div
      style={{
        marginTop: 6,
        display: 'grid',
        gridTemplateColumns: 'auto 1fr',
        columnGap: 8,
        rowGap: 2,
        fontSize: 12,
      }}
    >
      {rows.map(([k, v]) => (
        <React.Fragment key={k}>
          <span style={{ color: '#64748b', fontWeight: 600, whiteSpace: 'nowrap' }}>{k}:</span>
          <span style={{ color: '#0f172a' }}>{v}</span>
        </React.Fragment>
      ))}
    </div>
  )
}

// Human-readable PA decision. PA only applies to insurance-track deals;
// non-PA deals show a dash.
function paResultLabel(deal) {
  if (!deal.pa_status) return '—'
  const reason = deal.pa_decision_reason ? ` (${deal.pa_decision_reason})` : ''
  return `${deal.pa_status}${reason}`
}

// One-line "what's actually in JN" summary for the facts grid.
function jnPushLabel(push) {
  if (!push.inJn) {
    return <span style={{ color: '#b91c1c', fontWeight: 700 }}>Not pushed yet</span>
  }
  const item = (ok, label) => (
    <span style={{ color: ok ? '#166534' : '#b45309', fontWeight: 700, marginRight: 8 }}>
      {ok ? '✓' : '✗'} {label}
    </span>
  )
  return (
    <span>
      {item(true, 'Job')}
      {item(push.photos, 'Photos')}
      {item(push.cert, 'Cert')}
    </span>
  )
}

// One row of small status pills per deal. Each pill answers a
// yes/no/pending question the manager cares about. Tones:
//   done   — green   — locally we can confirm this is good
//   pending— amber   — requested / partially done / awaiting JN
//   missing— red     — should be there, isn't
//   na     — gray    — doesn't apply to this deal (e.g. no PA forms)
function BadgeRow({ deal }) {
  const badges = []

  // JN job — is this deal in JobNimbus at all?
  if (deal.jn_job_id) {
    badges.push({ label: 'JN', tone: 'done', title: `Linked to JN job ${deal.jn_job_id}` })
  } else if (deal.signed_at) {
    const hoursAgo = (Date.now() - new Date(deal.signed_at).getTime()) / 3_600_000
    if (hoursAgo > 24) {
      badges.push({ label: 'JN', tone: 'missing', title: 'Signed >24h ago but never made it into JN' })
    } else {
      badges.push({ label: 'JN', tone: 'pending', title: 'Signed — JN sync in progress' })
    }
  } else {
    badges.push({ label: 'JN', tone: 'na', title: 'Not signed yet — JN sync hasn\'t been attempted' })
  }

  // Cert — is the certificate in JN?
  const certStatuses = ['Cert Sent', 'Cert Uploaded', 'Awaiting Signature', 'Completed', 'Won']
  if (deal.jn_cert_uploaded_at) {
    badges.push({ label: 'Cert', tone: 'done', title: `Cert uploaded to JN ${fmtDate(deal.jn_cert_uploaded_at)}` })
  } else if (deal.jn_status && certStatuses.includes(deal.jn_status)) {
    badges.push({ label: 'Cert', tone: 'done', title: `Cert tracked in JN (${deal.jn_status})` })
  } else if (deal.jn_status === 'Awaiting Cert') {
    badges.push({ label: 'Cert', tone: 'pending', title: 'JN flagged as awaiting cert — may need a re-push' })
  } else if (deal.signed_at && deal.jn_job_id) {
    badges.push({ label: 'Cert', tone: 'pending', title: 'Signed + in JN — cert status not yet confirmed' })
  } else {
    badges.push({ label: 'Cert', tone: 'na', title: 'Cert generation hasn\'t started' })
  }

  // Inspection result — what did the inspector find?
  const result = deal.inspection_result || deal.result
  if (result) {
    const tone = /storm/i.test(result) ? 'pending' : 'done'
    badges.push({ label: result, tone, title: `Inspection result: ${result}` })
  }

  // LOR + PAC — only show if the deal had PA forms requested.
  const docs = String(deal.docs_signed || '').toLowerCase()
  if (docs.includes('lor')) {
    if (deal.signed_at) {
      badges.push({ label: 'LOR', tone: 'done', title: 'Letter of Representation signed' })
    } else {
      badges.push({ label: 'LOR', tone: 'pending', title: 'Letter of Representation — signature pending' })
    }
  }
  if (docs.includes('pac')) {
    if (deal.signed_at) {
      badges.push({ label: 'PAC', tone: 'done', title: 'Public Adjuster Contract signed' })
    } else {
      badges.push({ label: 'PAC', tone: 'pending', title: 'Public Adjuster Contract — signature pending' })
    }
  }

  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 4 }}>
      {badges.map((b, i) => (
        <Badge key={i} label={b.label} tone={b.tone} title={b.title} />
      ))}
    </div>
  )
}

function Badge({ label, tone, title }) {
  const palette = {
    done:    { bg: '#dcfce7', fg: '#166534', border: '#86efac' },  // green
    pending: { bg: '#fef3c7', fg: '#92400e', border: '#fcd34d' },  // amber
    missing: { bg: '#fee2e2', fg: '#991b1b', border: '#fca5a5' },  // red
    na:      { bg: '#f1f5f9', fg: '#64748b', border: '#cbd5e1' },  // gray
  }[tone] || { bg: '#f1f5f9', fg: '#64748b', border: '#cbd5e1' }
  const dot = { done: '✓', pending: '⏰', missing: '✗', na: '—' }[tone] || '·'
  return (
    <span
      title={title}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 4,
        background: palette.bg, color: palette.fg,
        border: `1px solid ${palette.border}`,
        borderRadius: 999, padding: '2px 8px',
        fontSize: 11, fontWeight: 700,
        lineHeight: 1.3, whiteSpace: 'nowrap',
      }}
    >
      <span style={{ fontSize: 10 }}>{dot}</span>
      {label}
    </span>
  )
}

function StubButton({ label, caption, what }) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation()
        alert(`${label}\n\n${what}`)
      }}
      style={{
        background: '#fff', border: '1px solid #cbd5e1', borderRadius: 6,
        padding: '4px 10px', fontSize: 12, fontWeight: 600, color: '#1e293b',
        cursor: 'pointer',
      }}
      title={caption}
    >
      {label}
    </button>
  )
}

// Live action button (real JN push). tone: 'primary' (blue, action
// needed) | 'done' (green outline, already pushed — re-push offered).
function ActionButton({ label, onClick, disabled, tone, title }) {
  const styles = disabled
    ? { background: '#f1f5f9', color: '#94a3b8', border: '1px solid #e2e8f0', cursor: 'not-allowed' }
    : tone === 'done'
      ? { background: '#ecfdf5', color: '#065f46', border: '1px solid #6ee7b7', cursor: 'pointer' }
      : { background: '#1d4ed8', color: '#fff', border: '1px solid #1d4ed8', cursor: 'pointer' }
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      style={{ ...styles, borderRadius: 6, padding: '4px 10px', fontSize: 12, fontWeight: 700 }}
    >
      {label}
    </button>
  )
}

function DealDetail({ deal, theme }) {
  return (
    <div>
      <div style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: theme.deep, letterSpacing: 0.5, textTransform: 'uppercase' }}>
          In JobNimbus
        </div>
        <Field label="Job ID" value={deal.jn_job_id ? (
          <a href={`https://app.jobnimbus.com/job/${deal.jn_job_id}`} target="_blank" rel="noopener noreferrer"
             style={{ color: theme.deep, textDecoration: 'underline' }}>
            {deal.jn_job_id} ↗
          </a>
        ) : <NotIn />} />
        <Field label="Status" value={deal.jn_status || <NotIn />} />
        <Field label="Result" value={deal.inspection_result || <NotIn />} />
        <Field label="Photos pushed" value={deal.jn_pushed_at ? fmtDateTime(deal.jn_pushed_at) : <NotIn />} />
        <Field label="Cert uploaded" value={deal.jn_cert_uploaded_at ? fmtDateTime(deal.jn_cert_uploaded_at) : <NotIn />} />
        <Field label="Docs in CCG" value={deal.docs_signed || <NotIn />} />
        <Field label="Signed at" value={fmtDateTime(deal.signed_at)} />
      </div>

      <div style={{ borderTop: '1px solid #e2e8f0', paddingTop: 12 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: '#475569', letterSpacing: 0.5, textTransform: 'uppercase' }}>
          Deal details
        </div>
        <Field label="Homeowner" value={deal.homeowner_name || <em>—</em>} />
        <Field label="Address" value={[deal.address, deal.city, deal.state, deal.zip].filter(Boolean).join(', ') || <em>—</em>} />
        <Field label="Phone" value={deal.phone ? <a href={`tel:${deal.phone}`} style={{ color: '#0f172a' }}>{deal.phone}</a> : <em>—</em>} />
        <Field label="Rep" value={deal.sales_rep_name || <em>—</em>} />
        <Field label="Result at" value={fmtDateTime(deal.result_at)} />
        <Field label="PA result" value={deal.pa_status ? paResultLabel(deal) : <em>—</em>} />
        <Field label="Source" value={deal.source} />
      </div>
    </div>
  )
}

function Field({ label, value }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '110px 1fr', gap: 8, fontSize: 13, padding: '4px 0' }}>
      <span style={{ color: '#64748b' }}>{label}:</span>
      <span style={{ color: '#0f172a', wordBreak: 'break-word' }}>{value}</span>
    </div>
  )
}

function NotIn() {
  return <span style={{ color: '#dc2626', fontWeight: 700 }}>— not in JN —</span>
}

function FilterChip({ active, onClick, children, theme }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        background: active ? theme.deep : '#fff',
        color: active ? '#fff' : '#475569',
        border: `1px solid ${active ? theme.deep : '#cbd5e1'}`,
        borderRadius: 999, padding: '6px 12px', fontSize: 12.5,
        fontWeight: 700, cursor: 'pointer',
      }}
    >
      {children}
    </button>
  )
}

function Pill({ label, value, bg, fg }) {
  return (
    <div style={{ background: bg, color: fg, borderRadius: 999, padding: '4px 12px', fontSize: 12, fontWeight: 800, letterSpacing: 0.5 }}>
      {label} {value}
    </div>
  )
}

function CenterMsg({ children, theme, bad }) {
  return (
    <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24, background: '#f8fafc' }}>
      <div style={{
        background: '#fff', border: `1px solid ${bad ? '#fecaca' : '#e2e8f0'}`,
        borderRadius: 12, padding: '20px 28px', maxWidth: 480,
        color: bad ? '#991b1b' : '#0f172a',
      }}>
        {children}
      </div>
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────
// Pure helpers — mirror the backend's bucketing rules so the UI and the
// totals on the API response agree on what's pending / attention.

// What's actually in JobNimbus for this deal, derived from the real
// push timestamps the admin flow stamps (jn_pushed_at = result+photos
// synced; jn_cert_uploaded_at = cert in the Documents tab). jn_status
// is a secondary signal for older rows stamped before those columns.
function jnPushParts(deal) {
  const certStatuses = ['Cert Sent', 'Cert Uploaded', 'Awaiting Signature', 'Completed', 'Won']
  return {
    inJn: !!deal.jn_job_id,
    photos: !!deal.jn_pushed_at,
    cert: !!deal.jn_cert_uploaded_at || (!!deal.jn_status && certStatuses.includes(deal.jn_status)),
  }
}

// ── Live JN push orchestration (mirrors the admin flow in App.jsx) ──
// All endpoints are POST + JSON and need no auth beyond reaching the URL.

const JSON_HEADERS = { 'Content-Type': 'application/json' }

async function postJson(fn, payload) {
  const res = await fetch(`/.netlify/functions/${fn}`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(payload),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok || body.ok === false) {
    throw new Error(body.error || `${fn} failed (${res.status})`)
  }
  return body
}

// Re-sync the result + upload the inspection photos to JN. Creates the
// JN job first if the deal isn't linked yet. Returns a small summary.
async function pushPhotosToJn(deal) {
  let jnJobId = deal.jn_job_id
  if (!jnJobId) {
    const synced = await postJson('retry-jn-sync', { inspectionId: deal.id })
    jnJobId = synced.jobId
    if (!jnJobId) throw new Error('Could not create the JobNimbus job.')
  }
  const pushed = await postJson('push-result-to-jn', { inspectionId: deal.id })
  jnJobId = pushed.jn_job_id || jnJobId
  if (pushed.lost) return { jnJobId, lost: true, uploaded: 0, failed: 0, alreadyIn: 0 }

  const toUpload = pushed.photos_to_upload || []
  let uploaded = 0
  let failed = 0
  // Upload in small parallel batches (mirrors App.jsx's batch-of-6).
  for (let i = 0; i < toUpload.length; i += 6) {
    const batch = toUpload.slice(i, i + 6)
    const results = await Promise.all(
      batch.map(async (p) => {
        try {
          const r = await fetch('/.netlify/functions/upload-photo-to-jn', {
            method: 'POST',
            headers: JSON_HEADERS,
            body: JSON.stringify({ jn_job_id: jnJobId, path: p.path, bucket: p.bucket, label: p.label }),
          })
          const b = await r.json().catch(() => ({}))
          return r.ok && b.ok !== false
        } catch {
          return false
        }
      }),
    )
    for (const ok of results) ok ? uploaded++ : failed++
  }
  return { jnJobId, lost: false, uploaded, failed, alreadyIn: pushed.photos_already_in_jn || 0 }
}

// Generate the certificate PDF and upload it to the JN job's Documents
// tab. Two-step chain to fit Netlify's per-call time budget.
async function pushCertToJn(deal) {
  const jnJobId = deal.jn_job_id
  if (!jnJobId) throw new Error('This deal isn’t in JobNimbus yet.')
  const gen = await postJson('generate-and-upload-insp-report', { jnid: jnJobId, skip_jn_upload: true })
  await postJson('upload-pdf-to-jn', {
    jnid: jnJobId,
    filename: gen.filename,
    pdf_url: gen.pdf_signed_url,
    pdf_storage_path: gen.pdf_storage_path,
  })
  return { jnJobId }
}

// Persist the "made it into JN" stamps so the status sticks on reload.
// Token-gated server-side; best-effort (the JN push already succeeded).
async function stampJn(token, id, fields) {
  try {
    await fetch('/.netlify/functions/manager-records-api', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ action: 'mark-jn-progress', token, id, fields }),
    })
  } catch {
    /* non-fatal — local state already reflects the push */
  }
}

function isPending(d) {
  if (d.cancelled_at) return false
  const docs = String(d.docs_signed || '').toLowerCase()
  if (!docs.includes('lor') && !docs.includes('pac')) return false
  return !d.signed_at
}

function isAttention(d) {
  if (d.cancelled_at) return false
  if (isPending(d)) return true
  const signedAt = d.signed_at ? new Date(d.signed_at).getTime() : null
  const hoursAgo = signedAt ? (Date.now() - signedAt) / 3_600_000 : null
  if (hoursAgo != null && hoursAgo > 24 && !d.jn_job_id) return true
  if (hoursAgo != null && hoursAgo > 24 && d.jn_status === 'Awaiting Cert') return true
  return false
}

function describeMissingDocs(d) {
  const docs = String(d.docs_signed || '').toLowerCase()
  const missing = []
  if (docs.includes('lor')) missing.push('LOR')
  if (docs.includes('pac')) missing.push('PAC')
  return missing.length > 0 ? `${missing.join(' + ')} pending` : 'docs pending'
}

function describeDealStatus(d) {
  if (d.cancelled_at) return `Cancelled ${fmtDate(d.cancelled_at)}`
  if (isPending(d)) return `⏰ Pending PA-form signatures · ${describeMissingDocs(d)}`
  if (d.signed_at && !d.jn_job_id) return `Signed ${fmtDate(d.signed_at)} — not in JN yet`
  if (d.signed_at && d.jn_status === 'Awaiting Cert') return `Signed ${fmtDate(d.signed_at)} — cert not in JN yet`
  if (d.jn_job_id && d.jn_status) return `JN: ${d.jn_status} · signed ${fmtDate(d.signed_at) || '—'}`
  if (d.result_at) return `Inspection result ${d.inspection_result || ''} · ${fmtDate(d.result_at)}`
  return 'In progress'
}

function fmtDate(iso) {
  if (!iso) return null
  try {
    return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  } catch { return null }
}
function fmtDateTime(iso) {
  if (!iso) return <NotIn />
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: 'short', day: 'numeric', year: 'numeric',
      hour: 'numeric', minute: '2-digit',
    })
  } catch { return iso }
}
