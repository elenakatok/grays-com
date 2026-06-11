/**
 * Tests for computeZScores.
 *
 * Uses Node's built-in test runner (no extra dependencies).
 * Run: npm run build && node lib/finalize.test.js
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { computeZScores, GameConfig, ParticipantRecord } from './finalize'

const CONFIG: GameConfig = {
  reservation_price_chris: 25_000,
  reservation_price_kelly: 475_000,
}

function makeChris(
  id: string,
  status: 'completed' | 'no_show',
  finalPrice: number | null,
): ParticipantRecord {
  return {
    participant_id: id,
    role: 'Chris',
    status,
    agreement_reached: finalPrice !== null,
    final_price: finalPrice,
    knowledge_check_score: 1.0,
    details: {},
  }
}

function makeKelly(
  id: string,
  status: 'completed' | 'no_show',
  finalPrice: number | null,
): ParticipantRecord {
  return {
    participant_id: id,
    role: 'Kelly',
    status,
    agreement_reached: finalPrice !== null,
    final_price: finalPrice,
    knowledge_check_score: 1.0,
    details: {},
  }
}

// ── helpers ───────────────────────────────────────────────────────────────────

function byId(results: ReturnType<typeof computeZScores>, id: string) {
  const r = results.find((x) => x.participant_id === id)
  assert.ok(r, `participant ${id} missing from results`)
  return r!
}

function approx(actual: number, expected: number, tol = 1e-9) {
  assert.ok(
    Math.abs(actual - expected) <= tol,
    `expected ≈${expected}, got ${actual}`,
  )
}

// ── tests ─────────────────────────────────────────────────────────────────────

test('reads reservation prices from config, not constants', () => {
  const customConfig: GameConfig = {
    reservation_price_chris: 10_000,
    reservation_price_kelly: 400_000,
  }
  // Chris agrees at 110,000 → surplus = 110,000 - 10,000 = 100,000
  const result = computeZScores(
    [makeChris('c1', 'completed', 110_000)],
    customConfig,
  )
  assert.equal(byId(result, 'c1').raw_score, 100_000)
})

test('chris agreement: raw_score = final_price - reservation_price_chris', () => {
  // 287,500 - 25,000 = 262,500
  const results = computeZScores([makeChris('c1', 'completed', 287_500)], CONFIG)
  assert.equal(byId(results, 'c1').raw_score, 262_500)
})

test('kelly agreement: raw_score = reservation_price_kelly - final_price', () => {
  // 475,000 - 287,500 = 187,500
  const results = computeZScores([makeKelly('k1', 'completed', 287_500)], CONFIG)
  assert.equal(byId(results, 'k1').raw_score, 187_500)
})

test('walk-away: raw_score = 0', () => {
  const results = computeZScores(
    [makeChris('c1', 'completed', null), makeKelly('k1', 'completed', null)],
    CONFIG,
  )
  assert.equal(byId(results, 'c1').raw_score, 0)
  assert.equal(byId(results, 'k1').raw_score, 0)
})

test('no_show receives normalized_score = -2 and does not affect the distribution', () => {
  // c2 (no_show) must appear in output with score -2.
  // Its presence must not shift c1's z-score (excluded from pool).
  const withNoShow = computeZScores(
    [makeChris('c1', 'completed', 300_000), makeChris('c2', 'no_show', 400_000)],
    CONFIG,
  )
  const withoutNoShow = computeZScores(
    [makeChris('c1', 'completed', 300_000)],
    CONFIG,
  )
  assert.equal(byId(withNoShow, 'c2').normalized_score, -2, 'no_show must receive -2')
  assert.equal(byId(withNoShow, 'c2').raw_score, null, 'no_show raw_score must be null')
  // c1's z-score is identical whether or not a no_show is present
  assert.equal(byId(withNoShow, 'c1').normalized_score, byId(withoutNoShow, 'c1').normalized_score)
})

test('walk-away IS in the pool and pulls normalized_score toward mean', () => {
  // Two Chrises: one deal at 300,000 (surplus 275,000), one walk-away (surplus 0)
  // mean = 137,500; stddev = 137,500; z-scores: deal = +1, walk-away = -1
  const results = computeZScores(
    [makeChris('deal', 'completed', 300_000), makeChris('walk', 'completed', null)],
    CONFIG,
  )
  approx(byId(results, 'deal').normalized_score, 1)
  approx(byId(results, 'walk').normalized_score, -1)
})

test('z-scores are computed per role independently', () => {
  // Both roles have perfectly symmetric surpluses — z-scores should be ±1 within each role.
  const results = computeZScores(
    [
      makeChris('c1', 'completed', 125_000),  // surplus 100,000
      makeChris('c2', 'completed', 325_000),  // surplus 300,000
      makeKelly('k1', 'completed', 275_000),  // surplus 200,000
      makeKelly('k2', 'completed', 375_000),  // surplus 100,000
    ],
    CONFIG,
  )
  // Chris: mean=200,000, stddev=100,000 → c1=-1, c2=+1
  approx(byId(results, 'c1').normalized_score, -1)
  approx(byId(results, 'c2').normalized_score, 1)
  // Kelly: mean=150,000, stddev=50,000 → k1=+1, k2=-1
  approx(byId(results, 'k1').normalized_score, 1)
  approx(byId(results, 'k2').normalized_score, -1)
})

test('stddev=0: normalized_score = 0 for all, no crash', () => {
  // Single participant → stddev is always 0
  const results = computeZScores([makeChris('c1', 'completed', 200_000)], CONFIG)
  assert.equal(byId(results, 'c1').normalized_score, 0)
})

test('stddev=0: all identical surpluses → normalized_score = 0 for all', () => {
  const results = computeZScores(
    [
      makeChris('c1', 'completed', 200_000),
      makeChris('c2', 'completed', 200_000),
      makeChris('c3', 'completed', 200_000),
    ],
    CONFIG,
  )
  assert.equal(byId(results, 'c1').normalized_score, 0)
  assert.equal(byId(results, 'c2').normalized_score, 0)
  assert.equal(byId(results, 'c3').normalized_score, 0)
})

test('knowledge_check_score is passed through unchanged', () => {
  const p = makeChris('c1', 'completed', 200_000)
  p.knowledge_check_score = 0.0
  const results = computeZScores([p], CONFIG)
  assert.equal(byId(results, 'c1').knowledge_check_score, 0.0)
})

test('empty input returns empty output', () => {
  const results = computeZScores([], CONFIG)
  assert.deepEqual(results, [])
})

test('all no_shows: each receives -2, output length equals input length', () => {
  const results = computeZScores(
    [makeChris('c1', 'no_show', null), makeKelly('k1', 'no_show', null)],
    CONFIG,
  )
  assert.equal(results.length, 2)
  assert.equal(byId(results, 'c1').normalized_score, -2)
  assert.equal(byId(results, 'k1').normalized_score, -2)
})

// ── end-to-end sanity check ───────────────────────────────────────────────────
//
// 4 Chris + 4 Kelly, one walk-away per role.
// Config: reservation_price_chris = $25,000 / reservation_price_kelly = $475,000
//
// Chris surpluses:  100k  200k  300k  0      mean=150k  stddev≈111,803.40
// Kelly surpluses:  400k  300k  100k  0      mean=200k  stddev≈158,113.88
//
// Expected z-scores (population stddev):
//   C1  -0.4472    C2  +0.4472    C3  +1.3416    C4  -1.3416
//   K1  +1.2649    K2  +0.6325    K3  -0.6325    K4  -1.2649

test('end-to-end: 4C + 4K, one walk-away per role', () => {
  const participants = [
    makeChris('C1', 'completed', 125_000),
    makeChris('C2', 'completed', 225_000),
    makeChris('C3', 'completed', 325_000),
    makeChris('C4', 'completed', null),       // walk-away
    makeKelly('K1', 'completed',  75_000),
    makeKelly('K2', 'completed', 175_000),
    makeKelly('K3', 'completed', 375_000),
    makeKelly('K4', 'completed', null),       // walk-away
  ]

  const results = computeZScores(participants, CONFIG)

  // ── print table ────────────────────────────────────────────────────────────
  const fmt = (n: number | null, prefix = '$') =>
    n === null ? 'walk-away'.padStart(12) : `${prefix}${n.toLocaleString()}`.padStart(12)
  const fmtZ = (z: number) => z.toFixed(4).padStart(10)

  console.log('\n── end-to-end: 4C + 4K, one walk-away per role ──────────────────')
  console.log(`  Config: reservation_price_chris = $25,000  /  reservation_price_kelly = $475,000`)
  console.log()
  console.log(`  ${'Role'.padEnd(6)}  ${'ID'.padEnd(3)}  ${'Final Price'.padStart(12)}  ${'Surplus'.padStart(12)}  ${'Norm. Score'.padStart(10)}`)
  console.log(`  ${'─'.repeat(6)}  ${'─'.repeat(3)}  ${'─'.repeat(12)}  ${'─'.repeat(12)}  ${'─'.repeat(10)}`)

  for (const r of results) {
    const p = participants.find((x) => x.participant_id === r.participant_id)!
    console.log(
      `  ${r.role.padEnd(6)}  ${r.participant_id.padEnd(3)}` +
      `  ${fmt(p.final_price)}` +
      `  ${fmt(r.raw_score)}` +
      `  ${fmtZ(r.normalized_score)}`,
    )
  }
  console.log()

  // ── assertions ─────────────────────────────────────────────────────────────
  // Surplus = final_price - 25,000  (Chris) or  475,000 - final_price  (Kelly)
  assert.equal(byId(results, 'C1').raw_score,  100_000)
  assert.equal(byId(results, 'C2').raw_score,  200_000)
  assert.equal(byId(results, 'C3').raw_score,  300_000)
  assert.equal(byId(results, 'C4').raw_score,        0)
  assert.equal(byId(results, 'K1').raw_score,  400_000)
  assert.equal(byId(results, 'K2').raw_score,  300_000)
  assert.equal(byId(results, 'K3').raw_score,  100_000)
  assert.equal(byId(results, 'K4').raw_score,        0)

  // z-scores sum to 0 within each role
  const chrisZ = ['C1','C2','C3','C4'].map((id) => byId(results, id).normalized_score)
  const kellyZ = ['K1','K2','K3','K4'].map((id) => byId(results, id).normalized_score)
  approx(chrisZ.reduce((a, b) => a + b, 0), 0)
  approx(kellyZ.reduce((a, b) => a + b, 0), 0)

  // Ordering preserved within each role (higher surplus → higher z-score)
  assert.ok(chrisZ[2] > chrisZ[1] && chrisZ[1] > chrisZ[0] && chrisZ[0] > chrisZ[3])
  assert.ok(kellyZ[0] > kellyZ[1] && kellyZ[1] > kellyZ[2] && kellyZ[2] > kellyZ[3])

  // Spot-check z-score magnitudes
  approx(byId(results, 'C1').normalized_score, -1 / Math.sqrt(5))
  approx(byId(results, 'C2').normalized_score,  1 / Math.sqrt(5))
  approx(byId(results, 'C3').normalized_score,  3 / Math.sqrt(5))
  approx(byId(results, 'C4').normalized_score, -3 / Math.sqrt(5))

  // stddev = √25,000,000,000 = 50,000√10
  // deviations: +200k +100k -100k -200k  →  z = ±4/√10, ±2/√10
  approx(byId(results, 'K1').normalized_score,  4 / Math.sqrt(10))
  approx(byId(results, 'K2').normalized_score,  2 / Math.sqrt(10))
  approx(byId(results, 'K3').normalized_score, -2 / Math.sqrt(10))
  approx(byId(results, 'K4').normalized_score, -4 / Math.sqrt(10))
})
