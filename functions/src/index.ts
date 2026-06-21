import { randomUUID } from 'crypto'
import type { Request, Response } from 'express'
import * as admin from 'firebase-admin'
import { FieldValue, Timestamp } from 'firebase-admin/firestore'
import { onRequest, onCall, HttpsError } from 'firebase-functions/v2/https'
import { verifyClassroomToken, ClassroomTokenPayload } from './engine/verifyToken'
import { extractInstructorGameIdCall } from './engine/instructorAuth'
import { reportResult } from './engine/reportResult'
import { matchParticipants } from './matching'
import { computeZScores } from './finalize'
import type { GameConfig, ParticipantRecord } from './finalize'
import { suggestGroupForLatecomer } from './lateParticipant'
import { assignRole as doAssignRole } from './assignRole'
import { getInfoUrlsForParticipant } from './getInfoUrls'
import { scoreKnowledgeCheck, calcKCScore } from './submitKnowledgeCheck'
import { markPrepComplete } from './completePrep'
import { markReadyConfirmed } from './confirmReady'
import { generateAttendanceCode as doGenerateCode, verifyAttendanceCode as doVerifyCode } from './attendanceCode'

admin.initializeApp()

// Public key is baked into classroomPublicKey.ts — no secret needed for auth.
// CLASSROOM_CALLBACK_SECRET and CLASSROOM_ROSTER_URL are set via .env (emulator) / Secret Manager (prod).

const CORS_ORIGINS = new Set(['https://grays.mygames.live'])

function corsOnRequest(handler: (req: Request, res: Response) => Promise<void>) {
  return onRequest(async (req, res) => {
    const origin = req.headers.origin ?? ''
    if (CORS_ORIGINS.has(origin)) {
      res.set('Access-Control-Allow-Origin', origin)
      res.set('Access-Control-Allow-Methods', 'POST, OPTIONS')
      res.set('Access-Control-Allow-Headers', 'Content-Type')
      res.set('Vary', 'Origin')
    }
    if (req.method === 'OPTIONS') {
      res.status(204).send('')
      return
    }
    await handler(req, res)
  })
}

export { reportResult, matchParticipants, computeZScores }
export { pushResultsToClassroom } from './callbacks'

/**
 * Assigns a role (Chris or Kelly) to a participant on first launch.
 * Idempotent: re-calling returns the same role. Balanced across all participants
 * in the game instance. Atomic via Firestore transaction.
 *
 * Request body (production): { token: "<classroom JWT>" }
 * Request body (emulator test mode): { _test: { participant_id, game_instance_id } }
 *
 * Response: { ok: true, role: "Chris" | "Kelly", customToken: "<Firebase custom auth token>" }
 * The customToken lets the client sign in to Firebase Auth so Firestore security
 * rules can identify them by participant_id (request.auth.uid == participantId).
 */
export const assignRole = corsOnRequest(async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' })
    return
  }

  const body = req.body as Record<string, unknown>
  let participantId: string
  let gameInstanceId: string

  const isEmulator = process.env.FUNCTIONS_EMULATOR === 'true'

  if (isEmulator && body._test != null) {
    const test = body._test as Record<string, unknown>
    if (typeof test.participant_id !== 'string' || typeof test.game_instance_id !== 'string') {
      res.status(400).json({ error: '_test requires participant_id and game_instance_id strings' })
      return
    }
    participantId = test.participant_id
    gameInstanceId = test.game_instance_id
  } else {
    if (typeof body.token !== 'string') {
      res.status(400).json({ error: 'Missing token' })
      return
    }
    let payload: ClassroomTokenPayload
    try {
      payload = verifyClassroomToken(body.token)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Invalid token'
      res.status(401).json({ error: message })
      return
    }
    participantId = payload.participant_id
    gameInstanceId = payload.game_instance_id
  }

  try {
    const role = await doAssignRole(gameInstanceId, participantId)
    const customToken = await admin.auth().createCustomToken(participantId, {
      game_instance_id: gameInstanceId,
    })
    res.json({ ok: true, role, customToken, participant_id: participantId, game_instance_id: gameInstanceId })
  } catch (err) {
    console.error('assignRole error:', err)
    res.status(500).json({ error: 'Internal error' })
  }
})

/**
 * Returns the PDF URLs a participant is authorized to see.
 * Reads the participant's role from their Firestore record (server-written, not
 * client-mutable) and returns only that role's private URL — the other role's
 * URL is never included in the response.
 *
 * Request body (production): { token: "<classroom JWT>" }
 * Request body (emulator test mode): { _test: { participant_id, game_instance_id } }
 *
 * Response: { ok: true, role, public_info_url, private_info_url }
 */
export const getInfoUrls = corsOnRequest(async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' })
    return
  }

  const body = req.body as Record<string, unknown>
  let participantId: string
  let gameInstanceId: string

  const isEmulator = process.env.FUNCTIONS_EMULATOR === 'true'

  if (isEmulator && body._test != null) {
    const test = body._test as Record<string, unknown>
    if (typeof test.participant_id !== 'string' || typeof test.game_instance_id !== 'string') {
      res.status(400).json({ error: '_test requires participant_id and game_instance_id strings' })
      return
    }
    participantId = test.participant_id
    gameInstanceId = test.game_instance_id
  } else {
    if (typeof body.token !== 'string') {
      res.status(400).json({ error: 'Missing token' })
      return
    }
    let payload: ClassroomTokenPayload
    try {
      payload = verifyClassroomToken(body.token)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Invalid token'
      res.status(401).json({ error: message })
      return
    }
    participantId = payload.participant_id
    gameInstanceId = payload.game_instance_id
  }

  try {
    const result = await getInfoUrlsForParticipant(gameInstanceId, participantId)
    res.json({ ok: true, ...result })
  } catch (err) {
    const status = (err as { status?: number }).status ?? 500
    const message = err instanceof Error ? err.message : 'Internal error'
    res.status(status).json({ error: message })
  }
})

/**
 * Scores a knowledge-check answer. Verifies the answer against the participant's
 * stored role (server-side), increments attempt count, and writes the score only
 * on a correct answer.
 *
 * Request body: { token | _test, answer: "Chris" | "Kelly" }
 * Response: { ok, correct, alreadyCompleted, score, attempts }
 */
export const submitKnowledgeCheck = corsOnRequest(async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' })
    return
  }

  const body = req.body as Record<string, unknown>
  let participantId: string
  let gameInstanceId: string

  const isEmulator = process.env.FUNCTIONS_EMULATOR === 'true'

  if (isEmulator && body._test != null) {
    const test = body._test as Record<string, unknown>
    if (typeof test.participant_id !== 'string' || typeof test.game_instance_id !== 'string') {
      res.status(400).json({ error: '_test requires participant_id and game_instance_id strings' })
      return
    }
    participantId = test.participant_id
    gameInstanceId = test.game_instance_id
  } else {
    if (typeof body.token !== 'string') {
      res.status(400).json({ error: 'Missing token' })
      return
    }
    let payload: ClassroomTokenPayload
    try {
      payload = verifyClassroomToken(body.token)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Invalid token'
      res.status(401).json({ error: message })
      return
    }
    participantId = payload.participant_id
    gameInstanceId = payload.game_instance_id
  }

  const answer = body.answer
  if (answer !== 'Chris' && answer !== 'Kelly') {
    res.status(400).json({ error: 'answer must be "Chris" or "Kelly"' })
    return
  }

  try {
    const result = await scoreKnowledgeCheck(gameInstanceId, participantId, answer)

    // Zero-static finalization: when the role question is answered correctly and
    // this participant has no role-filtered static KC questions, write
    // knowledge_check_score = 1/1 immediately so the batch endpoint is unreachable.
    if (result.correct && !result.alreadyCompleted) {
      const db = admin.firestore()
      const instanceRef = db.collection('game_instances').doc(gameInstanceId)
      const configSnap = await instanceRef.collection('config').doc('main').get()
      const cd = (configSnap.data() ?? {}) as Record<string, unknown>
      const stored = parsePrepTextQuestions(cd.prep_text_questions) ?? DEFAULT_PREP_TEXT_QUESTIONS
      // Same role filter used by submitStaticKnowledgeCheck and submitStaticKnowledgeCheckQuestion.
      const staticKCQuestions = mergeWithSystemDefaults(stored).filter(q =>
        q.category === 'knowledge_check' &&
        q.grading === 'static' &&
        !!q.correct_value &&
        (q.role_target === 'both' || q.role_target === answer),
      )

      if (staticKCQuestions.length === 0) {
        const participantRef = instanceRef.collection('participants').doc(participantId)
        await db.runTransaction(async (tx) => {
          const snap = await tx.get(participantRef)
          if ((snap.data() ?? {}).knowledge_check_score == null) {
            const { score } = calcKCScore({}, [])
            tx.update(participantRef, { knowledge_check_score: score })
          }
        })
      }
    }

    res.json({ ok: true, ...result })
  } catch (err) {
    const status = (err as { status?: number }).status ?? 500
    const message = err instanceof Error ? err.message : 'Internal error'
    res.status(status).json({ error: message })
  }
})

/**
 * Grades a single static KC question for a participant.
 *
 * Idempotent per field: stores the result in kc_static_answers[field] on the
 * participant doc and returns the stored value on repeat calls. After each
 * successful write, checks whether all role-filtered static KC questions are
 * now answered; if so, computes and writes knowledge_check_score in the same
 * transaction.
 *
 * Request body: { token | _test, field: string, answer: string }
 * Response: { ok: true, correct: boolean, explanation: string }
 */
export const submitStaticKnowledgeCheckQuestion = corsOnRequest(async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return }
  const body = req.body as Record<string, unknown>
  const isEmulator = process.env.FUNCTIONS_EMULATOR === 'true'
  const ids = extractStudentIds(body, isEmulator, res)
  if (!ids) return
  const { gameInstanceId, participantId } = ids

  const { field, answer } = body
  if (typeof field !== 'string' || !field) {
    res.status(400).json({ error: 'field must be a non-empty string' })
    return
  }
  if (typeof answer !== 'string' || !answer) {
    res.status(400).json({ error: 'answer must be a non-empty string' })
    return
  }

  try {
    const db = admin.firestore()
    const instanceRef = db.collection('game_instances').doc(gameInstanceId)

    // Read participant role and config in parallel (both are stable at this point).
    const [participantSnap, configSnap] = await Promise.all([
      instanceRef.collection('participants').doc(participantId).get(),
      instanceRef.collection('config').doc('main').get(),
    ])

    const participantRole = (participantSnap.data() ?? {}).role as 'Chris' | 'Kelly' | undefined
    if (!participantRole) {
      res.status(503).json({ error: 'Role not yet assigned.' })
      return
    }

    const cd = (configSnap.data() ?? {}) as Record<string, unknown>
    const stored = parsePrepTextQuestions(cd.prep_text_questions) ?? DEFAULT_PREP_TEXT_QUESTIONS
    const allQuestions = mergeWithSystemDefaults(stored)

    // Role-filtered static KC questions: category=knowledge_check, grading=static, role matches.
    const staticKCQuestions = allQuestions
      .filter(q =>
        q.category === 'knowledge_check' &&
        q.grading === 'static' &&
        !!q.correct_value &&
        (q.role_target === 'both' || q.role_target === participantRole),
      )

    const question = staticKCQuestions.find(q => q.field === field)
    if (!question) {
      res.status(400).json({ error: `'${field}' is not a valid concept check question for your role.` })
      return
    }

    const staticKCForScoring = staticKCQuestions.map(q => ({ field: q.field, correct_value: q.correct_value! }))
    const participantRef = instanceRef.collection('participants').doc(participantId)

    let resultCorrect: boolean
    let resultExplanation: string

    await db.runTransaction(async (tx) => {
      const snap = await tx.get(participantRef)
      if (!snap.exists) {
        throw Object.assign(new Error('Participant not found.'), { status: 404 })
      }
      const data = snap.data()!

      // Require role question to be passed first.
      if (data.knowledge_check_completed_at == null) {
        throw Object.assign(new Error('Role question not yet completed.'), { status: 400 })
      }

      type KCAnswer = { answer: string; correct: boolean }
      const existing = (data.kc_static_answers ?? {}) as Record<string, KCAnswer>

      // Idempotent: already answered — return stored result.
      if (existing[field] != null) {
        resultCorrect = existing[field].correct
        resultExplanation = question.explanation ?? ''
        return
      }

      const correct = answer === question.correct_value!
      resultCorrect = correct
      resultExplanation = question.explanation ?? ''

      // Build full answers map (existing + current) for potential score computation.
      const allAnswersMap: Record<string, string> = {}
      for (const [k, v] of Object.entries(existing)) {
        allAnswersMap[k] = v.answer
      }
      allAnswersMap[field] = answer

      const allAnswered = staticKCForScoring.every(q => q.field === field || existing[q.field] != null)

      const updateData: Record<string, unknown> = {
        [`kc_static_answers.${field}`]: { answer, correct, answered_at: FieldValue.serverTimestamp() },
      }

      if (allAnswered && data.knowledge_check_score == null) {
        const { score } = calcKCScore(allAnswersMap, staticKCForScoring)
        updateData.knowledge_check_score = score
      }

      tx.update(participantRef, updateData)
    })

    res.json({ ok: true, correct: resultCorrect!, explanation: resultExplanation! })
  } catch (err) {
    const status = (err as { status?: number }).status ?? 500
    const message = err instanceof Error ? err.message : 'Internal error'
    res.status(status).json({ error: message })
  }
})

/**
 * Marks a participant's preparation phase as complete, setting prep_status
 * and prep_completed_at. Idempotent: safe to call on every page load of the
 * hold screen. Written via Admin SDK so clients cannot set these fields
 * directly.
 *
 * Request body: { token | _test }
 * Response: { ok: true }
 */
