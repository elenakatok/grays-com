import * as admin from 'firebase-admin'
import { FieldValue } from 'firebase-admin/firestore'

/**
 * Marks a participant's preparation phase as complete.
 *
 * Idempotent: if prep_status is already "complete", returns without writing.
 * Writes prep_status and prep_completed_at using the Admin SDK so the client
 * can never set these fields directly (they are not in the Firestore rules
 * affectedKeys allowlist).
 */
export async function markPrepComplete(
  gameInstanceId: string,
  participantId: string,
): Promise<void> {
  const db = admin.firestore()
  const ref = db
    .collection('game_instances')
    .doc(gameInstanceId)
    .collection('participants')
    .doc(participantId)

  const snap = await ref.get()
  if (!snap.exists) {
    throw Object.assign(new Error('Participant not found.'), { status: 404 })
  }

  if (snap.data()?.prep_status === 'complete') return

  await ref.update({
    prep_status: 'complete',
    prep_completed_at: FieldValue.serverTimestamp(),
  })
}
