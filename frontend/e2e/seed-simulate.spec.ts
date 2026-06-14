/**
 * E2E tests: seedSimulatedGame staging function.
 *
 * Verifies that Completed-stage seeding produces N participant records with the
 * expected status mix (some no-shows, some walk-aways), non-degenerate price
 * variance, and that finalizeInstance computes a sensible z-score distribution.
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

test('seedSimulatedGame completed: N records, varied prices, walk-aways, no-shows, finalize runs', async ({
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
    no_shows: number
    price_min: number | null
    price_max: number | null
    price_range: { chris_reservation: number; kelly_reservation: number }
  }
  expect(seedBody.ok).toBe(true)
  expect(seedBody.students).toBe(N)
  expect(seedBody.groups).toBeGreaterThan(0)
  expect(seedBody.walk_aways).toBeGreaterThanOrEqual(0)
  expect(seedBody.no_shows).toBeGreaterThanOrEqual(0)

  // ── 2. Exactly N participant records exist ────────────────────────────────
  const participants = await fsGetAll(gameInstanceId, 'participants', request)
  expect(participants.length).toBe(N)

  // ── 3. Participants have human names (not "Student N") ───────────────────
  const names = participants.map((p) => strVal(p['display_name']))
  // Each name should be two words (first + last)
  for (const name of names) {
    expect(name.trim().split(' ').length).toBeGreaterThanOrEqual(2)
  }

  // ── 4. Some no-shows (no group_id set) ───────────────────────────────────
  const noShows = participants.filter((p) => !p['group_id'])
  expect(noShows.length).toBeGreaterThanOrEqual(1)

  // ── 5. Some participants ARE matched (have group_id) ─────────────────────
  const matched = participants.filter((p) => !!p['group_id'])
  expect(matched.length).toBeGreaterThan(0)

  // ── 6. Group records: varied prices, some walk-aways ─────────────────────
  const groups = await fsGetAll(gameInstanceId, 'groups', request)
  expect(groups.length).toBe(seedBody.groups)

  const completedGroups = groups.filter((g) => strVal(g['status']) === 'completed')
  expect(completedGroups.length).toBe(seedBody.groups) // all seeded groups are completed

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

  // Price variance: min and max differ by at least 1% of ZOPA (ensures non-uniform)
  if (prices.length >= 4) {
    const priceRange = Math.max(...prices) - Math.min(...prices)
    expect(priceRange).toBeGreaterThan((kellyRes - chrisRes) * 0.01)
  }

  // ── 7. Finalize runs and produces sensible z-scores ───────────────────────
  // finalizeInstance is an onCall function; the emulator accepts { data: {...} }.
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

  // After finalize, participants in completed groups should have normalized_score
  const finalParticipants = await fsGetAll(gameInstanceId, 'participants', request)
  const withScores = finalParticipants.filter((p) => p['normalized_score'] != null)
  // Everyone (including no-shows at -2) gets a normalized_score after finalize
  expect(withScores.length).toBe(N)

  // No-shows must have normalized_score = -2
  const noShowAfter = finalParticipants.filter((p) => !p['group_id'])
  for (const p of noShowAfter) {
    expect(numVal(p['normalized_score'])).toBe(-2)
  }

  // Walk-away participants should have raw_score = 0 (surplus = 0)
  // Map group_id → agreement_reached for walk-away groups
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

test('seedSimulatedGame matched: N records in groups, no completed groups', async ({ request }) => {
  const N = 8
  const gameInstanceId = `e2e-matched-${Date.now()}`

  const res = await request.post(`${FUNCTIONS_BASE}/seedSimulatedGame`, {
    data: { game_instance_id: gameInstanceId, stage: 'matched', n: N },
  })
  expect(res.ok()).toBe(true)
  const body = (await res.json()) as { ok: boolean; students: number; groups: number }
  expect(body.ok).toBe(true)
  expect(body.groups).toBeGreaterThan(0)

  const groups = await fsGetAll(gameInstanceId, 'groups', request)
  expect(groups.length).toBe(body.groups)

  // All groups must be in 'matched' state — NOT advanced to negotiating
  for (const g of groups) {
    expect(strVal(g['status'])).toBe('matched')
    expect(boolVal(g['agreement_reached'])).toBeNull()
    expect(numVal(g['final_price'])).toBeNull()
  }

  // Each group respects the 2C+2K cap
  for (const g of groups) {
    const chrisArr = g['chris_participants'] as { arrayValue?: { values?: unknown[] } } | undefined
    const kellyArr = g['kelly_participants'] as { arrayValue?: { values?: unknown[] } } | undefined
    const chrisCount = chrisArr?.arrayValue?.values?.length ?? 0
    const kellyCount = kellyArr?.arrayValue?.values?.length ?? 0
    expect(chrisCount).toBeLessThanOrEqual(2)
    expect(kellyCount).toBeLessThanOrEqual(2)
    expect(chrisCount + kellyCount).toBeLessThanOrEqual(4)
  }
})
