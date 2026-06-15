/**
 * Finalization: compute per-role z-scores across all completed participants.
 *
 * Pure function — no Firestore or Cloud Function wiring here.
 * The Cloud Function wrapper (finalizeInstance in index.ts) reads records from
 * Firestore, calls computeZScores, then writes results back and calls the
 * classroom callback.
 *
 * Formula (per game spec Appendix B):
 *   chris raw_score = final_price - config.reservation_price_chris
 *   kelly raw_score = config.reservation_price_kelly - final_price
 *   walk-away raw_score = 0
 *   normalized_score = (raw_score - role_mean) / role_stddev
 *
 * Reservation prices are read from GameConfig — never hardcoded.
 * no_show participants are excluded from the mean/stddev pool but receive
 * normalized_score = -2 as a visible floor, editable in the gradebook.
 */

export type GameConfig = {
  reservation_price_chris: number
  reservation_price_kelly: number
}

export type ParticipantRecord = {
  participant_id: string
  role: 'Chris' | 'Kelly'
  status: 'completed' | 'no_show' | 'late'
  agreement_reached: boolean
  final_price: number | null
  knowledge_check_score: number | null
  details: Record<string, unknown>
}

export type FinalizedResult = {
  participant_id: string
  role: 'Chris' | 'Kelly'
  raw_score: number | null
  normalized_score: number | null  // null for 'late'; -2 for no_show
  knowledge_check_score: number | null
}

export function computeZScores(
  participants: ParticipantRecord[],
  config: GameConfig,
): FinalizedResult[] {
  const { reservation_price_chris, reservation_price_kelly } = config

  // Only completed participants contribute to the mean/stddev pool.
  // no_show participants are excluded from the distribution; they receive
  // normalized_score = -2 (floor marker, below any real z-score).
  const pool = participants.filter((p) => p.status === 'completed')

  const surplusOf = (p: ParticipantRecord): number => {
    if (!p.agreement_reached || p.final_price === null) return 0
    return p.role === 'Chris'
      ? p.final_price - reservation_price_chris
      : reservation_price_kelly - p.final_price
  }

  function zScoresForRole(group: ParticipantRecord[]): Map<string, number> {
    if (group.length === 0) return new Map()

    const surpluses = group.map(surplusOf)
    const mean = surpluses.reduce((a, b) => a + b, 0) / surpluses.length
    const variance = surpluses.reduce((a, b) => a + (b - mean) ** 2, 0) / surpluses.length
    const stddev = Math.sqrt(variance)

    if (stddev === 0) {
      console.warn(
        `[finalize] stddev is 0 for ${group[0].role} pool ` +
        `(${group.length} participant(s), all surplus = ${surpluses[0]}). ` +
        `Setting normalized_score = 0 for all.`,
      )
      return new Map(group.map((p) => [p.participant_id, 0]))
    }

    return new Map(group.map((p, i) => [p.participant_id, (surpluses[i] - mean) / stddev]))
  }

  const chrisZ = zScoresForRole(pool.filter((p) => p.role === 'Chris'))
  const kellyZ = zScoresForRole(pool.filter((p) => p.role === 'Kelly'))

  return participants.map((p) => {
    if (p.status === 'no_show') {
      return {
        participant_id: p.participant_id,
        role: p.role,
        raw_score: null,
        normalized_score: -2,   // floor marker: absent, editable in gradebook
        knowledge_check_score: p.knowledge_check_score,
      }
    }
    if (p.status === 'late') {
      return {
        participant_id: p.participant_id,
        role: p.role,
        raw_score: null,
        normalized_score: null, // never negotiated → no surplus → not in distribution
        knowledge_check_score: p.knowledge_check_score,
      }
    }
    return {
      participant_id: p.participant_id,
      role: p.role,
      raw_score: surplusOf(p),
      normalized_score: (p.role === 'Chris' ? chrisZ : kellyZ).get(p.participant_id) ?? 0,
      knowledge_check_score: p.knowledge_check_score,
    }
  })
}
