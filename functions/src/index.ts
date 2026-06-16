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
  // Prices come from config; create with standard defaults if config is absent.
  const PRICE_DEFAULTS = {
    reservation_price_chris: 25_000,
    reservation_price_kelly: 475_000,
  } as const
  const configRef = instanceRef.collection('config').doc('main')
  const configSnap = await configRef.get()
  let priceChris: number
  let priceKelly: number
  if (!configSnap.exists) {
    priceChris = PRICE_DEFAULTS.reservation_price_chris
    priceKelly = PRICE_DEFAULTS.reservation_price_kelly
    await configRef.set({ reservation_price_chris: priceChris, reservation_price_kelly: priceKelly })
  } else {
    const cd = configSnap.data()!
    priceChris = typeof cd.reservation_price_chris === 'number'
      ? (cd.reservation_price_chris as number) : PRICE_DEFAULTS.reservation_price_chris
    priceKelly = typeof cd.reservation_price_kelly === 'number'
      ? (cd.reservation_price_kelly as number) : PRICE_DEFAULTS.reservation_price_kelly
  }

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
export const startNegotiation = onRequest(async (req, res) => {
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
 * Records a participant's actual opening offer from their negotiation.
 * Writes debrief_initial_offer to their participant doc, then recomputes
 * group_initial_price as the average of all submitted values so far.
 *
 * Request body (emulator): { _test: { participant_id, game_instance_id }, initial_offer: number }
 */
export const submitDebriefOffer = onRequest(async (req, res) => {
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

/**
 * Returns group outcomes and game config needed for the Reports page.
 * Request body: { _dev: { game_instance_id } }
 * Response: { ok, groups: GroupOutcome[], config: { reservation_price_chris, reservation_price_kelly } }
 */
export const getReportData = onRequest(async (req, res) => {
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
        }
      })
      .filter((p) => p.role === 'Chris' || p.role === 'Kelly')

    const cd = configSnap.data() ?? {}
    const config = {
      reservation_price_chris: typeof cd.reservation_price_chris === 'number'
        ? (cd.reservation_price_chris as number) : 25_000,
      reservation_price_kelly: typeof cd.reservation_price_kelly === 'number'
        ? (cd.reservation_price_kelly as number) : 475_000,
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
export const getRoster = onRequest(async (req, res) => {
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
export const markParticipantLate = onRequest(async (req, res) => {
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

// ── Reservation-price defaults ─────────────────────────────────────────────
// Single source of truth for both finalizeInstance scoring and the Settings
// page; must stay in sync with the standard role PDFs shipped with the scenario.
const RESERVATION_PRICE_DEFAULTS = {
  reservation_price_chris: 25_000,   // Chris's floor: cost to switch domains
  reservation_price_kelly: 475_000,  // Kelly's ceiling: 1% of $47.5M ticket sales
} as const

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
    const STANDARD_DEFAULTS = RESERVATION_PRICE_DEFAULTS

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
    await batch.commit()

    const chrisCount = results.filter((r) => r.role === 'Chris').length
    const kellyCount = results.filter((r) => r.role === 'Kelly').length
    return { ok: true, scored: { Chris: chrisCount, Kelly: kellyCount, total: results.length } }
  },
)

// ── Game config — Settings page ─────────────────────────────────────────────

/**
 * Returns the full game config for the Settings page: reservation prices
 * (with RESERVATION_PRICE_DEFAULTS fallback) and the three info-URL fields
 * (empty string when absent — they have no meaningful default).
 *
 * Request body (emulator): { _dev: { game_instance_id } }
 * Response: { ok, reservation_price_chris, reservation_price_kelly,
 *              public_info_url, chris_info_url, kelly_info_url }
 */
export const getGameConfig = onRequest(async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return }
  const body = req.body as Record<string, unknown>
  const isEmulator = process.env.FUNCTIONS_EMULATOR === 'true'
  const gameInstanceId = extractInstructorGameId(body, isEmulator, res)
  if (!gameInstanceId) return

  try {
    const db = admin.firestore()
    const snap = await db
      .collection('game_instances').doc(gameInstanceId)
      .collection('config').doc('main').get()
    const cd = (snap.data() ?? {}) as Record<string, unknown>
    res.json({
      ok: true,
      reservation_price_chris: typeof cd.reservation_price_chris === 'number'
        ? (cd.reservation_price_chris as number)
        : RESERVATION_PRICE_DEFAULTS.reservation_price_chris,
      reservation_price_kelly: typeof cd.reservation_price_kelly === 'number'
        ? (cd.reservation_price_kelly as number)
        : RESERVATION_PRICE_DEFAULTS.reservation_price_kelly,
      public_info_url: typeof cd.public_info_url  === 'string' ? (cd.public_info_url  as string) : '',
      chris_info_url:  typeof cd.chris_info_url   === 'string' ? (cd.chris_info_url   as string) : '',
      kelly_info_url:  typeof cd.kelly_info_url   === 'string' ? (cd.kelly_info_url   as string) : '',
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
export const updateGameConfig = onRequest(async (req, res) => {
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
        : RESERVATION_PRICE_DEFAULTS.reservation_price_chris,
      reservation_price_kelly: typeof cd.reservation_price_kelly === 'number'
        ? (cd.reservation_price_kelly as number)
        : RESERVATION_PRICE_DEFAULTS.reservation_price_kelly,
      public_info_url: typeof cd.public_info_url === 'string' ? (cd.public_info_url as string) : '',
      chris_info_url:  typeof cd.chris_info_url  === 'string' ? (cd.chris_info_url  as string) : '',
      kelly_info_url:  typeof cd.kelly_info_url  === 'string' ? (cd.kelly_info_url  as string) : '',
    })
  } catch (err) {
    console.error('updateGameConfig error:', err)
    res.status(500).json({ error: 'Internal error' })
  }
})
