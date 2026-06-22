import { useEffect, useRef, useState } from 'react'
import { getRoster, isAuthError, type RosterParticipant, type RosterGroup } from '../api'

// Minimal shape needed for the Outcome column — passed in from InstructorDashboard.
type GroupOutcome = {
  group_id: string
  agreement_reached: boolean | null
  final_price: number | null
}

type StatusLabel =
  | 'Enrolled'
  | 'Absent'
  | 'Prepared'
  | 'Present'
  | 'Late'
  | 'Matched'
  | 'Negotiating'
  | 'Deadlocked'
  | 'Completed'

type SortKey = 'name' | 'role' | 'status' | 'group' | 'outcome'
type SortDir = 'asc' | 'desc'

type RosterRow = {
  participantId: string
  name: string
  lastName: string
  role: string
  status: StatusLabel
  groupNumber: number | null
  groupId: string | null
  outcome: string
  outcomeTier: 0 | 1 | 2    // 0 = priced deal, 1 = walk-away, 2 = no outcome
  outcomePrice: number | null // set only for tier 0
}

const STATUS_ORDER: Record<StatusLabel, number> = {
  Enrolled: 0,
  Absent: 1,
  Prepared: 2,
  Present: 3,
  Late: 4,
  Matched: 5,
  Negotiating: 6,
  Deadlocked: 7,
  Completed: 8,
}

const USD = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })

function getLastName(name: string): string {
  const tokens = name.trim().split(/\s+/)
  return tokens[tokens.length - 1]
}

function deriveStatus(p: RosterParticipant, groupStatus: string | undefined, sessionLive: boolean): StatusLabel {
  if (p.is_late) return 'Late'
  if (!p.has_attendance && !p.has_prep_completed) return sessionLive ? 'Absent' : 'Enrolled'
  if (p.has_prep_completed && !p.has_attendance) return 'Prepared'
  if (!p.group_id) return 'Present'
  if (groupStatus === 'matched') return 'Matched'
  if (groupStatus === 'negotiating') return 'Negotiating'
  if (groupStatus === 'deadlocked') return 'Deadlocked'
  if (groupStatus === 'completed') return 'Completed'
  return 'Present'
}

function formatOutcome(
  status: StatusLabel,
  groupId: string | null,
  outcomeMap: Map<string, GroupOutcome>,
): string {
  if (status !== 'Completed' || !groupId) return '—'
  const o = outcomeMap.get(groupId)
  if (!o) return '—'
  if (o.agreement_reached === false) return 'No deal'
  if (o.final_price != null) return USD.format(o.final_price)
  return '—'
}

// Returns a stable tier (0/1/2) and raw price for outcome-column sorting.
// Tier ordering is always fixed: deals (0) → walk-aways (1) → no outcome (2).
function computeOutcomeTier(
  status: StatusLabel,
  groupId: string | null,
  outcomeMap: Map<string, GroupOutcome>,
): { outcomeTier: 0 | 1 | 2; outcomePrice: number | null } {
  if (status !== 'Completed' || !groupId) return { outcomeTier: 2, outcomePrice: null }
  const o = outcomeMap.get(groupId)
  if (!o) return { outcomeTier: 2, outcomePrice: null }
  if (o.agreement_reached === false) return { outcomeTier: 1, outcomePrice: null }
  if (o.final_price != null) return { outcomeTier: 0, outcomePrice: o.final_price }
  return { outcomeTier: 2, outcomePrice: null }
}

const POLL_INTERVAL_MS = 10_000