export const completePrep = corsOnRequest(async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' })
    return
  }

  const body = req.body as Record<string, unknown>
  let participantId: string
  let gameInstanceId: string

  const isEmulator = process.env.FUNCTIONS_EMULATOR === 'true'

  if (isEmulator && body._test != null) {
    const test = body._test as Record<string, unknown>
    if (typeof test.participant_id !== 'string' || typeof test.game_instance_id !== 'string') {
      res.status(400).json({ error: '_test requires participant_id and game_instance_id strings' })
      return
    }
    participantId = test.participant_id
    gameInstanceId = test.game_instance_id
  } else {
    if (typeof body.token !== 'string') {
      res.status(400).json({ error: 'Missing token' })
      return
    }
    let payload: ClassroomTokenPayload
    try {
      payload = verifyClassroomToken(body.token)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Invalid token'
      res.status(401).json({ error: message })
      return
    }
    participantId = payload.participant_id
    gameInstanceId = payload.game_instance_id
  }

  try {
    await markPrepComplete(gameInstanceId, participantId)
    res.json({ ok: true })
  } catch (err) {
    const status = (err as { status?: number }).status ?? 500
    const message = err instanceof Error ? err.message : 'Internal error'
    res.status(status).json({ error: message })
  }
})

/**
 * Verifies a classroom-issued JWT and returns the decoded participant payload.
 * Called by the frontend immediately after receiving the ?token= param.
 */
export const verifyToken = corsOnRequest(async (req, res) => {
  const token = req.body?.token as string | undefined
  if (!token) {
    res.status(400).json({ error: 'Missing token' })
    return
  }
  try {
    const payload = verifyClassroomToken(token)
    res.json({ ok: true, payload })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Invalid token'
    res.status(401).json({ error: message })
  }
})

/**
 * Records a participant's commitment to enter Phase 2. Requires prep_status
 * === 'complete'. Writes confirmed_ready_at via Admin SDK. Idempotent.
 *
 * Request body: { token | _test }
 * Response: { ok: true }
 */
export const confirmReady = corsOnRequest(async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' })
    return
  }

  const body = req.body as Record<string, unknown>
  let participantId: string
  let gameInstanceId: string

  const isEmulator = process.env.FUNCTIONS_EMULATOR === 'true'

  if (isEmulator && body._test != null) {
    const test = body._test as Record<string, unknown>
    if (typeof test.participant_id !== 'string' || typeof test.game_instance_id !== 'string') {
      res.status(400).json({ error: '_test requires participant_id and game_instance_id strings' })
      return
    }
    participantId = test.participant_id
    gameInstanceId = test.game_instance_id
  } else {
    if (typeof body.token !== 'string') {
      res.status(400).json({ error: 'Missing token' })
      return
    }
    let payload: ClassroomTokenPayload
    try {
      payload = verifyClassroomToken(body.token)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Invalid token'
      res.status(401).json({ error: message })
      return
    }
    participantId = payload.participant_id
    gameInstanceId = payload.game_instance_id
  }

  try {
    await markReadyConfirmed(gameInstanceId, participantId)
    res.json({ ok: true })
  } catch (err) {
    const status = (err as { status?: number }).status ?? 500
    const message = err instanceof Error ? err.message : 'Internal error'
    res.status(status).json({ error: message })
  }
})

/**
 * Generates a new attendance code for a game instance and stores it.
 * Called by the instructor dashboard. Always overwrites any existing code.
 *
 * Request body (emulator): { _dev: { game_instance_id } }
 * Request body (production): { token: "<instructor JWT>" }
 * Response: { ok: true, code: "ABCDE" }
 */
export const generateAttendanceCode = corsOnRequest(async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' })
    return
  }

  const body = req.body as Record<string, unknown>
  let gameInstanceId: string

  const isEmulator = process.env.FUNCTIONS_EMULATOR === 'true'

  if (isEmulator && body._dev != null) {
    const dev = body._dev as Record<string, unknown>
    if (typeof dev.game_instance_id !== 'string') {
      res.status(400).json({ error: '_dev requires game_instance_id' })
      return
    }
    gameInstanceId = dev.game_instance_id
  } else {
    if (typeof body.token !== 'string') {
      res.status(400).json({ error: 'Missing token' })
      return
    }
    let payload: ClassroomTokenPayload
    try {
      payload = verifyClassroomToken(body.token)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Invalid token'
      res.status(401).json({ error: message })
      return
    }
    if (payload.role !== 'instructor') {
      res.status(403).json({ error: 'Instructor access required' })
      return
    }
    gameInstanceId = payload.game_instance_id
  }

  try {
    const code = await doGenerateCode(gameInstanceId)
    res.json({ ok: true, code })
  } catch (err) {
    console.error('generateAttendanceCode error:', err)
    res.status(500).json({ error: 'Internal error' })
  }
})

/**
 * Verifies a student-submitted attendance code. On match, writes
 * attendance_confirmed_at to the participant record. Idempotent.
 *
 * Request body: { token | _test, code: "ABCDE" }
 * Response: { ok: true }
 */
export const verifyAttendanceCode = corsOnRequest(async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' })
    return
  }

  const body = req.body as Record<string, unknown>
  let participantId: string
  let gameInstanceId: string

  const isEmulator = process.env.FUNCTIONS_EMULATOR === 'true'

  if (isEmulator && body._test != null) {
    const test = body._test as Record<string, unknown>
    if (typeof test.participant_id !== 'string' || typeof test.game_instance_id !== 'string') {
      res.status(400).json({ error: '_test requires participant_id and game_instance_id strings' })
      return
    }
    participantId = test.participant_id
    gameInstanceId = test.game_instance_id
  } else {
    if (typeof body.token !== 'string') {
      res.status(400).json({ error: 'Missing token' })
      return
    }
    let payload: ClassroomTokenPayload
    try {
      payload = verifyClassroomToken(body.token)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Invalid token'
      res.status(401).json({ error: message })
      return
    }
    participantId = payload.participant_id
    gameInstanceId = payload.game_instance_id
  }

  const code = body.code
  if (typeof code !== 'string' || code.trim().length === 0) {
    res.status(400).json({ error: 'code is required' })
    return
  }

  try {
    await doVerifyCode(gameInstanceId, participantId, code)
    res.json({ ok: true })
  } catch (err) {
    const status = (err as { status?: number }).status ?? 500
    const message = err instanceof Error ? err.message : 'Internal error'
    res.status(status).json({ error: message })
  }
})

/**
 * Triggers the matching algorithm for a game instance.
 * Called by the instructor dashboard ("Match Now" button).
 *
 * Eligible participants: attendance verified + currently in RTDB presence.
 * Writes GraysGroup documents and stamps group_id / is_lead on participants.
 * Idempotent: if groups already exist, returns them without re-running.
 *
 * Request body (emulator): { _dev: { game_instance_id } }
 * Request body (production): { token: "<instructor JWT>" }
 * Response: { ok: true, groups: [...] }
 */
export const triggerMatching = corsOnRequest(async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' })
    return
  }

  const body = req.body as Record<string, unknown>
  let gameInstanceId: string

  const isEmulator = process.env.FUNCTIONS_EMULATOR === 'true'

  if (isEmulator && body._dev != null) {
    const dev = body._dev as Record<string, unknown>
    if (typeof dev.game_instance_id !== 'string') {
      res.status(400).json({ error: '_dev requires game_instance_id' })
      return
    }
    gameInstanceId = dev.game_instance_id
  } else {
    if (typeof body.token !== 'string') {
      res.status(400).json({ error: 'Missing token' })
      return
    }
    let payload: ClassroomTokenPayload
    try {
      payload = verifyClassroomToken(body.token)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Invalid token'
      res.status(401).json({ error: message })
      return
    }
    if (payload.role !== 'instructor') {
      res.status(403).json({ error: 'Instructor access required' })
      return
    }
    gameInstanceId = payload.game_instance_id
  }

  try {
    const db = admin.firestore()
    const instanceRef = db.collection('game_instances').doc(gameInstanceId)

    // Idempotency guard: return existing groups if matching already ran.
    const existingGroupsSnap = await instanceRef.collection('groups').limit(1).get()
    if (!existingGroupsSnap.empty) {
      const allGroupsSnap = await instanceRef.collection('groups').get()
      const groups = allGroupsSnap.docs.map((d) => {
        const data = d.data()
        return {
          group_id: data.group_id as string,
          game_instance_id: data.game_instance_id as string,
          chris_participants: data.chris_participants as string[],
          kelly_participants: data.kelly_participants as string[],
          lead_participant_id: data.lead_participant_id as string,
          status: data.status as string,
        }
      })
      res.json({ ok: true, groups, alreadyMatched: true })
      return
    }

    // Read presence from RTDB to identify connected students.
    const [presenceSnap, configSnap] = await Promise.all([
      admin.database().ref(`presence/${gameInstanceId}`).once('value'),
      instanceRef.collection('config').doc('main').get(),
    ])
    const presentIds = new Set<string>(Object.keys(presenceSnap.val() ?? {}))
    const cfgData = (configSnap.data() ?? {}) as Record<string, unknown>
    const sellerName = typeof cfgData.seller_name === 'string' ? cfgData.seller_name : CONFIG_DEFAULTS.seller_name
    const buyerName  = typeof cfgData.buyer_name  === 'string' ? cfgData.buyer_name  : CONFIG_DEFAULTS.buyer_name

    // Read all participants; filter to attended + present.
    const participantsSnap = await instanceRef.collection('participants').get()
    const eligible = participantsSnap.docs
      .filter((doc) => {
        const d = doc.data()
        return (
          d.attendance_confirmed_at != null &&
          (d.role === 'Chris' || d.role === 'Kelly') &&
          presentIds.has(doc.id)
        )
      })
      .map((doc) => ({
        participant_id: doc.id,
        role: doc.data().role as 'Chris' | 'Kelly',
      }))

    const chrisCount = eligible.filter((p) => p.role === 'Chris').length
    const kellyCount = eligible.filter((p) => p.role === 'Kelly').length
    if (chrisCount === 0 || kellyCount === 0) {
      res
        .status(400)
        .json({ error: `Need at least one ${sellerName} and one ${buyerName} present to match.` })
      return
    }

    // Run the matching algorithm.
    const rawGroups = matchParticipants(eligible)

    // Assign UUIDs and prepare Firestore writes.
    const batch = db.batch()
    const groups = rawGroups.map((g) => {
      const groupId = randomUUID()
      const groupRef = instanceRef.collection('groups').doc(groupId)
      batch.set(groupRef, {
        group_id: groupId,
        game_instance_id: gameInstanceId,
        chris_participants: g.chris_participants,
        kelly_participants: g.kelly_participants,
        lead_participant_id: g.lead_participant_id,
        status: 'matched',
        matched_at: FieldValue.serverTimestamp(),
      })
      // Stamp each participant's record with group_id and lead status.
      for (const pid of g.chris_participants) {
        batch.update(instanceRef.collection('participants').doc(pid), {
          group_id: groupId,
          is_lead: pid === g.lead_participant_id,
        })
      }
      for (const pid of g.kelly_participants) {
        batch.update(instanceRef.collection('participants').doc(pid), {
          group_id: groupId,
          is_lead: false,
        })
      }
      return {
        group_id: groupId,
        game_instance_id: gameInstanceId,
        chris_participants: g.chris_participants,
        kelly_participants: g.kelly_participants,
        lead_participant_id: g.lead_participant_id,
        status: 'matched',
      }
    })

    await batch.commit()
    res.json({ ok: true, groups })
  } catch (err) {
    console.error('triggerMatching error:', err)
    res.status(500).json({ error: 'Internal error' })
  }
})

// ── Instructor helpers ────────────────────────────────────────────────────────

function extractInstructorGameId(
  body: Record<string, unknown>,
  isEmulator: boolean,
  res: { status: (c: number) => { json: (d: object) => void } },
): string | null {
  if (isEmulator && body._dev != null) {
    const dev = body._dev as Record<string, unknown>
    if (typeof dev.game_instance_id !== 'string') {
      res.status(400).json({ error: '_dev requires game_instance_id' })
      return null
    }
    return dev.game_instance_id
  }
  if (typeof body.token !== 'string') {
    res.status(400).json({ error: 'Missing token' })
    return null
  }
  let payload: ClassroomTokenPayload
  try {
    payload = verifyClassroomToken(body.token)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Invalid token'
    res.status(401).json({ error: message })
    return null
  }
  if (payload.role !== 'instructor') {
    res.status(403).json({ error: 'Instructor access required' })
    return null
  }
  return payload.game_instance_id
}

function extractStudentIds(
  body: Record<string, unknown>,
  isEmulator: boolean,
  res: { status: (c: number) => { json: (d: object) => void } },
): { participantId: string; gameInstanceId: string } | null {
  if (isEmulator && body._test != null) {
    const test = body._test as Record<string, unknown>
    if (typeof test.participant_id !== 'string' || typeof test.game_instance_id !== 'string') {
      res.status(400).json({ error: '_test requires participant_id and game_instance_id strings' })
      return null
    }
    return { participantId: test.participant_id, gameInstanceId: test.game_instance_id }
  }
  if (typeof body.token !== 'string') {
    res.status(400).json({ error: 'Missing token' })
    return null
  }
  let payload: ClassroomTokenPayload
  try {
    payload = verifyClassroomToken(body.token)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Invalid token'
    res.status(401).json({ error: message })
    return null
  }
  return { participantId: payload.participant_id, gameInstanceId: payload.game_instance_id }
}

// ── Emulator-only test seed ───────────────────────────────────────────────────

/**
 * Seeds a matched group for e2e tests. Only available in the Functions emulator.
 *
 * Request body: {
 *   game_instance_id, group_id,
 *   participants: Array<{ id, role, is_lead, display_name }>
 * }
 */
