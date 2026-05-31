/**
 * Grays.com matching algorithm.
 *
 * Standard group: 1 Chris + 1 Kelly.
 * Remainder rule: extra players in the larger role are distributed among
 * existing C+K groups rather than left out or paired together.
 *
 * Examples:
 *   17C + 15K → 13 groups of 1C+1K, plus 2 groups of 2C+1K
 *   14C + 16K → 12 groups of 1C+1K, plus 2 groups of 1C+2K
 */

export type MatchParticipant = {
  participant_id: string
  role: 'Chris' | 'Kelly'
}

export type MatchGroup = {
  chris_participants: string[]
  kelly_participants: string[]
  lead_participant_id: string
}

export function matchParticipants(eligible: MatchParticipant[]): MatchGroup[] {
  const chrises = eligible
    .filter((p) => p.role === 'Chris')
    .map((p) => p.participant_id)
  const kellys = eligible
    .filter((p) => p.role === 'Kelly')
    .map((p) => p.participant_id)

  shuffle(chrises)
  shuffle(kellys)

  const pairCount = Math.min(chrises.length, kellys.length)
  const groups: MatchGroup[] = []

  for (let i = 0; i < pairCount; i++) {
    const leadId = chrises[i]
    groups.push({
      chris_participants: [leadId],
      kelly_participants: [kellys[i]],
      lead_participant_id: leadId,
    })
  }

  // Distribute extras into existing groups
  const extraChrises = chrises.slice(pairCount)
  const extraKellys = kellys.slice(pairCount)

  extraChrises.forEach((id, i) => {
    groups[i % groups.length].chris_participants.push(id)
  })

  extraKellys.forEach((id, i) => {
    groups[i % groups.length].kelly_participants.push(id)
  })

  return groups
}

function shuffle<T>(arr: T[]): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[arr[i], arr[j]] = [arr[j], arr[i]]
  }
}
