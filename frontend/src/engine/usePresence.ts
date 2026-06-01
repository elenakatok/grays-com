import { useEffect } from 'react'
import { ref, onDisconnect, set, serverTimestamp } from 'firebase/database'
import { rtdb } from '../firebase.ts'

const HEARTBEAT_INTERVAL_MS = 30_000

/**
 * Maintains a presence record in Firebase Realtime Database for the given participant.
 * Sets the record to null on disconnect (Firebase's built-in disconnect detection).
 * Sends a heartbeat every 30s so the instructor dashboard can distinguish
 * active (last_seen < 45s) from idle (last_seen ≥ 45s) students.
 *
 * The instructor dashboard reads presence/{instanceId}/{participantId} to show
 * active/idle/disconnected indicators.
 */
export function usePresence(instanceId: string, participantId: string) {
  useEffect(() => {
    if (!instanceId || !participantId) return

    const presenceRef = ref(rtdb, `presence/${instanceId}/${participantId}`)

    const writePresence = () =>
      set(presenceRef, { online: true, last_seen: serverTimestamp() })

    writePresence()
    onDisconnect(presenceRef).remove()

    const heartbeat = setInterval(writePresence, HEARTBEAT_INTERVAL_MS)

    return () => {
      clearInterval(heartbeat)
      set(presenceRef, null)
    }
  }, [instanceId, participantId])
}
