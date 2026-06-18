import * as admin from 'firebase-admin'
import { onCall, HttpsError } from 'firebase-functions/v2/https'
import { reportResult } from './engine/reportResult'
import type { GameResult } from './engine/reportResult'

export type FailedPush = { participant_id: string; reason: string }

export type PushSummary = {
  total: number
  succeeded: number
  failed: FailedPush[]
}

type ReportFn = (result: GameResult, callbackUrl: string, callbackSecret: string) => Promise<void>

function isRetryable(err: unknown): boolean {
  if (!(err instanceof Error)) return true
  const match = /HTTP (\d+)/.exec(err.message)
  if (!match) return true // network / timeout — transient
  return parseInt(match[1], 10) >= 500
}

async function pushWithRetry(
  result: GameResult,
  callbackUrl: string,
  callbackSecret: string,
  reportFn: ReportFn,
  retryDelays: readonly number[],
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const maxAttempts = retryDelays.length + 1
  let lastErr: unknown
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, retryDelays[attempt - 1]))
    }
    try {
      await reportFn(result, callbackUrl, callbackSecret)
      return { ok: true }
    } catch (err) {
      if (!isRetryable(err)) {
        return { ok: false, reason: err instanceof Error ? err.message : String(err) }
      }
      lastErr = err
    }
  }
  return {
    ok: false,
    reason: lastErr instanceof Error ? lastErr.message : String(lastErr),
  }
}

/**
 * Pushes finalized participant results to the classroom, one at a time.
 * A failure for one participant does not stop the others.
 * Retries on transient failures (network errors, HTTP 5xx); fails fast on HTTP 4xx.
 *
 * Exported for testing — the Cloud Function calls this with the real reportResult.
 * Pass retryDelays=[0,0] in tests to skip backoff waits.
 */
export async function dispatchResults(
  records: GameResult[],
  callbackUrl: string,
  callbackSecret: string,
  reportFn: ReportFn = reportResult,
  retryDelays: readonly number[] = [500, 1000],
): Promise<PushSummary> {
  let succeeded = 0
  const failed: FailedPush[] = []

  for (const record of records) {
    const outcome = await pushWithRetry(record, callbackUrl, callbackSecret, reportFn, retryDelays)
    if (outcome.ok) {
      succeeded++
    } else {
      failed.push({ participant_id: record.participant_id, reason: outcome.reason })
    }
  }

  return { total: records.length, succeeded, failed }
}

/**
 * Reads all finalized participant records for a game instance from Firestore
 * and POSTs each to the classroom callback URL via reportResult().
 * Pure transport — scores are sent as stored, no recomputation.
 *
 * Input:  { game_instance_id: string }
 * Output: { ok: true, total, succeeded, failed: [{ participant_id, reason }] }
 */
export const pushResultsToClassroom = onCall(
  { invoker: 'public' },
  async (request) => {
    const data = request.data as { game_instance_id?: unknown }
    const gameInstanceId = data.game_instance_id
    if (typeof gameInstanceId !== 'string' || gameInstanceId === '') {
      throw new HttpsError('invalid-argument', 'game_instance_id is required')
    }

    const callbackUrl = process.env.CLASSROOM_CALLBACK_URL ?? ''
    const callbackSecret = process.env.CLASSROOM_CALLBACK_SECRET ?? ''

    const db = admin.firestore()
    const snap = await db
      .collection('game_instances')
      .doc(gameInstanceId)
      .collection('participants')
      .get()

    const records: GameResult[] = []
    for (const doc of snap.docs) {
      const d = doc.data()
      // Only push participants the finalize step has already written
      if (d.finalized_at == null) continue
      if (d.role !== 'Chris' && d.role !== 'Kelly') continue

      // Derive status from stored data: finalize sets raw_score=null for no_show
      const status: GameResult['status'] = d.raw_score != null ? 'completed' : 'no_show'
      records.push({
        game_instance_id: gameInstanceId,
        participant_id: doc.id,
        status,
        role: d.role as string,
        normalized_score: (d.normalized_score ?? null) as number | null,
        knowledge_check_score: (d.knowledge_check_score ?? null) as number | null,
        details: (d.details ?? {}) as Record<string, unknown>,
      })
    }

    const summary = await dispatchResults(records, callbackUrl, callbackSecret)
    return { ok: true, ...summary }
  },
)
