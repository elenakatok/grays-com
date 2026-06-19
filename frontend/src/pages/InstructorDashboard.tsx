import { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams, useNavigate } from 'react-router-dom'
import { ref, onValue } from 'firebase/database'
import {
  generateAttendanceCode,
  triggerMatching,
  getGroupStatuses,
  submitInstructorOutcome,
  getUnmatchedParticipants,
  addLateParticipant,
  markParticipantLate,
  finalizeInstance,
  pushResultsToClassroom,
  syncRoster,
  getGameConfig,
  CLASSROOM_URL,
  isAuthError,
  type InstructorCallArgs,
  type GroupStatusResult,
  type UnmatchedParticipant,
} from '../api'
import { parsePrice } from '../utils/parsePrice'
import { rtdb } from '../firebase'
import RosterTable from './RosterTable'

const USD = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })

/**
 * Live instructor dashboard.
 * Reached via classroom-launched JWT (role: "instructor") from /play,
 * or directly via /dashboard for standalone mode.
 *
 * Dev URL: /dashboard?_dev_game_instance_id=<uuid>
 */

// Height of the sticky action bar — passed to RosterTable so column headers
// stick immediately below it instead of behind it.
const ACTION_BAR_HEIGHT = 52

const IDLE_THRESHOLD_MS = 45_000

type AttendingEntry = { display_name?: string; role: string; confirmed_at: number }
type PresenceEntry = { online: boolean; last_seen: number }

type FailedPush = { participant_id: string; reason: string }

type FinalizePhase =
  | { phase: 'idle' }
  | { phase: 'finalizing' }
  | { phase: 'pushing' }
  | { phase: 'success'; total: number }
  | { phase: 'partial'; total: number; succeeded: number; failed: FailedPush[] }
  | { phase: 'error'; message: string; retryPushOnly: boolean }

function checkAllGroupsComplete(
  groups: GroupStatusResult[],
): { blocked: false } | { blocked: true; message: string } {
  const incomplete = groups
    .map((g, i) => ({ number: i + 1, status: g.status }))
    .filter((g) => g.status !== 'completed')
  if (incomplete.length === 0) return { blocked: false }
  const count = incomplete.length
  const listing = incomplete.map(({ number, status }) => `Group ${number} (${status})`).join(', ')
  return { blocked: true, message: `${count} group${count !== 1 ? 's' : ''} still in progress: ${listing}.` }
}

function presenceStatus(entry: PresenceEntry | undefined): 'active' | 'idle' | 'disconnected' {
  if (!entry?.online) return 'disconnected'
  return Date.now() - (entry.last_seen ?? 0) > IDLE_THRESHOLD_MS ? 'idle' : 'active'
}