export const seedTestGroup = onRequest(async (req, res) => {
  if (process.env.FUNCTIONS_EMULATOR !== 'true') {
    res.status(404).json({ error: 'Not found' }); return
  }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return }

  const body = req.body as {
    game_instance_id: string
    group_id: string
    initial_status?: string
    participants: Array<{
      id: string
      role: 'Chris' | 'Kelly'
      is_lead: boolean
      /** Overrides the is_lead value written to the participant doc (defaults to is_lead). */
      doc_is_lead?: boolean
      display_name: string
    }>
  }

  const { game_instance_id: gameInstanceId, group_id: groupId, participants } = body
  if (!gameInstanceId || !groupId || !Array.isArray(participants)) {
    res.status(400).json({ error: 'Missing required fields' }); return
  }

  const db = admin.firestore()
  const rtdb = admin.database()
  const instanceRef = db.collection('game_instances').doc(gameInstanceId)
  const groupRef = instanceRef.collection('groups').doc(groupId)

  const chrisPids = participants.filter((p) => p.role === 'Chris').map((p) => p.id)
  const kellyPids = participants.filter((p) => p.role === 'Kelly').map((p) => p.id)
  const lead = participants.find((p) => p.is_lead)
  if (!lead) { res.status(400).json({ error: 'No lead participant' }); return }

  const batch = db.batch()

  batch.set(instanceRef, { status: 'active' }, { merge: true })

  batch.set(groupRef, {
    status: body.initial_status ?? 'matched',
    chris_participants: chrisPids,
    kelly_participants: kellyPids,
    lead_participant_id: lead.id,
    disagree_count: 0,
    lead_outcome: null,
    confirmations: {},
    agreement_reached: null,
    final_price: null,
    instructor_override: false,
  })

  for (const p of participants) {
    const pRef = instanceRef.collection('participants').doc(p.id)
    batch.set(pRef, {
      participant_id: p.id,
      game_instance_id: gameInstanceId,
      role: p.role,
      is_lead: p.doc_is_lead !== undefined ? p.doc_is_lead : p.is_lead,
      prep_status: 'complete',
      attendance_confirmed_at: Timestamp.now(),
      confirmed_ready_at: Timestamp.now(),
      group_id: groupId,
      display_name: p.display_name,
    })
  }

  await batch.commit()

  // Seed RTDB attending records for display names on the reveal screen.
  const attendingRef = rtdb.ref(`attending/${gameInstanceId}`)
  await Promise.all(
    participants.map((p) =>
      attendingRef.child(p.id).set({ display_name: p.display_name, role: p.role }),
    ),
  )

  res.json({ ok: true })
})

/**
 * Seeds a single unmatched (late) participant for e2e tests. The participant
 * doc is created without a group_id so addLateParticipant can be tested.
 * Only available in the Functions emulator.
 *
 * Request body: { game_instance_id, participant_id, role, display_name }
 */
export const seedLatecomer = onRequest(async (req, res) => {
  if (process.env.FUNCTIONS_EMULATOR !== 'true') {
    res.status(404).json({ error: 'Not found' }); return
  }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return }

  const body = req.body as {
    game_instance_id: string
    participant_id: string
    role: 'Chris' | 'Kelly'
    display_name: string
  }

  const { game_instance_id: gameInstanceId, participant_id: participantId, role, display_name: displayName } = body
  if (!gameInstanceId || !participantId || !role || !displayName) {
    res.status(400).json({ error: 'Missing required fields' }); return
  }

  const db = admin.firestore()
  await db
    .collection('game_instances')
    .doc(gameInstanceId)
    .collection('participants')
    .doc(participantId)
    .set({
      participant_id: participantId,
      game_instance_id: gameInstanceId,
      role,
      is_lead: false,
      prep_status: 'complete',
      attendance_confirmed_at: Timestamp.now(),
      confirmed_ready_at: Timestamp.now(),
      display_name: displayName,
      // No group_id — this participant has not been matched yet
    })

  res.json({ ok: true })
})

// ── Simulate-at-scale seed ────────────────────────────────────────────────────

const SIM_FIRST_NAMES = [
  'Aiden', 'Bella', 'Carlos', 'Diana', 'Ethan', 'Fiona', 'Gabriel', 'Hannah',
  'Ivan', 'Julia', 'Kevin', 'Laura', 'Marcus', 'Natalie', 'Oscar', 'Priya',
  'Quincy', 'Rachel', 'Samuel', 'Tara', 'Ulrich', 'Victoria', 'Wesley', 'Xenia',
  'Yusuf', 'Zoe', 'Aaron', 'Bianca', 'Connor', 'Delia',
]
const SIM_LAST_NAMES = [
  'Adams', 'Baker', 'Carter', 'Davis', 'Evans', 'Foster', 'Green', 'Harris',
  'Irving', 'Jones', 'King', 'Lopez', 'Miller', 'Nelson', 'Owens', 'Patel',
  'Quinn', 'Roberts', 'Smith', 'Turner', 'Upton', 'Vargas', 'White', 'Xavier',
  'Young', 'Zhang', 'Allen', 'Brooks', 'Cruz', 'Dixon',
]

function simDisplayName(index: number): string {
  const n = SIM_LAST_NAMES.length
  const last = SIM_LAST_NAMES[index % n]
  // Offset the first-name index by the "lap" count so that when last names
  // start repeating (at multiples of n), the first name is different →
  // no duplicate full names for N ≤ n² (= 900, well above the 200 seed cap).
  const first = SIM_FIRST_NAMES[(index + Math.floor(index / n)) % SIM_FIRST_NAMES.length]
  return `${first} ${last}`
}

/** Triangle distribution: average of two uniform samples → bell-shaped across the ZOPA. */
function simPrice(priceChris: number, priceKelly: number): number {
  const t = (Math.random() + Math.random()) / 2
  return Math.round(priceChris + t * (priceKelly - priceChris))
}

function randInt(lo: number, hi: number): number {
  return Math.round(lo + Math.random() * (hi - lo))
}

function simPrepFields(role: 'Chris' | 'Kelly'): {
  prep_planned_first_offer: number
  prep_estimated_other_price: number
} {
  return role === 'Chris'
    ? { prep_planned_first_offer: randInt(50_000, 280_000), prep_estimated_other_price: randInt(300_000, 500_000) }
    : { prep_planned_first_offer: randInt(250_000, 550_000), prep_estimated_other_price: randInt(25_000, 200_000) }
}

// Placeholder open-text reflections — the real `debrief_reflection` question is
// authored later via the questions editor. Seeding a few here lets the
// AI-Analysis Export report render/copy/download before that editor exists.
const SIM_DEBRIEF_REFLECTIONS = [
  "I wish I'd anchored higher with my opening offer.",
  'Learning the other side\'s walk-away price earlier would have changed my strategy.',
  'I felt pressure to concede too quickly once the silence got long.',
  'Building rapport first made the back-and-forth much easier later on.',
  'I underestimated how much the first offer anchors the whole negotiation.',
  "Next time I'd ask more questions before naming a number.",
  'Staying patient paid off — the final price ended up closer to my target.',
  'I should have prepared a stronger justification for my counteroffer.',
]
function simDebriefReflection(): string {
  return SIM_DEBRIEF_REFLECTIONS[Math.floor(Math.random() * SIM_DEBRIEF_REFLECTIONS.length)]
}

// PLACEHOLDER — `prep_first_topic` / `prep_question_for_other` / `prep_planned_offer_reason`
// are written client-side only (Phase1PrepQuestions) and are never seeded by simulate-at-scale,
// so there's no real data for their AI-Analysis Export tiles today. These three sentence
// pools exist solely to populate those tiles for demo/dev purposes. Remove this block (and
// the seeding below that uses it) once simulate-at-scale writes real prep answers instead —
// i.e. once the questions editor / prep flow is wired into the simulated seed path.
const SIM_PREP_FIRST_TOPIC = [
  "I'd open by asking about their timeline — when do they need this done?",
  "I'd start with small talk to build some rapport before getting into numbers.",
  "I'd ask what matters most to them about this deal.",
  "I'd lead with my own constraints so expectations are set early.",
  "I'd ask if they've talked to other parties about this.",
]
const SIM_PREP_QUESTION_FOR_OTHER = [
  'What is your real deadline for closing this? I want to know if there is room to wait.',
  "What would make this deal a clear win for you, beyond the price?",
  'Have you already gotten other offers? I want to gauge how much leverage you have.',
  'Is the price the only thing standing in the way, or are there other terms that matter to you?',
  'What is driving your number — is it based on comparable sales or something else?',
]
const SIM_PREP_PLANNED_OFFER_REASON = [
  'I picked a number close to my target so I have room to negotiate down without going below my floor.',
  'I anchored aggressively to set the tone and see how they react.',
  'I based it on what similar deals have closed at recently.',
  "I left some cushion in case they push back hard on the first offer.",
  'I wanted a round number that signals I am serious but still flexible.',
]
function simPrepFirstTopic(): string {
  return SIM_PREP_FIRST_TOPIC[Math.floor(Math.random() * SIM_PREP_FIRST_TOPIC.length)]
}
function simPrepQuestionForOther(): string {
  return SIM_PREP_QUESTION_FOR_OTHER[Math.floor(Math.random() * SIM_PREP_QUESTION_FOR_OTHER.length)]
}
function simPrepPlannedOfferReason(): string {
  return SIM_PREP_PLANNED_OFFER_REASON[Math.floor(Math.random() * SIM_PREP_PLANNED_OFFER_REASON.length)]
}

/**
 * Seeds N simulated students at a chosen stage (cumulative).
 * Three cumulative stages: enrolled → present → completed.
 * Only available in the Functions emulator.
 *
 * Each call clears the instance first so re-seeding always produces a clean slate.
 * N is the total number of enrolled students. For present/completed stages, ~70% of
 * them are marked as having attended; the remaining ~30% get bare enrolled records
 * (absent — no attendance, no presence, no match state).
 *
 * Request body: { game_instance_id, stage, n }
 * Response: { ok, stage, students, groups?, walk_aways?, price_range? }
 */
