import { useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { signInWithCustomToken } from 'firebase/auth'
import { auth } from '../firebase'
import { type CallArgs, assignRole, getInfoUrls } from '../api'
import Phase1Info from '../phases/Phase1Info'
import Phase1KnowledgeCheck from '../phases/Phase1KnowledgeCheck'

/**
 * Entry point for classroom-launched (and emulator dev-mode) sessions.
 *
 * Production URL:  /play?token=<classroom JWT>
 * Emulator dev URL: /play?_dev_participant_id=<id>&_dev_game_instance_id=<id>
 *   (DEV only — the _dev_* params bypass JWT verification in the Cloud Functions)
 */

type GamePhase =
  | { name: 'loading' }
  | { name: 'error'; message: string }
  | { name: 'info'; role: 'Chris' | 'Kelly'; publicUrl: string; privateUrl: string }
  | { name: 'knowledge-check' }
  | { name: 'prep-questions' }

export default function Play() {
  const [searchParams] = useSearchParams()
  const token = searchParams.get('token')
  const devParticipantId = import.meta.env.DEV ? searchParams.get('_dev_participant_id') : null
  const devGameInstanceId = import.meta.env.DEV ? searchParams.get('_dev_game_instance_id') : null

  const [phase, setPhase] = useState<GamePhase>({ name: 'loading' })
  // callArgs is session-level (constant after init); stored in a ref to avoid
  // triggering re-renders and to be accessible in phase render branches.
  const callArgsRef = useRef<CallArgs | null>(null)

  useEffect(() => {
    let cancelled = false

    const init = async () => {
      let resolvedCallArgs: CallArgs

      if (import.meta.env.DEV && devParticipantId && devGameInstanceId) {
        resolvedCallArgs = {
          _test: { participant_id: devParticipantId, game_instance_id: devGameInstanceId },
        }
      } else if (token) {
        resolvedCallArgs = { token }
      } else {
        if (!cancelled) {
          setPhase({
            name: 'error',
            message: 'No session token. Please launch this game from the classroom.',
          })
        }
        return
      }

      // Capture before any awaits so all render branches can access it.
      callArgsRef.current = resolvedCallArgs

      try {
        const { role, customToken } = await assignRole(resolvedCallArgs)
        await signInWithCustomToken(auth, customToken)
        const { public_info_url, private_info_url } = await getInfoUrls(resolvedCallArgs)

        if (!cancelled) {
          setPhase({ name: 'info', role, publicUrl: public_info_url, privateUrl: private_info_url })
        }
      } catch (err) {
        if (!cancelled) {
          const message =
            err instanceof Error ? err.message : 'Something went wrong. Please try again.'
          setPhase({ name: 'error', message })
        }
      }
    }

    void init()
    return () => {
      cancelled = true
    }
  }, [token, devParticipantId, devGameInstanceId])

  if (phase.name === 'loading') {
    return (
      <main style={{ padding: '2rem', maxWidth: '640px', margin: '0 auto' }}>
        <p>Setting up your session…</p>
      </main>
    )
  }

  if (phase.name === 'error') {
    return (
      <main style={{ padding: '2rem', maxWidth: '640px', margin: '0 auto' }}>
        <h1>Unable to join</h1>
        <p>{phase.message}</p>
        <p>
          If you don&apos;t have a classroom link, you can <a href="/">log in directly</a>.
        </p>
      </main>
    )
  }

  if (phase.name === 'knowledge-check') {
    return (
      <Phase1KnowledgeCheck
        callArgs={callArgsRef.current!}
        onComplete={() => setPhase({ name: 'prep-questions' })}
      />
    )
  }

  if (phase.name === 'prep-questions') {
    return (
      <main style={{ padding: '2rem', maxWidth: '640px', margin: '0 auto', fontFamily: 'sans-serif' }}>
        <p style={{ color: '#555', marginBottom: '0.25rem' }}>Preparation</p>
        <h1 style={{ marginTop: 0 }}>Preparation questions</h1>
        <p>Coming in the next step.</p>
      </main>
    )
  }

  // phase.name === 'info'
  return (
    <Phase1Info
      role={phase.role}
      publicUrl={phase.publicUrl}
      privateUrl={phase.privateUrl}
      onContinue={() => setPhase({ name: 'knowledge-check' })}
    />
  )
}
