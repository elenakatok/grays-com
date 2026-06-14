/**
 * Pure logic for the late-participant feature. No Firestore access here.
 *
 * A latecomer is a student who entered the attendance code but was not
 * present when "Match Now" ran. The instructor can add them to an existing
 * group that hasn't started negotiating yet.
 *
 * Eligibility rules for a target group:
 *   - status === 'matched'  (holding screen — negotiation has NOT started)
 *   - count of the latecomer's role after adding <= 2  (per-role cap)
 *   - total members after adding <= 4  (2C+2K overall cap)
 *
 * The status guard is the most regression-prone rule: any group whose status
 * is not exactly 'matched' (i.e. negotiating, reporting, deadlocked, completed)
 * is permanently closed to latecomers regardless of available slots.
 */

export type GroupSnapshot = {
  group_id: string
  status: string               // 'matched' | 'negotiating' | 'reporting' | 'deadlocked' | 'completed'
  chris_participants: string[]
  kelly_participants: string[]
}

export type LateGroupSuggestion = {
  group_id: string
  current_chris: number
  current_kelly: number
  result_composition: string   // e.g. '2C+1K'
} | null

/**
 * Returns every group that can legally accept one more participant of the
 * given role, sorted smallest-total first (fill smaller groups before larger).
 *
 * A group is eligible if and only if:
 *   1. status === 'matched'  (NOT negotiating/reporting/deadlocked/completed)
 *   2. fewer than 2 of the latecomer's role already in the group
 *   3. total members < 4  (adding one would not exceed 2C+2K)
 */
export function eligibleGroupsForRole(
  role: 'Chris' | 'Kelly',
  groups: GroupSnapshot[],
): GroupSnapshot[] {
  return groups
    .filter((g) => {
      if (g.status !== 'matched') return false
      const total = g.chris_participants.length + g.kelly_participants.length
      if (total >= 4) return false
      if (role === 'Chris' && g.chris_participants.length >= 2) return false
      if (role === 'Kelly' && g.kelly_participants.length >= 2) return false
      return true
    })
    .sort(
      (a, b) =>
        (a.chris_participants.length + a.kelly_participants.length) -
        (b.chris_participants.length + b.kelly_participants.length),
    )
}

/**
 * Returns the best group to add a latecomer of the given role to,
 * or null if no eligible group exists.
 */
export function suggestGroupForLatecomer(
  role: 'Chris' | 'Kelly',
  groups: GroupSnapshot[],
): LateGroupSuggestion {
  const eligible = eligibleGroupsForRole(role, groups)
  if (eligible.length === 0) return null
  const g = eligible[0]
  const newChris = g.chris_participants.length + (role === 'Chris' ? 1 : 0)
  const newKelly = g.kelly_participants.length + (role === 'Kelly' ? 1 : 0)
  return {
    group_id: g.group_id,
    current_chris: g.chris_participants.length,
    current_kelly: g.kelly_participants.length,
    result_composition: `${newChris}C+${newKelly}K`,
  }
}