export const seedSimulatedGame = onRequest(async (req, res) => {
  if (process.env.FUNCTIONS_EMULATOR !== 'true') {
    res.status(404).json({ error: 'Not found' }); return
  }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return }

  const body = req.body as {
    game_instance_id?: unknown
    stage?: unknown
    n?: unknown
  }

  const gameInstanceId = body.game_instance_id
  const stage = body.stage
  const rawN = body.n

  if (typeof gameInstanceId !== 'string' || !gameInstanceId) {
    res.status(400).json({ error: 'game_instance_id is required' }); return
  }
  const validStages = ['enrolled', 'present', 'completed']
  if (typeof stage !== 'string' || !validStages.includes(stage)) {
    res.status(400).json({ error: 'stage must be enrolled | present | completed' }); return
  }
  const numStudents = typeof rawN === 'number' ? Math.round(rawN) : parseInt(String(rawN ?? ''), 10)
  if (isNaN(numStudents) || numStudents < 2 || numStudents > 200) {
    res.status(400).json({ error: 'n must be 2–200' }); return
  }

  const db = admin.firestore()
  const rtdb = admin.database()
  const instanceRef = db.collection('game_instances').doc(gameInstanceId)
  const now = Timestamp.now()

  // ── Clear existing data ──────────────────────────────────────────────────────
  const [existingParticipants, existingGroups] = await Promise.all([
    instanceRef.collection('participants').get(),
    instanceRef.collection('groups').get(),
  ])
  if (existingParticipants.size > 0 || existingGroups.size > 0) {
    const clearBatch = db.batch()
    for (const d of existingParticipants.docs) clearBatch.delete(d.ref)
    for (const d of existingGroups.docs) clearBatch.delete(d.ref)
    await clearBatch.commit()
  }
  await Promise.all([
    rtdb.ref(`attending/${gameInstanceId}`).remove(),
    rtdb.ref(`presence/${gameInstanceId}`).remove(),
    instanceRef.collection('role_counts').doc('totals').delete(),
  ])

  // ── Generate roster ──────────────────────────────────────────────────────────
  type SimStudent = { id: string; role: 'Chris' | 'Kelly'; displayName: string }
  const students: SimStudent[] = Array.from({ length: numStudents }, (_, i) => ({
    id: `sim-${gameInstanceId.slice(-8)}-${String(i + 1).padStart(3, '0')}`,
    role: (i % 2 === 0 ? 'Chris' : 'Kelly') as 'Chris' | 'Kelly',
    displayName: simDisplayName(i),
  }))

  await instanceRef.set({ status: 'active' }, { merge: true })

  // ── Seed config/main with PDF URL defaults on first use ──────────────────────
  const configRef = instanceRef.collection('config').doc('main')
  const configSnap = await configRef.get()
  if (!configSnap.exists) {
    await configRef.set({
      reservation_price_chris: CONFIG_DEFAULTS.reservation_price_chris,
      reservation_price_kelly: CONFIG_DEFAULTS.reservation_price_kelly,
      public_info_url: '/role-info/public.pdf',
      chris_info_url: '/role-info/seller.pdf',
      kelly_info_url: '/role-info/buyer.pdf',
    })
  }

  // ~70% of enrolled students attended; the rest are absent (enrolled record only).
  const presentCount = Math.max(2, Math.round(numStudents * 0.7))
  const presentSet = new Set(students.slice(0, presentCount).map((s) => s.id))

  // ── Enrolled: write ALL N participant docs ───────────────────────────────────
  const enrollBatch = db.batch()
  for (const s of students) {
    const pRef = instanceRef.collection('participants').doc(s.id)
    if (stage === 'enrolled' || !presentSet.has(s.id)) {
      enrollBatch.set(pRef, {
        participant_id: s.id,
        game_instance_id: gameInstanceId,
        name: s.displayName,
        display_name: s.displayName,
        // In present/completed stages every student has an assigned role, even absent ones.
        ...(stage !== 'enrolled' ? { role: s.role } : {}),
        ...simPrepFields(s.role),
      })
    } else {
      enrollBatch.set(pRef, {
        participant_id: s.id,
        game_instance_id: gameInstanceId,
        role: s.role,
        name: s.displayName,
        display_name: s.displayName,
        prep_status: 'complete',
        attendance_confirmed_at: now,
        confirmed_ready_at: now,
        ...simPrepFields(s.role),
      })
    }
  }
  await enrollBatch.commit()

  if (stage === 'enrolled') {
    res.json({ ok: true, stage, students: numStudents })
    return
  }

  // ── Present: RTDB attending + presence for present students only ────────────
  const presentStudents = students.filter((s) => presentSet.has(s.id))
  const chrisCount = presentStudents.filter((s) => s.role === 'Chris').length
  const kellyCount = presentStudents.filter((s) => s.role === 'Kelly').length
  const attendingData: Record<string, unknown> = {}
  const presenceData: Record<string, unknown> = {}
  for (const s of presentStudents) {
    attendingData[s.id] = { display_name: s.displayName, role: s.role, confirmed_at: now.toMillis() }
    presenceData[s.id] = { online: true, last_seen: now.toMillis() }
  }
  await Promise.all([
    rtdb.ref(`attending/${gameInstanceId}`).set(attendingData),
    rtdb.ref(`presence/${gameInstanceId}`).set(presenceData),
    instanceRef.collection('role_counts').doc('totals').set({ chris: chrisCount, kelly: kellyCount }),
    // Generate an attendance code so the roster knows the session is live.
    doGenerateCode(gameInstanceId),
  ])

  if (stage === 'present') {
    res.json({ ok: true, stage, students: numStudents })
    return
  }

  // ── Match: run matching algorithm on present students only ──────────────────
  const rawGroups = matchParticipants(
    presentStudents.map((s) => ({ participant_id: s.id, role: s.role })),
  )

  type GroupRecord = { groupId: string }
  const groupRecords: GroupRecord[] = []

  // Batch: at most 200 students → 200 participant updates, safely under 500.
  const matchBatch = db.batch()
  for (const g of rawGroups) {
    const groupId = randomUUID()
    const groupRef = instanceRef.collection('groups').doc(groupId)
    matchBatch.set(groupRef, {
      group_id: groupId,
      game_instance_id: gameInstanceId,
      chris_participants: g.chris_participants,
      kelly_participants: g.kelly_participants,
      lead_participant_id: g.lead_participant_id,
      status: 'matched',
      matched_at: now,
      disagree_count: 0,
      lead_outcome: null,
      confirmations: {},
      agreement_reached: null,
      final_price: null,
      instructor_override: false,
    })
    for (const pid of g.chris_participants) {
      matchBatch.update(instanceRef.collection('participants').doc(pid), {
        group_id: groupId,
        is_lead: pid === g.lead_participant_id,
      })
    }
    for (const pid of g.kelly_participants) {
      matchBatch.update(instanceRef.collection('participants').doc(pid), {
        group_id: groupId,
        is_lead: false,
      })
    }
    groupRecords.push({ groupId })
  }
  await matchBatch.commit()

  // ── Completed: realistic outcomes ────────────────────────────────────────────
  // Prices come from config (seeded with defaults above if absent).
  const cd = (configSnap.data() ?? {}) as Record<string, unknown>
  const priceChris = typeof cd.reservation_price_chris === 'number'
    ? (cd.reservation_price_chris as number) : CONFIG_DEFAULTS.reservation_price_chris
  const priceKelly = typeof cd.reservation_price_kelly === 'number'
    ? (cd.reservation_price_kelly as number) : CONFIG_DEFAULTS.reservation_price_kelly

  // ~10% walk-aways (no deal), 1 deadlocked group, rest are agreements with varied prices.
  const walkAwayCount = Math.max(0, Math.round(groupRecords.length * 0.10))
  // Reserve one group (immediately after walk-aways) as deadlocked so the
  // roster dashboard always has at least one instructor-action-item to display.
  const deadlockedIndex = walkAwayCount
  const deadlockedCount = groupRecords.length > deadlockedIndex ? 1 : 0
  const pricesGenerated: number[] = []

  const outcomeBatch = db.batch()
  for (let i = 0; i < groupRecords.length; i++) {
    const { groupId } = groupRecords[i]
    const groupRef = instanceRef.collection('groups').doc(groupId)
    const isWalkAway = i < walkAwayCount
    const isDeadlocked = !isWalkAway && i === deadlockedIndex

    if (isDeadlocked) {
      outcomeBatch.update(groupRef, { status: 'deadlocked' })
    } else {
      const finalPrice = isWalkAway ? null : simPrice(priceChris, priceKelly)
      if (finalPrice !== null) pricesGenerated.push(finalPrice)
      outcomeBatch.update(groupRef, {
        status: 'completed',
        agreement_reached: !isWalkAway,
        final_price: finalPrice,
        completed_at: now,
        lead_outcome: { no_deal: isWalkAway, price: finalPrice },
        group_initial_price: simPrice(priceChris, priceKelly),
      })

      // ~60% of members in each completed group leave a placeholder reflection,
      // so the AI-Analysis Export demonstrates both populated and omitted lines.
      // Same treatment for the three free-text prep fields (PLACEHOLDER — see
      // SIM_PREP_* comment above; rolled independently per field so each export
      // tile shows its own realistic mix of populated and omitted members).
      const group = rawGroups[i]
      for (const pid of [...group.chris_participants, ...group.kelly_participants]) {
        const update: Record<string, string> = {}
        if (Math.random() < 0.6) update.debrief_reflection = simDebriefReflection()
        if (Math.random() < 0.6) update.prep_first_topic = simPrepFirstTopic()
        if (Math.random() < 0.6) update.prep_question_for_other = simPrepQuestionForOther()
        if (Math.random() < 0.6) update.prep_planned_offer_reason = simPrepPlannedOfferReason()
        if (Object.keys(update).length > 0) {
          outcomeBatch.update(instanceRef.collection('participants').doc(pid), update)
        }
      }
    }
  }
  await outcomeBatch.commit()

  const priceMin = pricesGenerated.length ? Math.min(...pricesGenerated) : null
  const priceMax = pricesGenerated.length ? Math.max(...pricesGenerated) : null

  res.json({
    ok: true,
    stage,
    students: numStudents,
    groups: groupRecords.length,
    walk_aways: walkAwayCount,
    deadlocked: deadlockedCount,
    price_min: priceMin,
    price_max: priceMax,
    price_range: { chris_reservation: priceChris, kelly_reservation: priceKelly },
  })
})

// ── Outcome reporting ─────────────────────────────────────────────────────────

/**
 * Any group member taps "Start negotiation" — transitions the group from
 * matched → negotiating. Idempotent: if already negotiating, returns ok.
 *
 * Request body: { token | _test }
 */
export const startNegotiation = corsOnRequest(async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return }
  const body = req.body as Record<string, unknown>
  const isEmulator = process.env.FUNCTIONS_EMULATOR === 'true'
  const ids = extractStudentIds(body, isEmulator, res)
  if (!ids) return
  const { participantId, gameInstanceId } = ids

  try {
    const db = admin.firestore()
    const pSnap = await db
      .collection('game_instances').doc(gameInstanceId)
      .collection('participants').doc(participantId).get()
    if (!pSnap.exists) { res.status(404).json({ error: 'Participant not found.' }); return }
    const pdata = pSnap.data()!
    if (!pdata.group_id) { res.status(400).json({ error: 'Not in a group.' }); return }

    const groupRef = db
      .collection('game_instances').doc(gameInstanceId)
      .collection('groups').doc(pdata.group_id as string)

    await db.runTransaction(async (tx) => {
      const gSnap = await tx.get(groupRef)
      const gdata = gSnap.data()!
      if (gdata.status === 'matched') {
        tx.update(groupRef, { status: 'negotiating', negotiation_started_at: Timestamp.now() })
      } else if (gdata.status !== 'negotiating') {
        throw Object.assign(
          new Error(`Cannot start negotiation — group is '${gdata.status as string}'.`),
          { status: 409 },
        )
      }
      // Already 'negotiating' — idempotent, do nothing
    })
    res.json({ ok: true })
  } catch (err) {
    const status = (err as { status?: number }).status ?? 500
    const message = err instanceof Error ? err.message : 'Internal error'
    res.status(status).json({ error: message })
  }
})

/**
 * Lead reports the group's outcome: a price (agreement) or null (no deal).
 * Initialises non-lead confirmations to 'pending' and marks group 'reporting'.
 * Idempotent guard: returns 400 if lead already submitted for this round.
 *
 * Request body: { token | _test, price: number | null }
 */
export const submitLeadOutcome = corsOnRequest(async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return }
  const body = req.body as Record<string, unknown>
  const isEmulator = process.env.FUNCTIONS_EMULATOR === 'true'
  const ids = extractStudentIds(body, isEmulator, res)
  if (!ids) return
  const { participantId, gameInstanceId } = ids

  const price = body.price as number | null | undefined
  if (price !== null && price !== undefined && (typeof price !== 'number' || price < 0 || !isFinite(price))) {
    res.status(400).json({ error: 'price must be a non-negative number, or null for no deal' })
    return
  }
  const finalPrice: number | null = price == null ? null : Math.round(price)

  try {
    const db = admin.firestore()
    const pSnap = await db
      .collection('game_instances').doc(gameInstanceId)
      .collection('participants').doc(participantId).get()
    if (!pSnap.exists) { res.status(404).json({ error: 'Participant not found.' }); return }
    const pdata = pSnap.data()!
    if (!pdata.group_id) { res.status(400).json({ error: 'Not in a group.' }); return }
    if (!pdata.is_lead) { res.status(403).json({ error: 'Only the lead can report the outcome.' }); return }

    const groupRef = db
      .collection('game_instances').doc(gameInstanceId)
      .collection('groups').doc(pdata.group_id as string)
    const gSnap = await groupRef.get()
    const gdata = gSnap.data()!

    if (gdata.status === 'completed') { res.status(400).json({ error: 'Outcome already locked.' }); return }
    if (gdata.status === 'deadlocked') { res.status(400).json({ error: 'Group is deadlocked — awaiting instructor.' }); return }
    if (gdata.status === 'reporting' && gdata.lead_outcome != null) {
      res.status(400).json({ error: 'Already submitted this round. Waiting for group to review.' }); return
    }

    const allPids = [
      ...(gdata.chris_participants as string[]),
      ...(gdata.kelly_participants as string[]),
    ]
    const confirmations: Record<string, string> = {}
    for (const pid of allPids) {
      if (pid !== gdata.lead_participant_id) confirmations[pid] = 'pending'
    }

    await groupRef.update({
      status: 'reporting',
      lead_outcome: { price: finalPrice, no_deal: finalPrice === null },
      lead_reported_at: FieldValue.serverTimestamp(),
      confirmations,
    })
    res.json({ ok: true })
  } catch (err) {
    console.error('submitLeadOutcome error:', err)
    res.status(500).json({ error: 'Internal error' })
  }
})

/**
 * Non-lead confirms or disagrees with the lead's reported outcome.
 * On agreement: if all non-leads confirmed → lock outcome.
 * On disagreement: increment disagree_count; if ≥3 → deadlock; else reset for next round.
 *
 * Request body: { token | _test, confirmed: boolean }
 */
export const submitConfirmation = corsOnRequest(async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return }
  const body = req.body as Record<string, unknown>
  const isEmulator = process.env.FUNCTIONS_EMULATOR === 'true'
  const ids = extractStudentIds(body, isEmulator, res)
  if (!ids) return
  const { participantId, gameInstanceId } = ids

  if (typeof body.confirmed !== 'boolean') {
    res.status(400).json({ error: 'confirmed must be boolean' }); return
  }
  const confirmed = body.confirmed as boolean

  try {
    const db = admin.firestore()
    const pSnap = await db
      .collection('game_instances').doc(gameInstanceId)
      .collection('participants').doc(participantId).get()
    if (!pSnap.exists) { res.status(404).json({ error: 'Participant not found.' }); return }
    const pdata = pSnap.data()!
    if (!pdata.group_id) { res.status(400).json({ error: 'Not in a group.' }); return }
    if (pdata.is_lead) { res.status(403).json({ error: 'Lead uses submitLeadOutcome.' }); return }

    const groupRef = db
      .collection('game_instances').doc(gameInstanceId)
      .collection('groups').doc(pdata.group_id as string)

    let outcome = 'waiting'
    await db.runTransaction(async (tx) => {
      const gSnap = await tx.get(groupRef)
      const gdata = gSnap.data()!

      if (gdata.status !== 'reporting') {
        throw Object.assign(new Error(`Cannot confirm — group is '${gdata.status}'.`), { status: 400 })
      }
      if (gdata.lead_outcome == null) {
        throw Object.assign(new Error('Lead has not reported yet.'), { status: 400 })
      }
      const currentConf = (gdata.confirmations ?? {})[participantId]
      if (currentConf !== 'pending') {
        throw Object.assign(new Error('You have already responded this round.'), { status: 400 })
      }

      if (!confirmed) {
        const disagreeCount = (gdata.disagree_count ?? 0) + 1
        if (disagreeCount >= 3) {
          tx.update(groupRef, {
            status: 'deadlocked',
            disagree_count: disagreeCount,
            [`confirmations.${participantId}`]: 'disagreed',
          })
          outcome = 'deadlocked'
        } else {
          // Reset: clear lead_outcome, set all confirmations back to pending
          const reset: Record<string, string> = {}
          for (const pid of Object.keys(gdata.confirmations ?? {})) reset[pid] = 'pending'
          tx.update(groupRef, {
            disagree_count: disagreeCount,
            lead_outcome: null,
            lead_reported_at: null,
            confirmations: reset,
          })
          outcome = 'disagreed'
        }
      } else {
        const newConf = { ...(gdata.confirmations ?? {}), [participantId]: 'confirmed' }
        const allConfirmed = Object.values(newConf).every((v) => v === 'confirmed')
        if (allConfirmed) {
          const lo = gdata.lead_outcome as { price: number | null; no_deal: boolean }
          tx.update(groupRef, {
            status: 'completed',
            confirmations: newConf,
            agreement_reached: !lo.no_deal,
            final_price: lo.price,
            completed_at: FieldValue.serverTimestamp(),
          })
          outcome = 'locked'
        } else {
          tx.update(groupRef, { [`confirmations.${participantId}`]: 'confirmed' })
          outcome = 'waiting'
        }
      }
    })
    res.json({ ok: true, outcome })
  } catch (err) {
    const status = (err as { status?: number }).status ?? 500
    const message = err instanceof Error ? err.message : 'Internal error'
    res.status(status).json({ error: message })
  }
})

/**
 * Instructor manually enters the outcome for a deadlocked group.
 * Overrides the group's reporting state and locks the outcome directly.
 *
 * Request body (emulator): { _dev: { game_instance_id }, group_id, price: number | null }
 */
