import * as admin from 'firebase-admin'
import { onRequest } from 'firebase-functions/v2/https'
import { defineSecret } from 'firebase-functions/params'
import { verifyClassroomToken } from './engine/verifyToken'
import { reportResult } from './engine/reportResult'
import { matchParticipants } from './matching'
import { computeZScores } from './finalize'

admin.initializeApp()

// Public key is baked into classroomPublicKey.ts — no secret needed.
// Only the callback secret is truly sensitive.
const classroomCallbackSecret = defineSecret('CLASSROOM_CALLBACK_SECRET')

export { reportResult, matchParticipants, computeZScores }

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
