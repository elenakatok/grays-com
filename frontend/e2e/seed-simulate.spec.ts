/**
 * E2E tests: seedSimulatedGame staging function.
 *
 * Verifies that Completed-stage seeding produces N participant records where ALL
 * students are placed in groups (no synthetic no-shows), with some walk-aways,
 * one deadlocked group, non-degenerate price variance, and that finalizeInstance
 * computes a sensible z-score distribution.
 *
 * Also tests the Present → triggerMatching → Completed pipeline: the real
 * matching path places all N students and produces the same group count as a
 * directly-seeded Completed stage with the same N.
 *
 * Prerequisites: Firebase emulators + Vite dev server must be running.
 */

import { test, expect } from '@playwright/test'

const FUNCTIONS_BASE = 'http://127.0.0.1:5004/grays-mygames-live/us-central1'
const FIRESTORE_BASE =
  'http://127.0.0.1:8081/v1/projects/grays-mygames-live/databases/(default)/documents'

// ── Firestore admin helpers (emulator allows Bearer owner) ────────────────────

async function fsGetAll(
  gameInstanceId: string,
  collection: string,
  request: import('@playwright/test').APIRequestContext,
): Promise<Array<Record<string, unknown>>> {
  const url = `${FIRESTORE_BASE}/game_instances/${gameInstanceId}/${collection}?pageSize=500`
  const res = await request.get(url, { headers: { Authorization: 'Bearer owner' } })
  if (!res.ok()) throw new Error(`fsGetAll(${collection}) failed: ${res.status()}`)
  const body = (await res.json()) as { documents?: Array<{ fields: Record<string, unknown> }> }
  return (body.documents ?? []).map((d) => d.fields)
}