export const submitInstructorOutcome = corsOnRequest(async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return }
  const body = req.body as Record<string, unknown>
  const isEmulator = process.env.FUNCTIONS_EMULATOR === 'true'
  const gameInstanceId = extractInstructorGameId(body, isEmulator, res)
  if (!gameInstanceId) return

  const { group_id, price } = body as { group_id?: string; price?: number | null }
  if (typeof group_id !== 'string') { res.status(400).json({ error: 'group_id required' }); return }
  const finalPrice: number | null = price == null ? null : Math.round(price)

  try {
    const db = admin.firestore()
    await db
      .collection('game_instances').doc(gameInstanceId)
      .collection('groups').doc(group_id)
      .update({
        status: 'completed',
        agreement_reached: finalPrice !== null,
        final_price: finalPrice,
        completed_at: FieldValue.serverTimestamp(),
        instructor_override: true,
      })
    res.json({ ok: true })
  } catch (err) {
    console.error('submitInstructorOutcome error:', err)
    res.status(500).json({ error: 'Internal error' })
  }
})

/**
 * Records a participant's actual opening offer from their negotiation.
 * Writes debrief_initial_offer to their participant doc, then recomputes
 * group_initial_price as the average of all submitted values so far.
 *
 * Request body (emulator): { _test: { participant_id, game_instance_id }, initial_offer: number }
 */
export const submitDebriefOffer = corsOnRequest(async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return }
  const body = req.body as Record<string, unknown>
  const isEmulator = process.env.FUNCTIONS_EMULATOR === 'true'
  const ids = extractStudentIds(body, isEmulator, res)
  if (!ids) return
  const { participantId, gameInstanceId } = ids

  const rawOffer = body.initial_offer
  if (typeof rawOffer !== 'number' || !isFinite(rawOffer) || rawOffer <= 0) {
    res.status(400).json({ error: 'initial_offer must be a positive number' })
    return
  }
  const offer = Math.round(rawOffer)

  try {
    const db = admin.firestore()
    const instanceRef = db.collection('game_instances').doc(gameInstanceId)
    const participantRef = instanceRef.collection('participants').doc(participantId)

    const pSnap = await participantRef.get()
    if (!pSnap.exists) { res.status(404).json({ error: 'Participant not found.' }); return }
    const pdata = pSnap.data()!
    if (!pdata.group_id) { res.status(400).json({ error: 'Not in a group.' }); return }
    const groupId = pdata.group_id as string

    await participantRef.update({ debrief_initial_offer: offer })

    const groupRef = instanceRef.collection('groups').doc(groupId)
    const gSnap = await groupRef.get()
    if (!gSnap.exists) { res.status(404).json({ error: 'Group not found.' }); return }
    const gdata = gSnap.data()!
    const allPids: string[] = [
      ...(gdata.chris_participants as string[]),
      ...(gdata.kelly_participants as string[]),
    ]

    const memberSnaps = await Promise.all(
      allPids.map((pid) => instanceRef.collection('participants').doc(pid).get()),
    )
    const offers: number[] = memberSnaps
      .map((snap) => snap.data()?.debrief_initial_offer)
      .filter((v): v is number => typeof v === 'number' && v > 0)

    const group_initial_price = Math.round(offers.reduce((a, b) => a + b, 0) / offers.length)
    await groupRef.update({ group_initial_price })

    res.json({ ok: true })
  } catch (err) {
    console.error('submitDebriefOffer error:', err)
    res.status(500).json({ error: 'Internal error' })
  }
})

/**
 * Returns all groups for a game instance with their current status and outcome.
 * Used by the instructor dashboard to monitor progress and spot deadlocked groups.
 *
 * Request body (emulator): { _dev: { game_instance_id } }
 */
export const getGroupStatuses = corsOnRequest(async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return }
  const body = req.body as Record<string, unknown>
  const isEmulator = process.env.FUNCTIONS_EMULATOR === 'true'
  const gameInstanceId = extractInstructorGameId(body, isEmulator, res)
  if (!gameInstanceId) return

  try {
    const db = admin.firestore()
    const snap = await db
      .collection('game_instances').doc(gameInstanceId)
      .collection('groups').get()
    const groups = snap.docs.map((d) => {
      const g = d.data()
      return {
        group_id: g.group_id as string,
        status: g.status as string,
        disagree_count: (g.disagree_count ?? 0) as number,
        lead_outcome: (g.lead_outcome ?? null) as { price: number | null; no_deal: boolean } | null,
        confirmations: (g.confirmations ?? {}) as Record<string, string>,
        agreement_reached: (g.agreement_reached ?? null) as boolean | null,
        final_price: (g.final_price ?? null) as number | null,
        instructor_override: (g.instructor_override ?? false) as boolean,
        chris_participants: g.chris_participants as string[],
        kelly_participants: g.kelly_participants as string[],
        lead_participant_id: g.lead_participant_id as string,
      }
    })
    res.json({ ok: true, groups })
  } catch (err) {
    console.error('getGroupStatuses error:', err)
    res.status(500).json({ error: 'Internal error' })
  }
})

/**
 * Returns group outcomes and game config needed for the Reports page.
 * Request body: { _dev: { game_instance_id } }
 * Response: { ok, groups: GroupOutcome[], config: { reservation_price_chris, reservation_price_kelly } }
 */
export const getReportData = corsOnRequest(async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return }
  const body = req.body as Record<string, unknown>
  const isEmulator = process.env.FUNCTIONS_EMULATOR === 'true'
  const gameInstanceId = extractInstructorGameId(body, isEmulator, res)
  if (!gameInstanceId) return

  try {
    const db = admin.firestore()
    const instanceRef = db.collection('game_instances').doc(gameInstanceId)
    const [groupsSnap, configSnap, participantsSnap] = await Promise.all([
      instanceRef.collection('groups').get(),
      instanceRef.collection('config').doc('main').get(),
      instanceRef.collection('participants').get(),
    ])

    const groups = groupsSnap.docs.map((d) => {
      const g = d.data()
      return {
        group_id: g.group_id as string,
        status: g.status as string,
        agreement_reached: (g.agreement_reached ?? null) as boolean | null,
        final_price: (g.final_price ?? null) as number | null,
        group_initial_price: (g.group_initial_price ?? null) as number | null,
        chris_participants: (g.chris_participants ?? []) as string[],
        kelly_participants: (g.kelly_participants ?? []) as string[],
      }
    })

    const participants = participantsSnap.docs
      .map((d) => {
        const p = d.data()
        return {
          participant_id: d.id as string,
          display_name: ((p.name ?? p.display_name ?? '') as string),
          role: (p.role ?? null) as 'Chris' | 'Kelly' | null,
          prep_planned_first_offer:   (p.prep_planned_first_offer   ?? null) as number | null,
          prep_estimated_other_price: (p.prep_estimated_other_price ?? null) as number | null,
          prep_first_topic:          (p.prep_first_topic          ?? null) as string | null,
          prep_question_for_other:   (p.prep_question_for_other   ?? null) as string | null,
          prep_planned_offer_reason: (p.prep_planned_offer_reason ?? null) as string | null,
          debrief_reflection: (p.debrief_reflection ?? null) as string | null,
          // Dynamic fields for instructor-added free-text questions.
          // Collect all string-valued keys that start with prep_ but aren't
          // the hardcoded numeric ones already mapped above.
          ...(Object.fromEntries(
            Object.entries(p)
              .filter(([k, v]) =>
                k.startsWith('prep_') &&
                !['prep_planned_first_offer', 'prep_estimated_other_price',
                  'prep_first_topic', 'prep_question_for_other',
                  'prep_planned_offer_reason'].includes(k) &&
                (typeof v === 'string' || v === null),
              )
              .map(([k, v]) => [k, (v ?? null) as string | null]),
          ) as Record<string, string | null>),
        }
      })
      .filter((p) => p.role === 'Chris' || p.role === 'Kelly')

    const cd = (configSnap.data() ?? {}) as Record<string, unknown>
    const config = {
      reservation_price_chris: typeof cd.reservation_price_chris === 'number'
        ? (cd.reservation_price_chris as number) : CONFIG_DEFAULTS.reservation_price_chris,
      reservation_price_kelly: typeof cd.reservation_price_kelly === 'number'
        ? (cd.reservation_price_kelly as number) : CONFIG_DEFAULTS.reservation_price_kelly,
      seller_name: typeof cd.seller_name === 'string' ? (cd.seller_name as string) : CONFIG_DEFAULTS.seller_name,
      buyer_name:  typeof cd.buyer_name  === 'string' ? (cd.buyer_name  as string) : CONFIG_DEFAULTS.buyer_name,
      prep_text_questions: parsePrepTextQuestions(cd.prep_text_questions) ?? DEFAULT_PREP_TEXT_QUESTIONS,
    }

    res.json({ ok: true, groups, config, participants })
  } catch (err) {
    console.error('getReportData error:', err)
    res.status(500).json({ error: 'Internal error' })
  }
})

/**
 * Returns all enrolled participants and group statuses for the instructor roster.
 *
 * Request body (emulator): { _dev: { game_instance_id } }
 * Response: { ok, participants: RosterEntry[], groups: RosterGroup[] }
 */
export const getRoster = corsOnRequest(async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return }
  const body = req.body as Record<string, unknown>
  const isEmulator = process.env.FUNCTIONS_EMULATOR === 'true'
  const gameInstanceId = extractInstructorGameId(body, isEmulator, res)
  if (!gameInstanceId) return

  try {
    const db = admin.firestore()
    const instanceRef = db.collection('game_instances').doc(gameInstanceId)
    const [participantsSnap, groupsSnap, attendanceCodeSnap] = await Promise.all([
      instanceRef.collection('participants').get(),
      instanceRef.collection('groups').get(),
      instanceRef.collection('attendance_code').doc('current').get(),
    ])
    const participants = participantsSnap.docs.map((d) => {
      const p = d.data()
      return {
        participant_id: p.participant_id as string,
        name: ((p.name ?? p.display_name ?? '') as string),
        role: (p.role ?? null) as string | null,
        has_attendance: p.attendance_confirmed_at != null,
        has_prep_completed: p.prep_completed_at != null,
        group_id: (p.group_id ?? null) as string | null,
        is_late: p.participant_late === true,
      }
    })
    const groups = groupsSnap.docs.map((d) => {
      const g = d.data()
      return {
        group_id: g.group_id as string,
        status: g.status as string,
      }
    })
    res.json({ ok: true, participants, groups, session_live: attendanceCodeSnap.exists })
  } catch (err) {
    console.error('getRoster error:', err)
    res.status(500).json({ error: 'Internal error' })
  }
})

// ── Late-participant helpers ───────────────────────────────────────────────────

/**
 * Marks a participant as "Late" — present but unplaceable.
 * Sets participant_late: true, which excludes them from getUnmatchedParticipants
 * and causes finalizeInstance to write raw_score: null, normalized_score: null
 * instead of the no_show floor of −2.
 *
 * Called automatically by the instructor dashboard when getUnmatchedParticipants
 * returns a participant with suggested_group: null.
 */
export const markParticipantLate = corsOnRequest(async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return }
  const body = req.body as Record<string, unknown>
  const isEmulator = process.env.FUNCTIONS_EMULATOR === 'true'
  const gameInstanceId = extractInstructorGameId(body, isEmulator, res)
  if (!gameInstanceId) return

  const participantId = body.participant_id
  if (typeof participantId !== 'string' || !participantId) {
    res.status(400).json({ error: 'participant_id is required' }); return
  }

  try {
    const db = admin.firestore()
    await db
      .collection('game_instances').doc(gameInstanceId)
      .collection('participants').doc(participantId)
      .update({ participant_late: true })
    res.json({ ok: true })
  } catch (err) {
    console.error('markParticipantLate error:', err)
    res.status(500).json({ error: 'Internal error' })
  }
})

/**
 * Returns all participants who have verified attendance but are not yet in any
 * group (entered the code after "Match Now" ran, or were absent then and arrived
 * later), together with a suggested group for each.
 *
 * "Present" here means: RTDB presence record exists (currently connected) AND
 * attendance_confirmed_at is set in Firestore.
 *
 * Request body (emulator): { _dev: { game_instance_id } }
 * Response: { ok, unmatched: [{ participant_id, display_name, role, suggested_group }] }
 */
export const getUnmatchedParticipants = corsOnRequest(async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return }
  const body = req.body as Record<string, unknown>
  const isEmulator = process.env.FUNCTIONS_EMULATOR === 'true'
  const gameInstanceId = extractInstructorGameId(body, isEmulator, res)
  if (!gameInstanceId) return

  try {
    const db = admin.firestore()
    const instanceRef = db.collection('game_instances').doc(gameInstanceId)

    // Read RTDB presence, all participants, and all groups in parallel.
    const [presenceSnap, participantsSnap, groupsSnap] = await Promise.all([
      admin.database().ref(`presence/${gameInstanceId}`).once('value'),
      instanceRef.collection('participants').get(),
      instanceRef.collection('groups').get(),
    ])

    const presentIds = new Set<string>(Object.keys(presenceSnap.val() ?? {}))

    // Collect participant IDs already in a group.
    const matchedIds = new Set<string>()
    const groupSnapshots = groupsSnap.docs.map((d) => {
      const gd = d.data()
      const chrisIds = gd.chris_participants as string[]
      const kellyIds = gd.kelly_participants as string[]
      for (const pid of [...chrisIds, ...kellyIds]) matchedIds.add(pid)
      return {
        group_id: d.id,
        status: gd.status as string,
        chris_participants: chrisIds,
        kelly_participants: kellyIds,
      }
    })

    // Unmatched = attended + present + has valid role + not in any group + not already marked Late.
    const unmatched = participantsSnap.docs
      .filter((doc) => {
        const d = doc.data()
        return (
          d.attendance_confirmed_at != null &&
          presentIds.has(doc.id) &&
          (d.role === 'Chris' || d.role === 'Kelly') &&
          !matchedIds.has(doc.id) &&
          d.participant_late !== true
        )
      })
      .map((doc) => {
        const d = doc.data()
        const role = d.role as 'Chris' | 'Kelly'
        return {
          participant_id: doc.id,
          display_name: (d.display_name ?? '') as string,
          role,
          suggested_group: suggestGroupForLatecomer(role, groupSnapshots),
        }
      })

    res.json({ ok: true, unmatched })
  } catch (err) {
    console.error('getUnmatchedParticipants error:', err)
    res.status(500).json({ error: 'Internal error' })
  }
})

