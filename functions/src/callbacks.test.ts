/**
 * Tests for dispatchResults (the push-to-classroom transport logic).
 *
 * Uses Node's built-in test runner (no extra dependencies).
 * Run: npm run build && node lib/callbacks.test.js
 *
 * All tests inject a mock reportFn — no real network calls are made.
 * retryDelays=[0,0] is passed so tests don't wait on backoff.
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { dispatchResults } from './callbacks'
import type { GameResult } from './engine/reportResult'

function makeRecord(participantId: string, status: GameResult['status'] = 'completed'): GameResult {
  return {
    game_instance_id: 'instance-1',
    participant_id: participantId,
    status,
    role: 'Chris',
    normalized_score: status === 'no_show' ? -2 : 0.5,
    knowledge_check_score: 1.0,
    details: {},
  }
}

// ── all-success ───────────────────────────────────────────────────────────────

test('all-success: every participant pushed, summary reflects full success', async () => {
  const records = [makeRecord('p1'), makeRecord('p2'), makeRecord('p3')]
  let callCount = 0

  const summary = await dispatchResults(
    records,
    'http://classroom.example',
    'secret',
    async () => { callCount++ },
    [0, 0],
  )

  assert.equal(summary.total, 3)
  assert.equal(summary.succeeded, 3)
  assert.deepEqual(summary.failed, [])
  assert.equal(callCount, 3, 'reportFn must be called once per participant')
})

// ── transient failure recovers on retry ───────────────────────────────────────

test('transient 5xx: participant succeeds after one retry', async () => {
  const records = [makeRecord('p1')]
  let callCount = 0

  const summary = await dispatchResults(
    records,
    'http://classroom.example',
    'secret',
    async () => {
      callCount++
      if (callCount === 1) throw new Error('Classroom callback returned HTTP 503')
    },
    [0, 0],
  )

  assert.equal(summary.total, 1)
  assert.equal(summary.succeeded, 1, 'participant should succeed after retry')
  assert.deepEqual(summary.failed, [])
  assert.equal(callCount, 2, 'reportFn must be called twice (1 failure + 1 success)')
})

test('network error (no HTTP status): treated as transient, retried', async () => {
  const records = [makeRecord('p1')]
  let callCount = 0

  const summary = await dispatchResults(
    records,
    'http://classroom.example',
    'secret',
    async () => {
      callCount++
      if (callCount === 1) throw new Error('connect ECONNREFUSED 127.0.0.1:443')
    },
    [0, 0],
  )

  assert.equal(summary.succeeded, 1)
  assert.equal(callCount, 2)
})

// ── 4xx fails fast ────────────────────────────────────────────────────────────

test('4xx (401): fails immediately with no retry', async () => {
  const records = [makeRecord('p1')]
  let callCount = 0

  const summary = await dispatchResults(
    records,
    'http://classroom.example',
    'secret',
    async () => {
      callCount++
      throw new Error('Classroom callback returned HTTP 401')
    },
    [0, 0],
  )

  assert.equal(summary.total, 1)
  assert.equal(summary.succeeded, 0)
  assert.equal(summary.failed.length, 1)
  assert.equal(summary.failed[0].participant_id, 'p1')
  assert.ok(summary.failed[0].reason.includes('401'))
  assert.equal(callCount, 1, 'reportFn must not be retried on 4xx')
})

test('4xx (400): fails fast', async () => {
  const records = [makeRecord('p1')]
  let callCount = 0

  const summary = await dispatchResults(
    records,
    'http://classroom.example',
    'secret',
    async () => {
      callCount++
      throw new Error('Classroom callback returned HTTP 400')
    },
    [0, 0],
  )

  assert.equal(summary.succeeded, 0)
  assert.equal(callCount, 1)
})

// ── one failure does not stop the others ─────────────────────────────────────

test('one 4xx failure does not stop remaining participants', async () => {
  const records = [makeRecord('p1'), makeRecord('p2'), makeRecord('p3')]
  const failIds = new Set(['p2'])

  const summary = await dispatchResults(
    records,
    'http://classroom.example',
    'secret',
    async (r) => {
      if (failIds.has(r.participant_id)) {
        throw new Error('Classroom callback returned HTTP 403')
      }
    },
    [0, 0],
  )

  assert.equal(summary.total, 3)
  assert.equal(summary.succeeded, 2)
  assert.equal(summary.failed.length, 1)
  assert.equal(summary.failed[0].participant_id, 'p2')
})

// ── exhausted retries ─────────────────────────────────────────────────────────

test('persistent 5xx: fails after all attempts exhausted', async () => {
  const records = [makeRecord('p1')]
  let callCount = 0

  const summary = await dispatchResults(
    records,
    'http://classroom.example',
    'secret',
    async () => {
      callCount++
      throw new Error('Classroom callback returned HTTP 500')
    },
    [0, 0], // 3 total attempts (1 initial + 2 retries)
  )

  assert.equal(summary.succeeded, 0)
  assert.equal(summary.failed.length, 1)
  assert.equal(summary.failed[0].participant_id, 'p1')
  assert.ok(summary.failed[0].reason.includes('500'))
  assert.equal(callCount, 3, 'should attempt 3 times before giving up')
})

// ── summary shape ─────────────────────────────────────────────────────────────

test('summary shape: total, succeeded, failed array of {participant_id, reason}', async () => {
  const records = [makeRecord('p1'), makeRecord('p2')]
  const failIds = new Set(['p2'])

  const summary = await dispatchResults(
    records,
    'http://classroom.example',
    'secret',
    async (r) => {
      if (failIds.has(r.participant_id)) throw new Error('Classroom callback returned HTTP 422')
    },
    [0, 0],
  )

  assert.ok(typeof summary.total === 'number', 'total must be a number')
  assert.ok(typeof summary.succeeded === 'number', 'succeeded must be a number')
  assert.ok(Array.isArray(summary.failed), 'failed must be an array')

  assert.equal(summary.total, 2)
  assert.equal(summary.succeeded, 1)
  assert.equal(summary.failed.length, 1)

  const [entry] = summary.failed
  assert.ok(typeof entry.participant_id === 'string', 'failed entry must have participant_id string')
  assert.ok(typeof entry.reason === 'string', 'failed entry must have reason string')
  assert.equal(entry.participant_id, 'p2')
})

// ── edge cases ────────────────────────────────────────────────────────────────

test('empty records: returns zero counts with no calls', async () => {
  let callCount = 0

  const summary = await dispatchResults(
    [],
    'http://classroom.example',
    'secret',
    async () => { callCount++ },
    [0, 0],
  )

  assert.equal(summary.total, 0)
  assert.equal(summary.succeeded, 0)
  assert.deepEqual(summary.failed, [])
  assert.equal(callCount, 0)
})

test('no_show participant is pushed with correct status', async () => {
  const records = [makeRecord('p1', 'no_show')]
  const captured: GameResult[] = []

  await dispatchResults(
    records,
    'http://classroom.example',
    'secret',
    async (r) => { captured.push(r) },
    [0, 0],
  )

  assert.equal(captured.length, 1)
  assert.equal(captured[0].status, 'no_show')
  assert.equal(captured[0].normalized_score, -2)
})
