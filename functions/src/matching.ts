/**
 * Grays.com matching algorithm.
 *
 * Standard group: 1 Chris + 1 Kelly.
 * Cap: max 2 Chris + 2 Kelly per group (four students total).
 * Remainder rule: extra players in the larger role are distributed into existing
 * C+K groups (up to 2 of that role per group) rather than left out or paired
 * same-role. A group is only opened to extras once all groups already hold 2 of
 * that role.
 *
 * Examples:
 *   17C + 15K → 13 groups of 1C+1K, plus 2 groups of 2C+1K
 *   14C + 16K → 12 groups of 1C+1K, plus 2 groups of 1C+2K
 *    7C +  3K →  1 group  of 2C+1K, plus 2 groups of 2C+1K  (c7 unmatched — no Kelly slot)
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

  // Distribute extras round-robin, skipping groups already at the per-role cap.
  distributeExtras(chrises.slice(pairCount), groups, 'chris_participants')
  distributeExtras(kellys.slice(pairCount), groups, 'kelly_participants')

  return groups
}

/**
 * Distributes ids into groups in round-robin order, respecting a per-role cap
 * of 2. Stops early if all groups are at the cap — remaining ids are left
 * unmatched (they appear in getUnmatchedParticipants for the instructor).
 */
function distributeExtras(
  ids: string[],
  groups: MatchGroup[],
  key: 'chris_participants' | 'kelly_participants',
): void {
  let cursor = 0
  for (const id of ids) {
    let placed = false
    for (let attempt = 0; attempt < groups.length; attempt++) {
      const g = groups[(cursor + attempt) % groups.length]
      if (g[key].length < 2) {
        g[key].push(id)
        cursor = (cursor + attempt + 1) % groups.length
        placed = true
        break
      }
    }
    if (!placed) break  // All groups at role cap; remaining extras cannot be placed
  }
}

function shuffle<T>(arr: T[]): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[arr[i], arr[j]] = [arr[j], arr[i]]
  }
}
