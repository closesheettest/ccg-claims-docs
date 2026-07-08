import React, { useEffect, useState } from 'react'

// Admin dashboard — weekly bar graph for the Regional Manager section.
// Metric selector (Total sales / Back to retail / Insulation-Radiant Barrier)
// × range toggle (This year / All time). One series shown at a time, so a
// single hue per metric (reused from the app's zone palette) — no legend
// needed; the heading + hover carry identity.

const METRICS = [
  { key: 'total_sales', label: 'Total sales', short: 'sales', color: '#1D6FB8' },
  { key: 'btr', label: 'Back to retail', short: 'BTR', color: '#F77F00' },
  { key: 'irb', label: 'Insulation / Radiant Barrier', short: 'IRB', color: '#2A9D4A' },
]
const RANGES = [
  { key: 'year', label: 'This year' },
  { key: 'all', label: 'All time' },
]

export default function AdminSalesChart() {
  const [range, setRange] = useState('year')
  const [metric, setMetric] = useState('total_sales')
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState(null)
  const [hover, setHover] = useState(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true); setErr(null); setHover(null)
    fetch(`/.netlify/functions/admin-sales-metrics?range=${range}`)
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return
        if (!d.ok) throw new Error(d.error || 'Failed to load')
        setData(d); setLoading(false)
      })
      .catch((e) => { if (!cancelled) { setErr(e.message); setLoading(false) } })
    return () => { cancelled = true }
  }, [range])

  const m = METRICS.find((x) => x.key === metric)
  const weeks = data?.weeks || []
  const values = data?.series?.[metric] || []
  const total = values.reduce((a, b) => a + b, 0)
  const max = Math.max(1, ...values)

  // SVG geometry (responsive via viewBox).
  const W = 760, H = 250, padL = 34, padB = 30, padT = 10, padR = 10
  const plotW = W - padL - padR, plotH = H - padT - padB
  const n = weeks.length
  const slot = n ? plotW / n : 0
  const bw = Math.max(2, Math.min(26, slot - 2))
  const yTicks = [0, Math.ceil(max / 2), max]
  const labelEvery = n > 26 ? Math.ceil(n / 13) : n > 13 ? 2 : 1

  return (
    <div style={card}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12, marginBottom: 14 }}>
        <div>
          <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: '#0f172a' }}>Sales by week</h3>
          <div style={{ fontSize: 13, color: '#64748b', marginTop: 2 }}>
            {m.label} · {RANGES.find((r) => r.key === range).label}
            {!loading && !err && <> · <b style={{ color: m.color }}>{total.toLocaleString()}</b> total</>}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          {RANGES.map((r) => (
            <button key={r.key} onClick={() => setRange(r.key)} style={pill(range === r.key)}>{r.label}</button>
          ))}
        </div>
      </div>

      {/* Metric selector */}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
        {METRICS.map((x) => (
          <button
            key={x.key}
            onClick={() => setMetric(x.key)}
            style={{
              ...pill(metric === x.key),
              borderColor: metric === x.key ? x.color : '#e2e8f0',
              color: metric === x.key ? '#fff' : '#334155',
              background: metric === x.key ? x.color : '#fff',
            }}
          >
            {x.label}
          </button>
        ))}
      </div>

      {loading ? (
        <div style={emptyBox}>Loading…</div>
      ) : err ? (
        <div style={{ ...emptyBox, color: '#b91c1c' }}>Couldn't load metrics: {err}</div>
      ) : n === 0 ? (
        <div style={emptyBox}>No data for this range yet.</div>
      ) : (
        <div style={{ position: 'relative' }}>
          <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ display: 'block' }} role="img"
            aria-label={`${m.label} by week, ${total} total`}>
            {/* gridlines + y labels */}
            {yTicks.map((t, i) => {
              const y = padT + plotH - (t / max) * plotH
              return (
                <g key={i}>
                  <line x1={padL} y1={y} x2={W - padR} y2={y} stroke="#eef2f7" strokeWidth="1" />
                  <text x={padL - 6} y={y + 3} textAnchor="end" fontSize="10" fill="#94a3b8">{t}</text>
                </g>
              )
            })}
            {/* bars */}
            {weeks.map((w, i) => {
              const v = values[i]
              const h = (v / max) * plotH
              const x = padL + i * slot + (slot - bw) / 2
              const y = padT + plotH - h
              const on = hover?.i === i
              return (
                <g key={w.key}>
                  <rect
                    x={x} y={y} width={bw} height={Math.max(h, v > 0 ? 2 : 0)}
                    rx={Math.min(3, bw / 2)} fill={m.color} opacity={on ? 1 : 0.88}
                  />
                  {/* full-height hit target */}
                  <rect
                    x={padL + i * slot} y={padT} width={slot} height={plotH} fill="transparent"
                    onMouseEnter={() => setHover({ i, label: w.label, v })}
                    onMouseLeave={() => setHover(null)}
                  />
                  {i % labelEvery === 0 && (
                    <text x={padL + i * slot + slot / 2} y={H - 10} textAnchor="middle" fontSize="9.5" fill="#94a3b8">
                      {w.label}
                    </text>
                  )}
                </g>
              )
            })}
          </svg>
          {hover && (
            <div style={{
              position: 'absolute', left: `${(padL + hover.i * slot + slot / 2) / W * 100}%`,
              top: 0, transform: 'translate(-50%,-4px)', pointerEvents: 'none',
              background: '#0f172a', color: '#fff', fontSize: 12, padding: '5px 9px',
              borderRadius: 7, whiteSpace: 'nowrap', boxShadow: '0 4px 12px rgba(0,0,0,.2)',
            }}>
              Week of {hover.label}: <b>{hover.v}</b> {m.short}
            </div>
          )}
        </div>
      )}
      {data?.truncated && (
        <div style={{ fontSize: 11, color: '#b45309', marginTop: 8 }}>
          ⚠ Large history — some older weeks may be capped. Ask me to add a nightly precompute if you need full all-time.
        </div>
      )}
    </div>
  )
}

const card = {
  border: '1px solid #e2e8f0', borderRadius: 12, background: '#fff',
  padding: '16px 18px', boxShadow: '0 1px 2px rgba(15,23,42,.04)',
}
const emptyBox = {
  height: 200, display: 'flex', alignItems: 'center', justifyContent: 'center',
  color: '#64748b', fontSize: 14, background: '#f8fafc', borderRadius: 8,
}
const pill = (active) => ({
  padding: '6px 12px', borderRadius: 999, fontSize: 13, fontWeight: 600, cursor: 'pointer',
  border: `1px solid ${active ? '#0f172a' : '#e2e8f0'}`,
  background: active ? '#0f172a' : '#fff', color: active ? '#fff' : '#334155',
})
