import { useEffect, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { getReportData, type ReportGroup, type ReportConfig, type ReportParticipant, type InstructorDevArgs } from '../api'

// ── Formatting ────────────────────────────────────────────────────────────────

const USD = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })

function usdShort(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`
  if (n >= 1_000) return `$${Math.round(n / 1_000)}k`
  return `$${n}`
}

// ── Tick helper (shared by scatter axes) ─────────────────────────────────────

function niceTicks(min: number, max: number, count = 6): number[] {
  const range = max - min || 1
  const raw = range / count
  const mag = Math.pow(10, Math.floor(Math.log10(raw)))
  const norm = raw / mag
  const step = norm < 1.5 ? mag : norm < 3.5 ? 2 * mag : norm < 7.5 ? 5 * mag : 10 * mag
  const start = Math.ceil(min / step) * step
  const ticks: number[] = []
  for (let t = start; t <= max + step * 0.01; t += step) ticks.push(Math.round(t))
  return ticks
}

// ── Histogram computation ─────────────────────────────────────────────────────

const BIN_WIDTHS = [25_000, 50_000, 100_000, 250_000, 500_000]

interface HistData {
  deals: number
  noDeals: number
  axisMin: number
  axisMax: number
  span: number
  binWidth: number
  numBins: number
  bins: number[]
  minPrice: number | null
  maxPrice: number | null
  mean: number | null
  stdDev: number | null
}

function computeHistogram(groups: ReportGroup[], config: ReportConfig): HistData {
  const dealPrices = groups
    .filter(g => g.status === 'completed' && g.agreement_reached === true && g.final_price != null)
    .map(g => g.final_price!)
  const noDeals = groups.filter(g => g.status === 'completed' && g.agreement_reached === false).length
  const deals = dealPrices.length

  // X-axis: at least the full ZOPA; extended outward if any price lands outside.
  const axisMin = deals > 0
    ? Math.min(config.reservation_price_chris, Math.min(...dealPrices))
    : config.reservation_price_chris
  const axisMax = deals > 0
    ? Math.max(config.reservation_price_kelly, Math.max(...dealPrices))
    : config.reservation_price_kelly
  const span = Math.max(axisMax - axisMin, 1)

  // First bin width where ceil(span/width) ≤ 20 bars.
  const binWidth = BIN_WIDTHS.find(w => Math.ceil(span / w) <= 20) ?? 500_000
  const numBins = Math.max(1, Math.ceil(span / binWidth))

  const bins: number[] = Array(numBins).fill(0)
  dealPrices.forEach(p => {
    const i = Math.min(Math.floor((p - axisMin) / binWidth), numBins - 1)
    bins[i]++
  })

  let minPrice: number | null = null
  let maxPrice: number | null = null
  let mean: number | null = null
  let stdDev: number | null = null

  if (deals > 0) {
    minPrice = Math.min(...dealPrices)
    maxPrice = Math.max(...dealPrices)
    mean = dealPrices.reduce((a, b) => a + b, 0) / deals
    const variance = dealPrices.reduce((a, b) => a + (b - mean!) ** 2, 0) / deals
    stdDev = Math.sqrt(variance)
  }

  return { deals, noDeals, axisMin, axisMax, span, binWidth, numBins, bins, minPrice, maxPrice, mean, stdDev }
}

// ── Price Histogram SVG ───────────────────────────────────────────────────────

// 16:9 viewport for projector-friendliness.
const W = 1280
const H = 680
const M = { top: 88, right: 50, bottom: 158, left: 55 }
const PW = W - M.left - M.right   // 1175
const PH = H - M.top - M.bottom   // 434

interface HistSVGProps {
  groups: ReportGroup[]
  config: ReportConfig
  svgRef: React.RefObject<SVGSVGElement | null>
}

function PriceHistogramSVG({ groups, config, svgRef }: HistSVGProps) {
  const h = computeHistogram(groups, config)
  const maxCount = Math.max(...h.bins, 1)
  const baseline = M.top + PH  // y of x-axis

  const xOf = (price: number) => M.left + ((price - h.axisMin) / h.span) * PW
  const barW = PW / h.numBins

  const chrisX = xOf(config.reservation_price_chris)
  const kellyX = xOf(config.reservation_price_kelly)

  // Pick label spacing so ~7 tick marks appear on x-axis.
  const labelStep = Math.max(1, Math.round(h.numBins / 7))

  const statsY = baseline + 96

  const statItems = [
    { k: 'Deals',    v: String(h.deals) },
    { k: 'No-deals', v: String(h.noDeals) },
    { k: 'Min',      v: h.minPrice != null ? USD.format(h.minPrice) : '—' },
    { k: 'Max',      v: h.maxPrice != null ? USD.format(h.maxPrice) : '—' },
    { k: 'Average',  v: h.mean    != null ? USD.format(Math.round(h.mean))   : '—' },
    { k: 'Std Dev',  v: h.stdDev  != null ? USD.format(Math.round(h.stdDev)) : '—' },
  ]

  return (
    <svg
      ref={svgRef}
      xmlns="http://www.w3.org/2000/svg"
      viewBox={`0 0 ${W} ${H}`}
      style={{ width: '100%', height: 'auto', display: 'block' }}
    >
      {/* Canvas */}
      <rect width={W} height={H} fill="#ffffff" />

      {/* Title */}
      <text
        x={W / 2} y={26}
        textAnchor="middle" fontSize={22} fontWeight={700}
        fill="#111" fontFamily="sans-serif"
      >
        Price Distribution — Final Agreed Prices
      </text>

      {/* Plot area background */}
      <rect x={M.left} y={M.top} width={PW} height={PH} fill="#f9fafb" stroke="#e5e7eb" />

      {/* Light horizontal gridlines (at 25%, 50%, 75%, 100% of maxCount) */}
      {[0.25, 0.5, 0.75, 1.0].map(frac => {
        const y = M.top + PH * (1 - frac)
        const countLabel = Math.round(frac * maxCount)
        return (
          <g key={frac}>
            <line x1={M.left} y1={y} x2={M.left + PW} y2={y} stroke="#e5e7eb" strokeWidth={1} />
            <text x={M.left - 7} y={y + 5} textAnchor="end" fontSize={11} fill="#9ca3af" fontFamily="sans-serif">
              {countLabel}
            </text>
          </g>
        )
      })}

      {/* Bars */}
      {h.bins.map((count, i) => {
        if (count === 0) return null
        const x = M.left + i * barW
        const bh = (count / maxCount) * PH
        const y = baseline - bh
        const fontSize = Math.min(20, Math.max(11, Math.round(barW * 0.32)))
        return (
          <g key={i}>
            <rect x={x + 2} y={y} width={barW - 4} height={bh} fill="#2563eb" opacity={0.80} rx={3} />
            <text
              x={x + barW / 2} y={y - 7}
              textAnchor="middle" fontSize={fontSize} fontWeight={700}
              fill="#1d4ed8" fontFamily="sans-serif"
            >
              {count}
            </text>
          </g>
        )
      })}

      {/* Reference line — Chris's floor */}
      <line x1={chrisX} y1={M.top} x2={chrisX} y2={baseline}
        stroke="#d97706" strokeWidth={2.5} strokeDasharray="8 5" />
      {/* Label to the right of the line so it doesn't overlap bars on the far left */}
      <text x={chrisX + 7} y={M.top + 18} fontSize={13} fontWeight={600} fill="#d97706" fontFamily="sans-serif">
        Chris's floor
      </text>
      <text x={chrisX + 7} y={M.top + 34} fontSize={12} fill="#d97706" fontFamily="sans-serif">
        {USD.format(config.reservation_price_chris)}
      </text>

      {/* Reference line — Kelly's ceiling */}
      <line x1={kellyX} y1={M.top} x2={kellyX} y2={baseline}
        stroke="#7c3aed" strokeWidth={2.5} strokeDasharray="8 5" />
      {/* Label to the left of the line */}
      <text x={kellyX - 7} y={M.top + 18} textAnchor="end" fontSize={13} fontWeight={600} fill="#7c3aed" fontFamily="sans-serif">
        Kelly's ceiling
      </text>
      <text x={kellyX - 7} y={M.top + 34} textAnchor="end" fontSize={12} fill="#7c3aed" fontFamily="sans-serif">
        {USD.format(config.reservation_price_kelly)}
      </text>

      {/* X-axis baseline */}
      <line x1={M.left} y1={baseline} x2={M.left + PW} y2={baseline} stroke="#374151" strokeWidth={2} />

      {/* X-axis tick labels — every labelStep bins, plus the rightmost edge */}
      {Array.from({ length: h.numBins + 1 }, (_, i) => {
        if (i % labelStep !== 0 && i !== h.numBins) return null
        const price = h.axisMin + i * h.binWidth
        const x = M.left + i * barW
        return (
          <text
            key={i}
            x={x} y={baseline + 15}
            textAnchor="end" fontSize={12} fill="#6b7280" fontFamily="sans-serif"
            transform={`rotate(-40 ${x} ${baseline + 15})`}
          >
            {usdShort(price)}
          </text>
        )
      })}

      {/* Stats separator line */}
      <line
        x1={M.left} y1={statsY - 18} x2={M.left + PW} y2={statsY - 18}
        stroke="#e5e7eb" strokeWidth={1}
      />

      {/* Stats items */}
      {statItems.map((s, i) => {
        const cx = M.left + (i + 0.5) * (PW / statItems.length)
        return (
          <g key={i}>
            <text x={cx} y={statsY} textAnchor="middle" fontSize={21} fontWeight={700} fill="#111" fontFamily="sans-serif">
              {s.v}
            </text>
            <text x={cx} y={statsY + 22} textAnchor="middle" fontSize={13} fill="#6b7280" fontFamily="sans-serif">
              {s.k}
            </text>
          </g>
        )
      })}
    </svg>
  )
}

// ── Regression scatter plot ───────────────────────────────────────────────────

interface RegData {
  points: { x: number; y: number }[]
  n: number
  canFit: boolean
  a: number | null
  b: number | null
  r2: number | null
  axisMinX: number; axisMaxX: number
  axisMinY: number; axisMaxY: number
}

function computeRegression(groups: ReportGroup[]): RegData {
  const points = groups
    .filter(g =>
      g.status === 'completed' &&
      g.agreement_reached === true &&
      g.final_price != null &&
      g.group_initial_price != null,
    )
    .map(g => ({ x: g.group_initial_price!, y: g.final_price! }))

  const n = points.length

  const empty = (): RegData => ({
    points, n, canFit: false, a: null, b: null, r2: null,
    axisMinX: 0, axisMaxX: 500_000, axisMinY: 0, axisMaxY: 500_000,
  })
  if (n === 0) return empty()

  const xs = points.map(p => p.x)
  const ys = points.map(p => p.y)
  const pad = (arr: number[]) => {
    const lo = Math.min(...arr), hi = Math.max(...arr)
    const p = Math.max((hi - lo) * 0.12, 25_000)
    return { lo: Math.max(0, lo - p), hi: hi + p }
  }
  const rx = pad(xs), ry = pad(ys)

  const xBar = xs.reduce((s, v) => s + v, 0) / n
  const yBar = ys.reduce((s, v) => s + v, 0) / n
  const ssX  = xs.reduce((s, v) => s + (v - xBar) ** 2, 0)

  if (n < 3 || ssX < 1) {
    return { points, n, canFit: false, a: null, b: null, r2: null,
      axisMinX: rx.lo, axisMaxX: rx.hi, axisMinY: ry.lo, axisMaxY: ry.hi }
  }

  const ssXY = points.reduce((s, p) => s + (p.x - xBar) * (p.y - yBar), 0)
  const ssY  = ys.reduce((s, v) => s + (v - yBar) ** 2, 0)
  const b = ssXY / ssX
  const a = yBar - b * xBar
  const r2 = ssY > 0 ? (ssXY ** 2) / (ssX * ssY) : 0

  return { points, n, canFit: true, a, b, r2,
    axisMinX: rx.lo, axisMaxX: rx.hi, axisMinY: ry.lo, axisMaxY: ry.hi }
}

// 16:9 scatter canvas — same outer dimensions as the histogram.
const SW = 1280, SH = 680
const SM = { top: 68, right: 70, bottom: 150, left: 116 }
const SPW = SW - SM.left - SM.right  // 1094
const SPH = SH - SM.top - SM.bottom  // 462

interface ScatterSVGProps {
  groups: ReportGroup[]
  svgRef: React.RefObject<SVGSVGElement | null>
}

function ScatterPlotSVG({ groups, svgRef }: ScatterSVGProps) {
  const r = computeRegression(groups)
  const spanX = r.axisMaxX - r.axisMinX || 1
  const spanY = r.axisMaxY - r.axisMinY || 1

  const xPx = (v: number) => SM.left + ((v - r.axisMinX) / spanX) * SPW
  const yPx = (v: number) => SM.top + SPH - ((v - r.axisMinY) / spanY) * SPH

  const xTicks = niceTicks(r.axisMinX, r.axisMaxX, 7)
  const yTicks = niceTicks(r.axisMinY, r.axisMaxY, 6)

  // Clamp regression line endpoints to plot x-range, y drawn by clipPath.
  const lineX0 = SM.left
  const lineX1 = SM.left + SPW
  const lineY0 = r.canFit && r.a != null && r.b != null ? yPx(r.a + r.b * r.axisMinX) : 0
  const lineY1 = r.canFit && r.a != null && r.b != null ? yPx(r.a + r.b * r.axisMaxX) : 0

  const statsY  = SM.top + SPH + 60  // 590
  const sepY    = statsY - 18        // 572

  const statItems = r.canFit
    ? [
        { k: 'N (groups)', v: String(r.n) },
        { k: 'Slope (b)',   v: r.b != null ? r.b.toFixed(3) : '—' },
        { k: 'Intercept (a)', v: r.a != null ? USD.format(Math.round(r.a)) : '—' },
        { k: 'R²',          v: r.r2 != null ? r.r2.toFixed(3) : '—' },
      ]
    : [{ k: 'N (groups)', v: String(r.n) }]

  const equation = r.canFit && r.a != null && r.b != null
    ? `Final Price = ${USD.format(Math.round(r.a))} ${r.b >= 0 ? '+' : '−'} ${Math.abs(r.b).toFixed(3)} · Initial Offer`
    : null

  return (
    <svg
      ref={svgRef}
      xmlns="http://www.w3.org/2000/svg"
      viewBox={`0 0 ${SW} ${SH}`}
      style={{ width: '100%', height: 'auto', display: 'block' }}
    >
      <rect width={SW} height={SH} fill="#ffffff" />

      {/* Title */}
      <text x={SW / 2} y={26} textAnchor="middle" fontSize={22} fontWeight={700} fill="#111" fontFamily="sans-serif">
        Regression: Final Agreed Price vs. Initial Offer
      </text>
      <text x={SW / 2} y={48} textAnchor="middle" fontSize={13} fill="#6b7280" fontFamily="sans-serif">
        x = opening offer (debrief)  ·  y = final agreed price  ·  deals only
      </text>

      {/* Plot area */}
      <defs>
        <clipPath id="scatter-clip">
          <rect x={SM.left} y={SM.top} width={SPW} height={SPH} />
        </clipPath>
      </defs>
      <rect x={SM.left} y={SM.top} width={SPW} height={SPH} fill="#f9fafb" stroke="#e5e7eb" />

      {/* Horizontal gridlines + y-axis labels */}
      {yTicks.map(t => {
        const y = yPx(t)
        if (y < SM.top - 1 || y > SM.top + SPH + 1) return null
        return (
          <g key={t}>
            <line x1={SM.left} y1={y} x2={SM.left + SPW} y2={y} stroke="#e5e7eb" strokeWidth={1} />
            <text x={SM.left - 8} y={y + 4} textAnchor="end" fontSize={12} fill="#9ca3af" fontFamily="sans-serif">
              {usdShort(t)}
            </text>
          </g>
        )
      })}

      {/* Vertical gridlines + x-axis labels */}
      {xTicks.map(t => {
        const x = xPx(t)
        if (x < SM.left - 1 || x > SM.left + SPW + 1) return null
        return (
          <g key={t}>
            <line x1={x} y1={SM.top} x2={x} y2={SM.top + SPH} stroke="#e5e7eb" strokeWidth={1} />
            <text x={x} y={SM.top + SPH + 18} textAnchor="middle" fontSize={12} fill="#6b7280" fontFamily="sans-serif">
              {usdShort(t)}
            </text>
          </g>
        )
      })}

      {/* Axis lines */}
      <line x1={SM.left} y1={SM.top} x2={SM.left} y2={SM.top + SPH} stroke="#374151" strokeWidth={2} />
      <line x1={SM.left} y1={SM.top + SPH} x2={SM.left + SPW} y2={SM.top + SPH} stroke="#374151" strokeWidth={2} />

      {/* Y-axis title (rotated) */}
      <text
        x={SM.left - 82} y={SM.top + SPH / 2}
        transform={`rotate(-90, ${SM.left - 82}, ${SM.top + SPH / 2})`}
        textAnchor="middle" fontSize={14} fill="#374151" fontFamily="sans-serif"
      >
        Final agreed price ($)
      </text>

      {/* X-axis title */}
      <text
        x={SM.left + SPW / 2} y={SM.top + SPH + 40}
        textAnchor="middle" fontSize={14} fill="#374151" fontFamily="sans-serif"
      >
        Initial offer ($)
      </text>

      {/* Regression line */}
      {r.canFit && (
        <line
          x1={lineX0} y1={lineY0} x2={lineX1} y2={lineY1}
          stroke="#dc2626" strokeWidth={2.5} opacity={0.75}
          clipPath="url(#scatter-clip)"
        />
      )}

      {/* Data points */}
      {r.points.map((p, i) => (
        <circle
          key={i}
          cx={xPx(p.x)} cy={yPx(p.y)} r={9}
          fill="#2563eb" opacity={0.78}
          clipPath="url(#scatter-clip)"
        />
      ))}

      {/* No-fit caption (shown alongside any points that exist) */}
      {!r.canFit && r.n > 0 && (
        <text
          x={SM.left + SPW / 2} y={SM.top + SPH / 2 + 6}
          textAnchor="middle" fontSize={15} fill="#94a3b8" fontFamily="sans-serif"
        >
          Not enough variation to fit a regression line.
        </text>
      )}

      {/* Empty state */}
      {r.n === 0 && (
        <text
          x={SM.left + SPW / 2} y={SM.top + SPH / 2 + 6}
          textAnchor="middle" fontSize={15} fill="#94a3b8" fontFamily="sans-serif"
        >
          No data — complete groups need both a deal and a debrief submission.
        </text>
      )}

      {/* Stats separator */}
      <line x1={SM.left} y1={sepY} x2={SM.left + SPW} y2={sepY} stroke="#e5e7eb" strokeWidth={1} />

      {/* Stat items */}
      {statItems.map((s, i) => {
        const cx = SM.left + (i + 0.5) * (SPW / statItems.length)
        return (
          <g key={i}>
            <text x={cx} y={statsY} textAnchor="middle" fontSize={21} fontWeight={700} fill="#111" fontFamily="sans-serif">
              {s.v}
            </text>
            <text x={cx} y={statsY + 22} textAnchor="middle" fontSize={13} fill="#6b7280" fontFamily="sans-serif">
              {s.k}
            </text>
          </g>
        )
      })}

      {/* Equation */}
      {equation && (
        <text
          x={SM.left + SPW / 2} y={statsY + 52}
          textAnchor="middle" fontSize={15} fontStyle="italic" fill="#374151" fontFamily="sans-serif"
        >
          {equation}
        </text>
      )}
      {!r.canFit && r.n > 0 && r.n < 3 && (
        <text
          x={SM.left + SPW / 2} y={statsY + 52}
          textAnchor="middle" fontSize={13} fill="#94a3b8" fontFamily="sans-serif"
        >
          Need at least 3 groups with both a deal and a debrief offer to fit a line.
        </text>
      )}
    </svg>
  )
}

// ── Dual-panel prep histogram ─────────────────────────────────────────────────

// 1280×680 16:9, two side-by-side panels sharing the same x-axis.
// Layout (px): 20 | 33 | 533 | 108 | 33 | 533 | 20 = 1280
const DW = 1280, DH = 680
const D_TH  = 66             // title block height; plot top = D_TH
const D_PPH = 429            // per-panel plot height
const D_BL  = D_TH + D_PPH  // 495 — x-axis baseline
const D_IML = 33             // inner-left margin per panel (y-axis label space)
const D_PPW = 533            // per-panel plot width
const D_LP_PX = 20 + D_IML          // 53  — left panel plot x
const D_RP_PX = D_LP_PX + D_PPW + 108 + D_IML  // 727 — right panel plot x
const D_STATS_Y = D_BL + 78 // 573

interface PrepPanelData {
  n: number
  min: number | null
  max: number | null
  mean: number | null
  stdDev: number | null
  bins: number[]
}

interface DualPrepData {
  chris: PrepPanelData
  kelly: PrepPanelData
  axisMin: number
  axisMax: number
  span: number
  binWidth: number
  numBins: number
}

function computeDualPrep(
  participants: ReportParticipant[],
  config: ReportConfig,
  field: 'prep_planned_first_offer' | 'prep_estimated_other_price',
): DualPrepData {
  const chrisVals = participants
    .filter(p => p.role === 'Chris' && p[field] != null)
    .map(p => p[field]!)
  const kellyVals = participants
    .filter(p => p.role === 'Kelly' && p[field] != null)
    .map(p => p[field]!)

  const all = [...chrisVals, ...kellyVals]
  const zopaMin = config.reservation_price_chris
  const zopaMax = config.reservation_price_kelly
  const axisMin = all.length > 0 ? Math.min(zopaMin, ...all) : zopaMin
  const axisMax = all.length > 0 ? Math.max(zopaMax, ...all) : zopaMax
  const span = Math.max(axisMax - axisMin, 1)
  const binWidth = BIN_WIDTHS.find(w => Math.ceil(span / w) <= 20) ?? 500_000
  const numBins = Math.max(1, Math.ceil(span / binWidth))

  function panel(vals: number[]): PrepPanelData {
    const n = vals.length
    const bins = Array<number>(numBins).fill(0)
    vals.forEach(v => {
      const i = Math.min(Math.floor((v - axisMin) / binWidth), numBins - 1)
      bins[i]++
    })
    if (n === 0) return { n, min: null, max: null, mean: null, stdDev: null, bins }
    const min = Math.min(...vals)
    const max = Math.max(...vals)
    const mean = vals.reduce((a, b) => a + b, 0) / n
    const variance = vals.reduce((a, b) => a + (b - mean) ** 2, 0) / n
    return { n, min, max, mean, stdDev: Math.sqrt(variance), bins }
  }

  return { chris: panel(chrisVals), kelly: panel(kellyVals), axisMin, axisMax, span, binWidth, numBins }
}

interface DualPrepSVGProps {
  participants: ReportParticipant[]
  config: ReportConfig
  field: 'prep_planned_first_offer' | 'prep_estimated_other_price'
  title: string
  svgRef: React.RefObject<SVGSVGElement | null>
}

function DualPrepHistSVG({ participants, config, field, title, svgRef }: DualPrepSVGProps) {
  const d = computeDualPrep(participants, config, field)

  const maxCountC = Math.max(...d.chris.bins, 1)
  const maxCountK = Math.max(...d.kelly.bins, 1)

  const xPxLeft  = (v: number) => D_LP_PX + ((v - d.axisMin) / d.span) * D_PPW
  const xPxRight = (v: number) => D_RP_PX + ((v - d.axisMin) / d.span) * D_PPW

  const barW = D_PPW / d.numBins
  const labelStep = Math.max(1, Math.round(d.numBins / 7))

  const chrisFloorX = (plotX: (v: number) => number) => plotX(config.reservation_price_chris)
  const kellyCeilX  = (plotX: (v: number) => number) => plotX(config.reservation_price_kelly)

  const statsFmt = (v: number | null) => v != null ? USD.format(Math.round(v)) : '—'

  function Panel({
    plotX, maxCount, panel, roleLabel, roleColor, showYLabels, chrisX, kellyX,
  }: {
    plotX: (v: number) => number
    maxCount: number
    panel: PrepPanelData
    roleLabel: string
    roleColor: string
    showYLabels: boolean
    chrisX: number
    kellyX: number
  }) {
    const plotLeft = plotX(d.axisMin)
    return (
      <g>
        {/* Role label */}
        <text
          x={plotLeft + D_PPW / 2} y={D_TH - 10}
          textAnchor="middle" fontSize={17} fontWeight={700}
          fill={roleColor} fontFamily="sans-serif"
        >
          {roleLabel}
        </text>

        {/* Plot background */}
        <rect x={plotLeft} y={D_TH} width={D_PPW} height={D_PPH} fill="#f9fafb" stroke="#e5e7eb" />

        {/* Y-axis gridlines + labels */}
        {[0.25, 0.5, 0.75, 1.0].map(frac => {
          const y = D_TH + D_PPH * (1 - frac)
          const countLabel = Math.round(frac * maxCount)
          return (
            <g key={frac}>
              <line x1={plotLeft} y1={y} x2={plotLeft + D_PPW} y2={y} stroke="#e5e7eb" strokeWidth={1} />
              {showYLabels && (
                <text x={plotLeft - 6} y={y + 4} textAnchor="end" fontSize={11} fill="#9ca3af" fontFamily="sans-serif">
                  {countLabel}
                </text>
              )}
            </g>
          )
        })}

        {/* Bars */}
        {panel.bins.map((count, i) => {
          if (count === 0) return null
          const x = plotLeft + i * barW
          const bh = (count / maxCount) * D_PPH
          const y = D_BL - bh
          const fs = Math.min(18, Math.max(10, Math.round(barW * 0.30)))
          return (
            <g key={i}>
              <rect x={x + 2} y={y} width={barW - 4} height={bh} fill="#2563eb" opacity={0.80} rx={3} />
              <text x={x + barW / 2} y={y - 6} textAnchor="middle" fontSize={fs} fontWeight={700} fill="#1d4ed8" fontFamily="sans-serif">
                {count}
              </text>
            </g>
          )
        })}

        {/* ZOPA reference lines */}
        <line x1={chrisX} y1={D_TH} x2={chrisX} y2={D_BL} stroke="#d97706" strokeWidth={2.5} strokeDasharray="8 5" />
        <line x1={kellyX} y1={D_TH} x2={kellyX} y2={D_BL} stroke="#7c3aed" strokeWidth={2.5} strokeDasharray="8 5" />

        {/* X-axis baseline */}
        <line x1={plotLeft} y1={D_BL} x2={plotLeft + D_PPW} y2={D_BL} stroke="#374151" strokeWidth={2} />

        {/* X-axis tick labels */}
        {Array.from({ length: d.numBins + 1 }, (_, i) => {
          if (i % labelStep !== 0 && i !== d.numBins) return null
          const price = d.axisMin + i * d.binWidth
          const x = plotLeft + i * barW
          return (
            <text
              key={i} x={x} y={D_BL + 15}
              textAnchor="end" fontSize={12} fill="#6b7280" fontFamily="sans-serif"
              transform={`rotate(-40 ${x} ${D_BL + 15})`}
            >
              {usdShort(price)}
            </text>
          )
        })}

        {/* Empty state */}
        {panel.n === 0 && (
          <text x={plotLeft + D_PPW / 2} y={D_TH + D_PPH / 2 + 6}
            textAnchor="middle" fontSize={14} fill="#94a3b8" fontFamily="sans-serif">
            No data
          </text>
        )}

        {/* Stats */}
        {[
          { k: 'N',       v: String(panel.n) },
          { k: 'Min',     v: statsFmt(panel.min) },
          { k: 'Max',     v: statsFmt(panel.max) },
          { k: 'Average', v: statsFmt(panel.mean) },
          { k: 'Std Dev', v: statsFmt(panel.stdDev) },
        ].map((s, i, arr) => {
          const cx = plotLeft + (i + 0.5) * (D_PPW / arr.length)
          return (
            <g key={i}>
              <text x={cx} y={D_STATS_Y} textAnchor="middle" fontSize={19} fontWeight={700} fill="#111" fontFamily="sans-serif">
                {s.v}
              </text>
              <text x={cx} y={D_STATS_Y + 22} textAnchor="middle" fontSize={12} fill="#6b7280" fontFamily="sans-serif">
                {s.k}
              </text>
            </g>
          )
        })}
      </g>
    )
  }

  // ZOPA legend in title area
  const legendY = 52

  return (
    <svg
      ref={svgRef}
      xmlns="http://www.w3.org/2000/svg"
      viewBox={`0 0 ${DW} ${DH}`}
      style={{ width: '100%', height: 'auto', display: 'block' }}
    >
      <rect width={DW} height={DH} fill="#ffffff" />

      {/* Title */}
      <text x={DW / 2} y={24} textAnchor="middle" fontSize={21} fontWeight={700} fill="#111" fontFamily="sans-serif">
        {title}
      </text>

      {/* ZOPA legend */}
      <g>
        <line x1={DW / 2 - 178} y1={legendY - 4} x2={DW / 2 - 150} y2={legendY - 4} stroke="#d97706" strokeWidth={2.5} strokeDasharray="6 4" />
        <text x={DW / 2 - 145} y={legendY} fontSize={12} fill="#d97706" fontFamily="sans-serif">Chris's floor ({USD.format(config.reservation_price_chris)})</text>
        <line x1={DW / 2 + 24} y1={legendY - 4} x2={DW / 2 + 52} y2={legendY - 4} stroke="#7c3aed" strokeWidth={2.5} strokeDasharray="6 4" />
        <text x={DW / 2 + 57} y={legendY} fontSize={12} fill="#7c3aed" fontFamily="sans-serif">Kelly's ceiling ({USD.format(config.reservation_price_kelly)})</text>
      </g>

      {/* Stats separator */}
      <line x1={D_LP_PX} y1={D_BL + 50} x2={D_LP_PX + D_PPW} y2={D_BL + 50} stroke="#e5e7eb" strokeWidth={1} />
      <line x1={D_RP_PX} y1={D_BL + 50} x2={D_RP_PX + D_PPW} y2={D_BL + 50} stroke="#e5e7eb" strokeWidth={1} />

      {/* Left panel — Chris */}
      <Panel
        plotX={xPxLeft}
        maxCount={maxCountC}
        panel={d.chris}
        roleLabel="Chris"
        roleColor="#0369a1"
        showYLabels={true}
        chrisX={chrisFloorX(xPxLeft)}
        kellyX={kellyCeilX(xPxLeft)}
      />

      {/* Right panel — Kelly */}
      <Panel
        plotX={xPxRight}
        maxCount={maxCountK}
        panel={d.kelly}
        roleLabel="Kelly"
        roleColor="#0f766e"
        showYLabels={true}
        chrisX={chrisFloorX(xPxRight)}
        kellyX={kellyCeilX(xPxRight)}
      />
    </svg>
  )
}

// ── Thumbnail tile ────────────────────────────────────────────────────────────

function ReportTile({
  title,
  onProject,
  disabled,
  actionLabel = 'Project ↗',
  compact = false,
  children,
}: {
  title: string
  onProject: () => void
  disabled?: boolean
  actionLabel?: string
  /** Modifier for the AI-Analysis Export tiles — roughly half footprint in
   *  both directions. Chart tiles (Outcomes/Preparation) never pass this. */
  compact?: boolean
  children: React.ReactNode
}) {
  const [hov, setHov] = useState(false)
  const active = !disabled && hov

  return (
    <div
      onClick={disabled ? undefined : onProject}
      onMouseEnter={() => { if (!disabled) setHov(true) }}
      onMouseLeave={() => setHov(false)}
      title={disabled ? undefined : 'Click to project full-screen'}
      style={{
        background: '#fff',
        border: `1.5px solid ${active ? '#3b82f6' : '#e2e8f0'}`,
        borderRadius: compact ? 6 : 8,
        overflow: 'hidden',
        cursor: disabled ? 'default' : 'pointer',
        boxShadow: active
          ? '0 4px 18px rgba(59,130,246,0.14)'
          : '0 1px 3px rgba(0,0,0,0.06)',
        transition: 'box-shadow 0.13s, border-color 0.13s',
        display: 'flex',
        flexDirection: 'column',
        userSelect: 'none',
      }}
    >
      {/* Title bar */}
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'flex-start',
        gap: '0.4rem',
        padding: compact ? '0.3rem 0.45rem' : '0.45rem 0.75rem',
        borderBottom: '1px solid #f0f4f8',
        background: active ? '#eff6ff' : '#fafafa',
        transition: 'background 0.13s',
        minHeight: compact ? 20 : 38,
      }}>
        <span
          title={compact ? title : undefined}
          style={{
            fontSize: compact ? '0.62rem' : '0.78rem',
            fontWeight: 600,
            color: '#1e293b',
            lineHeight: 1.3,
            ...(compact
              ? { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }
              : {}),
          }}
        >
          {title}
        </span>
        <span style={{
          fontSize: compact ? '0.56rem' : '0.7rem',
          fontWeight: 500,
          color: active ? '#2563eb' : '#cbd5e1',
          whiteSpace: 'nowrap',
          flexShrink: 0,
          paddingTop: 1,
          transition: 'color 0.13s',
        }}>
          {disabled ? '—' : actionLabel}
        </span>
      </div>

      {/* Preview — scales the SVG down; overflow clips the bottom */}
      <div style={{
        height: compact ? 84 : 168,
        overflow: 'hidden',
        background: '#f8fafc',
        opacity: disabled ? 0.38 : 1,
        transition: 'opacity 0.13s',
        display: 'flex',
        alignItems: 'flex-start',
      }}>
        {children}
      </div>
    </div>
  )
}

// ── AI-analysis text export (generic — reusable across games) ────────────────

// Note: field is now typed as `string` (not a mapped keyof union) so dynamic
// field names from instructor-added questions are accepted without casting.
// Runtime access uses `(p as Record<string,unknown>)[field]` — safe because
// buildGroupTextExport only reads, never writes, and checks `typeof val === 'string'`.

interface GroupExportResult {
  text: string
  groupCount: number
  responseCount: number
}

/**
 * Builds one plain-text block for the whole class: a header line + summary,
 * then one paragraph per completed group naming every member (role + name)
 * and the group's final price (or "No deal"), followed by that member's
 * response to `field`. Members with no response are simply omitted from
 * their group's lines; groups with zero responses still show their header.
 *
 * Generic over `field` / `headerText` so other games can reuse this exact
 * group-iteration + formatting logic for their own open-text debrief questions.
 */
function buildGroupTextExport(
  groups: ReportGroup[],
  participants: ReportParticipant[],
  field: string,
  headerText: string,
): GroupExportResult {
  const byId = new Map(participants.map(p => [p.participant_id, p]))

  const blocks: { header: string; lines: string[] }[] = []
  let responseCount = 0

  groups
    .filter(g => g.status === 'completed')
    .forEach((g, i) => {
      const chrisNames = g.chris_participants.map(id => byId.get(id)?.display_name).filter((n): n is string => !!n)
      const kellyNames = g.kelly_participants.map(id => byId.get(id)?.display_name).filter((n): n is string => !!n)
      const compositionParts: string[] = []
      if (chrisNames.length) compositionParts.push(`Chris: ${chrisNames.join(', ')}`)
      if (kellyNames.length) compositionParts.push(`Kelly: ${kellyNames.join(', ')}`)
      const priceLabel = g.agreement_reached === true && g.final_price != null
        ? `final price ${USD.format(g.final_price)}`
        : 'No deal'

      const members: { id: string; role: 'Chris' | 'Kelly' }[] = [
        ...g.chris_participants.map(id => ({ id, role: 'Chris' as const })),
        ...g.kelly_participants.map(id => ({ id, role: 'Kelly' as const })),
      ]
      const lines: string[] = []
      for (const m of members) {
        const p = byId.get(m.id)
        const val = p ? (p as Record<string, unknown>)[field] : undefined
        if (p && typeof val === 'string' && val.trim().length > 0) {
          lines.push(`  ${p.display_name} (${m.role}): ${val.trim()}`)
          responseCount++
        }
      }
      blocks.push({ header: `Group ${i + 1} — ${compositionParts.join(' · ')} — ${priceLabel}`, lines })
    })

  const groupCount = blocks.length
  const summary = `${groupCount} group${groupCount === 1 ? '' : 's'} · ${responseCount} response${responseCount === 1 ? '' : 's'}`
  const body = blocks.map(b => [b.header, ...b.lines].join('\n')).join('\n\n')
  const text = responseCount > 0
    ? `${headerText}\n${summary}\n\n${body}`
    : `${headerText}\n\nNo reflection responses yet.`

  return { text, groupCount, responseCount }
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-+|-+$)/g, '')
}

function downloadTextFile(text: string, filename: string) {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

// ── Export preview modal — copy / download the generated text block ─────────

function ExportModal({
  title,
  text,
  onClose,
}: {
  title: string
  text: string
  onClose: () => void
}) {
  const [copied, setCopied] = useState(false)

  const handleCopy = () => {
    navigator.clipboard.writeText(text)
      .then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500) })
      .catch(() => { /* clipboard unavailable — text is still selectable below */ })
  }
  const handleDownload = () => downloadTextFile(text, `${slugify(title)}.txt`)

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.55)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: '2rem', zIndex: 1000,
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: '#fff', borderRadius: 10, width: 'min(820px, 100%)',
          maxHeight: '100%', display: 'flex', flexDirection: 'column',
          boxShadow: '0 12px 60px rgba(0,0,0,0.35)', overflow: 'hidden',
        }}
      >
        <div style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          padding: '0.875rem 1.25rem', borderBottom: '1px solid #e2e8f0', gap: '1rem',
        }}>
          <h2 style={{ margin: 0, fontSize: '1rem', fontWeight: 600, color: '#1e293b' }}>{title}</h2>
          <button onClick={onClose} style={{ fontSize: '0.8rem' }}>✕ Close</button>
        </div>
        <div style={{
          display: 'flex', gap: '0.5rem', padding: '0.75rem 1.25rem',
          borderBottom: '1px solid #f0f4f8',
        }}>
          <button onClick={handleCopy} style={{ fontSize: '0.825rem', padding: '0.4rem 0.875rem' }}>
            {copied ? 'Copied ✓' : 'Copy to Clipboard'}
          </button>
          <button onClick={handleDownload} style={{ fontSize: '0.825rem', padding: '0.4rem 0.875rem' }}>
            Download .txt (whole class)
          </button>
        </div>
        <pre style={{
          margin: 0, padding: '1.25rem', overflow: 'auto', flex: 1,
          fontSize: '0.8rem', lineHeight: 1.55, whiteSpace: 'pre-wrap',
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
          color: '#1e293b', background: '#f8fafc',
        }}>
          {text}
        </pre>
      </div>
    </div>
  )
}

// ── Group text export tile ───────────────────────────────────────────────────

function GroupTextExportTile({
  title,
  headerText,
  groups,
  participants,
  field,
  compact = false,
}: {
  title: string
  headerText: string
  groups: ReportGroup[] | null
  participants: ReportParticipant[] | null
  field: string
  /** Roughly half footprint — see ReportTile. The caption line is dropped
   *  at this size rather than letting it cram or overflow. */
  compact?: boolean
}) {
  const [open, setOpen] = useState(false)
  const ready = groups != null && participants != null
  const result = ready ? buildGroupTextExport(groups, participants, field, headerText) : null

  return (
    <>
      <ReportTile title={title} onProject={() => setOpen(true)} disabled={!ready} actionLabel="Open ↗" compact={compact}>
        {result && (
          <div style={{
            width: '100%', height: '100%', display: 'flex', flexDirection: 'column',
            alignItems: 'center', justifyContent: 'center',
            padding: compact ? '0.4rem' : '1rem', textAlign: 'center',
          }}>
            {result.responseCount === 0 ? (
              <span style={{ color: '#94a3b8', fontSize: compact ? '0.68rem' : '0.875rem' }}>
                No reflection responses yet.
              </span>
            ) : compact ? (
              <span style={{ fontSize: '0.92rem', fontWeight: 700, color: '#111' }}>
                {result.groupCount} groups · {result.responseCount} responses
              </span>
            ) : (
              <>
                <span style={{ fontSize: '1.5rem', fontWeight: 700, color: '#111' }}>
                  {result.groupCount} groups · {result.responseCount} responses
                </span>
                <span style={{ marginTop: '0.5rem', fontSize: '0.75rem', color: '#94a3b8' }}>
                  Click to copy or download for the whole class
                </span>
              </>
            )}
          </div>
        )}
      </ReportTile>
      {open && result && (
        <ExportModal title={title} text={result.text} onClose={() => setOpen(false)} />
      )}
    </>
  )
}

const DEBRIEF_REFLECTION_HEADER =
  'Debrief reflection — "What surprised you about how the negotiation unfolded?"'

// Prep-question tile headers are now sourced from config.prep_text_questions so
// editing a prompt in the Settings editor is immediately reflected here too.
// The three formerly-hardcoded PREP_*_HEADER constants have been retired.

// ── Reports page ──────────────────────────────────────────────────────────────

export default function Reports() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const gameInstanceId = import.meta.env.DEV ? searchParams.get('_dev_game_instance_id') : null

  const [groups, setGroups] = useState<ReportGroup[] | null>(null)
  const [config, setConfig] = useState<ReportConfig | null>(null)
  const [participants, setParticipants] = useState<ReportParticipant[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const histogramSvgRef  = useRef<SVGSVGElement>(null)
  const scatterSvgRef    = useRef<SVGSVGElement>(null)
  const prepOfferSvgRef  = useRef<SVGSVGElement>(null)
  const prepEstSvgRef    = useRef<SVGSVGElement>(null)

  useEffect(() => {
    if (!gameInstanceId) return
    setLoading(true)
    setError(null)
    const args: InstructorDevArgs = { _dev: { game_instance_id: gameInstanceId } }
    getReportData(args)
      .then(r => {
        setGroups(r.groups)
        setConfig(r.config)
        setParticipants(r.participants)
        setLoading(false)
      })
      .catch(err => {
        setError(err instanceof Error ? err.message : 'Failed to load report data.')
        setLoading(false)
      })
  }, [gameInstanceId])

  const projectHistogram = () => {
    if (!histogramSvgRef.current) return
    const svgHtml = histogramSvgRef.current.outerHTML
    const w = window.open(
      '',
      'price-histogram-projection',
      'width=1280,height=720,menubar=no,toolbar=no,location=no,status=no',
    )
    if (!w) return
    w.document.open()
    w.document.write(
      `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>Price Distribution</title>` +
      `<style>*{margin:0;padding:0;box-sizing:border-box}` +
      `body{background:#0f172a;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:2vmin}` +
      `.wrap{width:94vw;background:#fff;border-radius:10px;padding:2vmin 2.5vmin;` +
      `box-shadow:0 12px 60px rgba(0,0,0,0.6)}</style>` +
      `</head><body><div class="wrap">${svgHtml}</div></body></html>`,
    )
    w.document.close()
  }

  const projectScatter = () => {
    if (!scatterSvgRef.current) return
    const svgHtml = scatterSvgRef.current.outerHTML
    const w = window.open(
      '',
      'regression-scatter-projection',
      'width=1280,height=720,menubar=no,toolbar=no,location=no,status=no',
    )
    if (!w) return
    w.document.open()
    w.document.write(
      `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>Regression: Final Price vs. Initial Offer</title>` +
      `<style>*{margin:0;padding:0;box-sizing:border-box}` +
      `body{background:#0f172a;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:2vmin}` +
      `.wrap{width:94vw;background:#fff;border-radius:10px;padding:2vmin 2.5vmin;` +
      `box-shadow:0 12px 60px rgba(0,0,0,0.6)}</style>` +
      `</head><body><div class="wrap">${svgHtml}</div></body></html>`,
    )
    w.document.close()
  }

  function projectDualPrep(ref: React.RefObject<SVGSVGElement | null>, windowName: string, windowTitle: string) {
    if (!ref.current) return
    const svgHtml = ref.current.outerHTML
    const w = window.open(
      '',
      windowName,
      'width=1280,height=720,menubar=no,toolbar=no,location=no,status=no',
    )
    if (!w) return
    w.document.open()
    w.document.write(
      `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>${windowTitle}</title>` +
      `<style>*{margin:0;padding:0;box-sizing:border-box}` +
      `body{background:#0f172a;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:2vmin}` +
      `.wrap{width:94vw;background:#fff;border-radius:10px;padding:2vmin 2.5vmin;` +
      `box-shadow:0 12px 60px rgba(0,0,0,0.6)}</style>` +
      `</head><body><div class="wrap">${svgHtml}</div></body></html>`,
    )
    w.document.close()
  }

  const projectPrepOffer = () => projectDualPrep(prepOfferSvgRef, 'prep-offer-projection', 'Planned First Offer')
  const projectPrepEst   = () => projectDualPrep(prepEstSvgRef,   'prep-est-projection',   "Estimated Other's Reservation Price")

  const dashLink = gameInstanceId
    ? `/dashboard?_dev_game_instance_id=${gameInstanceId}`
    : '/dashboard'

  const sectionLabel: React.CSSProperties = {
    fontSize: '0.75rem',
    fontWeight: 700,
    color: '#94a3b8',
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
    margin: '0 0 0.875rem',
  }

  return (
    <div style={{ fontFamily: 'sans-serif', minHeight: '100vh', background: '#f8fafc' }}>

      {/* ── Top bar ───────────────────────────────────────────────── */}
      <div style={{
        background: '#fff',
        borderBottom: '1px solid #e0e0e0',
        padding: '0.625rem 2rem',
      }}>
        <div style={{
          maxWidth: '1200px',
          margin: '0 auto',
          display: 'flex',
          alignItems: 'center',
          gap: '1.25rem',
        }}>
          <button
            onClick={() => navigate(dashLink)}
            style={{ fontSize: '0.875rem', padding: '0.3rem 0.75rem' }}
          >
            ← Dashboard
          </button>
          <h1 style={{ margin: 0, fontSize: '1.125rem', fontWeight: 600 }}>Reports — Grays.com</h1>
        </div>
      </div>

      {/* ── Main ──────────────────────────────────────────────────── */}
      <main style={{ maxWidth: '1200px', margin: '0 auto', padding: '2rem' }}>

        {!gameInstanceId && (
          <p style={{ color: '#94a3b8' }}>Navigate here from the Dashboard to see report data.</p>
        )}
        {loading && <p style={{ color: '#64748b' }}>Loading…</p>}
        {error && <p style={{ color: '#dc2626' }}>{error}</p>}

        {/* ── Outcomes ─────────────────────────────────────────────── */}
        <section>
          <p style={sectionLabel}>Outcomes</p>
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))',
            gap: '1rem',
          }}>
            <ReportTile
              title="Price Distribution — Agreed Final Prices"
              onProject={projectHistogram}
              disabled={!groups || !config}
            >
              {groups && config
                ? <PriceHistogramSVG groups={groups} config={config} svgRef={histogramSvgRef} />
                : null}
            </ReportTile>

            <ReportTile
              title="Regression — Final Price vs. Initial Offer"
              onProject={projectScatter}
              disabled={!groups}
            >
              {groups ? <ScatterPlotSVG groups={groups} svgRef={scatterSvgRef} /> : null}
            </ReportTile>
          </div>
        </section>

        {/* ── Preparation ──────────────────────────────────────────── */}
        <section style={{ marginTop: '1.75rem' }}>
          <p style={sectionLabel}>Preparation</p>
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))',
            gap: '1rem',
          }}>
            <ReportTile
              title="Planned First Offer — Where did students plan to open?"
              onProject={projectPrepOffer}
              disabled={!participants || !config}
            >
              {participants && config
                ? <DualPrepHistSVG
                    participants={participants}
                    config={config}
                    field="prep_planned_first_offer"
                    title="Planned First Offer"
                    svgRef={prepOfferSvgRef}
                  />
                : null}
            </ReportTile>

            <ReportTile
              title="Estimated Other's Reservation Price — How well did students estimate their counterpart's walk-away?"
              onProject={projectPrepEst}
              disabled={!participants || !config}
            >
              {participants && config
                ? <DualPrepHistSVG
                    participants={participants}
                    config={config}
                    field="prep_estimated_other_price"
                    title="Estimated Other's Reservation Price"
                    svgRef={prepEstSvgRef}
                  />
                : null}
            </ReportTile>
          </div>
        </section>

        {/* ── AI-Analysis Exports ──────────────────────────────────── */}
        {/* Tiles here use ReportTile/GroupTextExportTile's `compact` modifier —
            roughly half footprint of the chart tiles above, since the thumbnail
            doesn't carry enough information to justify the full size. The
            narrower grid track (170px vs. 340px) is scoped to this section only. */}
        <section style={{ marginTop: '1.75rem' }}>
          <p style={sectionLabel}>AI-Analysis Exports</p>
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))',
            gap: '0.75rem',
          }}>
            <GroupTextExportTile
              title="Debrief Reflections — Export for AI Analysis"
              headerText={DEBRIEF_REFLECTION_HEADER}
              groups={groups}
              participants={participants}
              field="debrief_reflection"
              compact
            />

            {/* Dynamic prep-question tiles — driven by config.prep_text_questions.
                Headers match the live prompt text; adding/editing/hiding a question
                in the Settings editor is immediately reflected here on next open. */}
            {(config?.prep_text_questions ?? [])
              .filter(q => q.type === 'text')
              .slice()
              .sort((a, b) => a.order - b.order)
              .map((q, i) => (
                <GroupTextExportTile
                  key={q.field}
                  title={`Prep Q${i + 1}: ${q.field} — Export for AI Analysis`}
                  headerText={`Prep Q${i + 1} — "${q.prompt}"`}
                  groups={groups}
                  participants={participants}
                  field={q.field}
                  compact
                />
              ))}
          </div>
        </section>

      </main>
    </div>
  )
}
