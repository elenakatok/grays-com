/**
 * Finalization: compute per-role z-scores across all completed participants
 * and push updated GameResult records to the classroom.
 *
 * Called when the instructor clicks "Finalize Results" in the dashboard.
 *
 * Formula (per game spec Section 4 / Appendix B):
 *   chris_surplus = final_price - CHRIS_RESERVATION  (15000)
 *   kelly_surplus = KELLY_RESERVATION - final_price  (550000)
 *   normalized_score = (surplus - role_mean) / role_stddev
 *
 * Walk-aways: raw_score = 0, included in normalization by default.
 */

const CHRIS_RESERVATION = 15_000
const KELLY_RESERVATION = 550_000

export type CompletedParticipant = {
  participant_id: string
  role: 'Chris' | 'Kelly'
  agreement_reached: boolean
  final_price: number | null
  knowledge_check_score: number | null
  details: Record<string, unknown>
}

export type FinalizedResult = {
  participant_id: string
  role: 'Chris' | 'Kelly'
  raw_score: number
  normalized_score: number
  knowledge_check_score: number | null
}

export function computeZScores(participants: CompletedParticipant[]): FinalizedResult[] {
  const surplusOf = (p: CompletedParticipant): number => {
    if (!p.agreement_reached || p.final_price === null) return 0
    return p.role === 'Chris'
      ? p.final_price - CHRIS_RESERVATION
      : KELLY_RESERVATION - p.final_price
  }

  const byRole = (role: 'Chris' | 'Kelly') => participants.filter((p) => p.role === role)

  function zScores(group: CompletedParticipant[]): Map<string, number> {
    const surpluses = group.map(surplusOf)
    const mean = surpluses.reduce((a, b) => a + b, 0) / (surpluses.length || 1)
    const variance =
      surpluses.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / (surpluses.length || 1)
    const stddev = Math.sqrt(variance) || 1

    return new Map(group.map((p, i) => [p.participant_id, (surpluses[i] - mean) / stddev]))
  }

  const chrisZ = zScores(byRole('Chris'))
  const kellyZ = zScores(byRole('Kelly'))

  return participants.map((p) => ({
    participant_id: p.participant_id,
    role: p.role,
    raw_score: surplusOf(p),
    normalized_score: (p.role === 'Chris' ? chrisZ : kellyZ).get(p.participant_id) ?? 0,
    knowledge_check_score: p.knowledge_check_score,
  }))
}
