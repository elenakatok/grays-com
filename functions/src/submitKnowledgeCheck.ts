import * as admin from 'firebase-admin'
import { FieldValue } from 'firebase-admin/firestore'

export type KnowledgeCheckResult = {
  correct: boolean
  alreadyCompleted: boolean
  score: number | null
  attempts: number
}

/**
 * Scores the role identity question for a participant.
 *
 * Rules:
 *   - Correct answer is the participant's assigned role (read server-side).
 *   - Idempotent once the full KC is complete: if knowledge_check_score is
 *     already set, returns stored result without modifying the record.
 *   - Idempotent once role is passed: if knowledge_check_completed_at is set
 *     (role answered correctly but static questions not yet submitted), does
 *     not re-increment attempts.
 *   - Wrong answers increment knowledge_check_attempts but do not set score.
 *   - The final knowledge_check_score is set by scoreStaticKnowledgeCheck after
 *     the concept questions are submitted; this function no longer writes it.
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

    // Full KC already complete — return stored values without touching the record.
    if (data.knowledge_check_score != null) {
      return {
        correct: true,
        alreadyCompleted: true,
        score: data.knowledge_check_score as number,
        attempts: data.knowledge_check_attempts as number,
      }
    }

    // Role already passed but static questions not yet submitted — don't re-count.
    if (data.knowledge_check_completed_at != null) {
      const correct = answer === role
      return {
        correct,
        alreadyCompleted: false,
        score: null,
        attempts: data.knowledge_check_attempts as number,
      }
    }

    const prevAttempts = (data.knowledge_check_attempts as number | undefined) ?? 0
    const newAttempts = prevAttempts + 1
    const correct = answer === role

    if (correct) {
      tx.update(participantRef, {
        knowledge_check_attempts: newAttempts,
        knowledge_check_completed_at: FieldValue.serverTimestamp(),
      })
      return { correct: true, alreadyCompleted: false, score: null, attempts: newAttempts }
    }

    // Wrong answer — increment counter only.
    tx.update(participantRef, { knowledge_check_attempts: newAttempts })
    return { correct: false, alreadyCompleted: false, score: null, attempts: newAttempts }
  })
}

/**
 * Grades the static concept questions and writes the final knowledge_check_score.
 *
 * The role question is counted as correct (the student must pass it to reach
 * this step). Score = (1 + staticCorrect) / (1 + staticKCQuestions.length).
 *
 * Idempotent: if knowledge_check_score is already set, returns stored values.
 */
export async function scoreStaticKnowledgeCheck(
  gameInstanceId: string,
  participantId: string,
  answers: Record<string, string>,
  staticKCQuestions: Array<{ field: string; correct_value: string }>,
): Promise<{ score: number; correctCount: number; totalCount: number }> {
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

    const totalCount = 1 + staticKCQuestions.length

    // Idempotent: already scored.
    if (data.knowledge_check_score != null) {
      const stored = data.knowledge_check_score as number
      return {
        score: stored,
        correctCount: Math.round(stored * totalCount),
        totalCount,
      }
    }

    const staticCorrect = staticKCQuestions.filter(q => answers[q.field] === q.correct_value).length
    const correctCount = 1 + staticCorrect  // role question always correct
    const score = correctCount / totalCount

    tx.update(participantRef, { knowledge_check_score: score })
    return { score, correctCount, totalCount }
  })
}
