import { useEffect } from 'react'
import { ref, onDisconnect, set, serverTimestamp } from 'firebase/database'
import { rtdb } from '../firebase.ts'

/**
 * Maintains a presence record in Firebase Realtime Database for the given participant.
 * Sets the record to null on disconnect (Firebase's built-in disconnect detection).
 *
 * The instructor dashboard reads presence/{instanceId}/{participantId} to show
 * active/idle/disconnected indicators.
 */
export function usePresence(instanceId: string, participantId: string) {
  useEffect(() => {
    if (!instanceId || !participantId) return

    const presenceRef = ref(rtdb, `presence/${instanceId}/${participantId}`)

    set(presenceRef, {
      online: true,
      last_seen: serverTimestamp(),
    })

    onDisconnect(presenceRef).remove()

    return () => {
      set(presenceRef, null)
    }
  }, [instanceId, participantId])
}
