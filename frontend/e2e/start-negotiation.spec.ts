/**
 * E2E tests: negotiating status + holding-screen auto-advance
 *
 * Prerequisites: Firebase emulators + Vite dev server must be running
 * (run ./start-local.sh from the project root).
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

test('Holding → reporting: tapper advances immediately, non-tapper auto-advances when lead submits', async ({
  browser,
  request,
}) => {
  const ts = Date.now()
  const gameInstanceId = `e2e-hold-${ts}`
  const groupId = `grp-${ts}`
  const pid1 = `p1-${ts}` // Chris, lead
  const pid2 = `p2-${ts}` // Kelly, non-lead

  // Seed as matched, then flip to negotiating so resume routing sends both to holding screen.
  await seedGroup(request, gameInstanceId, groupId, pid1, pid2)
  const negRes = await request.post(`${FUNCTIONS_BASE}/startNegotiation`, {
    data: { _test: { participant_id: pid1, game_instance_id: gameInstanceId } },
  })
  if (!negRes.ok()) throw new Error(`startNegotiation failed: ${negRes.status()} ${await negRes.text()}`)

  // Both users navigate — resume routing sees negotiating → off-platform-holding.
  const ctx1 = await browser.newContext()
  const ctx2 = await browser.newContext()
  const page1 = await ctx1.newPage()
  const page2 = await ctx2.newPage()

  const url = (pid: string) =>
    `/play?_dev_participant_id=${pid}&_dev_game_instance_id=${gameInstanceId}`

  await Promise.all([page1.goto(url(pid1)), page2.goto(url(pid2))])

  await Promise.all([
    page1.waitForSelector('text=Negotiate with your partner', { timeout: 15_000 }),
    page2.waitForSelector('text=Negotiate with your partner', { timeout: 15_000 }),
  ])

  // ── Lead (pid1) taps the button → must advance without a reload ──────────
  await page1.click("button:has-text(\"We've finished\")")
  await page1.waitForSelector('text=Report outcome', { timeout: 10_000 })

  // ── Lead submits an outcome via the API, which flips status → reporting ──
  // This simulates the lead filling in a price on the outcome-reporting screen.
  const submitRes = await request.post(`${FUNCTIONS_BASE}/submitLeadOutcome`, {
    data: { _test: { participant_id: pid1, game_instance_id: gameInstanceId }, price: 120 },
  })
  if (!submitRes.ok()) throw new Error(`submitLeadOutcome failed: ${submitRes.status()} ${await submitRes.text()}`)

  // ── Non-lead (pid2) must auto-advance from holding screen ─────────────────
  // The onSnapshot listener in Phase2OffPlatformHolding detects status === 'reporting'
  // and calls onReportOutcome without any user tap or page reload.
  await page2.waitForSelector('text=Confirm the outcome', { timeout: 10_000 })

  await ctx1.close()
  await ctx2.close()
})

test('Lead routing: lead reaches outcome-entry (not waiting screen) when is_lead was stale at page load', async ({
  browser,
  request,
}) => {
  // This test reproduces the real-game bug where students load the page before matching
  // runs, so is_lead is not yet set in their participant docs. The holding screen must
  // derive lead status from the group doc (lead_participant_id) rather than the stale
  // session ref.
  const ts = Date.now()
  const gameInstanceId = `e2e-lead-route-${ts}`
  const groupId = `grp-${ts}`
  const pid1 = `p1-${ts}` // Chris — actual lead in group doc, but doc_is_lead: false (stale)
  const pid2 = `p2-${ts}` // Kelly

  // Seed: group doc has lead_participant_id: pid1 (correct), but participant docs both
  // have is_lead: false (simulating the pre-matching stale state).
  const seedRes = await request.post(`${FUNCTIONS_BASE}/seedTestGroup`, {
    data: {
      game_instance_id: gameInstanceId,
      group_id: groupId,
      initial_status: 'negotiating',
      participants: [
        { id: pid1, role: 'Chris', is_lead: true, doc_is_lead: false, display_name: 'Alice' },
        { id: pid2, role: 'Kelly', is_lead: false, display_name: 'Bob' },
      ],
    },
  })
  if (!seedRes.ok()) throw new Error(`seedTestGroup failed: ${seedRes.status()} ${await seedRes.text()}`)

  // Both navigate — resume routing sees negotiating → off-platform-holding.
  // Because is_lead=false in both participant docs, the session ref has isLead=false for everyone.
  const ctx1 = await browser.newContext()
  const ctx2 = await browser.newContext()
  const page1 = await ctx1.newPage() // actual lead
  const page2 = await ctx2.newPage() // non-lead

  const url = (pid: string) =>
    `/play?_dev_participant_id=${pid}&_dev_game_instance_id=${gameInstanceId}`

  await Promise.all([page1.goto(url(pid1)), page2.goto(url(pid2))])

  await Promise.all([
    page1.waitForSelector('text=Negotiate with your partner', { timeout: 15_000 }),
    page2.waitForSelector('text=Negotiate with your partner', { timeout: 15_000 }),
  ])

  // ── Lead taps the button — must land on the LEAD outcome-entry form, not the waiting screen ──
  await page1.click("button:has-text(\"We've finished\")")
  // "Report outcome" is the lead entry form heading. "Your group lead is reporting" is the non-lead screen.
  await page1.waitForSelector('text=Report outcome', { timeout: 10_000 })
  // Confirm the non-lead waiting screen is NOT shown to the lead.
  await expect(page1.locator('text=Your group lead is reporting')).not.toBeVisible()

  // Kelly has not tapped and no submit has happened, so she stays on the holding screen.
  await expect(page2.locator('text=Negotiate with your partner')).toBeVisible()

  await ctx1.close()
  await ctx2.close()
})

// ── Latecomer guard ───────────────────────────────────────────────────────────

test('addLateParticipant: latecomer cannot be added to a negotiating group', async ({
  request,
}) => {
  // This test verifies the most regression-prone rule: a group whose status is
  // not exactly 'matched' is closed to latecomers regardless of available slots.
  const ts = Date.now()
  const gameInstanceId = `e2e-late-guard-${ts}`
  const groupId = `grp-${ts}`
  const pid1 = `p1-${ts}`
  const pid2 = `p2-${ts}`
  const latePid = `late-${ts}`

  // Seed a negotiating group (has 1 open Chris slot, but status is 'negotiating').
  const seedRes = await request.post(`${FUNCTIONS_BASE}/seedTestGroup`, {
    data: {
      game_instance_id: gameInstanceId,
      group_id: groupId,
      initial_status: 'negotiating',
      participants: [
        { id: pid1, role: 'Chris', is_lead: true, display_name: 'Alice' },
        { id: pid2, role: 'Kelly', is_lead: false, display_name: 'Bob' },
      ],
    },
  })
  if (!seedRes.ok()) throw new Error(`seedTestGroup failed: ${seedRes.status()} ${await seedRes.text()}`)

  // Seed the latecomer as an unmatched participant (no group_id).
  const lateRes = await request.post(`${FUNCTIONS_BASE}/seedLatecomer`, {
    data: {
      game_instance_id: gameInstanceId,
      participant_id: latePid,
      role: 'Chris',
      display_name: 'Charlie',
    },
  })
  if (!lateRes.ok()) throw new Error(`seedLatecomer failed: ${lateRes.status()} ${await lateRes.text()}`)

  // Attempt to add the latecomer to the negotiating group — must be rejected.
  const addRes = await request.post(`${FUNCTIONS_BASE}/addLateParticipant`, {
    data: {
      _dev: { game_instance_id: gameInstanceId },
      participant_id: latePid,
      group_id: groupId,
    },
  })
  expect(addRes.status()).toBe(409)
  const body = (await addRes.json()) as { error: string }
  expect(body.error).toMatch(/negotiation has already started/)
})
