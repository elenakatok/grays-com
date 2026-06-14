/**
 * E2E test: Start negotiation button
 *
 * Prerequisites: Firebase emulators + Vite dev server must be running
 * (run ./start-local.sh from the project root).
 *
 * What this tests:
 *   1. One group member taps "Start negotiation"
 *   2. Group status in Firestore becomes 'negotiating'
 *   3. The tapping member's view advances to the off-platform holding screen
 *   4. The other member's view auto-advances to the same screen
 */

import { test, expect, type APIRequestContext } from '@playwright/test'

const FUNCTIONS_BASE = 'http://127.0.0.1:5004/grays-mygames-live/us-central1'
const FIRESTORE_BASE =
  'http://127.0.0.1:8081/v1/projects/grays-mygames-live/databases/(default)/documents'

// ── Seed helper ───────────────────────────────────────────────────────────────

async function seedGroup(
  request: APIRequestContext,
  gameInstanceId: string,
  groupId: string,
  pid1: string,
  pid2: string,
): Promise<void> {
  const res = await request.post(`${FUNCTIONS_BASE}/seedTestGroup`, {
    data: {
      game_instance_id: gameInstanceId,
      group_id: groupId,
      participants: [
        { id: pid1, role: 'Chris', is_lead: true, display_name: 'Alice' },
        { id: pid2, role: 'Kelly', is_lead: false, display_name: 'Bob' },
      ],
    },
  })
  if (!res.ok()) {
    throw new Error(`seedGroup failed: ${res.status()} ${await res.text()}`)
  }
}

// ── Firestore read helper (Admin SDK bypasses rules; emulator REST requires it) ──

async function getGroupStatus(
  request: APIRequestContext,
  gameInstanceId: string,
  groupId: string,
): Promise<string> {
  // Groups are readable by any authenticated participant per security rules.
  // In the emulator, we can read without auth by using the emulator's admin
  // override header.
  const res = await request.get(
    `${FIRESTORE_BASE}/game_instances/${gameInstanceId}/groups/${groupId}`,
    { headers: { Authorization: 'Bearer owner' } },
  )
  if (!res.ok()) throw new Error(`getGroupStatus failed: ${res.status()} ${await res.text()}`)
  const body = (await res.json()) as {
    fields?: { status?: { stringValue?: string } }
  }
  return body.fields?.status?.stringValue ?? ''
}

// ── Test ─────────────────────────────────────────────────────────────────────

test('Start negotiation: flips group to negotiating and advances both members', async ({
  browser,
  request,
}) => {
  const ts = Date.now()
  const gameInstanceId = `e2e-neg-${ts}`
  const groupId = `grp-${ts}`
  const pid1 = `p1-${ts}`
  const pid2 = `p2-${ts}`

  await seedGroup(request, gameInstanceId, groupId, pid1, pid2)

  // ── Open two browser contexts ─────────────────────────────────────────────
  const ctx1 = await browser.newContext()
  const ctx2 = await browser.newContext()
  const page1 = await ctx1.newPage()
  const page2 = await ctx2.newPage()

  const url = (pid: string) =>
    `/play?_dev_participant_id=${pid}&_dev_game_instance_id=${gameInstanceId}`

  await Promise.all([page1.goto(url(pid1)), page2.goto(url(pid2))])

  // Both members should reach the group-reveal screen
  await Promise.all([
    page1.waitForSelector("text=You've been matched", { timeout: 15_000 }),
    page2.waitForSelector("text=You've been matched", { timeout: 15_000 }),
  ])

  // ── Member 1 taps "Start negotiation" ────────────────────────────────────
  await page1.click('button:has-text("Start negotiation")')

  // (a) Member 1 advances to the off-platform holding screen
  await page1.waitForSelector('text=Negotiate with your partner', { timeout: 10_000 })

  // (a) Group status in Firestore is now 'negotiating'
  const status = await getGroupStatus(request, gameInstanceId, groupId)
  expect(status).toBe('negotiating')

  // (b) Member 2 auto-advances to the off-platform holding screen
  await page2.waitForSelector('text=Negotiate with your partner', { timeout: 10_000 })

  await ctx1.close()
  await ctx2.close()
})
