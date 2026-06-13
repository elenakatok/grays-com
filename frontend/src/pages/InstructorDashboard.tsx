import { useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { ref, onValue } from 'firebase/database'
import {
  generateAttendanceCode,
  triggerMatching,
  getGroupStatuses,
  submitInstructorOutcome,
  getUnmatchedParticipants,
  addLateParticipant,
  finalizeInstance,
  pushResultsToClassroom,
  type InstructorDevArgs,
  type GroupStatusResult,
  type UnmatchedParticipant,
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

// ── Finalize types ────────────────────────────────────────────────────────────

type FailedPush = { participant_id: string; reason: string }

type FinalizePhase =
  | { phase: 'idle' }
  | { phase: 'finalizing' }
  | { phase: 'pushing' }
  | { phase: 'success'; total: number }
  | { phase: 'partial'; total: number; succeeded: number; failed: FailedPush[] }
  | { phase: 'error'; message: string; retryPushOnly: boolean }

// Same algorithm as functions/src/finalizeGuard.ts — typed against GroupStatusResult.
function checkAllGroupsComplete(
  groups: GroupStatusResult[],
): { blocked: false } | { blocked: true; message: string } {
  const incomplete: Array<{ number: number; status: string }> = []
  for (let i = 0; i < groups.length; i++) {
    if (groups[i].status !== 'completed') {
      incomplete.push({ number: i + 1, status: groups[i].status })
    }
  }
  if (incomplete.length === 0) return { blocked: false }
  const count = incomplete.length
  const listing = incomplete
    .map(({ number, status }) => `Group ${number} (${status})`)
    .join(', ')
  return {
    blocked: true,
    message: `${count} group${count !== 1 ? 's' : ''} still in progress: ${listing}.`,
  }
}

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
  const [matching, setMatching] = useState(false)
  const [matchError, setMatchError] = useState<string | null>(null)

  // ── Group statuses (post-match) ───────────────────────────────────
  const [groupStatuses, setGroupStatuses] = useState<GroupStatusResult[] | null>(null)
  const refreshIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const loadGroupStatuses = (instanceId: string) => {
    const args: InstructorDevArgs = { _dev: { game_instance_id: instanceId } }
    getGroupStatuses(args)
      .then((r) => setGroupStatuses(r.groups.length > 0 ? r.groups : null))
      .catch(() => {/* silently ignore refresh errors */})
  }

  // On mount: check if groups already exist
  useEffect(() => {
    if (!devGameInstanceId) return
    loadGroupStatuses(devGameInstanceId)
  }, [devGameInstanceId])

  // Auto-refresh every 8s while any group is not yet completed
  useEffect(() => {
    if (!devGameInstanceId || !groupStatuses) return
    const needsRefresh = groupStatuses.some((g) => g.status !== 'completed')
    if (needsRefresh) {
      refreshIntervalRef.current = setInterval(() => loadGroupStatuses(devGameInstanceId), 8_000)
    }
    return () => {
      if (refreshIntervalRef.current) clearInterval(refreshIntervalRef.current)
    }
  }, [devGameInstanceId, groupStatuses])

  // ── Deadlock resolution ───────────────────────────────────────────
  const [deadlockInputs, setDeadlockInputs] = useState<Record<string, string>>({})
  const [deadlockSubmitting, setDeadlockSubmitting] = useState<Record<string, boolean>>({})
  const [deadlockErrors, setDeadlockErrors] = useState<Record<string, string>>({})

  const handleInstructorOutcome = (groupId: string, priceStr: string | null) => {
    if (!devGameInstanceId) return
    const price = priceStr === null ? null : parseFloat(priceStr.replace(/[,$\s]/g, ''))
    if (priceStr !== null && (isNaN(price!) || price! <= 0)) {
      setDeadlockErrors((prev) => ({ ...prev, [groupId]: 'Enter a valid price, or use No deal.' }))
      return
    }
    setDeadlockSubmitting((prev) => ({ ...prev, [groupId]: true }))
    setDeadlockErrors((prev) => ({ ...prev, [groupId]: '' }))
    const args: InstructorDevArgs = { _dev: { game_instance_id: devGameInstanceId } }
    submitInstructorOutcome(args, groupId, price!)
      .then(() => {
        setDeadlockSubmitting((prev) => ({ ...prev, [groupId]: false }))
        loadGroupStatuses(devGameInstanceId)
      })
      .catch((err: unknown) => {
        setDeadlockErrors((prev) => ({
          ...prev,
          [groupId]: err instanceof Error ? err.message : 'Failed.',
        }))
        setDeadlockSubmitting((prev) => ({ ...prev, [groupId]: false }))
      })
  }

  // ── Late-participant (latecomers) ─────────────────────────────────
  const [unmatchedParticipants, setUnmatchedParticipants] = useState<UnmatchedParticipant[] | null>(null)
  const [loadingUnmatched, setLoadingUnmatched] = useState(false)
  const [unmatchedError, setUnmatchedError] = useState<string | null>(null)
  const [addingLatecomer, setAddingLatecomer] = useState<Record<string, boolean>>({})
  const [lateAddError, setLateAddError] = useState<Record<string, string>>({})

  const loadUnmatched = (instanceId: string) => {
    setLoadingUnmatched(true)
    setUnmatchedError(null)
    const args: InstructorDevArgs = { _dev: { game_instance_id: instanceId } }
    getUnmatchedParticipants(args)
      .then((r) => {
        setUnmatchedParticipants(r.unmatched)
        setLoadingUnmatched(false)
      })
      .catch((err: unknown) => {
        setUnmatchedError(err instanceof Error ? err.message : 'Failed to load latecomers.')
        setLoadingUnmatched(false)
      })
  }

  const handleAddLatecomer = (participantId: string, groupId: string) => {
    if (!devGameInstanceId) return
    setAddingLatecomer((prev) => ({ ...prev, [participantId]: true }))
    setLateAddError((prev) => ({ ...prev, [participantId]: '' }))
    const args: InstructorDevArgs = { _dev: { game_instance_id: devGameInstanceId } }
    addLateParticipant(args, participantId, groupId)
      .then(() => {
        setAddingLatecomer((prev) => ({ ...prev, [participantId]: false }))
        // Reload both group statuses and unmatched list after adding.
        loadGroupStatuses(devGameInstanceId)
        loadUnmatched(devGameInstanceId)
      })
      .catch((err: unknown) => {
        setLateAddError((prev) => ({
          ...prev,
          [participantId]: err instanceof Error ? err.message : 'Failed to add.',
        }))
        setAddingLatecomer((prev) => ({ ...prev, [participantId]: false }))
      })
  }

  // ── Finalize ─────────────────────────────────────────────────────
  const [finalizePhase, setFinalizePhase] = useState<FinalizePhase>({ phase: 'idle' })

  const handlePushOnly = async () => {
    if (!devGameInstanceId) return
    setFinalizePhase({ phase: 'pushing' })
    try {
      const result = await pushResultsToClassroom(devGameInstanceId)
      if (result.failed.length === 0) {
        setFinalizePhase({ phase: 'success', total: result.total })
      } else {
        setFinalizePhase({
          phase: 'partial',
          total: result.total,
          succeeded: result.succeeded,
          failed: result.failed,
        })
      }
    } catch (err) {
      setFinalizePhase({
        phase: 'error',
        message: err instanceof Error ? err.message : 'Push to gradebook failed.',
        retryPushOnly: true,
      })
    }
  }

  const handleFinalize = async () => {
    if (!devGameInstanceId) return
    setFinalizePhase({ phase: 'finalizing' })
    try {
      await finalizeInstance(devGameInstanceId)
    } catch (err) {
      setFinalizePhase({
        phase: 'error',
        message: err instanceof Error ? err.message : 'Finalization failed.',
        retryPushOnly: false,
      })
      return
    }
    await handlePushOnly()
  }

  const activeChrisCount = Object.entries(attending).filter(
    ([pid, info]) => info.role === 'Chris' && presenceStatus(presence[pid]) !== 'disconnected',
  ).length
  const activeKellyCount = Object.entries(attending).filter(
    ([pid, info]) => info.role === 'Kelly' && presenceStatus(presence[pid]) !== 'disconnected',
  ).length
  // Only show Match Now if no groups exist yet
  const alreadyMatched = groupStatuses != null && groupStatuses.length > 0
  const canMatch =
    devGameInstanceId != null &&
    !alreadyMatched &&
    activeChrisCount >= 1 &&
    activeKellyCount >= 1

  const handleMatch = () => {
    if (!devGameInstanceId) return
    setMatching(true)
    setMatchError(null)
    const args: InstructorDevArgs = { _dev: { game_instance_id: devGameInstanceId } }
    triggerMatching(args)
      .then(() => {
        setMatching(false)
        loadGroupStatuses(devGameInstanceId)
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

        {alreadyMatched ? (
          <p style={{ color: '#555' }}>Matching complete — see Groups below.</p>
        ) : (
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
        )}
      </section>

      {/* ── Groups ────────────────────────────────────────────────── */}
      {groupStatuses != null && groupStatuses.length > 0 && (
        <section style={{ marginTop: '2.5rem', maxWidth: '800px' }}>
          <h2 style={{ borderBottom: '1px solid #ddd', paddingBottom: '0.5rem' }}>
            Groups
          </h2>
          <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {groupStatuses.map((g, i) => {
              const nameFn = (pid: string) =>
                attending[pid]?.display_name ?? pid.slice(0, 8) + '…'
              const chrisLabels = g.chris_participants.map((pid) =>
                `${nameFn(pid)} (Chris${pid === g.lead_participant_id ? ', lead' : ''})`,
              )
              const kellyLabels = g.kelly_participants.map((pid) => `${nameFn(pid)} (Kelly)`)
              const members = [...chrisLabels, ...kellyLabels].join(' + ')

              const statusLabel: Record<string, string> = {
                matched: 'Waiting to report',
                reporting: 'Reporting…',
                completed: g.agreement_reached
                  ? `Deal at ${new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(g.final_price!)}`
                  : 'No deal',
                deadlocked: '⚠️ Needs attention',
              }

              return (
                <li
                  key={g.group_id}
                  style={{
                    padding: '0.75rem 0',
                    borderBottom: '1px solid #f0f0f0',
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      flexWrap: 'wrap',
                      gap: '0.25rem',
                    }}
                  >
                    <span>
                      <strong>Group {i + 1}:</strong> {members}
                    </span>
                    <span
                      style={{
                        color: g.status === 'completed' ? '#2a7' : g.status === 'deadlocked' ? '#c00' : '#555',
                        fontSize: '0.9rem',
                      }}
                    >
                      {statusLabel[g.status] ?? g.status}
                      {g.status === 'reporting' && ` (round ${(g.disagree_count ?? 0) + 1})`}
                    </span>
                  </div>

                  {/* Deadlock resolution form */}
                  {g.status === 'deadlocked' && (
                    <div
                      style={{
                        marginTop: '0.75rem',
                        padding: '0.75rem',
                        background: '#fff8f0',
                        border: '1px solid #f5c6a0',
                        borderRadius: 4,
                      }}
                    >
                      <p
                        style={{
                          margin: '0 0 0.5rem',
                          fontSize: '0.9rem',
                          fontWeight: 500,
                        }}
                      >
                        Enter outcome manually:
                      </p>
                      <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
                        <input
                          type="number"
                          min="0"
                          placeholder="Price (e.g. 287500)"
                          value={deadlockInputs[g.group_id] ?? ''}
                          onChange={(e) =>
                            setDeadlockInputs((prev) => ({ ...prev, [g.group_id]: e.target.value }))
                          }
                          style={{ fontSize: '1rem', padding: '0.35rem 0.5rem', width: '10rem' }}
                          disabled={deadlockSubmitting[g.group_id]}
                        />
                        <button
                          onClick={() =>
                            handleInstructorOutcome(g.group_id, deadlockInputs[g.group_id] ?? '')
                          }
                          disabled={deadlockSubmitting[g.group_id] || !deadlockInputs[g.group_id]}
                        >
                          {deadlockSubmitting[g.group_id] ? '…' : 'Lock deal'}
                        </button>
                        <button
                          onClick={() => handleInstructorOutcome(g.group_id, null)}
                          disabled={deadlockSubmitting[g.group_id]}
                          style={{ background: 'none', border: '1px solid #ccc' }}
                        >
                          No deal
                        </button>
                      </div>
                      {deadlockErrors[g.group_id] && (
                        <p style={{ color: '#c00', fontSize: '0.875rem', marginTop: '0.35rem' }}>
                          {deadlockErrors[g.group_id]}
                        </p>
                      )}
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        </section>
      )}

      {/* ── Latecomers ────────────────────────────────────────────── */}
      {alreadyMatched && (
        <section style={{ marginTop: '2.5rem', maxWidth: '800px' }}>
          <h2 style={{ borderBottom: '1px solid #ddd', paddingBottom: '0.5rem' }}>
            Latecomers
          </h2>
          <p style={{ color: '#555', marginBottom: '1rem', fontSize: '0.9rem' }}>
            Students who verified attendance but were not present when matching ran.
            Only groups still on the holding screen (not yet negotiating) are eligible targets.
          </p>

          <button
            onClick={() => devGameInstanceId && loadUnmatched(devGameInstanceId)}
            disabled={loadingUnmatched || !devGameInstanceId}
          >
            {loadingUnmatched ? 'Loading…' : unmatchedParticipants === null ? 'Check for latecomers' : 'Refresh'}
          </button>

          {unmatchedError && (
            <p style={{ color: '#c00', marginTop: '0.5rem' }}>{unmatchedError}</p>
          )}

          {unmatchedParticipants !== null && (
            unmatchedParticipants.length === 0 ? (
              <p style={{ color: '#555', marginTop: '0.75rem' }}>No unmatched students present.</p>
            ) : (
              <ul style={{ listStyle: 'none', padding: 0, margin: '0.75rem 0 0' }}>
                {unmatchedParticipants.map((p) => (
                  <li
                    key={p.participant_id}
                    style={{
                      padding: '0.75rem 0',
                      borderBottom: '1px solid #f0f0f0',
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.5rem', alignItems: 'flex-start' }}>
                      <div>
                        <span style={{ fontWeight: 500 }}>{p.display_name || p.participant_id.slice(0, 8) + '…'}</span>
                        <span style={{ color: '#666', fontSize: '0.875rem', marginLeft: '0.5rem' }}>({p.role})</span>
                      </div>

                      {p.suggested_group ? (
                        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
                          <span style={{ color: '#555', fontSize: '0.875rem' }}>
                            Suggested: group {p.suggested_group.group_id.slice(0, 6)}…
                            &nbsp;({p.suggested_group.current_chris}C+{p.suggested_group.current_kelly}K
                            &nbsp;→&nbsp;{p.suggested_group.result_composition})
                          </span>
                          <button
                            onClick={() => handleAddLatecomer(p.participant_id, p.suggested_group!.group_id)}
                            disabled={addingLatecomer[p.participant_id]}
                            style={{ fontSize: '0.875rem', padding: '0.3rem 0.75rem' }}
                          >
                            {addingLatecomer[p.participant_id] ? 'Adding…' : `Add to group`}
                          </button>
                        </div>
                      ) : (
                        <span style={{ color: '#888', fontSize: '0.875rem' }}>
                          No eligible group — all groups have started negotiating or are full.
                        </span>
                      )}
                    </div>

                    {lateAddError[p.participant_id] && (
                      <p style={{ color: '#c00', fontSize: '0.875rem', marginTop: '0.35rem' }}>
                        {lateAddError[p.participant_id]}
                        {lateAddError[p.participant_id].includes('re-suggest') && (
                          <button
                            onClick={() => devGameInstanceId && loadUnmatched(devGameInstanceId)}
                            style={{ marginLeft: '0.5rem', fontSize: '0.8rem', padding: '0.2rem 0.5rem' }}
                          >
                            Refresh suggestions
                          </button>
                        )}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            )
          )}
        </section>
      )}
      {/* ── Finalize Results ──────────────────────────────────────── */}
      {alreadyMatched && (
        <section style={{ marginTop: '2.5rem', maxWidth: '640px' }}>
          <h2 style={{ borderBottom: '1px solid #ddd', paddingBottom: '0.5rem' }}>
            Finalize Results
          </h2>

          {(() => {
            const guardResult = checkAllGroupsComplete(groupStatuses ?? [])
            const running =
              finalizePhase.phase === 'finalizing' || finalizePhase.phase === 'pushing'

            return (
              <>
                {/* Guard status */}
                {guardResult.blocked ? (
                  <p style={{ color: '#c00', marginBottom: '0.75rem' }}>
                    {guardResult.message}
                  </p>
                ) : (
                  <p style={{ color: '#555', marginBottom: '0.75rem' }}>
                    All groups completed. Ready to finalize and record grades.
                  </p>
                )}

                {/* Running progress */}
                {finalizePhase.phase === 'finalizing' && (
                  <p style={{ color: '#555', fontStyle: 'italic' }}>
                    Computing scores…
                  </p>
                )}
                {finalizePhase.phase === 'pushing' && (
                  <p style={{ color: '#555', fontStyle: 'italic' }}>
                    Sending results to gradebook…
                  </p>
                )}

                {/* Success */}
                {finalizePhase.phase === 'success' && (
                  <p style={{ color: '#2a7', fontWeight: 500 }}>
                    ✓ All {finalizePhase.total} results recorded in the gradebook.
                  </p>
                )}

                {/* Partial failure */}
                {finalizePhase.phase === 'partial' && (
                  <div
                    style={{
                      padding: '0.75rem',
                      background: '#fffbf0',
                      border: '1px solid #f5c650',
                      borderRadius: 4,
                      marginBottom: '0.75rem',
                    }}
                  >
                    <p style={{ margin: '0 0 0.5rem', fontWeight: 500 }}>
                      {finalizePhase.succeeded} of {finalizePhase.total} recorded.{' '}
                      {finalizePhase.failed.length} did not reach the gradebook:
                    </p>
                    <ul style={{ margin: '0 0 0.75rem', paddingLeft: '1.25rem' }}>
                      {finalizePhase.failed.map((f) => (
                        <li key={f.participant_id} style={{ fontSize: '0.875rem' }}>
                          {f.participant_id}: {f.reason}
                        </li>
                      ))}
                    </ul>
                    <button
                      onClick={() => { void handlePushOnly() }}
                      disabled={running}
                      style={{ fontSize: '0.875rem', padding: '0.35rem 0.75rem' }}
                    >
                      Retry push
                    </button>
                  </div>
                )}

                {/* Error */}
                {finalizePhase.phase === 'error' && (
                  <div
                    style={{
                      padding: '0.75rem',
                      background: '#fff5f5',
                      border: '1px solid #f5a0a0',
                      borderRadius: 4,
                      marginBottom: '0.75rem',
                    }}
                  >
                    <p style={{ margin: '0 0 0.5rem', color: '#c00' }}>
                      {finalizePhase.message}
                    </p>
                    {!finalizePhase.retryPushOnly && (
                      <p style={{ margin: '0 0 0.5rem', fontSize: '0.875rem', color: '#555' }}>
                        Nothing was pushed to the gradebook.
                      </p>
                    )}
                    <button
                      onClick={() => {
                        void (finalizePhase.retryPushOnly ? handlePushOnly() : handleFinalize())
                      }}
                      disabled={running}
                      style={{ fontSize: '0.875rem', padding: '0.35rem 0.75rem' }}
                    >
                      Retry
                    </button>
                  </div>
                )}

                {/* Primary action button */}
                {finalizePhase.phase === 'success' ? (
                  <p style={{ fontWeight: 500, color: '#2a7', marginTop: '0.5rem' }}>
                    Results finalized ✅
                  </p>
                ) : (
                  <div style={{ marginTop: '0.5rem' }}>
                    <button
                      onClick={() => { void handleFinalize() }}
                      disabled={running || guardResult.blocked || !devGameInstanceId}
                      style={{ fontSize: '1rem', padding: '0.6rem 1.5rem' }}
                    >
                      {finalizePhase.phase === 'finalizing'
                        ? 'Computing…'
                        : finalizePhase.phase === 'pushing'
                        ? 'Sending…'
                        : 'Finalize Results'}
                    </button>
                  </div>
                )}
              </>
            )
          })()}
        </section>
      )}
    </main>
  )
}

