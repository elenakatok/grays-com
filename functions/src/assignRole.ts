import * as admin from 'firebase-admin'
import { FieldValue } from 'firebase-admin/firestore'

export type Role = 'Chris' | 'Kelly'

interface RoleCounts {
  chris: number
  kelly: number
}

/**
 * Atomically assigns Chris or Kelly to a participant within a game instance.
 *
 * - Idempotent: re-calling returns the already-assigned role without touching counts.
 * - Balanced: assigns whichever role is currently behind (Chris on tie).
 * - Atomic: Firestore transaction prevents concurrent double-assignment.
 *
 * Firestore paths written:
 *   game_instances/{gameInstanceId}/participants/{participantId}  — role field
 *   game_instances/{gameInstanceId}/role_counts/totals            — running counters
 */
export async function assignRole(
  gameInstanceId: string,
  participantId: string,
): Promise<Role> {
  const db = admin.firestore()
  const participantRef = db
    .collection('game_instances')
    .doc(gameInstanceId)
    .collection('participants')
    .doc(participantId)
  const countsRef = db
    .collection('game_instances')
    .doc(gameInstanceId)
    .collection('role_counts')
    .doc('totals')

  return db.runTransaction(async (tx) => {
    const [participantSnap, countsSnap] = await Promise.all([
      tx.get(participantRef),
      tx.get(countsRef),
    ])

    // Idempotent: already assigned — return without modifying anything
    const existing = participantSnap.data()
    if (existing?.role) {
      return existing.role as Role
    }

    const { chris = 0, kelly = 0 } = (countsSnap.data() ?? {}) as Partial<RoleCounts>
    const role: Role = kelly < chris ? 'Kelly' : 'Chris'
    const now = FieldValue.serverTimestamp()

    if (participantSnap.exists) {
      tx.update(participantRef, { role, role_assigned_at: now })
    } else {
      tx.set(participantRef, {
        participant_id: participantId,
        game_instance_id: gameInstanceId,
        role,
        role_assigned_at: now,
        prep_status: 'not_started',
      })
    }

    const newCount = (role === 'Chris' ? chris : kelly) + 1
    tx.set(countsRef, { [role === 'Chris' ? 'chris' : 'kelly']: newCount }, { merge: true })

    return role
  })
}
