/**
 * E2E tests: Class Roster table on the instructor dashboard.
 *
 * Prerequisites: Firebase emulators + Vite dev server must be running
 * (run ./start-local.sh from the project root).
 */

import { test, expect, type APIRequestContext } from '@playwright/test'

const FUNCTIONS_BASE = 'http://127.0.0.1:5004/grays-mygames-live/us-central1'

async function seedStage(
  request: APIRequestContext,
  gameInstanceId: string,
  stage: string,
  n: number,
): Promise<Record<string, unknown>> {
  const res = await request.post(`${FUNCTIONS_BASE}/seedSimulatedGame`, {
    data: { game_instance_id: gameInstanceId, stage, n },
  })
  if (!res.ok()) throw new Error(`seedSimulatedGame(${stage}) failed: ${res.status()} ${await res.text()}`)
  return res.json() as Promise<Record<string, unknown>>
}

function lastToken(name: string): string {
  const tokens = name.trim().split(/\s+/)
  return tokens[tokens.length - 1]
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test('Roster: Completed stage — every student appears exactly once, sorted by last name, deadlocked rows flagged, no unmatched students', async ({
  page,
  request,
}) => {
  const N = 20
  const gameInstanceId = `e2e-roster-${Date.now()}`

  const seedBody = await seedStage(request, gameInstanceId, 'completed', N)
  expect(seedBody.ok).toBe(true)
  expect(seedBody.students).toBe(N)

  await page.goto(`/dashboard?_dev_game_instance_id=${gameInstanceId}`)

  // Wait for the roster table to populate
  const tbody = page.locator('[data-testid="roster-table"] tbody')
  await expect(tbody.locator('tr')).toHaveCount(N, { timeout: 15_000 })

  // Every enrolled student appears exactly once (N rows)
  const rows = tbody.locator('tr')
  expect(await rows.count()).toBe(N)

  // Rows are sorted by last name on load (ascending)
  const nameCells = await tbody.locator('tr td:nth-child(1)').allTextContents()
  const names = nameCells.map((s) => s.trim())
  const lastNames = names.map(lastToken)
  const firstNames = names.map((s) => s.split(/\s+/)[0])

  // The rendered order must equal the last-name sort (with full name as tiebreaker)
  const expectedOrder = [...names].sort((a, b) => lastToken(a).localeCompare(lastToken(b)) || a.localeCompare(b))
  expect(names).toEqual(expectedOrder)

  // The fixture must have multiple distinct last names — otherwise last-name ordering
  // degenerates to first-name ordering and proves nothing about the sort logic.
  const distinctLastNames = new Set(lastNames)
  expect(distinctLastNames.size).toBeGreaterThan(3)

  // The last-name sorted order must differ from the first-name sorted order.
  // If they were the same, a coincidental first-name-alpha list would produce a false pass.
  const sortedByFirstName = [...firstNames].sort((a, b) => a.localeCompare(b))
  expect(lastNames).not.toEqual(sortedByFirstName)

  // At least 1 row carries the Deadlocked status
  const deadlockedRows = tbody.locator('tr[data-status="Deadlocked"]')
  const deadlockedCount = await deadlockedRows.count()
  expect(deadlockedCount).toBeGreaterThanOrEqual(1)

  // Deadlocked rows show the ⚠ prefix in the status cell
  const statusCell = deadlockedRows.first().locator('td:nth-child(3)')
  await expect(statusCell).toContainText('Deadlocked')
  await expect(statusCell).toContainText('⚠')

  // All N students are in groups — no row shows Present (unmatched) status
  const statuses = await tbody.locator('tr td:nth-child(3)').allTextContents()
  for (const s of statuses) {
    expect(s.trim()).not.toBe('')
    expect(s.trim()).not.toBe('Present')
    expect(s.trim()).not.toBe('Absent')
    expect(s.trim()).not.toBe('Prepared')
  }
})

test('Roster: column header click re-sorts the table', async ({ page, request }) => {
  const N = 20
  const gameInstanceId = `e2e-roster-sort-${Date.now()}`
  await seedStage(request, gameInstanceId, 'completed', N)

  await page.goto(`/dashboard?_dev_game_instance_id=${gameInstanceId}`)

  const tbody = page.locator('[data-testid="roster-table"] tbody')
  await expect(tbody.locator('tr')).toHaveCount(N, { timeout: 15_000 })

  // Click "Role" header → sort by role ascending
  await page.locator('[data-testid="roster-table"] th').filter({ hasText: 'Role' }).click()
  const rolesAsc = await tbody.locator('tr td:nth-child(2)').allTextContents()
  const sortedAsc = [...rolesAsc].sort((a, b) => a.localeCompare(b))
  expect(rolesAsc).toEqual(sortedAsc)

  // Click "Role" again → reverse to descending
  await page.locator('[data-testid="roster-table"] th').filter({ hasText: 'Role' }).click()
  const rolesDesc = await tbody.locator('tr td:nth-child(2)').allTextContents()
  const sortedDesc = [...rolesDesc].sort((a, b) => b.localeCompare(a))
  expect(rolesDesc).toEqual(sortedDesc)

  // Click "Status" header → sort by status ascending
  await page.locator('[data-testid="roster-table"] th').filter({ hasText: 'Status' }).click()
  const statusTexts = await tbody.locator('tr td:nth-child(3)').allTextContents()
  // Absent < Prepared < Present < Matched < Negotiating < Deadlocked < Completed
  const STATUS_ORDER: Record<string, number> = {
    Absent: 0, Prepared: 1, Present: 2, Matched: 3,
    Negotiating: 4, Deadlocked: 5, Completed: 6,
  }
  const statusOrder = statusTexts.map((s) => {
    const clean = s.replace('⚠ ', '').trim()
    return STATUS_ORDER[clean] ?? -1
  })
  for (let i = 1; i < statusOrder.length; i++) {
    expect(statusOrder[i]).toBeGreaterThanOrEqual(statusOrder[i - 1])
  }
})

test('Roster: Enrolled stage — all students show Absent, group column is blank', async ({
  page,
  request,
}) => {
  const N = 10
  const gameInstanceId = `e2e-roster-enrolled-${Date.now()}`
  await seedStage(request, gameInstanceId, 'enrolled', N)

  await page.goto(`/dashboard?_dev_game_instance_id=${gameInstanceId}`)

  const tbody = page.locator('[data-testid="roster-table"] tbody')
  await expect(tbody.locator('tr')).toHaveCount(N, { timeout: 15_000 })

  const statuses = await tbody.locator('tr td:nth-child(3)').allTextContents()
  for (const s of statuses) {
    expect(s.trim()).toBe('Absent')
  }

  const groupCells = await tbody.locator('tr td:nth-child(4)').allTextContents()
  for (const g of groupCells) {
    expect(g.trim()).toBe('—')
  }
})

test('DevLauncher: Matched button is absent from the /dev page', async ({ page }) => {
  await page.goto('/dev')

  // The three valid stage buttons must exist
  await expect(page.getByRole('button', { name: /enrolled/i })).toBeVisible()
  await expect(page.getByRole('button', { name: /present/i })).toBeVisible()
  await expect(page.getByRole('button', { name: /completed/i })).toBeVisible()

  // The Matched button must NOT exist
  const matchedButton = page.getByRole('button', { name: /matched/i })
  await expect(matchedButton).toHaveCount(0)
})