export default function RosterTable({
  gameInstanceId,
  stickyHeaderTop = 0,
  groupOutcomes = [],
  onAuthError,
  sellerName,
  buyerName,
}: {
  gameInstanceId: string
  stickyHeaderTop?: number
  groupOutcomes?: GroupOutcome[]
  onAuthError?: (msg: string) => void
  sellerName?: string
  buyerName?: string
}) {
  const [participants, setParticipants] = useState<RosterParticipant[]>([])
  const [groups, setGroups] = useState<RosterGroup[]>([])
  const [sessionLive, setSessionLive] = useState(false)
  const [sortKey, setSortKey] = useState<SortKey>('name')
  const [sortDir, setSortDir] = useState<SortDir>('asc')
  const [filterChris, setFilterChris] = useState(true)
  const [filterKelly, setFilterKelly] = useState(true)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    let initialLoadDone = false
    const load = () => {
      getRoster()
        .then((r) => {
          initialLoadDone = true
          setParticipants(r.participants)
          setGroups(r.groups)
          setSessionLive(r.session_live)
        })
        .catch((err: unknown) => {
          if (!initialLoadDone && isAuthError(err)) {
            onAuthError?.(err instanceof Error ? err.message : 'Authentication failed.')
          }
          // else: silently ignore poll errors
        })
    }
    load()
    intervalRef.current = setInterval(load, POLL_INTERVAL_MS)
    return () => { if (intervalRef.current) clearInterval(intervalRef.current) }
  }, [gameInstanceId]) // eslint-disable-line react-hooks/exhaustive-deps

  // Build group maps: stable sort by group_id for consistent numbering.
  const sortedGroups = [...groups].sort((a, b) => a.group_id.localeCompare(b.group_id))
  const groupStatusMap = new Map<string, string>()
  const groupNumberMap = new Map<string, number>()
  sortedGroups.forEach((g, i) => {
    groupStatusMap.set(g.group_id, g.status)
    groupNumberMap.set(g.group_id, i + 1)
  })

  const outcomeMap = new Map<string, GroupOutcome>(groupOutcomes.map(g => [g.group_id, g]))

  const rows: RosterRow[] = participants.map((p) => {
    const groupStatus = p.group_id ? groupStatusMap.get(p.group_id) : undefined
    const status = deriveStatus(p, groupStatus, sessionLive)
    const { outcomeTier, outcomePrice } = computeOutcomeTier(status, p.group_id, outcomeMap)
    return {
      participantId: p.participant_id,
      name: p.name,
      lastName: getLastName(p.name),
      role: p.role ?? '—',
      status,
      groupNumber: p.group_id ? (groupNumberMap.get(p.group_id) ?? null) : null,
      groupId: p.group_id,
      outcome: formatOutcome(status, p.group_id, outcomeMap),
      outcomeTier,
      outcomePrice,
    }
  })

  // ── Role filter ──────────────────────────────────────────────────────────────
  // When any role is deselected, only students with that role are shown.
  // Students with role === null ('—') are always excluded when the filter is active
  // — they are pre-session no-shows who never received a role assignment.
  // Walk-aways (outcome = 'No deal') always have a role and pass through normally.
  const anyFilterActive = !filterChris || !filterKelly
  const filteredRows = anyFilterActive
    ? rows.filter((row) => {
        if (row.role === 'Chris') return filterChris
        if (row.role === 'Kelly') return filterKelly
        return false
      })
    : rows

  // ── Sort ─────────────────────────────────────────────────────────────────────
  const sorted = [...filteredRows].sort((a, b) => {
    let cmp = 0
    if (sortKey === 'name') {
      cmp = a.lastName.localeCompare(b.lastName) || a.name.localeCompare(b.name)
    } else if (sortKey === 'role') {
      cmp = a.role.localeCompare(b.role) || a.lastName.localeCompare(b.lastName)
    } else if (sortKey === 'status') {
      cmp = STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.lastName.localeCompare(b.lastName)
    } else if (sortKey === 'group') {
      const an = a.groupNumber ?? Infinity
      const bn = b.groupNumber ?? Infinity
      cmp = an - bn || a.lastName.localeCompare(b.lastName)
    } else if (sortKey === 'outcome') {
      // Tier ordering is always fixed regardless of sort direction:
      //   tier 0 (priced deals) → tier 1 (walk-aways) → tier 2 (no outcome / not completed)
      if (a.outcomeTier !== b.outcomeTier) return a.outcomeTier - b.outcomeTier
      if (a.outcomeTier === 0) {
        // Within priced deals: sort by price, direction-sensitive
        cmp = (a.outcomePrice ?? 0) - (b.outcomePrice ?? 0)
      } else {
        // Within walk-aways and no-outcomes: stable by lastName
        cmp = a.lastName.localeCompare(b.lastName)
      }
    }
    return sortDir === 'asc' ? cmp : -cmp
  })

  const handleSort = (key: SortKey) => {
    if (key === sortKey) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(key)
      setSortDir('asc')
    }
  }

  const arrow = (key: SortKey) => (sortKey === key ? (sortDir === 'asc' ? ' ↑' : ' ↓') : '')

  const thStyle: React.CSSProperties = {
    padding: '0.5rem 0.75rem',
    cursor: 'pointer',
    userSelect: 'none',
    borderBottom: '2px solid #ddd',
    whiteSpace: 'nowrap',
    textAlign: 'left',
    background: '#f5f5f5',
    position: 'sticky',
    top: stickyHeaderTop,
    zIndex: 1,
  }
  const tdStyle: React.CSSProperties = {
    padding: '0.45rem 0.75rem',
    borderBottom: '1px solid #f0f0f0',
  }

  if (participants.length === 0) {
    return <p style={{ color: '#555' }}>No enrolled students yet.</p>
  }

  const chrisLabel = sellerName ?? 'Chris'
  const kellyLabel = buyerName ?? 'Kelly'

  return (
    <div>
      {/* ── Role filter ──────────────────────────────────────────────── */}
      <div style={{
        marginBottom: '0.6rem',
        display: 'flex',
        gap: '1rem',
        alignItems: 'center',
        fontSize: '0.85rem',
        color: '#555',
      }}>
        <span>Show:</span>
        <label style={{ display: 'flex', gap: '0.35rem', alignItems: 'center', cursor: 'pointer' }}>
          <input type="checkbox" checked={filterChris} onChange={() => setFilterChris((v) => !v)} />
          {chrisLabel}
        </label>
        <label style={{ display: 'flex', gap: '0.35rem', alignItems: 'center', cursor: 'pointer' }}>
          <input type="checkbox" checked={filterKelly} onChange={() => setFilterKelly((v) => !v)} />
          {kellyLabel}
        </label>
        {anyFilterActive && (
          <span style={{ color: '#888', fontSize: '0.78rem' }}>
            ({filteredRows.length} of {rows.length} shown)
          </span>
        )}
      </div>

      {/* No overflowX wrapper — it would create a scroll container and defeat position:sticky on <th>. */}
      <table
        data-testid="roster-table"
        style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.9rem' }}
      >
        <thead>
          <tr>
            {(
              [
                ['name', 'Name'],
                ['role', 'Role'],
                ['status', 'Status'],
                ['group', 'Group #'],
                ['outcome', 'Outcome'],
              ] as [SortKey, string][]
            ).map(([key, label]) => (
              <th key={key} style={thStyle} onClick={() => handleSort(key)}>
                {label}{arrow(key)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((row) => {
            const isDeadlocked = row.status === 'Deadlocked'
            const isLate = row.status === 'Late'
            const roleColor =
              row.role === 'Chris' ? '#1a56db' : row.role === 'Kelly' ? '#7e3af2' : '#555'
            return (
              <tr
                key={row.participantId}
                style={
                  isDeadlocked ? { background: '#fff8f0' }
                  : isLate ? { background: '#f5f3ff' }
                  : undefined
                }
                data-status={row.status}
              >
                <td style={tdStyle}>{row.name}</td>
                <td style={{ ...tdStyle, color: roleColor }}>{row.role}</td>
                <td
                  style={{
                    ...tdStyle,
                    ...(isDeadlocked ? { color: '#c00', fontWeight: 600 } : {}),
                    ...(isLate ? { color: '#7c3aed', fontWeight: 600 } : {}),
                  }}
                >
                  {isDeadlocked && '⚠ '}
                  {isLate && '◷ '}
                  {row.status}
                </td>
                <td style={{ ...tdStyle, color: '#555' }}>{row.groupNumber ?? '—'}</td>
                <td style={{ ...tdStyle, color: row.outcome === '—' ? '#bbb' : '#333' }}>
                  {row.outcome}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
