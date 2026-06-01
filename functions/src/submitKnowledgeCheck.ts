import * as admin from 'firebase-admin'
import { FieldValue } from 'firebase-admin/firestore'

export type KnowledgeCheckResult = {
  correct: boolean
  alreadyCompleted: boolean
  score: number | null
  attempts: number
}

/**
 * Scores the knowledge-check answer for a participant.
 *
 * Rules:
 *   - Correct answer is the participant's assigned role (read server-side; clients
 *     cannot change it).
 *   - Idempotent once complete: if knowledge_check_score is already set, returns
 *     the stored result without modifying the record.
 *   - score = 1.0 if correct on the first attempt, 0.0 on any later attempt.
 *   - Wrong answers increment knowledge_check_attempts but do not set score.
 *
 * All writes go through a transaction to prevent race conditions on the counter.
 */
export async function scoreKnowledgeCheck(
  gameInstanceId: string,
  participantId: string,
  answer: 'Chris' | 'Kelly',
): Promise<KnowledgeCheckResult> {
  const db = admin.firestore()
  const participantRef = db
    .collection('game_instances')
    .doc(gameInstanceId)
    .collection('participants')
    .doc(participantId)

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(participantRef)

    if (!snap.exists) {
      throw Object.assign(new Error('Participant not found.'), { status: 404 })
    }

    const data = snap.data()!
    const role = data.role as 'Chris' | 'Kelly' | undefined
    if (!role) {
      throw Object.assign(new Error('Role not yet assigned.'), { status: 503 })
    }

    // Already scored correctly — return stored values without touching the record.
    if (data.knowledge_check_score != null) {
      return {
        correct: true,
        alreadyCompleted: true,
        score: data.knowledge_check_score as number,
        attempts: data.knowledge_check_attempts as number,
      }
    }

    const prevAttempts = (data.knowledge_check_attempts as number | undefined) ?? 0
    const newAttempts = prevAttempts + 1
    const correct = answer === role

    if (correct) {
      // score = 1.0 only if this is the very first attempt
      const score = prevAttempts === 0 ? 1.0 : 0.0
      tx.update(participantRef, {
        knowledge_check_score: score,
        knowledge_check_attempts: newAttempts,
        knowledge_check_completed_at: FieldValue.serverTimestamp(),
      })
      return { correct: true, alreadyCompleted: false, score, attempts: newAttempts }
    }

    // Wrong answer — increment counter only, score stays null
    tx.update(participantRef, { knowledge_check_attempts: newAttempts })
    return { correct: false, alreadyCompleted: false, score: null, attempts: newAttempts }
  })
}
