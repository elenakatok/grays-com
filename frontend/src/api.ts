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
  status: 'matched' | 'reporting' | 'completed' | 'deadlocked'
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

/** Lead reports price (number) or no-deal (null). */
export const submitLeadOutcome = (args: CallArgs, price: number | null) =>
  callFunction<{ ok: boolean }>('submitLeadOutcome', { ...args, price })

/** Non-lead confirms (true) or disagrees (false) with lead's report. */
export const submitConfirmation = (args: CallArgs, confirmed: boolean) =>
  callFunction<{ ok: boolean; outcome: string }>('submitConfirmation', { ...args, confirmed })

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
