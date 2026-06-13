/**
 * Pure guard: checks that all groups in a game instance have status 'completed'
 * before the instructor may finalize and push results.
 *
 * Kept as a plain TypeScript module (no Firebase/React deps) so it can be
 * compiled and tested with the functions build. The dashboard inlines the
 * same algorithm, typed against its local GroupStatusResult.
 */

export type GroupForGuard = { status: string }

export type GuardResult =
  | { blocked: false }
  | { blocked: true; message: string }

export function checkAllGroupsComplete(groups: GroupForGuard[]): GuardResult {
  const incomplete: Array<{ number: number; status: string }> = []
  for (let i = 0; i < groups.length; i++) {
    if (groups[i].status !== 'completed') {
      incomplete.push({ number: i + 1, status: groups[i].status })
    }
  }
  if (incomplete.length === 0) return { blocked: false }
  const count = incomplete.length
  const listing = incomplete
    .map(({ number, status }) => `Group ${number} (${status})`)
    .join(', ')
  return {
    blocked: true,
    message: `${count} group${count !== 1 ? 's' : ''} still in progress: ${listing}.`,
  }
}
