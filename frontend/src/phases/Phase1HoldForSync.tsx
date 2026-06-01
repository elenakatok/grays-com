import { useEffect } from 'react'
import { type CallArgs, completePrep } from '../api'

type Props = {
  callArgs: CallArgs
}

export default function Phase1HoldForSync({ callArgs }: Props) {
  useEffect(() => {
    // Mark prep complete on the server. Idempotent — safe to call on every mount.
    void completePrep(callArgs).catch((err: unknown) => {
      console.error('completePrep failed:', err)
    })
  }, [callArgs])

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
      <p style={{ color: '#555' }}>
        You can close this tab and come back later — your work has been saved.
      </p>
    </main>
  )
}
