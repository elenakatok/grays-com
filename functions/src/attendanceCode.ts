import * as admin from 'firebase-admin'
import { FieldValue } from 'firebase-admin/firestore'

// Unambiguous uppercase chars: no I (→1), L (→1), O (→0).
const CODE_CHARS = 'ABCDEFGHJKMNPQRTUVWXY'
const CODE_LENGTH = 5

function makeCode(): string {
  let code = ''
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]
  }
  return code
}

/**
 * Generates a new attendance code for a game instance and stores it in
 * Firestore. Always creates a fresh code (overwrites any existing one).
 * Called by the instructor dashboard.
 */
export async function generateAttendanceCode(gameInstanceId: string): Promise<string> {
  const code = makeCode()
  await admin
    .firestore()
    .collection('game_instances')
    .doc(gameInstanceId)
    .collection('attendance_code')
    .doc('current')
    .set({ code, generated_at: FieldValue.serverTimestamp() })
  return code
}

/**
 * Verifies a student-submitted attendance code against the stored code.
 * On match, records attendance_confirmed_at on the participant. Idempotent.
 * Requires confirmed_ready_at to be set (Phase 2 gate must come first).
 * Throws with .status for expected failures (wrong code, no code, etc).
 */
export async function verifyAttendanceCode(
  gameInstanceId: string,
  participantId: string,
  submittedCode: string,
): Promise<void> {
  const db = admin.firestore()
  const participantRef = db
    .collection('game_instances')
    .doc(gameInstanceId)
    .collection('participants')
    .doc(participantId)
  const codeRef = db
    .collection('game_instances')
    .doc(gameInstanceId)
    .collection('attendance_code')
    .doc('current')

  const [participantSnap, codeSnap] = await Promise.all([
    participantRef.get(),
    codeRef.get(),
  ])

  if (!participantSnap.exists) {
    throw Object.assign(new Error('Participant not found.'), { status: 404 })
  }

  const pdata = participantSnap.data()!

  if (pdata.confirmed_ready_at == null) {
    throw Object.assign(new Error('Please complete the confirmation step first.'), { status: 400 })
  }

  // Idempotent: already verified.
  if (pdata.attendance_confirmed_at != null) return

  if (!codeSnap.exists) {
    throw Object.assign(
      new Error('No attendance code has been generated yet. Ask your instructor to display one.'),
      { status: 400 },
    )
  }

  const storedCode = (codeSnap.data()!.code as string).toUpperCase()
  if (submittedCode.toUpperCase().trim() !== storedCode) {
    throw Object.assign(
      new Error("That code doesn't match. Check what your instructor is displaying and try again."),
      { status: 400 },
    )
  }

  await participantRef.update({
    attendance_confirmed_at: FieldValue.serverTimestamp(),
  })

  // Write the participant's roster record to RTDB so the instructor dashboard
  // can show a real-time attendance list without needing Firestore access.
  // This path is persistent (never deleted on disconnect) — the instructor sees
  // who attended even if they later disconnect.
  await admin
    .database()
    .ref(`attending/${gameInstanceId}/${participantId}`)
    .set({
      display_name: pdata.display_name ?? '',
      role: pdata.role ?? '',
      confirmed_at: Date.now(),
    })
}
