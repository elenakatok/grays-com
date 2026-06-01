import { useEffect, useState } from 'react'
import { doc, getDoc } from 'firebase/firestore'
import { ref, get } from 'firebase/database'
import { db, rtdb } from '../firebase'

type Props = {
  groupId: string
  gameInstanceId: string
}

type Member = { pid: string; displayName: string; role: 'Chris' | 'Kelly' }
type State =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; members: Member[]; agreementReached: boolean; finalPrice: number | null }

function formatPrice(p: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(p)
}

export default function Phase2Results({ groupId, gameInstanceId }: Props) {
  const [state, setState] = useState<State>({ status: 'loading' })

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

        const attendingSnap = await get(ref(rtdb, `attending/${gameInstanceId}`))
        const attending = (attendingSnap.val() ?? {}) as Record<string, { display_name?: string }>

        const members: Member[] = [
          ...chrisPids.map((pid) => ({
            pid,
            displayName: attending[pid]?.display_name ?? 'Unknown',
            role: 'Chris' as const,
          })),
          ...kellyPids.map((pid) => ({
            pid,
            displayName: attending[pid]?.display_name ?? 'Unknown',
            role: 'Kelly' as const,
          })),
        ]

        if (!cancelled) {
          setState({
            status: 'ready',
            members,
            agreementReached: Boolean(g.agreement_reached),
            finalPrice: (g.final_price as number | null) ?? null,
          })
        }
      } catch (err) {
        if (!cancelled) {
          setState({
            status: 'error',
            message: err instanceof Error ? err.message : 'Failed to load results.',
          })
        }
      }
    }
    void load()
    return () => { cancelled = true }
  }, [groupId, gameInstanceId])

  if (state.status === 'loading') {
    return (
      <main style={mainStyle}>
        <p>Loading results…</p>
      </main>
    )
  }
  if (state.status === 'error') {
    return (
      <main style={mainStyle}>
        <h1 style={{ marginTop: 0 }}>Something went wrong</h1>
        <p style={{ color: '#c00' }}>{state.message}</p>
      </main>
    )
  }

  const { members, agreementReached, finalPrice } = state

  return (
    <main style={mainStyle}>
      <h1 style={{ marginTop: 0 }}>Negotiation complete</h1>
      <ul style={{ listStyle: 'none', padding: 0, margin: '0 0 1.5rem' }}>
        {members.map((m) => (
          <li key={m.pid} style={{ padding: '0.35rem 0', fontSize: '1.05rem' }}>
            <strong>{m.role}</strong>: {m.displayName}
          </li>
        ))}
      </ul>
      <p style={{ fontSize: '1.1rem', fontWeight: 500 }}>
        Outcome:{' '}
        {agreementReached && finalPrice != null
          ? `Agreement at ${formatPrice(finalPrice)}`
          : 'No deal reached.'}
      </p>
    </main>
  )
}

const mainStyle: React.CSSProperties = {
  padding: '2rem',
  maxWidth: '640px',
  margin: '0 auto',
  fontFamily: 'sans-serif',
}
