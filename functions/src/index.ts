import { randomUUID } from 'crypto'
import * as admin from 'firebase-admin'
import { FieldValue, Timestamp } from 'firebase-admin/firestore'
import { onRequest, onCall, HttpsError } from 'firebase-functions/v2/https'
import { verifyClassroomToken, ClassroomTokenPayload } from './engine/verifyToken'
import { reportResult } from './engine/reportResult'
import { matchParticipants } from './matching'
import { computeZScores } from './finalize'
import type { GameConfig, ParticipantRecord } from './finalize'
import { suggestGroupForLatecomer } from './lateParticipant'
import { assignRole as doAssignRole } from './assignRole'
import { getInfoUrlsForParticipant } from './getInfoUrls'
import { scoreKnowledgeCheck } from './submitKnowledgeCheck'
import { markPrepComplete } from './completePrep'
import { markReadyConfirmed } from './confirmReady'
import { generateAttendanceCode as doGenerateCode, verifyAttendanceCode as doVerifyCode } from './attendanceCode'

admin.initializeApp()

// Public key is baked into classroomPublicKey.ts — no secret needed for auth.
// (CLASSROOM_CALLBACK_SECRET will be added back when the classroom-push step is wired.)

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

// ── Outcome reporting ─────────────────────────────────────────────────────────

/**
 * Lead reports the group's outcome: a price (agreement) or null (no deal).
 * Initialises non-lead confirmations to 'pending' and marks group 'reporting'.
 * Idempotent guard: returns 400 if lead already submitted for this round.
 *
 * Request body: { token | _test, price: number | null }
 */
export const submitLeadOutcome = onRequest(async (req, res) => {
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
export const submitConfirmation = onRequest(async (req, res) => {
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
export const submitInstructorOutcome = onRequest(async (req, res) => {
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
 * Returns all groups for a game instance with their current status and outcome.
 * Used by the instructor dashboard to monitor progress and spot deadlocked groups.
 *
 * Request body (emulator): { _dev: { game_instance_id } }
 */
export const getGroupStatuses = onRequest(async (req, res) => {
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

// ── Late-participant helpers ───────────────────────────────────────────────────

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
export const getUnmatchedParticipants = onRequest(async (req, res) => {
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

    // Unmatched = attended + present + has valid role + not in any group.
    const unmatched = participantsSnap.docs
      .filter((doc) => {
        const d = doc.data()
        return (
          d.attendance_confirmed_at != null &&
          presentIds.has(doc.id) &&
          (d.role === 'Chris' || d.role === 'Kelly') &&
          !matchedIds.has(doc.id)
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
export const addLateParticipant = onRequest(async (req, res) => {
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
      // Re-check total cap.
      if (total >= 3) {
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
            `Group already has ${chrisIds.length} Chrises. ` +
            `Please re-suggest a different group.`,
          ),
          { status: 409 },
        )
      }
      if (role === 'Kelly' && kellyIds.length >= 2) {
        throw Object.assign(
          new Error(
            `Group already has ${kellyIds.length} Kellys. ` +
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
    const data = request.data as { game_instance_id?: unknown }
    const gameInstanceId = data.game_instance_id
    if (typeof gameInstanceId !== 'string' || gameInstanceId === '') {
      throw new HttpsError('invalid-argument', 'game_instance_id is required')
    }

    const db = admin.firestore()
    const instanceRef = db.collection('game_instances').doc(gameInstanceId)

    const [configSnap, participantsSnap, groupsSnap] = await Promise.all([
      instanceRef.collection('config').doc('main').get(),
      instanceRef.collection('participants').get(),
      instanceRef.collection('groups').get(),
    ])

    // Standard reservation-price defaults — match the standard role PDFs.
    // Must stay in sync with the PDFs if an instructor ever overrides them in config.
    const STANDARD_DEFAULTS = {
      reservation_price_chris: 25_000,   // Chris's floor: cost to switch domains
      reservation_price_kelly: 475_000,  // Kelly's ceiling: 1% of $47.5M ticket sales
    } as const

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
    // 'no_show'   = everything else: group not completed, group_id absent, or truly absent.
    //               All no_show cases receive normalized_score = -2 (floor marker).
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
        return {
          participant_id: doc.id,
          role: d.role as 'Chris' | 'Kelly',
          status: groupOutcome !== undefined ? 'completed' : 'no_show',
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
    await batch.commit()

    const chrisCount = results.filter((r) => r.role === 'Chris').length
    const kellyCount = results.filter((r) => r.role === 'Kelly').length
    return { ok: true, scored: { Chris: chrisCount, Kelly: kellyCount, total: results.length } }
  },
)
