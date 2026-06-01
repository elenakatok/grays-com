import { useEffect } from 'react'
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

  // Watch the participant's own Firestore record for group_id to appear.
  useEffect(() => {
    const participantRef = doc(
      db,
      'game_instances',
      gameInstanceId,
      'participants',
      participantId,
    )
    return onSnapshot(participantRef, (snap) => {
      const groupId = snap.data()?.group_id as string | undefined
      if (groupId) onMatched(groupId)
    })
  }, [gameInstanceId, participantId, onMatched])

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
