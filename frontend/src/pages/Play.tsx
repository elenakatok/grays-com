import { useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { signInWithCustomToken } from 'firebase/auth'
import { doc, getDoc } from 'firebase/firestore'
import { auth, db } from '../firebase'
import { type CallArgs, assignRole, getInfoUrls } from '../api'
import Phase1Info from '../phases/Phase1Info'
import Phase1KnowledgeCheck from '../phases/Phase1KnowledgeCheck'
import Phase1PrepQuestions from '../phases/Phase1PrepQuestions'
import Phase1NameEntry from '../phases/Phase1NameEntry'
import Phase1HoldForSync from '../phases/Phase1HoldForSync'

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
  | { name: 'name-entry' }
  | { name: 'hold-for-sync' }

type SessionInfo = { participantId: string; gameInstanceId: string }

export default function Play() {
  const [searchParams] = useSearchParams()
  const token = searchParams.get('token')
  const devParticipantId = import.meta.env.DEV ? searchParams.get('_dev_participant_id') : null
  const devGameInstanceId = import.meta.env.DEV ? searchParams.get('_dev_game_instance_id') : null

  const [phase, setPhase] = useState<GamePhase>({ name: 'loading' })
  // Constant after init — stored in refs to avoid re-renders.
  const callArgsRef = useRef<CallArgs | null>(null)
  const sessionRef = useRef<SessionInfo | null>(null)

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

      callArgsRef.current = resolvedCallArgs

      try {
        const { role, customToken, participant_id, game_instance_id } =
          await assignRole(resolvedCallArgs)
        sessionRef.current = { participantId: participant_id, gameInstanceId: game_instance_id }

        await signInWithCustomToken(auth, customToken)

        // Resume check: if prep is already complete, skip straight to the hold
        // screen without re-running the info/knowledge-check/prep flow.
        const participantSnap = await getDoc(
          doc(db, 'game_instances', game_instance_id, 'participants', participant_id),
        )
        if (participantSnap.data()?.prep_status === 'complete') {
          if (!cancelled) setPhase({ name: 'hold-for-sync' })
          return
        }

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
    const { participantId, gameInstanceId } = sessionRef.current!
    return (
      <Phase1PrepQuestions
        participantId={participantId}
        gameInstanceId={gameInstanceId}
        onComplete={() => setPhase({ name: 'name-entry' })}
      />
    )
  }

  if (phase.name === 'name-entry') {
    const { participantId, gameInstanceId } = sessionRef.current!
    return (
      <Phase1NameEntry
        participantId={participantId}
        gameInstanceId={gameInstanceId}
        onComplete={() => setPhase({ name: 'hold-for-sync' })}
      />
    )
  }

  if (phase.name === 'hold-for-sync') {
    return <Phase1HoldForSync callArgs={callArgsRef.current!} />
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