export default function InstructorDashboard() {
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const devGameInstanceId = import.meta.env.DEV
    ? searchParams.get('_dev_game_instance_id')
    : null
  const tokenParam          = searchParams.get('token')
  const gameInstanceIdParam = searchParams.get('game_instance_id')

  // Dev shortcut takes precedence; token path is the production entry.
  const callArgs = useMemo<InstructorCallArgs | null>(() => {
    if (devGameInstanceId) return { _dev: { game_instance_id: devGameInstanceId } }
    if (tokenParam) return { token: tokenParam }
    return null
  }, [devGameInstanceId, tokenParam])

  // String ID used for RTDB paths and httpsCallable functions.
  const gameInstanceId = devGameInstanceId ?? gameInstanceIdParam

  // Builds a nav link that carries the current launch context forward.
  const makeLink = (base: string): string => {
    if (devGameInstanceId) return `${base}?_dev_game_instance_id=${encodeURIComponent(devGameInstanceId)}`
    if (tokenParam && gameInstanceIdParam)
      return `${base}?token=${encodeURIComponent(tokenParam)}&game_instance_id=${encodeURIComponent(gameInstanceIdParam)}`
    return base
  }

  // ── Display names ────────────────────────────────────────────────
  const [sellerName, setSellerName] = useState('Chris')
  const [buyerName,  setBuyerName]  = useState('Kelly')

  // ── Attendance code ──────────────────────────────────────────────
  const [authError, setAuthError] = useState<string | null>(null)

  const [code, setCode] = useState<string | null>(null)
  const [generating, setGenerating] = useState(false)
  const [codeError, setCodeError] = useState<string | null>(null)

  const handleGenerate = () => {
    if (!callArgs) {
      setCodeError('No valid launch token.')
      return
    }
    setGenerating(true)
    setCodeError(null)
    generateAttendanceCode(callArgs)
      .then((result) => { setCode(result.code); setGenerating(false) })
      .catch((err: unknown) => {
        setCodeError(err instanceof Error ? err.message : 'Failed to generate code.')
        setGenerating(false)
      })
  }

  // Opens the current code in a dark full-screen projection window.
  const projectCode = () => {
    if (!code) return
    const w = window.open(
      '',
      'attendance-code-projection',
      'width=960,height=540,menubar=no,toolbar=no,location=no,status=no',
    )
    if (!w) return
    w.document.open()
    w.document.write(
      `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">` +
      `<title>Attendance Code</title><style>` +
      `*{margin:0;padding:0;box-sizing:border-box}` +
      `body{background:#000;display:flex;flex-direction:column;align-items:center;` +
      `justify-content:center;height:100vh;font-family:monospace}` +
      `p{color:#555;font-family:sans-serif;font-size:clamp(0.9rem,2vw,1.4rem);` +
      `letter-spacing:0.4em;text-transform:uppercase;margin-bottom:2rem}` +
      `h1{color:#fff;font-size:clamp(5rem,22vw,18rem);font-weight:900;` +
      `letter-spacing:0.15em;line-height:1}` +
      `</style></head><body>` +
      `<p>Attendance Code</p><h1>${code}</h1>` +
      `</body></html>`,
    )
    w.document.close()
  }

  // ── Real-time presence (for Match Now gating) ───────────────────
  const [attending, setAttending] = useState<Record<string, AttendingEntry>>({})
  const [presence, setPresence] = useState<Record<string, PresenceEntry>>({})

  useEffect(() => {
    if (!gameInstanceId) return
    const attendingRef = ref(rtdb, `attending/${gameInstanceId}`)
    const presenceRef = ref(rtdb, `presence/${gameInstanceId}`)
    const unsubA = onValue(attendingRef, (snap) => {
      setAttending((snap.val() as Record<string, AttendingEntry>) ?? {})
    })
    const unsubP = onValue(presenceRef, (snap) => {
      setPresence((snap.val() as Record<string, PresenceEntry>) ?? {})
    })
    return () => { unsubA(); unsubP() }
  }, [gameInstanceId])

  // ── Matching ─────────────────────────────────────────────────────
  const [matching, setMatching] = useState(false)
  const [matchError, setMatchError] = useState<string | null>(null)

  const handleMatch = () => {
    if (!callArgs) return
    setMatching(true)
    setMatchError(null)
    triggerMatching(callArgs)
      .then(() => { setMatching(false); loadGroupStatuses(callArgs) })
      .catch((err: unknown) => {
        setMatchError(err instanceof Error ? err.message : 'Matching failed.')
        setMatching(false)
      })
  }

  // ── Group statuses ────────────────────────────────────────────────
  const [groupStatuses, setGroupStatuses] = useState<GroupStatusResult[] | null>(null)
  const refreshIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const loadGroupStatuses = (args: InstructorCallArgs) => {
    getGroupStatuses(args)
      .then((r) => setGroupStatuses(r.groups.length > 0 ? r.groups : null))
      .catch(() => {/* silently ignore */})
  }

  useEffect(() => {
    if (!callArgs) return
    // Fire-and-forget: pre-populate roster from classroom enrollment on launch.
    // Errors are non-fatal — the roster still shows self-joined students without it.
    syncRoster(callArgs).catch(() => {/* ignore — roster works without pre-pop */})
    getGameConfig(callArgs)
      .then(cfg => { setSellerName(cfg.seller_name); setBuyerName(cfg.buyer_name) })
      .catch(() => {/* non-fatal — dashboard still works with defaults */})
    getGroupStatuses(callArgs)
      .then((r) => setGroupStatuses(r.groups.length > 0 ? r.groups : null))
      .catch((err: unknown) => {
        if (isAuthError(err)) setAuthError(err instanceof Error ? err.message : 'Authentication failed.')
      })
  }, [callArgs])

  // ── Latecomers ────────────────────────────────────────────────────
  const [unmatchedParticipants, setUnmatchedParticipants] = useState<UnmatchedParticipant[] | null>(null)
  const [addingLatecomer, setAddingLatecomer] = useState<Record<string, boolean>>({})
  const [lateAddError, setLateAddError] = useState<Record<string, string>>({})
  // Ref tracks in-flight markParticipantLate calls to prevent duplicate auto-marks.
  const markingLateRef = useRef<Record<string, boolean>>({})

  const loadUnmatched = (args: InstructorCallArgs) => {
    getUnmatchedParticipants(args)
      .then((r) => setUnmatchedParticipants(r.unmatched))
      .catch(() => {/* silently ignore */})
  }

  const handleAddLatecomer = (participantId: string, groupId: string) => {
    if (!callArgs) return
    setAddingLatecomer((prev) => ({ ...prev, [participantId]: true }))
    setLateAddError((prev) => ({ ...prev, [participantId]: '' }))
    addLateParticipant(callArgs, participantId, groupId)
      .then(() => {
        setAddingLatecomer((prev) => ({ ...prev, [participantId]: false }))
        loadGroupStatuses(callArgs)
        loadUnmatched(callArgs)
      })
      .catch((err: unknown) => {
        setLateAddError((prev) => ({
          ...prev,
          [participantId]: err instanceof Error ? err.message : 'Failed to add.',
        }))
        setAddingLatecomer((prev) => ({ ...prev, [participantId]: false }))
      })
  }

  // Auto-refresh every 8s while any group hasn't completed.
  // Also refreshes the unmatched list on the same cadence when matching has run.
  useEffect(() => {
    if (!callArgs || !groupStatuses) return
    const needsRefresh = groupStatuses.some((g) => g.status !== 'completed')
    if (needsRefresh) {
      refreshIntervalRef.current = setInterval(() => {
        loadGroupStatuses(callArgs)
        loadUnmatched(callArgs)
      }, 8_000)
    }
    return () => { if (refreshIntervalRef.current) clearInterval(refreshIntervalRef.current) }
  }, [callArgs, groupStatuses])

  // Initial latecomer load once matching has run (groupStatuses non-empty = matched).
  useEffect(() => {
    if (!callArgs || !groupStatuses || groupStatuses.length === 0) return
    loadUnmatched(callArgs)
  }, [callArgs, groupStatuses])

  // Auto-mark participants as Late when no group can accept them.
  useEffect(() => {
    if (!callArgs || !unmatchedParticipants) return
    for (const p of unmatchedParticipants) {
      if (p.suggested_group === null && !markingLateRef.current[p.participant_id]) {
        markingLateRef.current[p.participant_id] = true
        markParticipantLate(callArgs, p.participant_id)
          .then(() => {
            delete markingLateRef.current[p.participant_id]
            loadUnmatched(callArgs)
          })
          .catch(() => { delete markingLateRef.current[p.participant_id] })
      }
    }
  }, [unmatchedParticipants, callArgs])

  // ── Deadlock resolution ───────────────────────────────────────────
  const [deadlockInputs, setDeadlockInputs] = useState<Record<string, string>>({})
  const [deadlockConfirms, setDeadlockConfirms] = useState<Record<string, number>>({})
  const [deadlockSubmitting, setDeadlockSubmitting] = useState<Record<string, boolean>>({})
  const [deadlockErrors, setDeadlockErrors] = useState<Record<string, string>>({})

  const submitOutcome = (groupId: string, price: number | null) => {
    if (!callArgs) return
    setDeadlockSubmitting((prev) => ({ ...prev, [groupId]: true }))
    setDeadlockErrors((prev) => ({ ...prev, [groupId]: '' }))
    submitInstructorOutcome(callArgs, groupId, price)
      .then(() => {
        setDeadlockSubmitting((prev) => ({ ...prev, [groupId]: false }))
        loadGroupStatuses(callArgs)
      })
      .catch((err: unknown) => {
        setDeadlockErrors((prev) => ({
          ...prev,
          [groupId]: err instanceof Error ? err.message : 'Failed.',
        }))
        setDeadlockSubmitting((prev) => ({ ...prev, [groupId]: false }))
      })
  }

  const handleDeadlockLockDeal = (groupId: string) => {
    const raw = deadlockInputs[groupId] ?? ''
    const result = parsePrice(raw)
    if (result.kind === 'invalid') {
      setDeadlockErrors((prev) => ({ ...prev, [groupId]: 'Enter a valid price, or use No deal.' }))
      return
    }
    if (result.kind === 'confirm') {
      setDeadlockErrors((prev) => ({ ...prev, [groupId]: '' }))
      setDeadlockConfirms((prev) => ({ ...prev, [groupId]: result.proposed }))
      return
    }
    submitOutcome(groupId, result.value)
  }

  // ── Finalize ─────────────────────────────────────────────────────
  const [finalizePhase, setFinalizePhase] = useState<FinalizePhase>({ phase: 'idle' })

  const handlePushOnly = async () => {
    if (!callArgs) return
    setFinalizePhase({ phase: 'pushing' })
    try {
      const result = await pushResultsToClassroom(callArgs)
      if (result.failed.length === 0) {
        setFinalizePhase({ phase: 'success', total: result.total })
      } else {
        setFinalizePhase({ phase: 'partial', total: result.total, succeeded: result.succeeded, failed: result.failed })
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
    if (!callArgs) return
    setFinalizePhase({ phase: 'finalizing' })
    try {
      await finalizeInstance(callArgs)
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

  // ── Derived state ─────────────────────────────────────────────────
  const activeChrisCount = Object.entries(attending).filter(
    ([pid, info]) => info.role === 'Chris' && presenceStatus(presence[pid]) !== 'disconnected',
  ).length
  const activeKellyCount = Object.entries(attending).filter(
    ([pid, info]) => info.role === 'Kelly' && presenceStatus(presence[pid]) !== 'disconnected',
  ).length
  const alreadyMatched = groupStatuses != null && groupStatuses.length > 0
  const canMatch = !!callArgs && !alreadyMatched && activeChrisCount >= 1 && activeKellyCount >= 1

  // Sort by group_id for stable numbering (same order as RosterTable uses).
  const sortedGroupStatuses = [...(groupStatuses ?? [])].sort((a, b) => a.group_id.localeCompare(b.group_id))
  const deadlockedGroups = sortedGroupStatuses
    .map((g, i) => ({ ...g, groupNumber: i + 1 }))
    .filter((g) => g.status === 'deadlocked')

  const guardResult = checkAllGroupsComplete(groupStatuses ?? [])
  // Placeable latecomers (suggested_group != null) block Finalize.
  // Already-marked-Late (null suggestion, handled automatically) do NOT block.
  const placeableLatecomers = (unmatchedParticipants ?? []).filter((p) => p.suggested_group != null)
  const finalizeRunning = finalizePhase.phase === 'finalizing' || finalizePhase.phase === 'pushing'
  const finalizeDisabled =
    finalizeRunning ||
    finalizePhase.phase === 'success' ||
    !callArgs ||
    !gameInstanceId ||
    (finalizePhase.phase === 'idle' &&
      (!alreadyMatched || guardResult.blocked || placeableLatecomers.length > 0))

  const handleFinalizeClick = () => {
    void (finalizePhase.phase === 'error' && finalizePhase.retryPushOnly
      ? handlePushOnly()
      : handleFinalize())
  }

  const finalizeBtnLabel =
    finalizePhase.phase === 'finalizing' ? 'Computing…' :
    finalizePhase.phase === 'pushing'    ? 'Sending…'   :
    finalizePhase.phase === 'success'    ? '✓ Finalized' :
    (finalizePhase.phase === 'error' || finalizePhase.phase === 'partial') ? 'Retry' :
    'Finalize'

  // ── Render ────────────────────────────────────────────────────────
  if (authError) {
    return (
      <main style={{ padding: '2rem', maxWidth: '800px', margin: '0 auto', fontFamily: 'sans-serif' }}>
        <div style={{
          background: '#fef2f2',
          border: '1px solid #fca5a5',
          borderRadius: 6,
          padding: '1.25rem 1.5rem',
          color: '#7f1d1d',
        }}>
          <p style={{ margin: '0 0 0.75rem' }}>
            This launch link is invalid or has expired. Launch links are only valid for a short time.
            Please return to the classroom and click &ldquo;Launch&rdquo; again to get a new link.
          </p>
          <a href={CLASSROOM_URL} style={{ color: '#b91c1c', fontWeight: 600 }}>Return to classroom</a>
        </div>
      </main>
    )
  }
  return (
    <div style={{ fontFamily: 'sans-serif' }}>

      {/* ── Sticky action bar ─────────────────────────────────────── */}
      <div style={{
        position: 'sticky',
        top: 0,
        zIndex: 10,
        background: '#fff',
        borderBottom: '1px solid #e0e0e0',
        boxShadow: '0 1px 4px rgba(0,0,0,0.06)',
      }}>
        <div style={{
          maxWidth: '1200px',
          margin: '0 auto',
          padding: '0.625rem 2rem',
          display: 'flex',
          alignItems: 'center',
          gap: '0.75rem',
          flexWrap: 'wrap',
        }}>

          {/* Generate Code / code display */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            {code ? (
              <>
                <span style={{
                  fontFamily: 'monospace',
                  fontWeight: 700,
                  fontSize: '1.25rem',
                  letterSpacing: '0.2em',
                  color: '#111',
                }}>
                  {code}
                </span>
                <button
                  onClick={handleGenerate}
                  disabled={generating}
                  title="Regenerate — invalidates the current code"
                  style={{ fontSize: '0.8rem', padding: '0.25rem 0.5rem' }}
                >
                  {generating ? '…' : '↻'}
                </button>
                <button
                  onClick={projectCode}
                  title="Open code in a projectable full-screen window"
                  style={{ fontSize: '0.8rem', padding: '0.25rem 0.5rem' }}
                >
                  Project
                </button>
              </>
            ) : (
              <button
                onClick={handleGenerate}
                disabled={generating || !callArgs}
              >
                {generating ? 'Generating…' : 'Generate Code'}
              </button>
            )}
          </div>

          <div style={{ width: 1, alignSelf: 'stretch', background: '#ddd', margin: '0 0.25rem' }} />

          {/* Match Now */}
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start' }}>
            <button onClick={handleMatch} disabled={!canMatch || matching}>
              {matching ? 'Matching…' : 'Match Now'}
            </button>
            {matchError && (
              <span style={{ fontSize: '0.7rem', color: '#c00', marginTop: 2 }}>{matchError}</span>
            )}
          </div>

          {/* Finalize */}
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start' }}>
            <button onClick={handleFinalizeClick} disabled={finalizeDisabled}>
              {finalizeBtnLabel}
            </button>
            {finalizePhase.phase === 'error' && (
              <span style={{ fontSize: '0.7rem', color: '#c00', marginTop: 2, maxWidth: '18rem' }}>
                {finalizePhase.message}
              </span>
            )}
            {finalizePhase.phase === 'partial' && (
              <span style={{ fontSize: '0.7rem', color: '#a60', marginTop: 2 }}>
                {finalizePhase.succeeded}/{finalizePhase.total} recorded — retry to push failed
              </span>
            )}
          </div>

          <div style={{ width: 1, alignSelf: 'stretch', background: '#ddd', margin: '0 0.25rem' }} />

          {/* Reports */}
          <button onClick={() => navigate(makeLink('/reports'))}>
            Reports →
          </button>

          {/* Settings */}
          <button onClick={() => navigate(makeLink('/settings'))}>
            Settings →
          </button>

          {codeError && (
            <span style={{ fontSize: '0.7rem', color: '#c00' }}>{codeError}</span>
          )}
        </div>
      </div>

      {/* ── Page content ──────────────────────────────────────────── */}
      <main style={{ maxWidth: '1200px', margin: '0 auto', padding: '1.5rem 2rem 3rem' }}>
        <h1 style={{ marginTop: 0, marginBottom: '1.25rem', fontSize: '1.25rem', fontWeight: 600 }}>
          Instructor Dashboard — Grays.com
        </h1>

        {/* ── Latecomers panel ────────────────────────────────────── */}
        {alreadyMatched && unmatchedParticipants != null && unmatchedParticipants.length > 0 && (
          <section style={{
            marginBottom: '1.5rem',
            padding: '1rem 1.25rem',
            background: '#f5f3ff',
            border: '1px solid #c4b5fd',
            borderRadius: 6,
          }}>
            <h2 style={{ margin: '0 0 0.75rem', fontSize: '1rem', fontWeight: 600, color: '#5b21b6' }}>
              ◷ Latecomers ({unmatchedParticipants.length})
            </h2>
            <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              {unmatchedParticipants.map((p) => (
                <li key={p.participant_id} style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.5rem', alignItems: 'flex-start' }}>
                  <div>
                    <span style={{ fontWeight: 500 }}>{p.display_name || p.participant_id.slice(0, 8) + '…'}</span>
                    <span style={{ color: '#666', fontSize: '0.875rem', marginLeft: '0.5rem' }}>({p.role})</span>
                  </div>

                  {p.suggested_group ? (
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '0.25rem' }}>
                      <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                        <span style={{ color: '#555', fontSize: '0.875rem' }}>
                          {p.suggested_group.current_chris}C+{p.suggested_group.current_kelly}K
                          {' → '}{p.suggested_group.result_composition}
                        </span>
                        <button
                          onClick={() => handleAddLatecomer(p.participant_id, p.suggested_group!.group_id)}
                          disabled={addingLatecomer[p.participant_id]}
                          style={{ fontSize: '0.875rem', padding: '0.3rem 0.75rem' }}
                        >
                          {addingLatecomer[p.participant_id] ? 'Adding…' : 'Add to group'}
                        </button>
                      </div>
                      {lateAddError[p.participant_id] && (
                        <p style={{ color: '#c00', fontSize: '0.8rem', margin: 0 }}>
                          {lateAddError[p.participant_id]}
                          {lateAddError[p.participant_id].includes('re-suggest') && (
                            <button
                              onClick={() => callArgs && loadUnmatched(callArgs)}
                              style={{ marginLeft: '0.5rem', fontSize: '0.75rem', padding: '0.15rem 0.4rem' }}
                            >
                              Refresh suggestions
                            </button>
                          )}
                        </p>
                      )}
                    </div>
                  ) : (
                    <span style={{ color: '#7c3aed', fontSize: '0.875rem', fontStyle: 'italic' }}>
                      No eligible group — marked Late
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* ── Needs Resolution panel ──────────────────────────────── */}
        {deadlockedGroups.length > 0 && (
          <section style={{
            marginBottom: '1.5rem',
            padding: '1rem 1.25rem',
            background: '#fff8f0',
            border: '1px solid #f5c6a0',
            borderRadius: 6,
          }}>
            <h2 style={{ margin: '0 0 0.75rem', fontSize: '1rem', fontWeight: 600, color: '#a04000' }}>
              ⚠ Needs Resolution ({deadlockedGroups.length})
            </h2>
            <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              {deadlockedGroups.map((g) => {
                const nameFn = (pid: string) =>
                  attending[pid]?.display_name ?? pid.slice(0, 8) + '…'
                const members = [
                  ...g.chris_participants.map((pid) =>
                    `${nameFn(pid)} (${sellerName}${pid === g.lead_participant_id ? ', lead' : ''})`),
                  ...g.kelly_participants.map((pid) => `${nameFn(pid)} (${buyerName})`),
                ].join(' · ')
                const pendingConfirm = deadlockConfirms[g.group_id]

                return (
                  <li key={g.group_id}>
                    <p style={{ margin: '0 0 0.5rem', fontWeight: 500 }}>
                      Group {g.groupNumber}
                      {members && <span style={{ fontWeight: 400, color: '#555', marginLeft: '0.5rem', fontSize: '0.875rem' }}>— {members}</span>}
                    </p>

                    {pendingConfirm != null ? (
                      <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
                        <span style={{ fontSize: '0.875rem' }}>
                          You entered <strong>{USD.format(pendingConfirm)}</strong>. Is that correct?
                        </span>
                        <button
                          onClick={() => {
                            setDeadlockConfirms((prev) => { const n = { ...prev }; delete n[g.group_id]; return n })
                            submitOutcome(g.group_id, pendingConfirm)
                          }}
                          disabled={deadlockSubmitting[g.group_id]}
                        >
                          {deadlockSubmitting[g.group_id] ? '…' : 'Yes'}
                        </button>
                        <button
                          onClick={() => setDeadlockConfirms((prev) => { const n = { ...prev }; delete n[g.group_id]; return n })}
                          style={{ background: 'none', border: '1px solid #ccc' }}
                        >
                          No
                        </button>
                      </div>
                    ) : (
                      <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
                        <input
                          type="text"
                          inputMode="decimal"
                          placeholder="Price (e.g. 287.5k)"
                          value={deadlockInputs[g.group_id] ?? ''}
                          onChange={(e) => {
                            setDeadlockInputs((prev) => ({ ...prev, [g.group_id]: e.target.value }))
                            setDeadlockConfirms((prev) => { const n = { ...prev }; delete n[g.group_id]; return n })
                          }}
                          style={{ fontSize: '0.9rem', padding: '0.3rem 0.5rem', width: '10rem' }}
                          disabled={deadlockSubmitting[g.group_id]}
                        />
                        <button
                          onClick={() => handleDeadlockLockDeal(g.group_id)}
                          disabled={deadlockSubmitting[g.group_id] || !deadlockInputs[g.group_id]}
                        >
                          {deadlockSubmitting[g.group_id] ? '…' : 'Lock deal'}
                        </button>
                        <button
                          onClick={() => submitOutcome(g.group_id, null)}
                          disabled={deadlockSubmitting[g.group_id]}
                          style={{ background: 'none', border: '1px solid #ccc' }}
                        >
                          No deal
                        </button>
                      </div>
                    )}

                    {deadlockErrors[g.group_id] && (
                      <p style={{ color: '#c00', fontSize: '0.8rem', margin: '0.25rem 0 0' }}>
                        {deadlockErrors[g.group_id]}
                      </p>
                    )}
                  </li>
                )
              })}
            </ul>
          </section>
        )}

        {/* ── Roster table ────────────────────────────────────────── */}
        {callArgs ? (
          <RosterTable
            callArgs={callArgs}
            stickyHeaderTop={ACTION_BAR_HEIGHT}
            groupOutcomes={sortedGroupStatuses}
            onAuthError={setAuthError}
          />
        ) : (
          <p style={{ color: '#c00' }}>
            No valid launch token. Open this page from the classroom.
          </p>
        )}
      </main>
    </div>
  )
}
