import { HttpsError } from 'firebase-functions/v2/https'
import { verifyClassroomToken, type ClassroomTokenPayload } from './verifyToken'
import { verifyFirebaseToken } from './verifyFirebaseToken'

/**
 * onCall-compatible version of extractInstructorGameId.
 * Throws HttpsError instead of writing to an HTTP response object,
 * matching the onCall contract used by finalizeInstance and pushResultsToClassroom.
 *
 * Dev path  (emulator only):  data._dev.game_instance_id — bypasses JWT.
 * Firebase path: Authorization: Bearer <id_token> — role must be 'instructor'.
 * Prod path: data.token — verified RS256 JWT; role must be 'instructor'.
 */
export async function extractInstructorGameIdCall(
  data: Record<string, unknown>,
  isEmulator: boolean,
  authHeader?: string,
): Promise<string> {
  if (isEmulator && data._dev != null) {
    const dev = data._dev as Record<string, unknown>
    if (typeof dev.game_instance_id !== 'string') {
      throw new HttpsError('invalid-argument', '_dev requires game_instance_id')
    }
    return dev.game_instance_id
  }
  if (authHeader?.startsWith('Bearer ')) {
    try {
      const { gameInstanceId, role } = await verifyFirebaseToken(authHeader)
      if (role !== 'instructor') {
        throw new HttpsError('permission-denied', 'Instructor access required')
      }
      return gameInstanceId
    } catch (err) {
      if (err instanceof HttpsError) throw err
      const message = err instanceof Error ? err.message : 'Invalid token'
      throw new HttpsError('unauthenticated', message)
    }
  }
  if (typeof data.token !== 'string') {
    throw new HttpsError('invalid-argument', 'Missing token')
  }
  let payload: ClassroomTokenPayload
  try {
    payload = verifyClassroomToken(data.token)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Invalid token'
    throw new HttpsError('unauthenticated', message)
  }
  if (payload.role !== 'instructor') {
    throw new HttpsError('permission-denied', 'Instructor access required')
  }
  return payload.game_instance_id
}
