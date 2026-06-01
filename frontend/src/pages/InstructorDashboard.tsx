import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { ref, onValue } from 'firebase/database'
import {
  generateAttendanceCode,
  triggerMatching,
  type InstructorDevArgs,
  type MatchGroupResult,
} from '../api'
import { rtdb } from '../firebase'

/**
 * Live instructor dashboard.
 * Reached via classroom-launched JWT (role: "instructor") from /play,
 * or directly via /dashboard for standalone mode.
 *
 * Dev URL: /dashboard?_dev_game_instance_id=<uuid>
 */

const IDLE_THRESHOLD_MS = 45_000

type AttendingEntry = { display_name: string; role: string; confirmed_at: number }
type PresenceEntry = { online: boolean; last_seen: number }

function presenceStatus(entry: PresenceEntry | undefined): 'active' | 'idle' | 'disconnected' {
  if (!entry?.online) return 'disconnected'
  return Date.now() - (entry.last_seen ?? 0) > IDLE_THRESHOLD_MS ? 'idle' : 'active'
}

const STATUS_ICON = { active: '🟢', idle: '🟡', disconnected: '🔴' } as const

export default function InstructorDashboard() {
  const [searchParams] = useSearchParams()
  const devGameInstanceId = import.meta.env.DEV
    ? searchParams.get('_dev_game_instance_id')
    : null

  // ── Attendance code ──────────────────────────────────────────────
  const [code, setCode] = useState<string | null>(null)
  const [generating, setGenerating] = useState(false)
  const [codeError, setCodeError] = useState<string | null>(null)

  const handleGenerate = () => {
    if (!devGameInstanceId) {
      setCodeError('No game instance ID. Add ?_dev_game_instance_id=<uuid> to the URL.')
      return
    }
    setGenerating(true)
    setCodeError(null)
    const args: InstructorDevArgs = { _dev: { game_instance_id: devGameInstanceId } }
    generateAttendanceCode(args)
      .then((result) => {
        setCode(result.code)
        setGenerating(false)
      })
      .catch((err: unknown) => {
        setCodeError(err instanceof Error ? err.message : 'Failed to generate code.')
        setGenerating(false)
      })
  }

  // ── Real-time presence ───────────────────────────────────────────
  const [attending, setAttending] = useState<Record<string, AttendingEntry>>({})
  const [presence, setPresence] = useState<Record<string, PresenceEntry>>({})

  useEffect(() => {
    if (!devGameInstanceId) return

    const attendingRef = ref(rtdb, `attending/${devGameInstanceId}`)
    const presenceRef = ref(rtdb, `presence/${devGameInstanceId}`)

    const unsubAttending = onValue(attendingRef, (snap) => {
      setAttending((snap.val() as Record<string, AttendingEntry>) ?? {})
    })
    const unsubPresence = onValue(presenceRef, (snap) => {
      setPresence((snap.val() as Record<string, PresenceEntry>) ?? {})
    })

    return () => {
      unsubAttending()
      unsubPresence()
    }
  }, [devGameInstanceId])

  // ── Matching ─────────────────────────────────────────────────────
  const [groups, setGroups] = useState<MatchGroupResult[] | null>(null)
  const [matching, setMatching] = useState(false)
  const [matchError, setMatchError] = useState<string | null>(null)

  const activeChrisCount = Object.entries(attending).filter(
    ([pid, info]) => info.role === 'Chris' && presenceStatus(presence[pid]) !== 'disconnected',
  ).length
  const activeKellyCount = Object.entries(attending).filter(
    ([pid, info]) => info.role === 'Kelly' && presenceStatus(presence[pid]) !== 'disconnected',
  ).length
  const canMatch = devGameInstanceId != null && activeChrisCount >= 1 && activeKellyCount >= 1

  const handleMatch = () => {
    if (!devGameInstanceId) return
    setMatching(true)
    setMatchError(null)
    const args: InstructorDevArgs = { _dev: { game_instance_id: devGameInstanceId } }
    triggerMatching(args)
      .then((result) => {
        setGroups(result.groups)
        setMatching(false)
      })
      .catch((err: unknown) => {
        setMatchError(err instanceof Error ? err.message : 'Matching failed.')
        setMatching(false)
      })
  }

  // ── Derived counts ───────────────────────────────────────────────
  const attendingList = Object.entries(attending)
  const chrisCount = attendingList.filter(([, a]) => a.role === 'Chris').length
  const kellyCount = attendingList.filter(([, a]) => a.role === 'Kelly').length

  return (
    <main
      style={{
        padding: '2rem',
        maxWidth: '1200px',
        margin: '0 auto',
        fontFamily: 'sans-serif',
      }}
    >
      <h1 style={{ marginTop: 0 }}>Instructor Dashboard — Grays.com</h1>

      {/* ── Attendance Code ────────────────────────────────────────── */}
      <section style={{ marginTop: '2rem', maxWidth: '640px' }}>
        <h2 style={{ borderBottom: '1px solid #ddd', paddingBottom: '0.5rem' }}>
          Attendance Code
        </h2>

        {code ? (
          <div>
            <p style={{ color: '#555', marginBottom: '0.5rem' }}>
              Display this code to your class:
            </p>
            <div
              style={{
                fontSize: '5rem',
                fontFamily: 'monospace',
                fontWeight: 'bold',
                letterSpacing: '0.2em',
                color: '#111',
                lineHeight: 1.1,
                marginBottom: '1.5rem',
              }}
            >
              {code}
            </div>
            <button onClick={handleGenerate} disabled={generating}>
              {generating ? 'Generating…' : 'Regenerate code'}
            </button>
            <p style={{ color: '#888', fontSize: '0.875rem', marginTop: '0.75rem' }}>
              Regenerating will invalidate the current code. Students who
              haven&apos;t entered it yet will need to use the new one.
            </p>
          </div>
        ) : (
          <div>
            <p style={{ color: '#555' }}>No code has been generated yet.</p>
            <button onClick={handleGenerate} disabled={generating}>
              {generating ? 'Generating…' : 'Generate code'}
            </button>
          </div>
        )}

        {codeError && (
          <p style={{ color: '#c00', marginTop: '0.75rem' }}>{codeError}</p>
        )}
      </section>

      {/* ── Students Present ──────────────────────────────────────── */}
      <section style={{ marginTop: '2.5rem', maxWidth: '640px' }}>
        <h2 style={{ borderBottom: '1px solid #ddd', paddingBottom: '0.5rem' }}>
          Students Present
        </h2>

        {attendingList.length === 0 ? (
          <p style={{ color: '#555' }}>No students have verified attendance yet.</p>
        ) : (
          <>
            <p style={{ color: '#555', marginBottom: '1rem' }}>
              {chrisCount} Chris{chrisCount !== 1 ? 'es' : ''} + {kellyCount}{' '}
              {kellyCount !== 1 ? 'Kellys' : 'Kelly'} verified present
            </p>
            <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
              {attendingList
                .sort(
                  ([, a], [, b]) =>
                    a.role.localeCompare(b.role) ||
                    a.display_name.localeCompare(b.display_name),
                )
                .map(([pid, info]) => {
                  const status = presenceStatus(presence[pid])
                  return (
                    <li
                      key={pid}
                      style={{
                        padding: '0.4rem 0',
                        borderBottom: '1px solid #f0f0f0',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '0.5rem',
                      }}
                    >
                      <span title={status}>{STATUS_ICON[status]}</span>
                      <span style={{ fontWeight: 500 }}>{info.display_name}</span>
                      <span style={{ color: '#666', fontSize: '0.875rem' }}>
                        ({info.role})
                      </span>
                    </li>
                  )
                })}
            </ul>
          </>
        )}
      </section>

      {/* ── Match Now ─────────────────────────────────────────────── */}
      <section style={{ marginTop: '2.5rem', maxWidth: '640px' }}>
        <h2 style={{ borderBottom: '1px solid #ddd', paddingBottom: '0.5rem' }}>
          Match Now
        </h2>

        {groups == null ? (
          <div>
            <p style={{ color: '#555', marginBottom: '1rem' }}>
              {activeChrisCount} Chris{activeChrisCount !== 1 ? 'es' : ''} +{' '}
              {activeKellyCount} {activeKellyCount !== 1 ? 'Kellys' : 'Kelly'} ready to
              match
            </p>
            <button
              onClick={handleMatch}
              disabled={!canMatch || matching}
              style={{ fontSize: '1rem', padding: '0.6rem 1.5rem' }}
            >
              {matching ? 'Matching…' : 'Match Now'}
            </button>
            {!canMatch && (
              <p style={{ color: '#888', fontSize: '0.875rem', marginTop: '0.5rem' }}>
                Need at least one Chris and one Kelly present.
              </p>
            )}
            {matchError && (
              <p style={{ color: '#c00', marginTop: '0.75rem' }}>{matchError}</p>
            )}
          </div>
        ) : (
          <GroupsDisplay groups={groups} attending={attending} />
        )}
      </section>
    </main>
  )
}

function GroupsDisplay({
  groups,
  attending,
}: {
  groups: MatchGroupResult[]
  attending: Record<string, AttendingEntry>
}) {
  const name = (pid: string) => attending[pid]?.display_name ?? pid.slice(0, 8) + '…'

  return (
    <div>
      <p style={{ color: '#555', marginBottom: '1rem' }}>
        {groups.length} group{groups.length !== 1 ? 's' : ''} matched.
      </p>
      <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
        {groups.map((g, i) => {
          const chrisLabels = g.chris_participants.map((pid) => {
            const isLead = pid === g.lead_participant_id
            return `${name(pid)} (Chris${isLead ? ', lead' : ''})`
          })
          const kellyLabels = g.kelly_participants.map((pid) => `${name(pid)} (Kelly)`)
          return (
            <li
              key={g.group_id}
              style={{
                padding: '0.5rem 0',
                borderBottom: '1px solid #f0f0f0',
              }}
            >
              <span style={{ fontWeight: 500 }}>Group {i + 1}:</span>{' '}
              {[...chrisLabels, ...kellyLabels].join(' + ')}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
