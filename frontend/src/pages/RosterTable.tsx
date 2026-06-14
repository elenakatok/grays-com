import { useEffect, useRef, useState } from 'react'
import { getRoster, type InstructorDevArgs, type RosterParticipant, type RosterGroup } from '../api'

type StatusLabel =
  | 'Absent'
  | 'Prepared'
  | 'Present'
  | 'Matched'
  | 'Negotiating'
  | 'Deadlocked'
  | 'Completed'

type SortKey = 'name' | 'role' | 'status' | 'group'
type SortDir = 'asc' | 'desc'

type RosterRow = {
  participantId: string
  name: string
  lastName: string
  role: string
  status: StatusLabel
  groupNumber: number | null
}

const STATUS_ORDER: Record<StatusLabel, number> = {
  Absent: 0,
  Prepared: 1,
  Present: 2,
  Matched: 3,
  Negotiating: 4,
  Deadlocked: 5,
  Completed: 6,
}

function getLastName(name: string): string {
  const tokens = name.trim().split(/\s+/)
  return tokens[tokens.length - 1]
}

function deriveStatus(p: RosterParticipant, groupStatus: string | undefined): StatusLabel {
  if (!p.has_attendance && !p.has_prep_completed) return 'Absent'
  if (p.has_prep_completed && !p.has_attendance) return 'Prepared'
  if (!p.group_id) return 'Present'
  if (groupStatus === 'matched') return 'Matched'
  if (groupStatus === 'negotiating') return 'Negotiating'
  if (groupStatus === 'deadlocked') return 'Deadlocked'
  if (groupStatus === 'completed') return 'Completed'
  return 'Present'
}

const POLL_INTERVAL_MS = 10_000

export default function RosterTable({ gameInstanceId }: { gameInstanceId: string }) {
  const [participants, setParticipants] = useState<RosterParticipant[]>([])
  const [groups, setGroups] = useState<RosterGroup[]>([])
  const [sortKey, setSortKey] = useState<SortKey>('name')
  const [sortDir, setSortDir] = useState<SortDir>('asc')
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    const args: InstructorDevArgs = { _dev: { game_instance_id: gameInstanceId } }
    const load = () => {
      getRoster(args)
        .then((r) => {
          setParticipants(r.participants)
          setGroups(r.groups)
        })
        .catch(() => {/* silently ignore poll errors */})
    }

    load()
    intervalRef.current = setInterval(load, POLL_INTERVAL_MS)
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current)
    }
  }, [gameInstanceId])

  // Build group maps: stable sort by group_id for consistent numbering.
  const sortedGroups = [...groups].sort((a, b) => a.group_id.localeCompare(b.group_id))
  const groupStatusMap = new Map<string, string>()
  const groupNumberMap = new Map<string, number>()
  sortedGroups.forEach((g, i) => {
    groupStatusMap.set(g.group_id, g.status)
    groupNumberMap.set(g.group_id, i + 1)
  })

  const rows: RosterRow[] = participants.map((p) => {
    const groupStatus = p.group_id ? groupStatusMap.get(p.group_id) : undefined
    const name = p.name
    return {
      participantId: p.participant_id,
      name,
      lastName: getLastName(name),
      role: p.role ?? '—',
      status: deriveStatus(p, groupStatus),
      groupNumber: p.group_id ? (groupNumberMap.get(p.group_id) ?? null) : null,
    }
  })

  const sorted = [...rows].sort((a, b) => {
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
  }
  const tdStyle: React.CSSProperties = {
    padding: '0.45rem 0.75rem',
    borderBottom: '1px solid #f0f0f0',
  }

  if (participants.length === 0) {
    return <p style={{ color: '#555' }}>No enrolled students yet.</p>
  }

  return (
    <div style={{ overflowX: 'auto' }}>
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
            const roleColor =
              row.role === 'Chris' ? '#1a56db' : row.role === 'Kelly' ? '#7e3af2' : '#555'
            return (
              <tr
                key={row.participantId}
                style={isDeadlocked ? { background: '#fff8f0' } : undefined}
                data-status={row.status}
              >
                <td style={tdStyle}>{row.name}</td>
                <td style={{ ...tdStyle, color: roleColor }}>{row.role}</td>
                <td
                  style={{
                    ...tdStyle,
                    ...(isDeadlocked ? { color: '#c00', fontWeight: 600 } : {}),
                  }}
                >
                  {isDeadlocked && '⚠ '}
                  {row.status}
                </td>
                <td style={{ ...tdStyle, color: '#555' }}>
                  {row.groupNumber ?? '—'}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
