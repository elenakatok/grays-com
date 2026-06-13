import { useEffect, useRef } from 'react'
import { doc, onSnapshot } from 'firebase/firestore'
import { db } from '../firebase'
import { usePresence } from '../engine/usePresence'

type Props = {
  participantId: string
  gameInstanceId: string
  displayName: string
  role: 'Chris' | 'Kelly'
  onMatched: (groupId: string) => void
}

export default function Phase2WaitingRoom({
  participantId,
  gameInstanceId,
  displayName,
  role,
  onMatched,
}: Props) {
  usePresence(gameInstanceId, participantId)

  // Keep a ref to onMatched so the snapshot callback always calls the latest
  // version without the effect needing to re-run (and re-subscribe) when the
  // prop reference changes across Play renders.
  const onMatchedRef = useRef(onMatched)
  onMatchedRef.current = onMatched

  // Watch the participant's own Firestore record for group_id to appear.
  useEffect(() => {
    const tag = `[WaitingRoom:${participantId}]`
    console.log(`${tag} listener attaching @ ${new Date().toISOString()}`)

    const participantRef = doc(
      db,
      'game_instances',
      gameInstanceId,
      'participants',
      participantId,
    )

    const unsub = onSnapshot(participantRef, (snap) => {
      const groupId = snap.data()?.group_id as string | undefined
      console.log(
        `${tag} snapshot fired — group_id=${groupId ?? '(none)'}` +
        ` fromCache=${snap.metadata.fromCache}` +
        ` hasPendingWrites=${snap.metadata.hasPendingWrites}` +
        ` @ ${new Date().toISOString()}`,
      )
      if (groupId) {
        console.log(`${tag} calling onMatched(${groupId})`)
        onMatchedRef.current(groupId)
      }
    })

    const onVisibilityChange = () => {
      console.log(
        `${tag} visibilitychange → ${document.visibilityState}` +
        ` @ ${new Date().toISOString()}`,
      )
    }
    document.addEventListener('visibilitychange', onVisibilityChange)

    return () => {
      console.log(`${tag} listener cleanup (unmount or re-run) @ ${new Date().toISOString()}`)
      unsub()
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [gameInstanceId, participantId]) // onMatched intentionally omitted — held via ref above

  return (
    <main
      style={{
        padding: '2rem',
        maxWidth: '640px',
        margin: '0 auto',
        fontFamily: 'sans-serif',
      }}
    >
      <h1 style={{ marginTop: 0 }}>Waiting to be matched</h1>
      <p style={{ fontSize: '1.05rem', lineHeight: 1.6, marginBottom: '1.5rem' }}>
        Your instructor will pair you with a partner shortly. Stay on this page.
      </p>
      <p style={{ fontSize: '1rem' }}>
        🟢 {displayName} ({role}) — connected
      </p>
      <p style={{ color: '#555', fontSize: '0.9rem', marginTop: '1.5rem' }}>
        Keep this tab open and don&apos;t close it — your instructor needs to see
        you here before pairing you.
      </p>
    </main>
  )
}
