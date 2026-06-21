import { useEffect } from 'react'
import { callFunctionWithSession } from '../api'

type Props = {
  onAdvanceToPhase2: () => void
}

export default function Phase1HoldForSync({ onAdvanceToPhase2 }: Props) {
  useEffect(() => {
    // Mark prep complete on the server. Idempotent — safe to call on every mount.
    void callFunctionWithSession<{ ok: boolean }>('completePrep', {}).catch((err: unknown) => {
      console.error('completePrep failed:', err)
    })
  }, [])

  return (
    <main
      style={{
        padding: '2rem',
        maxWidth: '640px',
        margin: '0 auto',
        fontFamily: 'sans-serif',
      }}
    >
      <h1 style={{ marginTop: 0 }}>Preparation complete</h1>
      <p style={{ fontSize: '1.05rem', lineHeight: 1.6, marginBottom: '0.75rem' }}>
        When class begins and your instructor starts the session, you&apos;ll see who
        you&apos;ve been matched with.
      </p>
      <p style={{ color: '#555', marginBottom: '1.75rem' }}>
        You can close this tab and come back later — your work has been saved.
      </p>
      <button onClick={onAdvanceToPhase2}>
        I&apos;m in class — continue
      </button>
    </main>
  )
}