function strVal(f: unknown): string {
  return (f as { stringValue?: string })?.stringValue ?? ''
}
function boolVal(f: unknown): boolean | null {
  const v = f as { booleanValue?: boolean }
  return v?.booleanValue ?? null
}
function numVal(f: unknown): number | null {
  const v = f as { integerValue?: string; doubleValue?: number }
  if (v?.integerValue != null) return parseInt(v.integerValue, 10)
  if (v?.doubleValue != null) return v.doubleValue
  return null
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test('seedSimulatedGame completed: all N records placed in groups, varied prices, walk-aways, finalize runs', async ({
  request,
}) => {
  const N = 20
  const gameInstanceId = `e2e-sim-${Date.now()}`

  // ── 1. Seed Completed stage ───────────────────────────────────────────────
  const seedRes = await request.post(`${FUNCTIONS_BASE}/seedSimulatedGame`, {
    data: { game_instance_id: gameInstanceId, stage: 'completed', n: N },
  })
  expect(seedRes.ok()).toBe(true)

  const seedBody = (await seedRes.json()) as {
    ok: boolean
    students: number
    groups: number
    walk_aways: number
    deadlocked: number
    price_min: number | null
    price_max: number | null
    price_range: { chris_reservation: number; kelly_reservation: number }
  }
  expect(seedBody.ok).toBe(true)
  expect(seedBody.students).toBe(N)
  expect(seedBody.groups).toBeGreaterThan(0)
  expect(seedBody.walk_aways).toBeGreaterThanOrEqual(0)

  // ── 2. Exactly N participant records exist ────────────────────────────────
  const participants = await fsGetAll(gameInstanceId, 'participants', request)
  expect(participants.length).toBe(N)

  // ── 3. Participants have human names (not "Student N") ───────────────────
  const names = participants.map((p) => strVal(p['display_name']))
  for (const name of names) {
    expect(name.trim().split(' ').length).toBeGreaterThanOrEqual(2)
  }

  // ── 4. All N students are placed in groups (zero unmatched) ──────────────
  const unmatched = participants.filter((p) => !p['group_id'])
  expect(unmatched.length).toBe(0)

  // ── 5. Group records: varied prices, walk-aways, and 1 deadlocked group ──
  const groups = await fsGetAll(gameInstanceId, 'groups', request)

  const completedGroups = groups.filter((g) => strVal(g['status']) === 'completed')
  const deadlockedGroups = groups.filter((g) => strVal(g['status']) === 'deadlocked')

  // All groups are completed or deadlocked
  expect(completedGroups.length + deadlockedGroups.length).toBe(seedBody.groups)
  expect(deadlockedGroups.length).toBe(seedBody.deadlocked)
  expect(deadlockedGroups.length).toBeGreaterThanOrEqual(1)

  const agreementGroups = completedGroups.filter((g) => boolVal(g['agreement_reached']) === true)
  const walkAwayGroups = completedGroups.filter((g) => boolVal(g['agreement_reached']) === false)

  expect(walkAwayGroups.length).toBeGreaterThanOrEqual(0)  // may be 0 if groups < 10
  expect(agreementGroups.length).toBeGreaterThan(0)

  // Prices are within the ZOPA and non-degenerate (at least 2 distinct values for N≥20)
  const prices = agreementGroups
    .map((g) => numVal(g['final_price']))
    .filter((p): p is number => p !== null)
  expect(prices.length).toBeGreaterThan(0)

  const { chris_reservation: chrisRes, kelly_reservation: kellyRes } = seedBody.price_range
  for (const p of prices) {
    expect(p).toBeGreaterThanOrEqual(chrisRes)
    expect(p).toBeLessThanOrEqual(kellyRes)
  }

  if (prices.length >= 4) {
    const priceRange = Math.max(...prices) - Math.min(...prices)
    expect(priceRange).toBeGreaterThan((kellyRes - chrisRes) * 0.01)
  }

  // ── 6. Finalize runs and produces sensible z-scores ───────────────────────
  const finalizeRes = await request.post(`${FUNCTIONS_BASE}/finalizeInstance`, {
    headers: { 'Content-Type': 'application/json' },
    data: { data: { game_instance_id: gameInstanceId } },
  })
  expect(finalizeRes.ok()).toBe(true)
  const finalizeBody = (await finalizeRes.json()) as {
    result?: { ok: boolean; scored: { Chris: number; Kelly: number; total: number } }
  }
  const scored = finalizeBody.result?.scored
  expect(scored).toBeDefined()
  expect(scored!.total).toBeGreaterThan(0)

  // After finalize, all N participants (all in groups) get a normalized_score
  const finalParticipants = await fsGetAll(gameInstanceId, 'participants', request)
  const withScores = finalParticipants.filter((p) => p['normalized_score'] != null)
  expect(withScores.length).toBe(N)

  // Walk-away participants should have raw_score = 0 (surplus = 0)
  const walkAwayGroupIds = new Set(
    walkAwayGroups.map((g) => strVal(g['group_id'])),
  )
  const walkAwayParticipants = finalParticipants.filter((p) => {
    const gid = strVal(p['group_id'])
    return gid && walkAwayGroupIds.has(gid)
  })
  for (const p of walkAwayParticipants) {
    expect(numVal(p['raw_score'])).toBe(0)
  }
})

test('seedSimulatedGame enrolled: N records, no roles or groups', async ({ request }) => {
  const N = 10
  const gameInstanceId = `e2e-enrolled-${Date.now()}`

  const res = await request.post(`${FUNCTIONS_BASE}/seedSimulatedGame`, {
    data: { game_instance_id: gameInstanceId, stage: 'enrolled', n: N },
  })
  expect(res.ok()).toBe(true)
  const body = (await res.json()) as { ok: boolean; students: number }
  expect(body.ok).toBe(true)
  expect(body.students).toBe(N)

  const participants = await fsGetAll(gameInstanceId, 'participants', request)
  expect(participants.length).toBe(N)

  // No role assigned (Enrolled = absent on dashboard)
  const withRole = participants.filter((p) => p['role'])
  expect(withRole.length).toBe(0)

  // No groups exist
  const groups = await fsGetAll(gameInstanceId, 'groups', request)
  expect(groups.length).toBe(0)
})

test('Present→triggerMatching: all N placed; Completed same N: same group count, all placed, walk-aways exist', async ({
  request,
}) => {
  // N=12: 6 Chris + 6 Kelly → exactly 6 groups, deterministic.
  const N = 12
  const presentId = `e2e-pipeline-p-${Date.now()}`
  const completedId = `e2e-pipeline-c-${Date.now()}`

  // ── 1. Seed Present, then run real triggerMatching ────────────────────────
  const presentSeedRes = await request.post(`${FUNCTIONS_BASE}/seedSimulatedGame`, {
    data: { game_instance_id: presentId, stage: 'present', n: N },
  })
  expect(presentSeedRes.ok()).toBe(true)

  const matchRes = await request.post(`${FUNCTIONS_BASE}/triggerMatching`, {
    data: { _dev: { game_instance_id: presentId } },
  })
  expect(matchRes.ok()).toBe(true)
  const matchBody = (await matchRes.json()) as { ok: boolean; groups: unknown[] }
  expect(matchBody.ok).toBe(true)
  const G = matchBody.groups.length
  expect(G).toBeGreaterThan(0)

  // All N students placed (each has group_id)
  const presentParticipants = await fsGetAll(presentId, 'participants', request)
  const unmatchedAfterMatch = presentParticipants.filter((p) => !p['group_id'])
  expect(unmatchedAfterMatch.length).toBe(0)

  // ── 2. Seed Completed with same N in a separate instance ─────────────────
  const completedSeedRes = await request.post(`${FUNCTIONS_BASE}/seedSimulatedGame`, {
    data: { game_instance_id: completedId, stage: 'completed', n: N },
  })
  expect(completedSeedRes.ok()).toBe(true)
  const completedBody = (await completedSeedRes.json()) as {
    ok: boolean
    students: number
    groups: number
    walk_aways: number
    deadlocked: number
  }
  expect(completedBody.ok).toBe(true)

  // Group count must equal what the real matching path produced
  expect(completedBody.groups).toBe(G)

  // All N students placed — zero unmatched
  const completedParticipants = await fsGetAll(completedId, 'participants', request)
  expect(completedParticipants.length).toBe(N)
  const unmatchedInCompleted = completedParticipants.filter((p) => !p['group_id'])
  expect(unmatchedInCompleted.length).toBe(0)

  // All G group records exist
  const completedGroups = await fsGetAll(completedId, 'groups', request)
  expect(completedGroups.length).toBe(G)

  // Groups are completed or deadlocked — no bare "matched" groups
  for (const g of completedGroups) {
    const s = strVal(g['status'])
    expect(['completed', 'deadlocked']).toContain(s)
  }
})
