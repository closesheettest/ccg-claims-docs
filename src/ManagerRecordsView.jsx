import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

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
  const [filter, setFilter] = useState('all') // 'all' | 'attention'
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

  // Position the detail panel directly to the RIGHT of the clicked row
  // (instead of pinning it to the top of the column, which left it "way
  // above" the deal a manager tapped near the bottom of a long list).
  const gridRef = useRef(null)
  const detailRef = useRef(null)
  const [detailTop, setDetailTop] = useState(16)
  const [gridMinH, setGridMinH] = useState(0)

  useLayoutEffect(() => {
    const grid = gridRef.current
    if (!grid) return
    // On narrow screens the panel stacks below the list (CSS handles it),
    // so don't bother offsetting it there.
    const isNarrow = typeof window !== 'undefined' &&
      window.matchMedia('(max-width: 900px)').matches
    if (!selectedDealId || isNarrow) {
      setDetailTop(16)
      setGridMinH(0)
      return
    }
    const row = grid.querySelector(`[data-deal-id="${selectedDealId}"]`)
    if (!row) return
    const top = row.getBoundingClientRect().top - grid.getBoundingClientRect().top
    const clamped = Math.max(0, top)
    setDetailTop(clamped)
    // Reserve enough height so an absolutely-positioned panel near the
    // bottom of the list doesn't overlap the footer.
    const h = detailRef.current ? detailRef.current.offsetHeight : 0
    setGridMinH(clamped + h + 8)
  }, [selectedDealId, openReps, query, filter, data])

  // Keep the panel aligned to its row when the window resizes.
  useEffect(() => {
    function onResize() {
      const grid = gridRef.current
      if (!grid || !selectedDealId) return
      const isNarrow = window.matchMedia('(max-width: 900px)').matches
      if (isNarrow) { setDetailTop(16); setGridMinH(0); return }
      const row = grid.querySelector(`[data-deal-id="${selectedDealId}"]`)
      if (!row) return
      const top = row.getBoundingClientRect().top - grid.getBoundingClientRect().top
      const clamped = Math.max(0, top)
      setDetailTop(clamped)
      const h = detailRef.current ? detailRef.current.offsetHeight : 0
      setGridMinH(clamped + h + 8)
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [selectedDealId])

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
        </section>

        {/* ─────────── Two-column layout (mobile: stacked) ─────────── */}
        <div ref={gridRef}
             style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 380px', gap: 14, alignItems: 'start', position: 'relative', minHeight: gridMinH || undefined }}
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
                          onSelect={() => setSelectedDealId((prev) => (prev === d.id ? null : d.id))}
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

          {/* RIGHT — Detail panel. Absolutely positioned so it sits
              directly to the right of the row the manager tapped. Only
              rendered while a deal is selected — tapping the same deal
              again clears the selection and the panel disappears. */}
          {selectedDeal && (
            <aside
              ref={detailRef}
              className="mgr-detail"
              style={{
                position: 'absolute', top: detailTop, right: 0, width: 380,
                background: '#fff', border: '1px solid #e2e8f0', borderRadius: 12,
                padding: 16, minHeight: 200, fontSize: 13.5,
                boxShadow: '0 4px 14px rgba(15,23,42,0.10)',
              }}
            >
              <button
                type="button"
                onClick={() => setSelectedDealId(null)}
                aria-label="Close"
                style={{
                  position: 'absolute', top: 8, right: 10,
                  background: 'none', border: 'none', cursor: 'pointer',
                  fontSize: 18, lineHeight: 1, color: '#94a3b8',
                }}
              >
                ✕
              </button>
              <DealDetail deal={selectedDeal} theme={zoneTheme} />
            </aside>
          )}
        </div>

        {/* Responsive stack — at narrow widths, force grid to 1 column and
            let the detail panel flow inline below the list instead of
            floating to the right. */}
        <style>{`
          @media (max-width: 900px) {
            .mgr-grid { grid-template-columns: 1fr !important; min-height: 0 !important; }
            .mgr-detail {
              position: static !important;
              top: auto !important;
              width: auto !important;
              margin-top: 12px;
            }
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
  const action = actionFor(deal)
  const tone = ACTION_TONE[action.tone]
  // The big chip can carry its own color (e.g. the result category) that's
  // distinct from the red/green instruction-line tone. Falls back to the
  // action tone when no chip-specific tone is set.
  const chipTone = ACTION_TONE[action.chipTone] || tone

  // Per-deal push state. busy = which action is running; msg = result.
  const [busy, setBusy] = useState(null) // 'photos' | 'cert' | null
  const [msg, setMsg] = useState(null) // { ok: bool, text }

  // Inline edit / mark-lost state.
  const [editing, setEditing] = useState(false)
  const [form, setForm] = useState(null)
  const [saving, setSaving] = useState(false)
  const [lostNote, setLostNote] = useState('')
  const [lostBusy, setLostBusy] = useState(false)

  function openEdit(e) {
    e.stopPropagation()
    setForm({
      homeowner_name: deal.homeowner_name || '',
      address: deal.address || '',
      city: deal.city || '',
      state: deal.state || '',
      zip: deal.zip || '',
      phone: deal.phone || '',
    })
    setLostNote('')
    setMsg(null)
    setEditing((v) => !v)
  }

  async function saveEdit(e) {
    e.stopPropagation()
    if (saving) return
    setSaving(true); setMsg(null)
    try {
      await postJson('manager-records-api', {
        action: 'update-deal', token, id: deal.id, source: deal.source, fields: form,
      })
      onDealPatch(deal.id, { ...form })
      setMsg({ ok: true, text: 'Saved.' })
      setEditing(false)
    } catch (err) {
      setMsg({ ok: false, text: err.message || 'Save failed.' })
    } finally {
      setSaving(false)
    }
  }

  async function markLost(e) {
    e.stopPropagation()
    if (lostBusy) return
    const note = lostNote.trim()
    if (!note) { setMsg({ ok: false, text: 'Add a quick note on why it’s lost (e.g. “it was a test”).' }); return }
    setLostBusy(true); setMsg(null)
    try {
      if (deal.source === 'inspection') {
        // Reuse the inspector Lost flow — also reflects "Lost" into JN.
        await postJson('inspector-submit-result', { inspectionId: deal.id, result: 'lost', lost_reason: note })
      } else {
        await postJson('manager-records-api', { action: 'mark-lost', token, id: deal.id, source: deal.source, reason: note })
      }
      onDealPatch(deal.id, { inspection_result: 'lost', result: 'lost', cancelled_at: new Date().toISOString() })
      setMsg({ ok: true, text: 'Marked lost — it’s off your list.' })
      setEditing(false)
    } catch (err) {
      setMsg({ ok: false, text: err.message || 'Could not mark lost.' })
    } finally {
      setLostBusy(false)
    }
  }

  const push = jnPushParts(deal)
  // Buttons stay grey unless the verdict says THIS action is the thing
  // that's owed. Right after signing a deal sits in "NEEDS INSPECTION"
  // and nothing is owed, so both buttons are grey until a result lands.
  const canPushPhotos = action.need === 'photos'
  const canPushCert = action.need === 'cert'

  // Before an inspection result exists there are no roof photos — the
  // "photos" push is really just re-syncing the signed agreement/info
  // into JN. Label it "Send Info to JN" so a manager isn't told to send
  // photos that don't exist yet. Once a result is in, it's real photos.
  const hasResult = !!(deal.inspection_result || deal.result)
  const photosLabel = busy === 'photos'
    ? (hasResult ? '⏳ Sending Photos…' : '⏳ Sending Info…')
    : (hasResult ? '📸 Send Photos to JN' : '📤 Send Info to JN')

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
          : !hasResult
            ? 'Synced to JobNimbus — the job + agreement info are now in JN.'
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
      data-deal-id={deal.id}
      style={{
        borderTop: '1px solid #e2e8f0',
        padding: '12px 16px',
        background: selected ? theme.light : '#fff',
        cursor: 'pointer',
      }}
      onClick={onSelect}
    >
      <div style={{ display: 'flex', gap: 10, alignItems: 'stretch' }}>
        <span style={{ fontSize: 18, color: tone.fg, lineHeight: 1.3 }}>{action.icon}</span>
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

          {/* Bold, plain-English instruction — the manager's “what do I
              do?” answer, color-matched to the status chip. */}
          <div style={{ marginTop: 6, fontSize: 13, fontWeight: 700, color: tone.fg }}>
            {action.detail}
          </div>

          {/* Action buttons — live JN pushes. */}
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
            <ActionButton
              label={photosLabel}
              onClick={runPhotos}
              disabled={!canPushPhotos || !!busy}
              tone="primary"
              title={
                !canPushPhotos
                  ? 'Nothing to push right now — this lights up only when info or photos still need to reach JobNimbus.'
                  : hasResult
                    ? 'Uploads the inspection photos to the JobNimbus job (skips any already there).'
                    : 'Re-syncs this signed deal into JobNimbus (creates the job + pushes the agreement info).'
              }
            />
            <ActionButton
              label={busy === 'cert' ? '⏳ Sending Cert…' : '📄 Send Cert to JN'}
              onClick={runCert}
              disabled={!canPushCert || !!busy}
              tone="primary"
              title={
                !canPushCert
                  ? 'Nothing to push right now — the certificate is only owed once the photos are in JobNimbus.'
                  : 'Generates the roof inspection certificate PDF and uploads it to the JobNimbus job.'
              }
            />
            <button
              type="button"
              onClick={openEdit}
              title="Fix the homeowner name, address, or phone — or mark the deal Lost."
              style={{
                background: editing ? '#1e293b' : '#fff',
                color: editing ? '#fff' : '#1e293b',
                border: '1px solid #cbd5e1', borderRadius: 6,
                padding: '4px 10px', fontSize: 12, fontWeight: 700, cursor: 'pointer',
              }}
            >
              ✏️ Edit Details
            </button>
          </div>

          {editing && form && (
            <div
              onClick={(e) => e.stopPropagation()}
              style={{
                marginTop: 8, padding: 12, borderRadius: 10,
                border: '1px solid #e2e8f0', background: '#f8fafc',
              }}
            >
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                {[
                  ['homeowner_name', 'Homeowner name', 2],
                  ['address', 'Street address', 2],
                  ['city', 'City', 1],
                  ['state', 'State', 1],
                  ['zip', 'Zip', 1],
                  ['phone', 'Phone', 1],
                ].map(([k, label, span]) => (
                  <label key={k} style={{ gridColumn: span === 2 ? '1 / -1' : 'auto', fontSize: 11, fontWeight: 700, color: '#475569' }}>
                    {label}
                    <input
                      value={form[k]}
                      onChange={(e) => setForm((s) => ({ ...s, [k]: e.target.value }))}
                      style={{
                        display: 'block', width: '100%', marginTop: 3, boxSizing: 'border-box',
                        padding: '6px 8px', border: '1px solid #cbd5e1', borderRadius: 6, fontSize: 13,
                      }}
                    />
                  </label>
                ))}
              </div>
              <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
                <button
                  type="button"
                  onClick={saveEdit}
                  disabled={saving}
                  style={{
                    background: '#1d4ed8', color: '#fff', border: '1px solid #1d4ed8',
                    borderRadius: 6, padding: '6px 12px', fontSize: 12, fontWeight: 700,
                    cursor: saving ? 'not-allowed' : 'pointer', opacity: saving ? 0.7 : 1,
                  }}
                >
                  {saving ? 'Saving…' : 'Save changes'}
                </button>
                <button
                  type="button"
                  onClick={() => setEditing(false)}
                  style={{
                    background: '#fff', color: '#475569', border: '1px solid #cbd5e1',
                    borderRadius: 6, padding: '6px 12px', fontSize: 12, fontWeight: 700, cursor: 'pointer',
                  }}
                >
                  Cancel
                </button>
              </div>

              {/* Mark Lost — for test deals / homeowners who backed out. */}
              <div style={{ marginTop: 12, paddingTop: 10, borderTop: '1px solid #e2e8f0' }}>
                <div style={{ fontSize: 11, fontWeight: 800, color: '#991b1b', marginBottom: 4 }}>
                  Not a real deal? Mark it Lost
                </div>
                <textarea
                  value={lostNote}
                  onChange={(e) => setLostNote(e.target.value)}
                  placeholder="Why is this lost?  e.g. it was a test"
                  rows={2}
                  style={{
                    width: '100%', boxSizing: 'border-box', padding: '6px 8px',
                    border: '1px solid #cbd5e1', borderRadius: 6, fontSize: 13, resize: 'vertical',
                  }}
                />
                <button
                  type="button"
                  onClick={markLost}
                  disabled={lostBusy}
                  style={{
                    marginTop: 6, background: '#b91c1c', color: '#fff', border: '1px solid #b91c1c',
                    borderRadius: 6, padding: '6px 12px', fontSize: 12, fontWeight: 700,
                    cursor: lostBusy ? 'not-allowed' : 'pointer', opacity: lostBusy ? 0.7 : 1,
                  }}
                >
                  {lostBusy ? 'Marking…' : '🚫 Mark as Lost'}
                </button>
              </div>
            </div>
          )}

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

        {/* Large status chip — fills the blank space on the right so the
            manager can tell at a glance whether this deal needs them. */}
        <div
          style={{
            flexShrink: 0,
            width: 132,
            display: 'flex', flexDirection: 'column',
            justifyContent: 'center', alignItems: 'center',
            textAlign: 'center', gap: 4,
            borderRadius: 12, padding: '12px 8px',
            background: chipTone.bg, color: chipTone.fg,
            border: `1.5px solid ${chipTone.border}`,
          }}
        >
          <span style={{ fontSize: 30, lineHeight: 1 }}>{action.icon}</span>
          <span style={{ fontSize: 13, fontWeight: 800, letterSpacing: 0.4 }}>{action.headline}</span>
          {action.chipNote && (
            <span style={{ fontSize: 11, fontWeight: 600, lineHeight: 1.25 }}>{action.chipNote}</span>
          )}
        </div>
      </div>
    </div>
  )
}

// Readable label grid the manager scans per customer.
function DealFacts({ deal, push }) {
  const result = deal.inspection_result || deal.result
  const rows = [
    ['Signed', deal.signed_at ? fmtDate(deal.signed_at) : 'Not signed yet'],
    ['Inspection', result || (deal.signed_at ? 'Awaiting result' : '—')],
    ['PA result', paResultLabel(deal)],
    ['In JobNimbus', jnPushLabel(push, !!result)],
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

// One-line "what's actually in JN" summary for the facts grid. Before an
// inspection result is back, Photos/Cert show a neutral "—" (they can't
// exist yet) rather than a red ✗ that would imply something's missing.
function jnPushLabel(push, hasResult) {
  if (!push.inJn) {
    return <span style={{ color: '#b91c1c', fontWeight: 700 }}>Not pushed yet</span>
  }
  const item = (state, label) => {
    const m = {
      yes: { c: '#166534', mark: '✓' },
      no: { c: '#b45309', mark: '✗' },
      na: { c: '#94a3b8', mark: '—' },
    }[state]
    return (
      <span style={{ color: m.c, fontWeight: 700, marginRight: 8 }}>
        {m.mark} {label}
      </span>
    )
  }
  return (
    <span>
      {item('yes', 'Job')}
      {item(hasResult ? (push.photos ? 'yes' : 'no') : 'na', 'Photos')}
      {item(hasResult ? (push.cert ? 'yes' : 'no') : 'na', 'Cert')}
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
  const hasResult = !!(deal.inspection_result || deal.result)

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
  } else if (deal.signed_at && deal.jn_job_id && hasResult) {
    badges.push({ label: 'Cert', tone: 'pending', title: 'Inspected + in JN — cert status not yet confirmed' })
  } else {
    badges.push({ label: 'Cert', tone: 'na', title: hasResult ? 'Cert generation hasn\'t started' : 'Waiting on the inspection — no cert yet' })
  }

  // Inspection result — what did the inspector find?
  const result = deal.inspection_result || deal.result
  if (result) {
    const tone = /storm/i.test(result) ? 'pending' : 'done'
    badges.push({ label: result, tone, title: `Inspection result: ${result}` })
  }

  // NOTE: LOR/PAC are deliberately NOT shown here — those signatures are
  // the Public Adjuster's responsibility, not the manager's. This page is
  // only about getting photos + the certificate into JobNimbus.

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
  const result = deal.inspection_result || deal.result
  const hasResult = !!result
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
        {/* jn_status is just JobNimbus's free-text status string and is
            very often null even when the job, photos, and cert are all
            in JN — so an empty one means "no status set", not "not in
            JN". Show a neutral dash, never the red "not in JN" flag
            (that lives on Job ID / Photos / Cert, which actually prove
            presence). */}
        <Field label="Status" value={deal.jn_status || '—'} />
        <Field label="Result" value={result || <Waiting />} />
        <Field label="Photos pushed" value={!hasResult ? <Waiting /> : (deal.jn_pushed_at ? fmtDateTime(deal.jn_pushed_at) : <NotIn />)} />
        <Field label="Cert uploaded" value={!hasResult ? <Waiting /> : (deal.jn_cert_uploaded_at ? fmtDateTime(deal.jn_cert_uploaded_at) : <NotIn />)} />
        <Field label="Docs in App" value={deal.docs_signed || <NotIn />} />
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

// Neutral "this can't exist yet — waiting on the inspection" placeholder.
function Waiting() {
  return <span style={{ color: '#94a3b8', fontWeight: 600 }}>— awaiting inspection —</span>
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
  // jn_pushed_at is ALSO stamped at sign→JN sync time (find-orphan-signings
  // sets it to signed_at), so on its own it can't tell us roof photos are
  // in JN. Roof photos only exist after an inspection result, so don't
  // treat photos as pushed until there's a result.
  const hasResult = !!(deal.inspection_result || deal.result)
  return {
    inJn: !!deal.jn_job_id,
    photos: hasResult && !!deal.jn_pushed_at,
    cert: hasResult && (!!deal.jn_cert_uploaded_at || (!!deal.jn_status && certStatuses.includes(deal.jn_status))),
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

// A deal "needs attention" iff the manager actually has something to do
// on it — i.e. the verdict is a red ACTION NEEDED (photos or cert still
// missing from JobNimbus). LOR/PAC signatures are the PA's job, not the
// manager's, so they never count here.
function isAttention(d) {
  // The chip can now be a non-red color (e.g. blue DAMAGE) while the
  // manager still owes a JN push, so gate attention on whether there's an
  // actual task (action.need) rather than the chip/instruction tone.
  return actionFor(d).need !== null
}

// Raw inspection result as JobNimbus stores it: "Damage" | "No Damage" |
// "Retail" | "lost" (or null while we're still waiting on the inspection).
function inspectionResult(deal) {
  return deal.inspection_result || deal.result || ''
}
function isLostResult(deal) {
  return /lost/i.test(inspectionResult(deal))
}

// Business-facing summary for an inspected deal: WHAT came back and what
// the company does next with it. Drives the big chip's headline + the
// note line under it. This is deliberately separate from the manager's
// JobNimbus data task (photos/cert) — that shows as the red instruction
// line + the action button, only when something's actually owed.
//   Damage    → it's a claim, going to the Public Adjuster.
//   Retail    → no insurance angle; get a rep out to sell the job.
//   No Damage → nothing to sell; mine it for referrals.
function resultChip(resultRaw) {
  const r = String(resultRaw || '').toLowerCase()
  // "no damage" contains "damage" — check it first.
  if (r.includes('no damage')) {
    return { headline: 'NO DAMAGE', chipNote: 'Get a rep over there for referrals.', chipTone: 'na', icon: '🤝' }
  }
  if (r.includes('damage')) {
    return { headline: 'DAMAGE', chipNote: 'Going to the PA.', chipTone: 'info', icon: '📋' }
  }
  if (r.includes('retail')) {
    return { headline: 'RETAIL', chipNote: 'Get a rep over there to get an appointment and sell it.', chipTone: 'warn', icon: '🏠' }
  }
  // Unknown result string — show it raw, neutral, no business note.
  return { headline: String(resultRaw || '').toUpperCase(), chipNote: null, chipTone: 'na', icon: '•' }
}

// The big, plain-English verdict for one deal: does the manager need to
// do something, and if so what? Drives the large status chip, the bold
// instruction line, AND which action button is live (action.need).
//
// Lifecycle (inspection-source deal):
//   signed → auto-pushed to JN (job + agreement + fields)
//     → "NEEDS INSPECTION"  (grey, nothing to do — wait on the inspector)
//   inspection comes back (Damage / No Damage / Retail — any result)
//     → photos + the certificate are owed to JN
//     → if either is missing: red ACTION NEEDED, the matching button lights up
//     → once both are in JN: "ALL SET" (green)
//   "Lost" → dead deal → grey, nothing to do.
//
// action.need is 'photos' | 'cert' | null — only the matching button is
// enabled; everything else stays grey so the manager only ever taps the
// thing that's actually owed.
function actionFor(deal) {
  if (deal.cancelled_at) {
    return { tone: 'na', icon: '—', headline: 'CANCELLED', detail: 'No action needed.', need: null }
  }
  // Lost deals (homeowner backed out, or a test deal a manager killed)
  // short-circuit regardless of JN/inspection state — nothing is owed.
  if (isLostResult(deal)) {
    return { tone: 'na', icon: '—', headline: 'LOST', detail: 'Marked lost — no action needed.', need: null }
  }

  // NOTE: LOR/PAC signatures are the Public Adjuster's responsibility,
  // not the manager's (or the rep's) — so they are deliberately NOT a
  // manager action item here. The manager's job on this page is getting
  // photos + the certificate into JobNimbus.

  const push = jnPushParts(deal)
  const hasResult = !!inspectionResult(deal)

  if (deal.source === 'inspection') {
    // Not signed yet — nothing exists to push.
    if (!deal.signed_at) {
      return { tone: 'na', icon: '•', headline: 'IN PROGRESS', detail: 'Not signed yet — nothing to do right now.', need: null }
    }
    const signedHoursAgo = deal.signed_at
      ? (Date.now() - new Date(deal.signed_at).getTime()) / 3_600_000
      : null

    // Not inspected yet. The resting state is NEEDS INSPECTION — nothing
    // for the manager to do but wait on the inspector. The one exception:
    // if it was signed more than a day ago and STILL never linked a
    // JobNimbus job, the automatic sync failed and the manager should
    // re-sync. Fresh signings get a 24h grace because the auto-push can
    // lag right after signing — flagging them red immediately cries wolf.
    if (!hasResult) {
      if (!push.inJn && signedHoursAgo != null && signedHoursAgo > 24) {
        return {
          tone: 'bad', icon: '⚠', headline: 'ACTION NEEDED',
          detail: 'Signed over a day ago but never made it into JobNimbus — tap “Send Info to JN” to re-sync.',
          need: 'photos',
        }
      }
      return {
        tone: 'na', icon: '🔍', headline: 'NEEDS INSPECTION',
        detail: push.inJn
          ? 'In JobNimbus — waiting on the inspection. Nothing to do yet.'
          : 'Waiting on the inspection. Nothing to do yet.',
        need: null,
      }
    }
    // Inspection came back (Damage / No Damage / Retail). The big chip
    // now shows the RESULT + the business next-step (resultChip), so the
    // manager sees what came back and what happens with it at a glance.
    // Independently, every result owes photos + the certificate to
    // JobNimbus — that's the manager's data task, surfaced as the red
    // instruction line + whichever action button is owed (action.need).
    const resultRaw = inspectionResult(deal)
    const meta = resultChip(resultRaw)
    let tone, detail, need
    if (!push.photos) {
      tone = 'bad'; need = 'photos'
      detail = `Inspection came back “${resultRaw}” — photos not in JobNimbus yet. Tap “Send Photos to JN”.`
    } else if (!push.cert) {
      tone = 'bad'; need = 'cert'
      detail = `Inspection came back “${resultRaw}” — certificate not in JobNimbus yet. Tap “Send Cert to JN”.`
    } else {
      tone = 'good'; need = null
      detail = `Photos + certificate for the “${resultRaw}” inspection are in JobNimbus — nothing to do.`
    }
    return {
      tone,            // drives the red/green instruction line + button
      need,            // 'photos' | 'cert' | null — which button lights up
      detail,
      icon: meta.icon, // chip shows the result, not a generic ⚠/✓
      headline: meta.headline,
      chipNote: meta.chipNote,
      chipTone: meta.chipTone,
    }
  }

  // Claim-track (PA pipeline). The manager can't push photos/cert here,
  // so the only thing to flag is a deal that never linked to JN.
  if (push.inJn) {
    return {
      tone: 'good', icon: '✓', headline: 'ALL SET',
      detail: 'In JobNimbus and moving through the PA pipeline — nothing to do.',
      need: null,
    }
  }
  if (deal.signed_at) {
    return {
      tone: 'warn', icon: '!', headline: 'CHECK',
      detail: 'Signed but not linked in JobNimbus — let the office know.',
      need: null,
    }
  }
  return {
    tone: 'na', icon: '•', headline: 'IN PROGRESS',
    detail: 'Not signed yet — nothing to do right now.',
    need: null,
  }
}

// Color palette for an action tone.
const ACTION_TONE = {
  good: { fg: '#166534', bg: '#dcfce7', border: '#86efac' },
  bad:  { fg: '#991b1b', bg: '#fee2e2', border: '#fca5a5' },
  warn: { fg: '#92400e', bg: '#fef3c7', border: '#fcd34d' },
  na:   { fg: '#475569', bg: '#f1f5f9', border: '#cbd5e1' },
  // Blue — a damage claim heading to the Public Adjuster (informational,
  // not an action and not a problem).
  info: { fg: '#1e40af', bg: '#dbeafe', border: '#93c5fd' },
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