/**
 * Adds a late participant to a specific group.
 *
 * Server-side enforcement: inside a transaction, re-checks that the group is
 * still in 'matched' state AND still has room under the composition caps before
 * writing. If the group started negotiating between the suggestion and this
 * call, the transaction rejects with a clear error so the instructor can
 * re-suggest.
 *
 * Request body (emulator): { _dev: { game_instance_id }, participant_id, group_id }
 * Response: { ok, participant_id, group_id, composition } or error
 */
export const addLateParticipant = corsOnRequest(async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return }
  const body = req.body as Record<string, unknown>
  const isEmulator = process.env.FUNCTIONS_EMULATOR === 'true'
  const gameInstanceId = extractInstructorGameId(body, isEmulator, res)
  if (!gameInstanceId) return

  const participantId = body.participant_id
  const groupId = body.group_id
  if (typeof participantId !== 'string' || !participantId) {
    res.status(400).json({ error: 'participant_id is required' }); return
  }
  if (typeof groupId !== 'string' || !groupId) {
    res.status(400).json({ error: 'group_id is required' }); return
  }

  try {
    const db = admin.firestore()
    const instanceRef = db.collection('game_instances').doc(gameInstanceId)
    const pRef = instanceRef.collection('participants').doc(participantId)
    const gRef = instanceRef.collection('groups').doc(groupId)

    const cfgSnap = await instanceRef.collection('config').doc('main').get()
    const cfgData = (cfgSnap.data() ?? {}) as Record<string, unknown>
    const sellerName = typeof cfgData.seller_name === 'string' ? cfgData.seller_name : CONFIG_DEFAULTS.seller_name
    const buyerName  = typeof cfgData.buyer_name  === 'string' ? cfgData.buyer_name  : CONFIG_DEFAULTS.buyer_name

    let resultComposition = ''
    let alreadyInThisGroup = false

    await db.runTransaction(async (tx) => {
      const [pSnap, gSnap] = await Promise.all([tx.get(pRef), tx.get(gRef)])

      if (!pSnap.exists) {
        throw Object.assign(new Error('Participant not found.'), { status: 404 })
      }
      if (!gSnap.exists) {
        throw Object.assign(new Error('Group not found.'), { status: 404 })
      }

      const pd = pSnap.data()!
      const gd = gSnap.data()!

      // Idempotency: already in this exact group.
      if (pd.group_id === groupId) {
        alreadyInThisGroup = true
        return
      }
      // Already matched to a different group — refuse.
      if (pd.group_id) {
        throw Object.assign(
          new Error(`Participant is already in a different group (${pd.group_id as string}).`),
          { status: 409 },
        )
      }

      const role = pd.role as 'Chris' | 'Kelly'
      const chrisIds = gd.chris_participants as string[]
      const kellyIds = gd.kelly_participants as string[]
      const total = chrisIds.length + kellyIds.length

      // Re-check: group must still be in pre-negotiation state.
      if (gd.status !== 'matched') {
        throw Object.assign(
          new Error(
            `Cannot add to group — negotiation has already started ` +
            `(status: '${gd.status as string}'). Please re-suggest a different group.`,
          ),
          { status: 409 },
        )
      }
      // Re-check total cap (max 2C+2K = 4).
      if (total >= 4) {
        throw Object.assign(
          new Error(
            `Group is now full (${chrisIds.length}C+${kellyIds.length}K). ` +
            `Please re-suggest a different group.`,
          ),
          { status: 409 },
        )
      }
      // Re-check role cap.
      if (role === 'Chris' && chrisIds.length >= 2) {
        throw Object.assign(
          new Error(
            `Group already has ${chrisIds.length} ${sellerName} participants. ` +
            `Please re-suggest a different group.`,
          ),
          { status: 409 },
        )
      }
      if (role === 'Kelly' && kellyIds.length >= 2) {
        throw Object.assign(
          new Error(
            `Group already has ${kellyIds.length} ${buyerName} participants. ` +
            `Please re-suggest a different group.`,
          ),
          { status: 409 },
        )
      }

      // All checks pass — write.
      const roleField = role === 'Chris' ? 'chris_participants' : 'kelly_participants'
      tx.update(gRef, { [roleField]: FieldValue.arrayUnion(participantId) })
      tx.update(pRef, { group_id: groupId, is_lead: false })

      const newChris = chrisIds.length + (role === 'Chris' ? 1 : 0)
      const newKelly = kellyIds.length + (role === 'Kelly' ? 1 : 0)
      resultComposition = `${newChris}C+${newKelly}K`
    })

    if (alreadyInThisGroup) {
      res.json({ ok: true, participant_id: participantId, group_id: groupId, already_matched: true })
    } else {
      res.json({ ok: true, participant_id: participantId, group_id: groupId, composition: resultComposition })
    }
  } catch (err) {
    const status = (err as { status?: number }).status ?? 500
    const message = err instanceof Error ? err.message : 'Internal error'
    res.status(status).json({ error: message })
  }
})

// ── Config defaults ─────────────────────────────────────────────────────────
// Single source of truth for both finalizeInstance scoring and the Settings
// page; must stay in sync with the standard role PDFs shipped with the scenario.
const CONFIG_DEFAULTS = {
  reservation_price_chris: 25_000,
  reservation_price_kelly: 475_000,
  seller_name: 'Chris',
  buyer_name: 'Kelly',
} as const

async function ensureConfigSeeded(instanceRef: FirebaseFirestore.DocumentReference): Promise<void> {
  const configRef = instanceRef.collection('config').doc('main')
  const snap = await configRef.get()
  if (!snap.exists) {
    await configRef.set({
      reservation_price_chris: CONFIG_DEFAULTS.reservation_price_chris,
      reservation_price_kelly: CONFIG_DEFAULTS.reservation_price_kelly,
      public_info_url: '/role-info/public.pdf',
      chris_info_url: '/role-info/seller.pdf',
      kelly_info_url: '/role-info/buyer.pdf',
    }, { merge: true })
  }
}

// ── Prep questions (text, numeric, multiple-choice) ─────────────────────────

export type MCOption = { value: string; label: string }

/** A single prep question — free-text, numeric, or multiple-choice. */
export type PrepTextQuestion = {
  /** Participant doc field name (must start with prep_/kc_/debrief_) or 'knowledge_check'. */
  field: string
  /** Input type: 'text' textarea, 'number' dollar input, 'mc' radio buttons. Default: 'text'. */
  type: 'text' | 'number' | 'mc'
  /** True for system-defined questions (knowledge check + numeric). Instructor cannot delete or change field/type/deletable. */
  system: boolean
  /** The question prompt shown to students. */
  prompt: string
  /** Textarea/input placeholder hint. */
  placeholder: string
  /** Global sort key across all question types. */
  order: number
  /** When true the question is skipped in the student flow. */
  hidden: boolean
  /** False for system questions — no delete action is ever shown. */
  deletable: boolean
  /** MC options (value = grading key, label = display text). Only present for type 'mc'. */
  options?: MCOption[]
  /** Lifecycle phase this question belongs to. */
  category: 'knowledge_check' | 'preparation' | 'debrief'
  /** Canonical input format. Parallel to `type` but with unambiguous names. */
  format: 'multiple_choice' | 'number' | 'text'
  /** How the answer is graded. Only present on knowledge_check questions. */
  grading?: 'static' | 'assigned_role'
  /** The single correct option value. Required when grading === 'static'; absent when grading === 'assigned_role'. */
  correct_value?: string
  /** Which role(s) see this question. 'both' = all participants. Legacy stored questions without this field default to 'both'. */
  role_target: 'Chris' | 'Kelly' | 'both'
  /** Explanation shown to the student after they submit a graded KC answer. Never sent to the client pre-submission. */
  explanation?: string
}

/** Default prep + knowledge-check questions for instances that have never opened Settings. */
const DEFAULT_PREP_TEXT_QUESTIONS: PrepTextQuestion[] = [
  // ── Preparation questions (ungraded, both roles) ─────────────────────────────
  {
    field: 'prep_first_topic',
    type: 'text', system: false, category: 'preparation', format: 'text',
    role_target: 'both',
    prompt: 'When you sit down to talk, what is the first topic you will bring up with the other side?',
    placeholder: '', order: 0, hidden: false, deletable: true,
  },
  {
    field: 'prep_question_for_other',
    type: 'text', system: false, category: 'preparation', format: 'text',
    role_target: 'both',
    prompt: 'What question would you most like to ask the other side? Why?',
    placeholder: '', order: 2, hidden: false, deletable: true,
  },
  {
    field: 'prep_planned_offer_reason',
    type: 'text', system: false, category: 'preparation', format: 'text',
    role_target: 'both',
    prompt: 'What is the reason for the number you gave?',
    placeholder: '', order: 4, hidden: false, deletable: true,
  },

  // ── Knowledge-check Q2: BATNA ─────────────────────────────────────────────────
  {
    field: 'kc_chris_batna',
    type: 'mc', system: false, category: 'knowledge_check', format: 'multiple_choice',
    role_target: 'Chris', grading: 'static', correct_value: 'keep',
    prompt: 'If no deal is reached, your best alternative is to:',
    placeholder: '', order: 10, hidden: false, deletable: true,
    options: [
      { value: 'keep',    label: 'Keep the Grays.com domain and continue using it for your business' },
      { value: 'resell',  label: 'Sell the domain to a middle-man ticket reseller for $35' },
      { value: 'lapse',   label: 'Let the registration lapse and give up the name' },
      { value: 'buy_alt', label: 'Buy WashingtonGrays.com instead' },
    ],
    explanation: 'You already own the name; with no deal you simply keep it.',
  },
  {
    field: 'kc_kelly_batna',
    type: 'mc', system: false, category: 'knowledge_check', format: 'multiple_choice',
    role_target: 'Kelly', grading: 'static', correct_value: 'register',
    prompt: 'If no deal is reached, your best alternative is to:',
    placeholder: '', order: 10, hidden: false, deletable: true,
    options: [
      { value: 'vancouver', label: "Use the team's existing Vancouver domain" },
      { value: 'register',  label: 'Register and use WashingtonGrays.com for a $10 fee' },
      { value: 'icann',     label: 'Take the matter to ICANN to force a transfer' },
      { value: 'rebrand',   label: "Abandon the 'Grays' name and rebrand the team" },
    ],
    explanation: "Per your instructions, WashingtonGrays.com is unregistered and available for $10 — your fallback if you can't get Grays.com.",
  },

  // ── Knowledge-check Q3: own walk-away value ───────────────────────────────────
  {
    field: 'kc_chris_walkaway',
    type: 'mc', system: false, category: 'knowledge_check', format: 'multiple_choice',
    role_target: 'Chris', grading: 'static', correct_value: 'switch_25k',
    prompt: 'Which figure applies to you?',
    placeholder: '', order: 11, hidden: false, deletable: true,
    options: [
      { value: 'switch_25k',  label: '~$25,000 — your estimated total cost to switch your business to a new domain' },
      { value: 'gartner_75k', label: '$75,000 — the Gartner estimate for managing a new domain name' },
      { value: 'biz_7_5m',    label: '$7.5 million — the most ever paid for a domain name (business.com)' },
      { value: 'reseller_35', label: '$35 — what middle-man ticket resellers pay for domains' },
    ],
    explanation: "You can replace the name for ~$25K, so you needn't accept less than roughly that — and ideally far more.",
  },
  {
    field: 'kc_kelly_walkaway',
    type: 'mc', system: false, category: 'knowledge_check', format: 'multiple_choice',
    role_target: 'Kelly', grading: 'static', correct_value: 'loss_475k',
    prompt: 'Which figure applies to you?',
    placeholder: '', order: 11, hidden: false, deletable: true,
    options: [
      { value: 'reg_10',      label: '$10 — the registration fee for WashingtonGrays.com' },
      { value: 'loss_475k',   label: '~$475,000 — your expected first-year cost (≈1% of ticket sales) of using WashingtonGrays.com instead of Grays.com' },
      { value: 'stadium_440m', label: '$440 million — the cost of the new stadium' },
      { value: 'reseller_35', label: '$35 — what middle-man ticket resellers pay for domains' },
    ],
    explanation: 'Your best alternative is WashingtonGrays.com; the ~$475K expected loss from using it is your ceiling.',
  },

  // ── Knowledge-check Q5: implied ZOPA ─────────────────────────────────────────
  {
    field: 'kc_chris_zopa',
    type: 'mc', system: false, category: 'knowledge_check', format: 'multiple_choice',
    role_target: 'Chris', grading: 'static', correct_value: 'floor_to_kelly_max',
    prompt: 'Based on your numbers, the implied ZOPA is the range from:',
    placeholder: '', order: 12, hidden: false, deletable: true,
    options: [
      { value: 'floor_to_kelly_max', label: "Your ~$25,000 floor up to your guess of Kelly's maximum" },
      { value: 'zero_to_switch',     label: '$0 up to your ~$25,000 switching cost' },
      { value: 'kelly_max_to_7_5m',  label: "Your guess of Kelly's maximum up to $7.5 million" },
      { value: 'single_25k',         label: 'Exactly $25,000 — there is no range, just a single number' },
    ],
    explanation: "As the seller, your reservation price is the bottom of the ZOPA; the buyer's reservation price — your estimate of Kelly's max — is the top. A deal is possible only if your guess of Kelly's max exceeds your ~$25K floor.",
  },
  {
    field: 'kc_kelly_zopa',
    type: 'mc', system: false, category: 'knowledge_check', format: 'multiple_choice',
    role_target: 'Kelly', grading: 'static', correct_value: 'chris_min_to_ceiling',
    prompt: 'Based on your numbers, the implied ZOPA is the range from:',
    placeholder: '', order: 12, hidden: false, deletable: true,
    options: [
      { value: 'chris_min_to_ceiling', label: "Your guess of Chris's minimum up to your ~$475,000 maximum" },
      { value: 'zero_to_475k',         label: '$0 up to your ~$475,000 maximum' },
      { value: '475k_to_7_5m',         label: 'Your ~$475,000 maximum up to $7.5 million' },
      { value: 'single_475k',          label: 'Exactly $475,000 — there is no range, just a single number' },
    ],
    explanation: "As the buyer, your reservation price is the top of the ZOPA; the seller's reservation price — your estimate of Chris's min — is the bottom. A deal is possible only if your ~$475K ceiling exceeds your guess of Chris's min.",
  },
]

