import * as admin from 'firebase-admin'
import { onRequest } from 'firebase-functions/v2/https'
import { defineSecret } from 'firebase-functions/params'
import { verifyClassroomToken, ClassroomTokenPayload } from './engine/verifyToken'
import { reportResult } from './engine/reportResult'
import { matchParticipants } from './matching'
import { computeZScores } from './finalize'
import { assignRole as doAssignRole } from './assignRole'

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
    res.json({ ok: true, role, customToken })
  } catch (err) {
    console.error('assignRole error:', err)
    res.status(500).json({ error: 'Internal error' })
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
 * Triggers the matching algorithm for a game instance.
 * Called by the instructor dashboard ("Match Now" button).
 * Reads eligible participants from Firestore, writes groups back.
 */
export const triggerMatching = onRequest(async (req, res) => {
  // TODO: read eligible participants from Firestore
  // TODO: run matchParticipants()
  // TODO: write GraysGroup records to Firestore
  // TODO: update participant records with group_id
  void req
  res.status(501).json({ error: 'Not yet implemented' })
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
