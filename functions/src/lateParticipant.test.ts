/**
 * Tests for the late-participant pure logic.
 *
 * Run: npm run build && node lib/lateParticipant.test.js
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { eligibleGroupsForRole, suggestGroupForLatecomer } from './lateParticipant'
import type { GroupSnapshot } from './lateParticipant'

// ── helpers ───────────────────────────────────────────────────────────────────

function g(
  id: string,
  status: string,
  chris: number,
  kelly: number,
): GroupSnapshot {
  return {
    group_id: id,
    status,
    chris_participants: Array.from({ length: chris }, (_, i) => `c${id}-${i}`),
    kelly_participants: Array.from({ length: kelly }, (_, i) => `k${id}-${i}`),
  }
}

// ── eligibleGroupsForRole ─────────────────────────────────────────────────────

test('empty group list → no eligible groups for either role', () => {
  assert.deepEqual(eligibleGroupsForRole('Chris', []), [])
  assert.deepEqual(eligibleGroupsForRole('Kelly', []), [])
})

test('1C+1K matched → eligible for Chris', () => {
  const result = eligibleGroupsForRole('Chris', [g('g1', 'matched', 1, 1)])
  assert.equal(result.length, 1)
  assert.equal(result[0].group_id, 'g1')
})

test('1C+1K matched → eligible for Kelly', () => {
  const result = eligibleGroupsForRole('Kelly', [g('g1', 'matched', 1, 1)])
  assert.equal(result.length, 1)
  assert.equal(result[0].group_id, 'g1')
})

test('1C+1K reporting → NOT eligible (negotiation started)', () => {
  assert.deepEqual(eligibleGroupsForRole('Chris', [g('g1', 'reporting', 1, 1)]), [])
  assert.deepEqual(eligibleGroupsForRole('Kelly', [g('g1', 'reporting', 1, 1)]), [])
})

test('1C+1K negotiating → NOT eligible (status guard)', () => {
  assert.deepEqual(eligibleGroupsForRole('Chris', [g('g1', 'negotiating', 1, 1)]), [])
  assert.deepEqual(eligibleGroupsForRole('Kelly', [g('g1', 'negotiating', 1, 1)]), [])
})

test('1C+1K completed → NOT eligible', () => {
  assert.deepEqual(eligibleGroupsForRole('Chris', [g('g1', 'completed', 1, 1)]), [])
  assert.deepEqual(eligibleGroupsForRole('Kelly', [g('g1', 'completed', 1, 1)]), [])
})

test('1C+1K deadlocked → NOT eligible', () => {
  assert.deepEqual(eligibleGroupsForRole('Chris', [g('g1', 'deadlocked', 1, 1)]), [])
  assert.deepEqual(eligibleGroupsForRole('Kelly', [g('g1', 'deadlocked', 1, 1)]), [])
})

test('2C+1K matched → NOT eligible for Chris (role cap: already 2 Chrises)', () => {
  assert.deepEqual(eligibleGroupsForRole('Chris', [g('g1', 'matched', 2, 1)]), [])
})

test('2C+1K matched → eligible for Kelly (can fill to 2C+2K)', () => {
  const result = eligibleGroupsForRole('Kelly', [g('g1', 'matched', 2, 1)])
  assert.equal(result.length, 1)
  assert.equal(result[0].group_id, 'g1')
})

test('1C+2K matched → eligible for Chris (can fill to 2C+2K)', () => {
  const result = eligibleGroupsForRole('Chris', [g('g1', 'matched', 1, 2)])
  assert.equal(result.length, 1)
  assert.equal(result[0].group_id, 'g1')
})

test('1C+2K matched → NOT eligible for Kelly (role cap: already 2 Kellys)', () => {
  assert.deepEqual(eligibleGroupsForRole('Kelly', [g('g1', 'matched', 1, 2)]), [])
})

test('2C+2K matched (full, total=4) → NOT eligible for either role', () => {
  assert.deepEqual(eligibleGroupsForRole('Chris', [g('g1', 'matched', 2, 2)]), [])
  assert.deepEqual(eligibleGroupsForRole('Kelly', [g('g1', 'matched', 2, 2)]), [])
})

test('mixed statuses → only matched groups returned', () => {
  const groups = [
    g('negotiating', 'negotiating', 1, 1),
    g('reporting', 'reporting', 1, 1),
    g('matched', 'matched', 1, 1),
    g('completed', 'completed', 1, 1),
    g('deadlocked', 'deadlocked', 1, 1),
  ]
  const result = eligibleGroupsForRole('Chris', groups)
  assert.equal(result.length, 1)
  assert.equal(result[0].group_id, 'matched')
})

test('sort: smaller groups come first', () => {
  // 1C+0K (total=1) < 1C+1K (total=2) — both are under the total cap of 4
  const groups = [
    g('big', 'matched', 1, 1),   // total 2
    g('small', 'matched', 1, 0), // total 1
  ]
  const result = eligibleGroupsForRole('Kelly', groups)
  // 'small' (1C+0K, total=1) should come first; 'big' (1C+1K, total=2) second
  assert.equal(result[0].group_id, 'small')
  assert.equal(result[1].group_id, 'big')
})

// ── suggestGroupForLatecomer ──────────────────────────────────────────────────

test('no eligible groups → null', () => {
  assert.equal(suggestGroupForLatecomer('Chris', []), null)
  assert.equal(suggestGroupForLatecomer('Kelly', [g('g1', 'reporting', 1, 1)]), null)
  assert.equal(suggestGroupForLatecomer('Kelly', [g('g1', 'negotiating', 1, 1)]), null)
})

test('suggest for Chris on 1C+1K: composition shows 2C+1K', () => {
  const suggestion = suggestGroupForLatecomer('Chris', [g('g1', 'matched', 1, 1)])
  assert.ok(suggestion !== null)
  assert.equal(suggestion.group_id, 'g1')
  assert.equal(suggestion.current_chris, 1)
  assert.equal(suggestion.current_kelly, 1)
  assert.equal(suggestion.result_composition, '2C+1K')
})

test('suggest for Kelly on 1C+1K: composition shows 1C+2K', () => {
  const suggestion = suggestGroupForLatecomer('Kelly', [g('g1', 'matched', 1, 1)])
  assert.ok(suggestion !== null)
  assert.equal(suggestion.group_id, 'g1')
  assert.equal(suggestion.result_composition, '1C+2K')
})

test('suggest for Kelly on 2C+1K: composition shows 2C+2K', () => {
  const suggestion = suggestGroupForLatecomer('Kelly', [g('g1', 'matched', 2, 1)])
  assert.ok(suggestion !== null)
  assert.equal(suggestion.group_id, 'g1')
  assert.equal(suggestion.result_composition, '2C+2K')
})

test('suggest for Chris on 1C+2K: composition shows 2C+2K', () => {
  const suggestion = suggestGroupForLatecomer('Chris', [g('g1', 'matched', 1, 2)])
  assert.ok(suggestion !== null)
  assert.equal(suggestion.group_id, 'g1')
  assert.equal(suggestion.result_composition, '2C+2K')
})

test('multiple eligible groups: returns the smallest (prefer filling 1C+1K)', () => {
  // Two 1C+1K groups (equal size) — picks the first stable after sort
  const groups = [
    g('g1', 'matched', 1, 1),
    g('g2', 'matched', 1, 1),
  ]
  const suggestion = suggestGroupForLatecomer('Chris', groups)
  assert.ok(suggestion !== null)
  // Either g1 or g2 is fine; both are size 2 — just verify one is returned
  assert.ok(['g1', 'g2'].includes(suggestion.group_id))
})

test('all groups at 2C+2K cap → null suggestion for either role', () => {
  const groups = [
    g('a', 'matched', 2, 2),
    g('b', 'matched', 2, 2),
  ]
  assert.equal(suggestGroupForLatecomer('Chris', groups), null)
  assert.equal(suggestGroupForLatecomer('Kelly', groups), null)
})

test('Chris role cap hit but Kelly slot open: Chris null, Kelly suggested', () => {
  const groups = [g('a', 'matched', 2, 1)]
  assert.equal(suggestGroupForLatecomer('Chris', groups), null)
  const s = suggestGroupForLatecomer('Kelly', groups)
  assert.ok(s !== null)
  assert.equal(s.result_composition, '2C+2K')
})

test('ineligible-status groups beside eligible: only eligible suggested', () => {
  const groups = [
    g('negotiating', 'negotiating', 1, 1),
    g('reporting', 'reporting', 1, 1),
    g('eligible', 'matched', 1, 1),
    g('completed', 'completed', 1, 1),
  ]
  const suggestion = suggestGroupForLatecomer('Kelly', groups)
  assert.ok(suggestion !== null)
  assert.equal(suggestion.group_id, 'eligible')
})