/**
 * System question defaults — injected for any instance whose stored
 * prep_text_questions does not yet include them (first load after Slice 2 deploy).
 * Instructors can edit prompt/hidden/order and (for MC) option labels, but not
 * field/type/deletable/system or MC option values.
 */
const SYSTEM_QUESTION_DEFAULTS: PrepTextQuestion[] = [
  {
    field: 'knowledge_check',
    type: 'mc', system: true, deletable: false,
    category: 'knowledge_check', format: 'multiple_choice',
    role_target: 'both', grading: 'assigned_role',
    prompt: 'What is your role in the negotiation?',
    placeholder: '', order: -1, hidden: false,
    options: [
      { value: 'Chris', label: 'Seller (Chris Gray)' },
      { value: 'Kelly', label: 'Buyer (Kelly Kaplan)' },
    ],
  },
  {
    field: 'prep_estimated_other_price',
    type: 'number', system: true, deletable: false,
    category: 'preparation', format: 'number',
    role_target: 'both',
    prompt: "What is your best guess of the other side's walk-away value (reservation price)?",
    placeholder: 'e.g. 250000', order: 1, hidden: false,
  },
  {
    field: 'prep_planned_first_offer',
    type: 'number', system: true, deletable: false,
    category: 'preparation', format: 'number',
    role_target: 'both',
    prompt: 'Assuming you make the first offer, what number do you think you will put on the table? This is non-binding.',
    placeholder: 'e.g. 300000', order: 3, hidden: false,
  },
  {
    field: 'debrief_initial_offer',
    type: 'number', system: false, deletable: true,
    category: 'debrief', format: 'number',
    role_target: 'both',
    prompt: 'What was the first price offer made in your negotiation?',
    placeholder: 'e.g. 300000', order: 5, hidden: true,
  },
]

/** Injects any missing system questions (by field name) into the stored list and sorts by order. */
function mergeWithSystemDefaults(stored: PrepTextQuestion[]): PrepTextQuestion[] {
  const result = [...stored]
  for (const def of SYSTEM_QUESTION_DEFAULTS) {
    if (!result.some(q => q.field === def.field)) {
      result.push({ ...def })
    }
  }
  return result.sort((a, b) => a.order - b.order)
}

function parsePrepTextQuestions(raw: unknown): PrepTextQuestion[] | null {
  if (!Array.isArray(raw)) return null
  const result: PrepTextQuestion[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) return null
    const q = item as Record<string, unknown>
    if (typeof q.field !== 'string') return null
    if (
      !q.field.startsWith('prep_') &&
      !q.field.startsWith('kc_') &&
      !q.field.startsWith('debrief_') &&
      q.field !== 'knowledge_check'
    ) return null
    if (typeof q.prompt      !== 'string')                              return null
    if (typeof q.placeholder !== 'string')                              return null
    if (typeof q.order       !== 'number' || !Number.isFinite(q.order)) return null
    if (typeof q.hidden      !== 'boolean')                             return null
    if (typeof q.deletable   !== 'boolean')                             return null

    const type: 'text' | 'number' | 'mc' =
      q.type === 'number' ? 'number' : q.type === 'mc' ? 'mc' : 'text'
    const system: boolean = q.system === true

    let options: MCOption[] | undefined
    if (type === 'mc') {
      if (!Array.isArray(q.options)) return null
      options = []
      for (const opt of q.options) {
        if (typeof opt !== 'object' || opt === null) return null
        const o = opt as Record<string, unknown>
        if (typeof o.value !== 'string' || typeof o.label !== 'string') return null
        options.push({ value: o.value, label: o.label })
      }
    }

    // Infer format from type when absent (backward compat for pre-Slice-A stored data).
    const format: PrepTextQuestion['format'] =
      q.format === 'multiple_choice' ? 'multiple_choice'
      : q.format === 'number' ? 'number'
      : q.format === 'text' ? 'text'
      : type === 'mc' ? 'multiple_choice'
      : type === 'number' ? 'number'
      : 'text'

    // Infer category from field name when absent (backward compat).
    const category: PrepTextQuestion['category'] =
      q.category === 'knowledge_check' ? 'knowledge_check'
      : q.category === 'debrief' ? 'debrief'
      : q.category === 'preparation' ? 'preparation'
      : q.field === 'knowledge_check' || q.field.startsWith('kc_') ? 'knowledge_check'
      : q.field.startsWith('debrief_') ? 'debrief'
      : 'preparation'

    const grading: PrepTextQuestion['grading'] =
      q.grading === 'static' ? 'static'
      : q.grading === 'assigned_role' ? 'assigned_role'
      : undefined

    const correct_value: string | undefined =
      typeof q.correct_value === 'string' ? q.correct_value : undefined

    // Default 'both' for legacy stored questions that predate role_target.
    const role_target: PrepTextQuestion['role_target'] =
      q.role_target === 'Chris' ? 'Chris'
      : q.role_target === 'Kelly' ? 'Kelly'
      : 'both'

    const explanation: string | undefined =
      typeof q.explanation === 'string' ? q.explanation : undefined

    const parsed: PrepTextQuestion = {
      field:       q.field       as string,
      type,
      system,
      prompt:      q.prompt      as string,
      placeholder: q.placeholder as string,
      order:       q.order       as number,
      hidden:      q.hidden      as boolean,
      deletable:   q.deletable   as boolean,
      category,
      format,
      role_target,
    }
    if (options !== undefined)       parsed.options       = options
    if (grading !== undefined)       parsed.grading       = grading
    if (correct_value !== undefined) parsed.correct_value = correct_value
    if (explanation !== undefined)   parsed.explanation   = explanation
    result.push(parsed)
  }
  // Guard against absurd sizes.
  if (result.length > 50) return null
  // Guard against duplicate field names.
  const fields = result.map(q => q.field)
  if (new Set(fields).size !== fields.length) return null
  return result
}

/**
 * Validates knowledge-check grading constraints for a list of questions.
 * Returns an error string on the first violation, or null if all pass.
 */
function validateQuestionSemantics(questions: PrepTextQuestion[]): string | null {
  const validRoleTargets = ['Chris', 'Kelly', 'both'] as const
  for (const q of questions) {
    if (!validRoleTargets.includes(q.role_target)) {
      return `Question "${q.field}": role_target must be 'Chris', 'Kelly', or 'both'`
    }
    if (q.explanation !== undefined && typeof q.explanation !== 'string') {
      return `Question "${q.field}": explanation must be a string`
    }
    if (q.category === 'knowledge_check' && q.format !== 'multiple_choice') {
      return `Question "${q.field}": knowledge_check questions must have format 'multiple_choice'`
    }
    if (q.grading === 'static') {
      if (!q.correct_value) {
        return `Question "${q.field}": grading 'static' requires correct_value`
      }
      const optionValues = (q.options ?? []).map(o => o.value)
      if (!optionValues.includes(q.correct_value)) {
        return `Question "${q.field}": correct_value '${q.correct_value}' does not match any option value`
      }
    }
    if (q.grading === 'assigned_role' && q.correct_value !== undefined) {
      return `Question "${q.field}": grading 'assigned_role' must not have correct_value`
    }
  }
  return null
}

/**
 * Finalizes a game instance: reads all participant and group records, computes
 * per-role z-scores via computeZScores(), and writes raw_score / normalized_score
 * back to each completed participant's Firestore record.
 *
 * Classroom-push wiring is a separate step (needs CLASSROOM_CALLBACK_SECRET).
 *
 * Input:  { game_instance_id: string }
 * Output: { ok: true, scored: { Chris: n, Kelly: n, total: n } }
 */
export const finalizeInstance = onCall(
  { invoker: 'public' },
  async (request) => {
    const gameInstanceId = extractInstructorGameIdCall(
      request.data as Record<string, unknown>,
      process.env.FUNCTIONS_EMULATOR === 'true',
    )

    const db = admin.firestore()
    const instanceRef = db.collection('game_instances').doc(gameInstanceId)

    await ensureConfigSeeded(instanceRef)

    const [configSnap, participantsSnap, groupsSnap] = await Promise.all([
      instanceRef.collection('config').doc('main').get(),
      instanceRef.collection('participants').get(),
      instanceRef.collection('groups').get(),
    ])

    // Standard reservation-price defaults — match the standard role PDFs.
    // Must stay in sync with the PDFs if an instructor ever overrides them in config.
    const STANDARD_DEFAULTS = CONFIG_DEFAULTS

    // Three cases for reservation prices:
    //   1. Config document loaded and both fields are present → use them (instructor override).
    //   2. Config document loaded but fields are absent/unset → use STANDARD_DEFAULTS.
    //      This is the normal pre-configure state; no warning needed.
    //   3. Config document could not be read (missing document, null data) → abort.
    //      A missing document means we cannot distinguish "zero" from "unknown";
    //      scoring against silent assumptions could produce wrong grades.
    const rawConfig = configSnap.data()
    if (rawConfig == null) {
      throw new HttpsError(
        'not-found',
        `Finalize aborted: could not read game config for instance ${gameInstanceId}. ` +
        `Reservation prices unknown — refusing to score against assumptions.`,
      )
    }
    const configData = rawConfig as Record<string, unknown>
    const hasChris = typeof configData.reservation_price_chris === 'number'
    const hasKelly = typeof configData.reservation_price_kelly === 'number'
    const gameConfig: GameConfig = {
      reservation_price_chris: hasChris
        ? (configData.reservation_price_chris as number)
        : STANDARD_DEFAULTS.reservation_price_chris,
      reservation_price_kelly: hasKelly
        ? (configData.reservation_price_kelly as number)
        : STANDARD_DEFAULTS.reservation_price_kelly,
    }
    console.info(
      `[finalizeInstance] ${gameInstanceId}: reservation prices — ` +
      `Chris $${gameConfig.reservation_price_chris}${hasChris ? ' (config)' : ' (default)'}, ` +
      `Kelly $${gameConfig.reservation_price_kelly}${hasKelly ? ' (config)' : ' (default)'}`,
    )

    // Index completed group outcomes by group_id.
    const completedGroups = new Map<string, { agreement_reached: boolean; final_price: number | null }>()
    for (const groupDoc of groupsSnap.docs) {
      const g = groupDoc.data()
      if (g.status === 'completed') {
        completedGroups.set(groupDoc.id, {
          agreement_reached: g.agreement_reached as boolean,
          final_price: (g.final_price ?? null) as number | null,
        })
      }
    }

    // Map each participant to a ParticipantRecord.
    // 'completed' = group finished (agreement or walk-away).
    // 'late'      = present but unplaceable; marked by instructor UI. normalized_score = null.
    // 'no_show'   = everything else. normalized_score = -2 (floor marker).
    const participantRecords: ParticipantRecord[] = participantsSnap.docs
      .filter((doc) => {
        const role = doc.data().role
        return role === 'Chris' || role === 'Kelly'
      })
      .map((doc) => {
        const d = doc.data()
        const groupOutcome = d.group_id
          ? completedGroups.get(d.group_id as string)
          : undefined
        const status: 'completed' | 'late' | 'no_show' =
          groupOutcome !== undefined ? 'completed'
          : d.participant_late === true ? 'late'
          : 'no_show'
        return {
          participant_id: doc.id,
          role: d.role as 'Chris' | 'Kelly',
          status,
          agreement_reached: groupOutcome?.agreement_reached ?? false,
          final_price: groupOutcome?.final_price ?? null,
          knowledge_check_score: (d.knowledge_check_score ?? null) as number | null,
          details: {},
        }
      })

    // Pure function does all the math — no Firestore access inside.
    const results = computeZScores(participantRecords, gameConfig)

    // Write raw_score and normalized_score back to each completed participant.
    const batch = db.batch()
    const finalizedAt = Timestamp.now()
    for (const r of results) {
      batch.update(
        instanceRef.collection('participants').doc(r.participant_id),
        { raw_score: r.raw_score, normalized_score: r.normalized_score, finalized_at: finalizedAt },
      )
    }

    // Second pass: enrolled-but-never-joined students (no Chris/Kelly role).
    // Excluded from z-score math; write the -2 floor marker + finalized_at so the push includes them.
    let noRoleCount = 0
    for (const doc of participantsSnap.docs) {
      const role = doc.data().role
      if (role === 'Chris' || role === 'Kelly') continue
      batch.update(
        instanceRef.collection('participants').doc(doc.id),
        { raw_score: null, normalized_score: -2, finalized_at: finalizedAt },
      )
      noRoleCount++
    }
    await batch.commit()

    const chrisCount = results.filter((r) => r.role === 'Chris').length
    const kellyCount = results.filter((r) => r.role === 'Kelly').length
    return { ok: true, scored: { Chris: chrisCount, Kelly: kellyCount, total: results.length + noRoleCount } }
  },
)

// ── Game config — Settings page ─────────────────────────────────────────────

/**
 * Returns the full game config for the Settings page: reservation prices,
 * info-URL fields, and the editable prep_text_questions list.
 *
 * Request body (emulator): { _dev: { game_instance_id } }
 */
