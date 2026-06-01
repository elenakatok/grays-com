import * as admin from 'firebase-admin'
import { FieldValue } from 'firebase-admin/firestore'

/**
 * Records that a participant has confirmed they are present and ready to
 * enter Phase 2. Requires prep_status === 'complete'.
 *
 * Idempotent: if confirmed_ready_at is already set, returns without writing.
 */
export async function markReadyConfirmed(
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

  const data = snap.data()!
  if (data.prep_status !== 'complete') {
    throw Object.assign(new Error('Preparation not complete.'), { status: 400 })
  }

  if (data.confirmed_ready_at != null) return

  await ref.update({
    confirmed_ready_at: FieldValue.serverTimestamp(),
  })
}
