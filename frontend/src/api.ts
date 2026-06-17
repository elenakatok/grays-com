import { httpsCallable } from 'firebase/functions'
import { functions } from './firebase'

const FUNCTIONS_BASE = import.meta.env.DEV
  ? 'http://127.0.0.1:5004/grays-mygames-live/us-central1'
  : 'https://us-central1-grays-mygames-live.cloudfunctions.net'

export type TestArgs = { _test: { participant_id: string; game_instance_id: string } }
export type TokenArgs = { token: string }
export type CallArgs = TokenArgs | TestArgs
// Instructor-side args (no participant_id) — dev-mode only; production uses a token.
export type InstructorDevArgs = { _dev: { game_instance_id: string } }

async function callFunction<T>(name: string, body: object): Promise<T> {
  const res = await fetch(`${FUNCTIONS_BASE}/${name}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = (await res.json()) as T & { error?: string }
  if (!res.ok) {
    throw new Error(data.error ?? `${name} failed (${res.status})`)
  }
  return data
}

export type AssignRoleResult = {
  ok: boolean
  role: 'Chris' | 'Kelly'
  customToken: string
  participant_id: string
  game_instance_id: string
}

export type InfoUrlsResult = {
  ok: boolean
  role: 'Chris' | 'Kelly'
  public_info_url: string
  private_info_url: string
}

export type KnowledgeCheckResult = {
  ok: boolean
  correct: boolean
  alreadyCompleted: boolean
  score: number | null
  attempts: number
}

export const assignRole = (args: CallArgs) =>
  callFunction<AssignRoleResult>('assignRole', args)

export const getInfoUrls = (args: CallArgs) =>
  callFunction<InfoUrlsResult>('getInfoUrls', args)

export const submitKnowledgeCheck = (args: CallArgs, answer: 'Chris' | 'Kelly') =>
  callFunction<KnowledgeCheckResult>('submitKnowledgeCheck', { ...args, answer })

export const completePrep = (args: CallArgs) =>
  callFunction<{ ok: boolean }>('completePrep', args)

export const confirmReady = (args: CallArgs) =>
  callFunction<{ ok: boolean }>('confirmReady', args)

export const generateAttendanceCode = (args: InstructorDevArgs) =>
  callFunction<{ ok: boolean; code: string }>('generateAttendanceCode', args)

export const verifyAttendanceCode = (args: CallArgs, code: string) =>
  callFunction<{ ok: boolean }>('verifyAttendanceCode', { ...args, code })

export type MatchGroupResult = {
  group_id: string
  game_instance_id: string
  chris_participants: string[]
  kelly_participants: string[]
  lead_participant_id: string
  status: string
}

export const triggerMatching = (args: InstructorDevArgs) =>
  callFunction<{ ok: boolean; groups: MatchGroupResult[]; alreadyMatched?: boolean }>(
    'triggerMatching',
    args,
  )

// ── Outcome reporting ──────────────────────────────────────────────────────

export type GroupStatusResult = {
  group_id: string
  status: 'matched' | 'negotiating' | 'reporting' | 'completed' | 'deadlocked'
  disagree_count: number
  lead_outcome: { price: number | null; no_deal: boolean } | null
  confirmations: Record<string, 'pending' | 'confirmed' | 'disagreed'>
  agreement_reached: boolean | null
  final_price: number | null
  instructor_override: boolean
  chris_participants: string[]
  kelly_participants: string[]
  lead_participant_id: string
}

/** Any group member taps "Start negotiation" — flips group from matched → negotiating. Idempotent. */
export const startNegotiation = (args: CallArgs) =>
  callFunction<{ ok: boolean }>('startNegotiation', args)

/** Lead reports price (number) or no-deal (null). */
export const submitLeadOutcome = (args: CallArgs, price: number | null) =>
  callFunction<{ ok: boolean }>('submitLeadOutcome', { ...args, price })

/** Non-lead confirms (true) or disagrees (false) with lead's report. */
export const submitConfirmation = (args: CallArgs, confirmed: boolean) =>
  callFunction<{ ok: boolean; outcome: string }>('submitConfirmation', { ...args, confirmed })

/** Records a participant's debrief opening offer and recomputes the group average. */
export const submitDebriefOffer = (args: CallArgs, initialOffer: number) =>
  callFunction<{ ok: boolean }>('submitDebriefOffer', { ...args, initial_offer: initialOffer })

/** Instructor manually settles a deadlocked group. */
export const submitInstructorOutcome = (
  args: InstructorDevArgs,
  groupId: string,
  price: number | null,
) =>
  callFunction<{ ok: boolean }>('submitInstructorOutcome', {
    ...args,
    group_id: groupId,
    price,
  })

/** Returns all groups with current status — for the instructor dashboard. */
export const getGroupStatuses = (args: InstructorDevArgs) =>
  callFunction<{ ok: boolean; groups: GroupStatusResult[] }>('getGroupStatuses', args)

export type RosterParticipant = {
  participant_id: string
  name: string
  role: string | null
  has_attendance: boolean
  has_prep_completed: boolean
  group_id: string | null
  is_late: boolean
}

export type RosterGroup = {
  group_id: string
  status: string
}

/** Returns all enrolled participants + group statuses for the instructor roster. */
export const getRoster = (args: InstructorDevArgs) =>
  callFunction<{ ok: boolean; participants: RosterParticipant[]; groups: RosterGroup[]; session_live: boolean }>(
    'getRoster',
    args,
  )

// ── Shared question type ──────────────────────────────────────────────────────

export type MCOption = { value: string; label: string }

/**
 * A single prep question — text, numeric, or multiple-choice.
 * Mirrors the backend PrepTextQuestion type in functions/src/index.ts.
 */
export type PrepTextQuestion = {
  field: string
  type: 'text' | 'number' | 'mc'
  system: boolean
  prompt: string
  placeholder: string
  order: number
  hidden: boolean
  deletable: boolean
  options?: MCOption[]
}

// ── Reports ───────────────────────────────────────────────────────────────────

export type ReportGroup = {
  group_id: string
  status: string
  agreement_reached: boolean | null
  final_price: number | null
  group_initial_price: number | null
  chris_participants: string[]
  kelly_participants: string[]
}

export type ReportConfig = {
  reservation_price_chris: number
  reservation_price_kelly: number
  prep_text_questions: PrepTextQuestion[]
}

export type ReportParticipant = {
  participant_id: string
  display_name: string
  role: 'Chris' | 'Kelly'
  prep_planned_first_offer:   number | null
  prep_estimated_other_price: number | null
  // Known named fields (the three original text questions + debrief):
  prep_first_topic:          string | null
  prep_question_for_other:   string | null
  prep_planned_offer_reason: string | null
  debrief_reflection: string | null
  // Dynamic fields for instructor-added questions (arbitrary prep_* names):
  [key: string]: unknown
}

/** Returns group outcomes, game config, and per-participant prep answers for the Reports page. */
export const getReportData = (args: InstructorDevArgs) =>
  callFunction<{ ok: boolean; groups: ReportGroup[]; config: ReportConfig; participants: ReportParticipant[] }>('getReportData', args)

// ── Settings page — game config ────────────────────────────────────────────

export type GameConfigResult = {
  ok: boolean
  reservation_price_chris: number
  reservation_price_kelly: number
  public_info_url: string
  chris_info_url:  string
  kelly_info_url:  string
  prep_text_questions: PrepTextQuestion[]
}

/** Reads the full game config from config/main for the Settings page. */
export const getGameConfig = (args: InstructorDevArgs) =>
  callFunction<GameConfigResult>('getGameConfig', args)

/**
 * Merge-writes any subset of config/main fields; only the keys present in
 * `fields` are written — all other fields on the doc are left untouched.
 * The response is the full current config after the write.
 */
export const updateGameConfig = (
  args: InstructorDevArgs,
  fields: Partial<Omit<GameConfigResult, 'ok'>>,
) =>
  callFunction<GameConfigResult>('updateGameConfig', { ...args, ...fields })

// ── Student question delivery ─────────────────────────────────────────────────

/** Returns visible, ordered free-text prep questions for the current student session. */
export const getStudentPrepQuestions = (args: CallArgs) =>
  callFunction<{ ok: boolean; questions: PrepTextQuestion[] }>('getStudentPrepQuestions', args)

// ── Late-participant helpers ───────────────────────────────────────────────────

export type LateGroupSuggestion = {
  group_id: string
  current_chris: number
  current_kelly: number
  result_composition: string  // e.g. '2C+1K'
} | null

export type UnmatchedParticipant = {
  participant_id: string
  display_name: string
  role: 'Chris' | 'Kelly'
  suggested_group: LateGroupSuggestion
}

/** Returns present, attendance-verified participants who are not yet in any group. */
export const getUnmatchedParticipants = (args: InstructorDevArgs) =>
  callFunction<{ ok: boolean; unmatched: UnmatchedParticipant[] }>('getUnmatchedParticipants', args)

/** Marks a present-but-unplaceable participant as "Late" (raw_score/normalized_score = null). */
export const markParticipantLate = (args: InstructorDevArgs, participantId: string) =>
  callFunction<{ ok: boolean }>('markParticipantLate', { ...args, participant_id: participantId })

/** Adds a late participant to a specific group (server re-checks eligibility). */
export const addLateParticipant = (
  args: InstructorDevArgs,
  participantId: string,
  groupId: string,
) =>
  callFunction<{ ok: boolean; composition?: string; already_matched?: boolean }>(
    'addLateParticipant',
    { ...args, participant_id: participantId, group_id: groupId },
  )

// ── onCall functions (finalize + push) ────────────────────────────────────────
// These use the Firebase SDK's httpsCallable — onCall protocol differs from
// the plain HTTP POST pattern used by the onRequest functions above.

export type FinalizeResult = {
  ok: boolean
  scored: { Chris: number; Kelly: number; total: number }
}

export type PushResult = {
  ok: boolean
  total: number
  succeeded: number
  failed: Array<{ participant_id: string; reason: string }>
}

const _finalizeInstance = httpsCallable<
  { game_instance_id: string },
  FinalizeResult
>(functions, 'finalizeInstance')

const _pushResultsToClassroom = httpsCallable<
  { game_instance_id: string },
  PushResult
>(functions, 'pushResultsToClassroom')

/** Computes and writes z-scores for all participants in a game instance. */
export const finalizeInstance = (gameInstanceId: string): Promise<FinalizeResult> =>
  _finalizeInstance({ game_instance_id: gameInstanceId }).then((r) => r.data)

/** Pushes finalized scores from Firestore to the classroom gradebook. */
export const pushResultsToClassroom = (gameInstanceId: string): Promise<PushResult> =>
  _pushResultsToClassroom({ game_instance_id: gameInstanceId }).then((r) => r.data)