export const getGameConfig = corsOnRequest(async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return }
  const body = req.body as Record<string, unknown>
  const isEmulator = process.env.FUNCTIONS_EMULATOR === 'true'
  const gameInstanceId = extractInstructorGameId(body, isEmulator, res)
  if (!gameInstanceId) return

  try {
    const db = admin.firestore()
    const instanceRef = db.collection('game_instances').doc(gameInstanceId)
    await ensureConfigSeeded(instanceRef)
    const snap = await instanceRef.collection('config').doc('main').get()
    const cd = (snap.data() ?? {}) as Record<string, unknown>
    res.json({
      ok: true,
      reservation_price_chris: typeof cd.reservation_price_chris === 'number'
        ? (cd.reservation_price_chris as number)
        : CONFIG_DEFAULTS.reservation_price_chris,
      reservation_price_kelly: typeof cd.reservation_price_kelly === 'number'
        ? (cd.reservation_price_kelly as number)
        : CONFIG_DEFAULTS.reservation_price_kelly,
      seller_name: typeof cd.seller_name === 'string' ? (cd.seller_name as string) : CONFIG_DEFAULTS.seller_name,
      buyer_name:  typeof cd.buyer_name  === 'string' ? (cd.buyer_name  as string) : CONFIG_DEFAULTS.buyer_name,
      public_info_url: typeof cd.public_info_url  === 'string' ? (cd.public_info_url  as string) : '',
      chris_info_url:  typeof cd.chris_info_url   === 'string' ? (cd.chris_info_url   as string) : '',
      kelly_info_url:  typeof cd.kelly_info_url   === 'string' ? (cd.kelly_info_url   as string) : '',
      prep_text_questions: mergeWithSystemDefaults(
        parsePrepTextQuestions(cd.prep_text_questions) ?? DEFAULT_PREP_TEXT_QUESTIONS,
      ),
    })
  } catch (err) {
    console.error('getGameConfig error:', err)
    res.status(500).json({ error: 'Internal error' })
  }
})

/**
 * Writes any subset of config/main fields with { merge: true } — only the
 * fields present in the request body are written; all other fields (prices,
 * URL slots, future additions) are left untouched.
 *
 * Each Settings section saves independently:
 *   - Reservation Prices section sends only the two price fields.
 *   - PDF Info Links section sends only the three URL fields.
 *
 * Validation:
 *   Prices (if present) — must be positive integers.
 *   URLs   (if present) — must be empty string OR a well-formed http(s) URL.
 *   At least one recognised field must be present.
 *
 * Request body (emulator): { _dev: { game_instance_id }, ...fields }
 * Response: full current config (all five fields) after the write.
 */
export const updateGameConfig = corsOnRequest(async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return }
  const body = req.body as Record<string, unknown>
  const isEmulator = process.env.FUNCTIONS_EMULATOR === 'true'
  const gameInstanceId = extractInstructorGameId(body, isEmulator, res)
  if (!gameInstanceId) return

  // Build the partial update — only validated, present fields are written.
  const update: Record<string, unknown> = {}

  // ── Prices ────────────────────────────────────────────────────────
  if ('reservation_price_chris' in body) {
    const v = body.reservation_price_chris
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || !Number.isInteger(v)) {
      res.status(400).json({ error: 'reservation_price_chris must be a positive integer' }); return
    }
    update.reservation_price_chris = v
  }
  if ('reservation_price_kelly' in body) {
    const v = body.reservation_price_kelly
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || !Number.isInteger(v)) {
      res.status(400).json({ error: 'reservation_price_kelly must be a positive integer' }); return
    }
    update.reservation_price_kelly = v
  }

  // ── URL fields ────────────────────────────────────────────────────
  // Empty string = intentionally unset (allowed). Non-empty must be http(s).
  for (const field of ['public_info_url', 'chris_info_url', 'kelly_info_url'] as const) {
    if (!(field in body)) continue
    const v = body[field]
    if (typeof v !== 'string') {
      res.status(400).json({ error: `${field} must be a string` }); return
    }
    if (v !== '') {
      try {
        const parsed = new URL(v)
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error()
      } catch {
        res.status(400).json({ error: `${field}: must be empty or a valid http(s) URL` }); return
      }
    }
    update[field] = v
  }

  // ── Display names ──────────────────────────────────────────────────
  for (const field of ['seller_name', 'buyer_name'] as const) {
    if (!(field in body)) continue
    const v = body[field]
    if (typeof v !== 'string' || v.trim() === '') {
      res.status(400).json({ error: `${field} must be a non-empty string` }); return
    }
    update[field] = v.trim()
  }

  // ── prep_text_questions ────────────────────────────────────────────
  if ('prep_text_questions' in body) {
    const parsed = parsePrepTextQuestions(body.prep_text_questions)
    if (parsed === null) {
      res.status(400).json({ error: 'prep_text_questions: invalid shape — must be an array of {field(prep_*/kc_*/debrief_*),prompt,placeholder,order,hidden,deletable} with unique field names' }); return
    }
    const semanticError = validateQuestionSemantics(parsed)
    if (semanticError !== null) {
      res.status(400).json({ error: `prep_text_questions: ${semanticError}` }); return
    }
    update.prep_text_questions = parsed
  }

  if (Object.keys(update).length === 0) {
    res.status(400).json({ error: 'No recognised fields to update' }); return
  }

  try {
    const db = admin.firestore()
    const ref = db
      .collection('game_instances').doc(gameInstanceId)
      .collection('config').doc('main')

    await ref.set(update, { merge: true })

    // Re-read the whole doc so the response reflects the authoritative current
    // state of every watched field — the caller's section only sent a subset.
    const snap = await ref.get()
    const cd = (snap.data() ?? {}) as Record<string, unknown>
    res.json({
      ok: true,
      reservation_price_chris: typeof cd.reservation_price_chris === 'number'
        ? (cd.reservation_price_chris as number)
        : CONFIG_DEFAULTS.reservation_price_chris,
      reservation_price_kelly: typeof cd.reservation_price_kelly === 'number'
        ? (cd.reservation_price_kelly as number)
        : CONFIG_DEFAULTS.reservation_price_kelly,
      seller_name: typeof cd.seller_name === 'string' ? (cd.seller_name as string) : CONFIG_DEFAULTS.seller_name,
      buyer_name:  typeof cd.buyer_name  === 'string' ? (cd.buyer_name  as string) : CONFIG_DEFAULTS.buyer_name,
      public_info_url: typeof cd.public_info_url === 'string' ? (cd.public_info_url as string) : '',
      chris_info_url:  typeof cd.chris_info_url  === 'string' ? (cd.chris_info_url  as string) : '',
      kelly_info_url:  typeof cd.kelly_info_url  === 'string' ? (cd.kelly_info_url  as string) : '',
      prep_text_questions: mergeWithSystemDefaults(
        parsePrepTextQuestions(cd.prep_text_questions) ?? DEFAULT_PREP_TEXT_QUESTIONS,
      ),
    })
  } catch (err) {
    console.error('updateGameConfig error:', err)
    res.status(500).json({ error: 'Internal error' })
  }
})

// ── Student question delivery ───────────────────────────────────────────────

/** djb2 hash → unsigned 32-bit integer. Used as a shuffle seed. */
function djb2Hash(str: string): number {
  let h = 5381
  for (let i = 0; i < str.length; i++) {
    h = ((h * 33) ^ str.charCodeAt(i)) >>> 0
  }
  return h
}

/** Fisher-Yates shuffle driven by an LCG seeded from `seed`. Returns a new array. */
function seededShuffle<T>(arr: T[], seed: number): T[] {
  const a = [...arr]
  let s = seed >>> 0
  for (let i = a.length - 1; i > 0; i--) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    const j = s % (i + 1)
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

/**
 * Returns the visible, ordered free-text prep questions for a student's session.
 * Hidden questions are excluded. Numeric prep questions are hardcoded in the
 * client and are not returned here.
 *
 * Falls back to DEFAULT_PREP_TEXT_QUESTIONS when config/main has no stored list.
 *
 * Request body: { token | _test: { participant_id, game_instance_id } }
 * Response: { ok, questions: PrepTextQuestion[] }
 */
export const getStudentPrepQuestions = corsOnRequest(async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return }
  const body = req.body as Record<string, unknown>
  const isEmulator = process.env.FUNCTIONS_EMULATOR === 'true'
  const ids = extractStudentIds(body, isEmulator, res)
  if (!ids) return
  const { gameInstanceId, participantId } = ids

  try {
    const db = admin.firestore()
    const instanceRef = db.collection('game_instances').doc(gameInstanceId)
    const [configSnap, participantSnap] = await Promise.all([
      instanceRef.collection('config').doc('main').get(),
      instanceRef.collection('participants').doc(participantId).get(),
    ])

    // Fail closed: role must be assigned before questions are delivered.
    const participantRole = (participantSnap.data() ?? {}).role as 'Chris' | 'Kelly' | undefined
    if (!participantRole) {
      res.status(503).json({ error: 'Role not yet assigned.' })
      return
    }

    const cd = (configSnap.data() ?? {}) as Record<string, unknown>
    const sellerName = typeof cd.seller_name === 'string' ? cd.seller_name : CONFIG_DEFAULTS.seller_name
    const buyerName  = typeof cd.buyer_name  === 'string' ? cd.buyer_name  : CONFIG_DEFAULTS.buyer_name
    const stored = parsePrepTextQuestions(cd.prep_text_questions) ?? DEFAULT_PREP_TEXT_QUESTIONS
    const visible = mergeWithSystemDefaults(stored)
      .filter(q =>
        !q.hidden &&
        q.category !== 'debrief' &&
        (q.role_target === 'both' || q.role_target === participantRole),
      )
      .sort((a, b) => a.order - b.order)
    // Strip answer key fields — correct_value, grading, and explanation must never reach the client pre-submission.
    const sanitized = visible.map(({ correct_value: _cv, grading: _g, explanation: _ex, ...rest }) => rest)
    // Override KC role option labels with the configured display names.
    const withNames = sanitized.map(q => {
      if (q.field !== 'knowledge_check' || !q.options) return q
      return {
        ...q,
        options: q.options.map(o => {
          if (o.value === 'Chris') return { ...o, label: `${sellerName}, the seller` }
          if (o.value === 'Kelly') return { ...o, label: `${buyerName}, the buyer` }
          return o
        }),
      }
    })
    // Shuffle MC options deterministically per participant so answer position isn't a hint.
    // Seed = djb2(participantId + ':' + field) — stable on reload for the same student.
    const shuffled = withNames.map(q => {
      if (q.type !== 'mc' || !q.options || q.options.length <= 1) return q
      const seed = djb2Hash(`${participantId}:${q.field}`)
      return { ...q, options: seededShuffle(q.options, seed) }
    })
    res.json({ ok: true, questions: shuffled })
  } catch (err) {
    console.error('getStudentPrepQuestions error:', err)
    res.status(500).json({ error: 'Internal error' })
  }
})

// ── syncRoster ────────────────────────────────────────────────────────────────
// Fetches the classroom enrollment roster and pre-populates participant docs so
// the instructor sees all enrolled students as "Enrolled" before they self-join.
//
// Merge rule: docs that already have a role (student has self-joined) are never
// touched. Only creates new rows or refreshes enrollment name/external_id on
// existing role-less rows. No deletions.
//
// Request body: { token } | { _dev: { game_instance_id } }
// Response: { ok, synced, skipped } — force-rebuild 2026-06-20

export const syncRoster = corsOnRequest(async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return }
  const body = req.body as Record<string, unknown>
  const isEmulator = process.env.FUNCTIONS_EMULATOR === 'true'
  const gameInstanceId = extractInstructorGameId(body, isEmulator, res)
  if (!gameInstanceId) return

  const rosterUrl = process.env.CLASSROOM_ROSTER_URL ?? ''
  const callbackSecret = process.env.CLASSROOM_CALLBACK_SECRET ?? ''
  if (!rosterUrl || !callbackSecret) {
    console.error('syncRoster: CLASSROOM_ROSTER_URL or CLASSROOM_CALLBACK_SECRET not configured')
    res.status(500).json({ error: 'Classroom roster not configured' })
    return
  }

  try {
    const rosterRes = await fetch(rosterUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${callbackSecret}` },
      body: JSON.stringify({ game_instance_id: gameInstanceId }),
    })
    if (!rosterRes.ok) {
      const errData = await rosterRes.json().catch(() => ({}) as Record<string, unknown>)
      const errMsg = (errData as Record<string, unknown>).error as string | undefined
      res.status(502).json({ error: `Classroom roster error: ${errMsg ?? String(rosterRes.status)}` })
      return
    }
    const { participants } = await rosterRes.json() as {
      participants: Array<{ participant_id: string; name: string; external_id: string | null }>
    }

    if (participants.length === 0) {
      res.json({ ok: true, synced: 0, skipped: 0 })
      return
    }

    const db = admin.firestore()
    const instanceRef = db.collection('game_instances').doc(gameInstanceId)
    const participantRefs = participants.map((p) =>
      instanceRef.collection('participants').doc(p.participant_id)
    )

    // Bulk-read all participant docs in one round-trip
    const snaps = await db.getAll(...participantRefs)

    const batch = db.batch()
    let synced = 0
    let skipped = 0

    for (let i = 0; i < participants.length; i++) {
      const snap = snaps[i]
      const p = participants[i]
      const existing = snap.data()

      if (existing?.role) {
        // Student has already self-joined with a role — never touch their doc
        skipped++
        continue
      }

      if (snap.exists) {
        // Pre-populated row without a role — refresh enrollment name and external_id only
        batch.update(snap.ref, { name: p.name, external_id: p.external_id ?? null })
      } else {
        // New row — create a placeholder so the instructor sees this student immediately
        batch.set(snap.ref, {
          participant_id: p.participant_id,
          game_instance_id: gameInstanceId,
          name: p.name,
          external_id: p.external_id ?? null,
          prep_status: 'not_started',
        })
      }
      synced++
    }

    // Ensure the game_instances/{id} document exists so it appears in dev tooling
    // (e.g. DevLauncher instance picker). merge:true is safe — only writes the key field.
    await instanceRef.set({ game_instance_id: gameInstanceId }, { merge: true })

    if (synced > 0) await batch.commit()

    console.log(`syncRoster: synced=${synced} skipped=${skipped} for instance ${gameInstanceId}`)
    res.json({ ok: true, synced, skipped })
  } catch (err) {
    console.error('syncRoster error:', err)
    res.status(500).json({ error: 'Internal error' })
  }
})
