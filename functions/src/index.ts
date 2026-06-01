import { randomUUID } from 'crypto'
import * as admin from 'firebase-admin'
import { FieldValue } from 'firebase-admin/firestore'
import { onRequest } from 'firebase-functions/v2/https'
import { defineSecret } from 'firebase-functions/params'
import { verifyClassroomToken, ClassroomTokenPayload } from './engine/verifyToken'
import { reportResult } from './engine/reportResult'
import { matchParticipants } from './matching'
import { computeZScores } from './finalize'
import { assignRole as doAssignRole } from './assignRole'
import { getInfoUrlsForParticipant } from './getInfoUrls'
import { scoreKnowledgeCheck } from './submitKnowledgeCheck'
import { markPrepComplete } from './completePrep'
import { markReadyConfirmed } from './confirmReady'
import { generateAttendanceCode as doGenerateCode, verifyAttendanceCode as doVerifyCode } from './attendanceCode'

admin.initializeApp()

// Public key is baked into classroomPublicKey.ts — no secret needed.
// Only the callback secret is truly sensitive.
const classroomCallbackSecret = defineSecret('CLASSROOM_CALLBACK_SECRET')

export { reportResult, matchParticipants, computeZScores }

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
export const assignRole = onRequest(async (req, res) => {
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
export const getInfoUrls = onRequest(async (req, res) => {
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
export const submitKnowledgeCheck = onRequest(async (req, res) => {
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
    res.json({ ok: true, ...result })
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
export const completePrep = onRequest(async (req, res) => {
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
export const verifyToken = onRequest(async (req, res) => {
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
export const confirmReady = onRequest(async (req, res) => {
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
export const generateAttendanceCode = onRequest(async (req, res) => {
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
export const verifyAttendanceCode = onRequest(async (req, res) => {
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
export const triggerMatching = onRequest(async (req, res) => {
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
    const presenceSnap = await admin
      .database()
      .ref(`presence/${gameInstanceId}`)
      .once('value')
    const presentIds = new Set<string>(Object.keys(presenceSnap.val() ?? {}))

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
        .json({ error: 'Need at least one Chris and one Kelly present to match.' })
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

/**
 * Finalizes a game instance: computes z-scores and pushes updated results
 * to the classroom callback URL.
 * Called by the instructor dashboard ("Finalize Results" button).
 */
export const finalizeInstance = onRequest(
  { secrets: [classroomCallbackSecret] },
  async (req, res) => {
    // TODO: read completed participants from Firestore
    // TODO: run computeZScores()
    // TODO: call reportResult() for each participant with normalized_score
    void req
    void classroomCallbackSecret
    res.status(501).json({ error: 'Not yet implemented' })
  },
)
