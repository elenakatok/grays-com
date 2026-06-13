/**
 * Tests for the all-groups-complete guard logic.
 *
 * Uses Node's built-in test runner (no extra dependencies).
 * Run: npm run build && node lib/finalizeGuard.test.js
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { checkAllGroupsComplete } from './finalizeGuard'
import type { GroupForGuard } from './finalizeGuard'

function g(status: string): GroupForGuard {
  return { status }
}

// ── passes when all complete ───────────────────────────────────────────────────

test('empty group list: not blocked (nothing to wait for)', () => {
  const result = checkAllGroupsComplete([])
  assert.equal(result.blocked, false)
})

test('all completed: not blocked', () => {
  const result = checkAllGroupsComplete([g('completed'), g('completed'), g('completed')])
  assert.equal(result.blocked, false)
})

test('single completed group: not blocked', () => {
  const result = checkAllGroupsComplete([g('completed')])
  assert.equal(result.blocked, false)
})

// ── blocks on each non-complete status ────────────────────────────────────────

test('matched group blocks finalize', () => {
  const result = checkAllGroupsComplete([g('completed'), g('matched')])
  assert.equal(result.blocked, true)
  if (result.blocked) {
    assert.ok(result.message.includes('matched'), `message should mention 'matched': ${result.message}`)
  }
})

test('reporting group blocks finalize', () => {
  const result = checkAllGroupsComplete([g('reporting'), g('completed')])
  assert.equal(result.blocked, true)
  if (result.blocked) {
    assert.ok(result.message.includes('reporting'))
  }
})

test('deadlocked group blocks finalize', () => {
  const result = checkAllGroupsComplete([g('completed'), g('deadlocked')])
  assert.equal(result.blocked, true)
  if (result.blocked) {
    assert.ok(result.message.includes('deadlocked'))
  }
})

test('reconciling group blocks finalize (future status handled generically)', () => {
  const result = checkAllGroupsComplete([g('reconciling')])
  assert.equal(result.blocked, true)
  if (result.blocked) {
    assert.ok(result.message.includes('reconciling'))
  }
})

// ── message lists the right groups ────────────────────────────────────────────

test('blocked message identifies group by 1-based index', () => {
  // Groups: completed, reporting, completed — only group 2 is incomplete
  const result = checkAllGroupsComplete([g('completed'), g('reporting'), g('completed')])
  assert.equal(result.blocked, true)
  if (result.blocked) {
    assert.ok(result.message.includes('Group 2'), `expected "Group 2" in: ${result.message}`)
    assert.ok(result.message.includes('reporting'))
  }
})

test('blocked message lists multiple incomplete groups', () => {
  // Groups 1, 3, 5 are incomplete; groups 2 and 4 are completed
  const groups = [g('matched'), g('completed'), g('deadlocked'), g('completed'), g('reporting')]
  const result = checkAllGroupsComplete(groups)
  assert.equal(result.blocked, true)
  if (result.blocked) {
    assert.ok(result.message.includes('Group 1'), result.message)
    assert.ok(result.message.includes('Group 3'), result.message)
    assert.ok(result.message.includes('Group 5'), result.message)
    assert.ok(!result.message.includes('Group 2'), 'completed groups must not appear')
    assert.ok(!result.message.includes('Group 4'), 'completed groups must not appear')
  }
})

test('singular "group" in message when only one is incomplete', () => {
  const result = checkAllGroupsComplete([g('matched')])
  assert.equal(result.blocked, true)
  if (result.blocked) {
    assert.ok(result.message.includes('1 group still in progress'), result.message)
  }
})

test('plural "groups" in message when multiple are incomplete', () => {
  const result = checkAllGroupsComplete([g('matched'), g('reporting')])
  assert.equal(result.blocked, true)
  if (result.blocked) {
    assert.ok(result.message.includes('2 groups still in progress'), result.message)
  }
})

test('count in message matches actual number of incomplete groups', () => {
  const groups = [g('completed'), g('matched'), g('reporting'), g('deadlocked'), g('completed')]
  const result = checkAllGroupsComplete(groups)
  assert.equal(result.blocked, true)
  if (result.blocked) {
    assert.ok(result.message.startsWith('3 groups'), result.message)
  }
})
