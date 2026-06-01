import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { signInWithCustomToken } from 'firebase/auth'
import { auth } from '../firebase'
import { assignRole, getInfoUrls } from '../api'
import Phase1Info from '../phases/Phase1Info'

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
  | { name: 'knowledge-check'; role: 'Chris' | 'Kelly' }

export default function Play() {
  const [searchParams] = useSearchParams()
  const token = searchParams.get('token')
  const devParticipantId = import.meta.env.DEV ? searchParams.get('_dev_participant_id') : null
  const devGameInstanceId = import.meta.env.DEV ? searchParams.get('_dev_game_instance_id') : null

  const [phase, setPhase] = useState<GamePhase>({ name: 'loading' })

  useEffect(() => {
    let cancelled = false

    const init = async () => {
      type CallArgs =
        | { token: string }
        | { _test: { participant_id: string; game_instance_id: string } }

      let callArgs: CallArgs

      if (import.meta.env.DEV && devParticipantId && devGameInstanceId) {
        callArgs = { _test: { participant_id: devParticipantId, game_instance_id: devGameInstanceId } }
      } else if (token) {
        callArgs = { token }
      } else {
        if (!cancelled) {
          setPhase({
            name: 'error',
            message: 'No session token. Please launch this game from the classroom.',
          })
        }
        return
      }

      try {
        const { role, customToken } = await assignRole(callArgs)
        await signInWithCustomToken(auth, customToken)
        const { public_info_url, private_info_url } = await getInfoUrls(callArgs)

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
      <main style={{ padding: '2rem', maxWidth: '640px', margin: '0 auto' }}>
        <h1>Knowledge Check</h1>
        <p>Coming in the next step.</p>
      </main>
    )
  }

  return (
    <Phase1Info
      role={phase.role}
      publicUrl={phase.publicUrl}
      privateUrl={phase.privateUrl}
      onContinue={() => setPhase({ name: 'knowledge-check', role: phase.role })}
    />
  )
}
