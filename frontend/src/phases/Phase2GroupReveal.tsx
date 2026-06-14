import { useEffect, useRef, useState } from 'react'
import { doc, getDoc, onSnapshot } from 'firebase/firestore'
import { ref, get } from 'firebase/database'
import { db, rtdb } from '../firebase'
import { type CallArgs, startNegotiation } from '../api'

type Props = {
  groupId: string
  participantId: string
  gameInstanceId: string
  callArgs: CallArgs
  onContinue: () => void
}

type Member = {
  pid: string
  displayName: string
  role: 'Chris' | 'Kelly'
  isLead: boolean
}

type State =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; members: Member[] }

export default function Phase2GroupReveal({
  groupId,
  participantId,
  gameInstanceId,
  callArgs,
  onContinue,
}: Props) {
  const [state, setState] = useState<State>({ status: 'loading' })
  const [starting, setStarting] = useState(false)
  const [startError, setStartError] = useState<string | null>(null)

  const calledContinue = useRef(false)
  const onContinueRef = useRef(onContinue)
  onContinueRef.current = onContinue

  // Real-time listener: auto-advance any member when group flips to negotiating.
  useEffect(() => {
    return onSnapshot(
      doc(db, 'game_instances', gameInstanceId, 'groups', groupId),
      (snap) => {
        if (!snap.exists()) return
        const d = snap.data() as { status: string }
        if (d.status === 'negotiating' && !calledContinue.current) {
          calledContinue.current = true
          onContinueRef.current()
        }
      },
    )
  }, [groupId, gameInstanceId]) // onContinue intentionally omitted — held via ref above

  // One-time load of member list and display names.
  useEffect(() => {
    let cancelled = false

    const load = async () => {
      try {
        const groupSnap = await getDoc(
          doc(db, 'game_instances', gameInstanceId, 'groups', groupId),
        )
        if (!groupSnap.exists()) {
          if (!cancelled) setState({ status: 'error', message: 'Group not found.' })
          return
        }
        const g = groupSnap.data()!
        const chrisPids = g.chris_participants as string[]
        const kellyPids = g.kelly_participants as string[]
        const leadPid = g.lead_participant_id as string

        // One-time RTDB read for display names.
        const attendingSnap = await get(ref(rtdb, `attending/${gameInstanceId}`))
        const attending = (attendingSnap.val() ?? {}) as Record<string, { display_name?: string }>

        const members: Member[] = [
          ...chrisPids.map((pid) => ({
            pid,
            displayName: attending[pid]?.display_name ?? 'Unknown',
            role: 'Chris' as const,
            isLead: pid === leadPid,
          })),
          ...kellyPids.map((pid) => ({
            pid,
            displayName: attending[pid]?.display_name ?? 'Unknown',
            role: 'Kelly' as const,
            isLead: false,
          })),
        ]

        if (!cancelled) setState({ status: 'ready', members })
      } catch (err) {
        if (!cancelled) {
          setState({
            status: 'error',
            message: err instanceof Error ? err.message : 'Failed to load group.',
          })
        }
      }
    }

    void load()
    return () => {
      cancelled = true
    }
  }, [groupId, gameInstanceId])

  const handleStartNegotiation = () => {
    setStarting(true)
    setStartError(null)
    startNegotiation(callArgs)
      .then(() => {
        if (!calledContinue.current) {
          calledContinue.current = true
          onContinueRef.current()
        }
      })
      .catch((err: unknown) => {
        setStartError(err instanceof Error ? err.message : 'Failed to start negotiation.')
        setStarting(false)
      })
  }

  if (state.status === 'loading') {
    return (
      <main style={{ padding: '2rem', maxWidth: '640px', margin: '0 auto', fontFamily: 'sans-serif' }}>
        <p>Loading your group…</p>
      </main>
    )
  }

  if (state.status === 'error') {
    return (
      <main style={{ padding: '2rem', maxWidth: '640px', margin: '0 auto', fontFamily: 'sans-serif' }}>
        <h1 style={{ marginTop: 0 }}>Something went wrong</h1>
        <p style={{ color: '#c00' }}>{state.message}</p>
      </main>
    )
  }

  const { members } = state

  return (
    <main
      style={{
        padding: '2rem',
        maxWidth: '640px',
        margin: '0 auto',
        fontFamily: 'sans-serif',
      }}
    >
      <h1 style={{ marginTop: 0 }}>You&apos;ve been matched</h1>
      <p style={{ fontSize: '1.05rem', lineHeight: 1.6, marginBottom: '1.25rem' }}>
        Your group consists of:
      </p>
      <ul style={{ listStyle: 'none', padding: 0, margin: '0 0 1.5rem' }}>
        {members.map((m) => (
          <li key={m.pid} style={{ padding: '0.35rem 0', fontSize: '1.05rem' }}>
            <strong>{m.role}</strong>: {m.displayName}
            {m.isLead ? ' (lead)' : ''}
            {m.pid === participantId ? ' — you' : ''}
          </li>
        ))}
      </ul>
      <p style={{ fontSize: '1.05rem', lineHeight: 1.6, marginBottom: '0.5rem' }}>
        Find your group, then tap this when you begin.
      </p>
      {startError && (
        <p style={{ color: '#c00', marginBottom: '0.75rem' }}>{startError}</p>
      )}
      <button
        onClick={handleStartNegotiation}
        disabled={starting}
        style={{ fontSize: '1rem', padding: '0.6rem 1.25rem' }}
      >
        {starting ? 'Starting…' : 'Start negotiation'}
      </button>
    </main>
  )
}
