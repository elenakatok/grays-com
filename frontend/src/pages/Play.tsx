import { useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { signInWithCustomToken, setPersistence, inMemoryPersistence, signOut } from 'firebase/auth'
import { doc, getDoc } from 'firebase/firestore'
import { auth, db } from '../firebase'
import { type CallArgs, assignRole, callFunctionWithSession, type InfoUrlsResult } from '../api'
import Phase2OutcomeReporting from '../phases/Phase2OutcomeReporting'
import Phase2Results from '../phases/Phase2Results'
import Phase2Debrief from '../phases/Phase2Debrief'
import Phase1Info from '../phases/Phase1Info'
import Phase1KnowledgeCheck from '../phases/Phase1KnowledgeCheck'
import Phase1PrepQuestions from '../phases/Phase1PrepQuestions'
import Phase1NameEntry from '../phases/Phase1NameEntry'
import Phase1HoldForSync from '../phases/Phase1HoldForSync'
import Phase2ConfirmationGate from '../phases/Phase2ConfirmationGate'
import Phase2AttendanceCode from '../phases/Phase2AttendanceCode'
import Phase2WaitingRoom from '../phases/Phase2WaitingRoom'
import Phase2GroupReveal from '../phases/Phase2GroupReveal'
import Phase2OffPlatformHolding from '../phases/Phase2OffPlatformHolding'
import GameHeader from '../components/GameHeader'

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
  | { name: 'info'; role: 'Chris' | 'Kelly'; sellerName: string; buyerName: string; publicUrl: string; privateUrl: string }
  | { name: 'knowledge-check' }
  | { name: 'prep-questions' }
  | { name: 'name-entry' }
  | { name: 'hold-for-sync' }
  | { name: 'confirmation-gate' }
  | { name: 'attendance-code' }
  | { name: 'waiting-room'; participantId: string; gameInstanceId: string; displayName: string; role: 'Chris' | 'Kelly' }
  | { name: 'group-reveal'; groupId: string; participantId: string; gameInstanceId: string; displayName: string; role: 'Chris' | 'Kelly' }
  | { name: 'off-platform-holding'; groupId: string; isLead: boolean }
  | { name: 'outcome-reporting'; groupId: string; participantId: string; gameInstanceId: string; isLead: boolean }
  | { name: 'results'; groupId: string; gameInstanceId: string }
  | { name: 'debrief'; groupId: string; participantId: string; gameInstanceId: string }

type SessionInfo = {
  participantId: string
  gameInstanceId: string
  displayName: string
  role: 'Chris' | 'Kelly'
  isLead: boolean
}

export default function Play() {
  const [searchParams] = useSearchParams()
  const token = searchParams.get('token')
  const devParticipantId = import.meta.env.DEV ? searchParams.get('_dev_participant_id') : null
  const devGameInstanceId = import.meta.env.DEV ? searchParams.get('_dev_game_instance_id') : null

  const [phase, setPhase] = useState<GamePhase>({ name: 'loading' })
  const sessionRef = useRef<SessionInfo | null>(null)

  useEffect(() => {
    let cancelled = false

    // Shared Firestore-to-phase routing used by both resume and fresh-entry paths.
    // On the resume path, role comes from pdata.role (no assignRole response).
    // On the fresh-entry path, roleFallback is the assignRole response role (same value).
    const doPhaseRouting = async (
      participant_id: string,
      game_instance_id: string,
      roleFallback: 'Chris' | 'Kelly',
    ) => {
      const participantSnap = await getDoc(
        doc(db, 'game_instances', game_instance_id, 'participants', participant_id),
      )
      const pdata = participantSnap.data()
      if (pdata?.display_name) sessionRef.current!.displayName = pdata.display_name as string
      if (pdata?.is_lead != null) sessionRef.current!.isLead = Boolean(pdata.is_lead)
      const role: 'Chris' | 'Kelly' = (pdata?.role as 'Chris' | 'Kelly') ?? roleFallback
      sessionRef.current!.role = role

      if (pdata?.prep_status === 'complete') {
        const confirmedReady = pdata.confirmed_ready_at != null
        const attendanceDone = pdata.attendance_confirmed_at != null
        if (!cancelled) {
          if (attendanceDone) {
            if (pdata.group_id) {
              // Read group status to determine the correct resume phase.
              const groupSnap = await getDoc(
                doc(db, 'game_instances', game_instance_id, 'groups', pdata.group_id as string),
              )
              const gdata = groupSnap.data()
              const groupStatus = gdata?.status as string | undefined
              if (!cancelled) {
                if (groupStatus === 'completed') {
                  if (pdata.debrief_initial_offer != null) {
                    setPhase({ name: 'debrief', groupId: pdata.group_id as string, participantId: participant_id, gameInstanceId: game_instance_id })
                  } else {
                    setPhase({ name: 'results', groupId: pdata.group_id as string, gameInstanceId: game_instance_id })
                  }
                } else if (groupStatus === 'reporting' || groupStatus === 'deadlocked') {
                  setPhase({
                    name: 'outcome-reporting',
                    groupId: pdata.group_id as string,
                    participantId: participant_id,
                    gameInstanceId: game_instance_id,
                    isLead: sessionRef.current!.isLead,
                  })
                } else if (groupStatus === 'negotiating') {
                  setPhase({
                    name: 'off-platform-holding',
                    groupId: pdata.group_id as string,
                    isLead: sessionRef.current!.isLead,
                  })
                } else {
                  // 'matched' or unknown — show group reveal
                  setPhase({
                    name: 'group-reveal',
                    groupId: pdata.group_id as string,
                    participantId: participant_id,
                    gameInstanceId: game_instance_id,
                    displayName: sessionRef.current!.displayName,
                    role,
                  })
                }
              }
            } else {
              setPhase({
                name: 'waiting-room',
                participantId: participant_id,
                gameInstanceId: game_instance_id,
                displayName: sessionRef.current!.displayName,
                role,
              })
            }
          } else if (confirmedReady) {
            setPhase({ name: 'attendance-code' })
          } else {
            setPhase({ name: 'hold-for-sync' })
          }
        }
        return
      }

      const { public_info_url, private_info_url, seller_name, buyer_name } =
        await callFunctionWithSession<InfoUrlsResult>('getInfoUrls', {})
      if (!cancelled) {
        setPhase({ name: 'info', role, sellerName: seller_name, buyerName: buyer_name, publicUrl: public_info_url, privateUrl: private_info_url })
      }
    }

    const init = async () => {
      // Production-only: before making any JWT network call, check whether a Firebase
      // session for this participant is already persisted in IndexedDB (browserLocalPersistence).
      // auth.authStateReady() waits for the async IndexedDB restore before auth.currentUser
      // is reliable. The client-side JWT decode is used only to match UIDs — all actual
      // backend authorization still rides the server-verified Firebase ID token.
      if (!import.meta.env.DEV && token) {
        await auth.authStateReady()
        if (cancelled) return

        if (auth.currentUser) {
          let resumedParticipantId: string | null = null
          try {
            const seg = token.split('.')[1] ?? ''
            const payload = JSON.parse(
              atob(seg.replace(/-/g, '+').replace(/_/g, '/')),
            ) as Record<string, unknown>
            if (typeof payload.participant_id === 'string') resumedParticipantId = payload.participant_id
          } catch { /* malformed JWT — fall through to normal entry */ }

          if (resumedParticipantId !== null && auth.currentUser.uid === resumedParticipantId) {
            // Session matches: skip assignRole and signInWithCustomToken.
            const { claims } = await auth.currentUser.getIdTokenResult()
            if (cancelled) return
            const participant_id = auth.currentUser.uid
            const game_instance_id = claims.game_instance_id as string
            sessionRef.current = {
              participantId: participant_id,
              gameInstanceId: game_instance_id,
              role: 'Chris', // overridden from pdata.role in doPhaseRouting
              displayName: '',
              isLead: false,
            }
            try {
              await doPhaseRouting(participant_id, game_instance_id, 'Chris')
            } catch (err) {
              if (!cancelled) {
                setPhase({ name: 'error', message: err instanceof Error ? err.message : 'Something went wrong. Please try again.' })
              }
            }
            return
          }

          // UID mismatch (different game or participant): clear the stale session.
          await signOut(auth)
          if (cancelled) return
        }
      }

      // Normal entry: DEV _test bypass, JWT, or no-token error.
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

      try {
        const { role, customToken, participant_id, game_instance_id } =
          await assignRole(resolvedCallArgs)
        // Initialise with role from assignRole; displayName and isLead filled in doPhaseRouting.
        sessionRef.current = {
          participantId: participant_id,
          gameInstanceId: game_instance_id,
          role,
          displayName: '',
          isLead: false,
        }

        if (import.meta.env.DEV) {
          await setPersistence(auth, inMemoryPersistence)
        }
        await signInWithCustomToken(auth, customToken)
        await doPhaseRouting(participant_id, game_instance_id, role)
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

  function content() {
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
        participantId={sessionRef.current!.participantId}
        gameInstanceId={sessionRef.current!.gameInstanceId}
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
    return (
      <Phase1HoldForSync
        onAdvanceToPhase2={() => setPhase({ name: 'confirmation-gate' })}
      />
    )
  }

  if (phase.name === 'confirmation-gate') {
    return (
      <Phase2ConfirmationGate
        onConfirm={() => setPhase({ name: 'attendance-code' })}
        onCancel={() => setPhase({ name: 'hold-for-sync' })}
      />
    )
  }

  if (phase.name === 'attendance-code') {
    return (
      <Phase2AttendanceCode
        onValid={() => {
          const { participantId, gameInstanceId, displayName, role } = sessionRef.current!
          setPhase({ name: 'waiting-room', participantId, gameInstanceId, displayName, role })
        }}
      />
    )
  }

  if (phase.name === 'waiting-room') {
    return (
      <Phase2WaitingRoom
        participantId={phase.participantId}
        gameInstanceId={phase.gameInstanceId}
        displayName={phase.displayName}
        role={phase.role}
        onMatched={(groupId) =>
          setPhase({
            name: 'group-reveal',
            groupId,
            participantId: phase.participantId,
            gameInstanceId: phase.gameInstanceId,
            displayName: phase.displayName,
            role: phase.role,
          })
        }
      />
    )
  }

  if (phase.name === 'group-reveal') {
    return (
      <Phase2GroupReveal
        groupId={phase.groupId}
        participantId={phase.participantId}
        gameInstanceId={phase.gameInstanceId}
        onContinue={() =>
          setPhase({
            name: 'off-platform-holding',
            groupId: phase.groupId,
            isLead: sessionRef.current!.isLead,
          })
        }
      />
    )
  }

  if (phase.name === 'off-platform-holding') {
    return (
      <Phase2OffPlatformHolding
        groupId={phase.groupId}
        gameInstanceId={sessionRef.current!.gameInstanceId}
        participantId={sessionRef.current!.participantId}
        onReportOutcome={(isLead) =>
          setPhase({
            name: 'outcome-reporting',
            groupId: phase.groupId,
            participantId: sessionRef.current!.participantId,
            gameInstanceId: sessionRef.current!.gameInstanceId,
            isLead,
          })
        }
      />
    )
  }

  if (phase.name === 'outcome-reporting') {
    return (
      <Phase2OutcomeReporting
        groupId={phase.groupId}
        participantId={phase.participantId}
        gameInstanceId={phase.gameInstanceId}
        isLead={phase.isLead}
        onComplete={() =>
          setPhase({
            name: 'results',
            groupId: phase.groupId,
            gameInstanceId: phase.gameInstanceId,
          })
        }
      />
    )
  }

  if (phase.name === 'results') {
    return (
      <Phase2Results
        groupId={phase.groupId}
        gameInstanceId={phase.gameInstanceId}
        onComplete={() =>
          setPhase({
            name: 'debrief',
            groupId: phase.groupId,
            participantId: sessionRef.current!.participantId,
            gameInstanceId: phase.gameInstanceId,
          })
        }
      />
    )
  }

  if (phase.name === 'debrief') {
    return (
      <Phase2Debrief
        groupId={phase.groupId}
        participantId={phase.participantId}
        gameInstanceId={phase.gameInstanceId}
      />
    )
  }

  // phase.name === 'info'
  return (
    <Phase1Info
      role={phase.role}
      sellerName={phase.sellerName}
      buyerName={phase.buyerName}
      publicUrl={phase.publicUrl}
      privateUrl={phase.privateUrl}
      onContinue={() => setPhase({ name: 'knowledge-check' })}
    />
  )
  } // end content()

  return (
    <>
      <GameHeader />
      {content()}
    </>
  )
}
