/**
 * DEV-ONLY test launcher — not included in production builds.
 *
 * Concern A: Role-balance stress test — simulates N student enrollments by calling
 *   the real assignRole endpoint sequentially, then reports the Chris/Kelly balance.
 *   No browser windows opened.
 *
 * Concern B: Interactive flow testing — seeds 2–8 named students via the real
 *   assignRole endpoint (roles NOT hardcoded), then opens per-student /play windows.
 */

import { useCallback, useEffect, useState } from 'react'

// These constants match the emulator ports in firebase.json
const FS_EMULATOR        = 'http://127.0.0.1:8081'
const RTDB_EMULATOR      = 'http://127.0.0.1:9001'
const FUNCTIONS_EMULATOR = 'http://127.0.0.1:5004/grays-mygames-live/us-central1'
const PROJECT_ID         = 'grays-mygames-live'
const RTDB_NS            = 'grays-mygames-live'
const DEFAULT_INSTANCE   = 'dd000000-0000-0000-0000-000000000000'
const STORAGE_KEY        = 'dev_launcher_instance_id'
const FIXED_TS           = '2026-06-01T10:00:00Z'

// Named students available for interactive testing (up to 8)
const NAMED_STUDENTS = [
  { id: 'p-alice', name: 'Alice Johnson' },
  { id: 'p-bob',   name: 'Bob Smith'     },
  { id: 'p-carol', name: 'Carol Davis'   },
  { id: 'p-dan',   name: 'Dan Lee'       },
  { id: 'p-eve',   name: 'Eve Martinez'  },
  { id: 'p-frank', name: 'Frank Wilson'  },
  { id: 'p-grace', name: 'Grace Chen'    },
  { id: 'p-henry', name: 'Henry Brown'   },
] as const

type Participant = {
  id: string
  displayName: string
  role: string
  prepStatus: string
  hasGroupId: boolean
  hasAttendance: boolean
}

// ── Emulator helpers ──────────────────────────────────────────────────────────

function fsParticipantBase(instanceId: string): string {
  return `${FS_EMULATOR}/v1/projects/${PROJECT_ID}/databases/(default)/documents/game_instances/${instanceId}/participants`
}

async function fsPatch(url: string, fields: Record<string, unknown>): Promise<void> {
  // Include updateMask so this is a merge (not a full-document replace).
  // Without updateMask, Firestore REST PATCH overwrites the entire document.
  const mask = Object.keys(fields)
    .map(k => `updateMask.fieldPaths=${encodeURIComponent(k)}`)
    .join('&')
  const res = await fetch(`${url}?${mask}`, {
    method: 'PATCH',
    headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields }),
  })
  if (!res.ok) throw new Error(`Firestore PATCH failed: ${res.status}`)
}

async function fsDelete(url: string): Promise<void> {
  await fetch(url, { method: 'DELETE', headers: { Authorization: 'Bearer owner' } })
}

async function rtdbPut(path: string, data: unknown): Promise<void> {
  const url = `${RTDB_EMULATOR}${path}?ns=${RTDB_NS}&access_token=owner`
  const res = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
  if (!res.ok) throw new Error(`RTDB PUT failed: ${res.status}`)
}

/**
 * Calls the real assignRole Cloud Function via the Functions emulator.
 * Uses the same _test body that /play uses in dev mode.
 */
async function callAssignRole(
  participantId: string,
  gameInstanceId: string,
): Promise<'Chris' | 'Kelly'> {
  const res = await fetch(`${FUNCTIONS_EMULATOR}/assignRole`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ _test: { participant_id: participantId, game_instance_id: gameInstanceId } }),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`assignRole(${participantId}) → HTTP ${res.status}: ${text.slice(0, 120)}`)
  }
  const data = await res.json() as { role: 'Chris' | 'Kelly' }
  return data.role
}

/** Lists all participant IDs currently in the instance (up to 200). */
async function listParticipantIds(instanceId: string): Promise<string[]> {
  const res = await fetch(`${fsParticipantBase(instanceId)}?pageSize=200`, {
    headers: { Authorization: 'Bearer owner' },
  })
  if (!res.ok) return []
  const data = await res.json() as { documents?: Array<{ name: string }> }
  return (data.documents ?? []).map((d) => d.name.split('/').pop() ?? '').filter(Boolean)
}

/** Deletes ALL participants and the role_counts/totals doc for the instance. */
async function clearInstanceRoles(instanceId: string): Promise<void> {
  const base = fsParticipantBase(instanceId)
  const ids = await listParticipantIds(instanceId)
  const rcUrl = `${FS_EMULATOR}/v1/projects/${PROJECT_ID}/databases/(default)/documents/game_instances/${instanceId}/role_counts/totals`
  await Promise.all([
    ...ids.map((id) => fsDelete(`${base}/${id}`)),
    fsDelete(rcUrl),
  ])
}

async function seedGameConfig(instanceId: string): Promise<void> {
  const url = `${FS_EMULATOR}/v1/projects/${PROJECT_ID}/databases/(default)/documents/game_instances/${instanceId}/config/main`
  await fsPatch(url, {
    reservation_price_chris: { integerValue: '25000' },
    reservation_price_kelly: { integerValue: '475000' },
  })
}

/**
 * Clears the N named students + role_counts, seeds bare docs (no role field),
 * then calls the real assignRole endpoint sequentially for each.
 * Returns a participantId → role map.
 */
async function seedNamedStudents(
  instanceId: string,
  n: number,
): Promise<Map<string, 'Chris' | 'Kelly'>> {
  const students = NAMED_STUDENTS.slice(0, n)
  const base = fsParticipantBase(instanceId)
  const rcUrl = `${FS_EMULATOR}/v1/projects/${PROJECT_ID}/databases/(default)/documents/game_instances/${instanceId}/role_counts/totals`

  // Remove only the named participant docs + role counter so other instance data is unaffected
  await Promise.all([
    ...students.map((s) => fsDelete(`${base}/${s.id}`)),
    fsDelete(rcUrl),
  ])

  // Seed bare docs with display_name but NO role — assignRole must assign it
  await Promise.all(
    students.map((s) =>
      fsPatch(`${base}/${s.id}`, {
        participant_id:   { stringValue: s.id },
        game_instance_id: { stringValue: instanceId },
        display_name:     { stringValue: s.name },
      }),
    ),
  )

  // Call real assignRole sequentially so each Firestore transaction sees the
  // previous counter update and the balancing logic produces the correct distribution
  const roleMap = new Map<string, 'Chris' | 'Kelly'>()
  for (const s of students) {
    const role = await callAssignRole(s.id, instanceId)
    roleMap.set(s.id, role)
  }
  return roleMap
}

async function doSeedPhase2Entry(instanceId: string, n: number): Promise<void> {
  const base = fsParticipantBase(instanceId)
  const students = NAMED_STUDENTS.slice(0, n)
  await seedNamedStudents(instanceId, n)
  await Promise.all([
    ...students.map((s) =>
      fsPatch(`${base}/${s.id}`, { prep_status: { stringValue: 'complete' } }),
    ),
    seedGameConfig(instanceId),
  ])
}

async function doSeedWaitingRoom(instanceId: string, n: number): Promise<void> {
  const base = fsParticipantBase(instanceId)
  const students = NAMED_STUDENTS.slice(0, n)
  const now = Date.now()
  const roleMap = await seedNamedStudents(instanceId, n)
  await Promise.all([
    ...students.map(async (s) => {
      await fsPatch(`${base}/${s.id}`, {
        prep_status:             { stringValue: 'complete' },
        confirmed_ready_at:      { timestampValue: FIXED_TS },
        attendance_confirmed_at: { timestampValue: FIXED_TS },
      })
      // attending/ → dashboard roster display
      await rtdbPut(`/attending/${instanceId}/${s.id}.json`, {
        display_name: s.name,
        role:         roleMap.get(s.id) ?? 'Chris',
        confirmed_at: now,
      })
      // presence/ → triggerMatching eligibility (Object.keys check); mirrors usePresence
      await rtdbPut(`/presence/${instanceId}/${s.id}.json`, {
        online: true,
        last_seen: now,
      })
    }),
    seedGameConfig(instanceId),
  ])
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function DevLauncher() {
  // ── Instance ID ───────────────────────────────────────────────────
  const [instanceId, setInstanceId] = useState(
    () => localStorage.getItem(STORAGE_KEY) ?? DEFAULT_INSTANCE,
  )
  const [inputId, setInputId] = useState(instanceId)

  // ── Concern A state ───────────────────────────────────────────────
  const [simN, setSimN] = useState('10')
  const [simBusy, setSimBusy] = useState(false)
  const [simProgress, setSimProgress] = useState<string | null>(null)
  const [simResult, setSimResult] = useState<{ chris: number; kelly: number } | null>(null)
  const [simError, setSimError] = useState<string | null>(null)

  // ── Concern C state ───────────────────────────────────────────────
  const [stageN, setStageN] = useState('20')
  const [stageBusy, setStageBusy] = useState(false)
  const [stageProgress, setStageProgress] = useState<string | null>(null)
  const [stageResult, setStageResult] = useState<{
    stage: string; students: number; groups?: number
    walk_aways?: number; deadlocked?: number
    price_min?: number | null; price_max?: number | null
    price_range?: { chris_reservation: number; kelly_reservation: number }
  } | null>(null)
  const [stageError, setStageError] = useState<string | null>(null)

  // ── Concern B state ───────────────────────────────────────────────
  const [interactiveN, setInteractiveN] = useState(4)
  const [participants, setParticipants] = useState<Participant[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [seedBusy, setSeedBusy] = useState(false)
  const [seedError, setSeedError] = useState<string | null>(null)

  // All hooks above — early return for production is after them
  if (!import.meta.env.DEV) {
    return (
      <main style={{ padding: '2rem', fontFamily: 'sans-serif' }}>
        <p>Not available.</p>
      </main>
    )
  }

  // ── Instance ID handlers ──────────────────────────────────────────

  const applyInstanceId = () => {
    const trimmed = inputId.trim()
    if (!trimmed || trimmed === instanceId) return
    localStorage.setItem(STORAGE_KEY, trimmed)
    setInstanceId(trimmed)
    setInputId(trimmed)
  }

  // ── Concern B: participant list ───────────────────────────────────

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const loadParticipants = useCallback(async (iid: string) => {
    setLoading(true)
    setLoadError(null)
    try {
      const res = await fetch(`${fsParticipantBase(iid)}?pageSize=50`, {
        headers: { Authorization: 'Bearer owner' },
      })
      const data = await res.json() as {
        documents?: Array<{ name: string; fields: Record<string, unknown> }>
      }
      const docs = data.documents ?? []
      const parsed: Participant[] = docs.map((d) => {
        const f = d.fields as Record<string, { stringValue?: string }>
        const pid = f.participant_id?.stringValue ?? d.name.split('/').pop() ?? '?'
        return {
          id: pid,
          displayName: f.display_name?.stringValue ?? '(unnamed)',
          role:        f.role?.stringValue ?? '?',
          prepStatus:  f.prep_status?.stringValue ?? '?',
          hasGroupId:  Boolean(f.group_id?.stringValue),
          hasAttendance: Boolean(f.attendance_confirmed_at),
        }
      })
      parsed.sort((a, b) => a.role.localeCompare(b.role) || a.displayName.localeCompare(b.displayName))
      setParticipants(parsed)
    } catch {
      setLoadError('Could not reach Firestore emulator on port 8081. Is it running?')
      setParticipants(null)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadParticipants(instanceId)
  }, [instanceId, loadParticipants])

  // ── Concern A: simulation ─────────────────────────────────────────

  const runSimulation = async () => {
    const n = parseInt(simN, 10)
    if (isNaN(n) || n < 2 || n > 500) {
      setSimError('N must be an integer between 2 and 500')
      return
    }
    setSimBusy(true)
    setSimProgress(null)
    setSimResult(null)
    setSimError(null)
    try {
      setSimProgress('clearing instance…')
      await clearInstanceRoles(instanceId)

      // Padded IDs: p-s-001, p-s-002, … (pad to at least 3 digits)
      const width = Math.max(3, String(n).length)
      const ids = Array.from({ length: n }, (_, i) =>
        `p-s-${String(i + 1).padStart(width, '0')}`,
      )

      // Seed bare docs (no role) so assignRole creates them from scratch
      setSimProgress(`seeding ${n} bare docs…`)
      const base = fsParticipantBase(instanceId)
      await Promise.all(
        ids.map((id) =>
          fsPatch(`${base}/${id}`, {
            participant_id:   { stringValue: id },
            game_instance_id: { stringValue: instanceId },
          }),
        ),
      )

      // Call real assignRole sequentially — one Firestore transaction per student
      for (let i = 0; i < ids.length; i++) {
        setSimProgress(`assigning ${i + 1} / ${n}…`)
        await callAssignRole(ids[i], instanceId)
      }

      // Read back role_counts/totals to verify the counter matches expectations
      setSimProgress('reading results…')
      const rcUrl = `${FS_EMULATOR}/v1/projects/${PROJECT_ID}/databases/(default)/documents/game_instances/${instanceId}/role_counts/totals`
      const rcRes = await fetch(rcUrl, { headers: { Authorization: 'Bearer owner' } })
      let chris = 0
      let kelly = 0
      if (rcRes.ok) {
        const rcData = await rcRes.json() as {
          fields?: {
            chris?: { integerValue?: string }
            kelly?: { integerValue?: string }
          }
        }
        chris = parseInt(rcData.fields?.chris?.integerValue ?? '0', 10)
        kelly = parseInt(rcData.fields?.kelly?.integerValue ?? '0', 10)
      }
      setSimResult({ chris, kelly })
    } catch (err) {
      setSimError(
        err instanceof Error ? err.message : 'Simulation failed — are emulators running?',
      )
    } finally {
      setSimBusy(false)
      setSimProgress(null)
    }
  }

  // ── Concern C: simulate at scale ─────────────────────────────────

  const runStage = async (stage: string) => {
    const n = parseInt(stageN, 10)
    if (isNaN(n) || n < 2 || n > 200) {
      setStageError('N must be an integer between 2 and 200')
      return
    }
    setStageBusy(true)
    setStageProgress(`Seeding ${n} students → "${stage}"…`)
    setStageResult(null)
    setStageError(null)
    try {
      const res = await fetch(`${FUNCTIONS_EMULATOR}/seedSimulatedGame`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ game_instance_id: instanceId, stage, n }),
      })
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(`seedSimulatedGame → HTTP ${res.status}: ${text.slice(0, 200)}`)
      }
      const data = await res.json() as {
        stage: string; students: number; groups?: number
        walk_aways?: number; deadlocked?: number
        price_min?: number | null; price_max?: number | null
        price_range?: { chris_reservation: number; kelly_reservation: number }
      }
      setStageResult(data)
      await loadParticipants(instanceId)
    } catch (err) {
      setStageError(err instanceof Error ? err.message : 'Failed — are emulators running?')
    } finally {
      setStageBusy(false)
      setStageProgress(null)
    }
  }

  // ── Concern B: seeding ────────────────────────────────────────────

  const runSeed = async (fn: (iid: string, n: number) => Promise<void>) => {
    setSeedBusy(true)
    setSeedError(null)
    try {
      await fn(instanceId, interactiveN)
      await loadParticipants(instanceId)
    } catch (err) {
      setSeedError(
        err instanceof Error ? err.message : 'Seeding failed — are both emulators running?',
      )
    } finally {
      setSeedBusy(false)
    }
  }

  const openPlayer = (participantId: string) => {
    window.open(
      `/play?_dev_participant_id=${encodeURIComponent(participantId)}&_dev_game_instance_id=${encodeURIComponent(instanceId)}`,
      '_blank',
    )
  }

  const openDashboard = () => {
    window.open(
      `/dashboard?_dev_game_instance_id=${encodeURIComponent(instanceId)}`,
      '_blank',
    )
  }

  // ── Render ────────────────────────────────────────────────────────

  const roleColor = (role: string) =>
    role === 'Chris' ? '#1a56db' : role === 'Kelly' ? '#7e3af2' : '#555'

  const activeStudents = NAMED_STUDENTS.slice(0, interactiveN)
  const simBalanced = simResult !== null && Math.abs(simResult.chris - simResult.kelly) <= 1

  return (
    <main style={{ padding: '2rem', maxWidth: '700px', margin: '0 auto', fontFamily: 'sans-serif' }}>

      <div style={{
        background: '#fff3cd', border: '1px solid #ffc107', borderRadius: 4,
        padding: '0.5rem 0.85rem', marginBottom: '1.75rem', fontSize: '0.9rem',
      }}>
        <strong>Dev / emulator only.</strong>{' '}
        This page is excluded from production builds. Reads/writes the local Firestore
        + RTDB emulators directly and calls the Functions emulator for role assignment.
      </div>

      <h1 style={{ marginTop: 0 }}>Test Launcher</h1>

      {/* ── Instance ID ──────────────────────────────────────────────── */}
      <section style={{ marginBottom: '2rem' }}>
        <label style={{ display: 'block', fontWeight: 500, marginBottom: '0.4rem' }}>
          Game instance ID
        </label>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <input
            value={inputId}
            onChange={(e) => setInputId(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') applyInstanceId() }}
            style={{
              fontFamily: 'monospace', fontSize: '0.825rem',
              padding: '0.35rem 0.5rem', flex: 1,
            }}
          />
          <button
            onClick={applyInstanceId}
            disabled={inputId.trim() === instanceId}
            style={{ whiteSpace: 'nowrap' }}
          >
            Use this ID
          </button>
        </div>
        <p style={{ margin: '0.3rem 0 0', fontSize: '0.8rem', color: '#777' }}>
          Active: <code style={{ background: '#f5f5f5', padding: '0 3px' }}>{instanceId}</code>
        </p>
      </section>

      {/* ── A: Role-balance stress test ──────────────────────────────── */}
      <section style={{
        marginBottom: '2rem', padding: '1rem 1.25rem',
        border: '1px solid #bcd4f5', borderRadius: 6, background: '#f5f9ff',
      }}>
        <h2 style={{ margin: '0 0 0.35rem', fontSize: '1rem' }}>
          A — Role-balance stress test
        </h2>
        <p style={{ margin: '0 0 0.85rem', fontSize: '0.825rem', color: '#555' }}>
          Calls the real <code>assignRole</code> endpoint N times sequentially. No browser
          windows opened. Tests Chris/Kelly balance at any class size, including odd N
          and large N (up to 500).
        </p>

        <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }}>
          <label style={{ fontSize: '0.875rem' }}>
            <strong>N students:</strong>
            <input
              type="number"
              min={2}
              max={500}
              value={simN}
              onChange={(e) => {
                setSimN(e.target.value)
                setSimResult(null)
                setSimError(null)
              }}
              disabled={simBusy}
              style={{
                width: '5rem', marginLeft: '0.5rem',
                fontFamily: 'monospace', padding: '0.25rem 0.4rem', fontSize: '0.875rem',
              }}
            />
          </label>
          <button
            onClick={() => void runSimulation()}
            disabled={simBusy}
            style={{ whiteSpace: 'nowrap' }}
          >
            {simBusy ? 'Running…' : 'Simulate N enrollments'}
          </button>
        </div>

        {simProgress && (
          <p style={{ margin: '0.5rem 0 0', fontSize: '0.825rem', color: '#555', fontStyle: 'italic' }}>
            {simProgress}
          </p>
        )}
        {simResult && !simBusy && (
          <div style={{
            marginTop: '0.6rem', padding: '0.5rem 0.8rem', borderRadius: 4, fontSize: '0.9rem',
            background: simBalanced ? '#e8f8ee' : '#fff4f4',
            border: `1px solid ${simBalanced ? '#5cb87a' : '#e57373'}`,
          }}>
            <strong>Chris: {simResult.chris} · Kelly: {simResult.kelly}</strong>
            {'  '}
            {simBalanced
              ? '✓ balanced (|Δ| ≤ 1)'
              : `✗ imbalanced — |Δ| = ${Math.abs(simResult.chris - simResult.kelly)}`}
          </div>
        )}
        {simError && (
          <p style={{ margin: '0.5rem 0 0', color: '#c00', fontSize: '0.825rem' }}>{simError}</p>
        )}
      </section>

      {/* ── C: Simulate at scale ─────────────────────────────────────── */}
      <section style={{
        marginBottom: '2rem', padding: '1rem 1.25rem',
        border: '1px solid #b8d9b8', borderRadius: 6, background: '#f4faf4',
      }}>
        <h2 style={{ margin: '0 0 0.35rem', fontSize: '1rem' }}>
          C — Simulate at scale (no windows)
        </h2>
        <p style={{ margin: '0 0 0.85rem', fontSize: '0.825rem', color: '#555' }}>
          Seeds N students with human names up to the chosen stage. No browser windows —
          use this to populate the dashboard and reports at class size. Each button
          clears the current instance first.
        </p>

        <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap', marginBottom: '0.3rem' }}>
          <label style={{ fontSize: '0.875rem' }}>
            <strong>N students:</strong>
            <input
              type="number"
              min={2}
              max={200}
              value={stageN}
              onChange={(e) => { setStageN(e.target.value); setStageResult(null); setStageError(null) }}
              disabled={stageBusy}
              style={{
                width: '4.5rem', marginLeft: '0.5rem',
                fontFamily: 'monospace', padding: '0.25rem 0.4rem', fontSize: '0.875rem',
              }}
            />
          </label>
          {(['enrolled', 'present', 'completed'] as const).map((s) => (
            <button
              key={s}
              onClick={() => void runStage(s)}
              disabled={stageBusy}
              style={{ whiteSpace: 'nowrap', textTransform: 'capitalize' }}
            >
              {stageBusy ? 'Seeding…' : s.charAt(0).toUpperCase() + s.slice(1)}
            </button>
          ))}
        </div>

        <p style={{ margin: '0 0 0.75rem', fontSize: '0.775rem', color: '#777' }}>
          <strong>Enrolled</strong> — roster only, no role/prep (Absent on dashboard).{' '}
          <strong>Present</strong> — all N prepped + attendance confirmed; use Match Now on the dashboard to form groups.{' '}
          <strong>Completed</strong> — all N matched with outcomes (walk-aways + 1 deadlocked group).
        </p>

        {stageProgress && (
          <p style={{ margin: '0.5rem 0 0', fontSize: '0.825rem', color: '#555', fontStyle: 'italic' }}>
            {stageProgress}
          </p>
        )}
        {stageResult && !stageBusy && (
          <div style={{
            marginTop: '0.6rem', padding: '0.5rem 0.8rem', borderRadius: 4, fontSize: '0.875rem',
            background: '#e8f8ee', border: '1px solid #5cb87a',
          }}>
            <strong>{stageResult.students} students seeded → {stageResult.stage}</strong>
            {stageResult.groups != null && <span> · {stageResult.groups} groups</span>}
            {stageResult.walk_aways != null && <span> · {stageResult.walk_aways} walk-away{stageResult.walk_aways !== 1 ? 's' : ''}</span>}
            {stageResult.deadlocked != null && stageResult.deadlocked > 0 && <span> · {stageResult.deadlocked} deadlocked</span>}
            {stageResult.price_min != null && stageResult.price_max != null && (
              <span> · prices ${stageResult.price_min.toLocaleString()}–${stageResult.price_max.toLocaleString()}</span>
            )}
            {stageResult.price_range && (
              <span style={{ color: '#555', fontSize: '0.8rem' }}>
                {' '}(ZOPA ${stageResult.price_range.chris_reservation.toLocaleString()}–${stageResult.price_range.kelly_reservation.toLocaleString()})
              </span>
            )}
          </div>
        )}
        {stageError && (
          <p style={{ margin: '0.5rem 0 0', color: '#c00', fontSize: '0.825rem' }}>{stageError}</p>
        )}
      </section>

      {/* ── B: Interactive flow ──────────────────────────────────────── */}
      <section style={{
        marginBottom: '2rem', padding: '1rem 1.25rem',
        border: '1px solid #ddd', borderRadius: 6,
      }}>
        <h2 style={{ margin: '0 0 0.35rem', fontSize: '1rem' }}>
          B — Interactive flow (browser windows)
        </h2>
        <p style={{ margin: '0 0 0.85rem', fontSize: '0.825rem', color: '#555' }}>
          Seeds 2–8 named students via the real <code>assignRole</code> endpoint —
          roles are not hardcoded; the role_counts counter is reset and rebuilt
          correctly. Opens per-student <code>/play</code> windows for end-to-end testing.
        </p>

        {/* N input + seed buttons */}
        <div style={{
          display: 'flex', gap: '0.75rem', alignItems: 'center',
          flexWrap: 'wrap', marginBottom: '0.5rem',
        }}>
          <label style={{ fontSize: '0.875rem' }}>
            <strong>Students (2–8):</strong>
            <input
              type="number"
              min={2}
              max={8}
              value={interactiveN}
              onChange={(e) => {
                const v = parseInt(e.target.value, 10)
                setInteractiveN(isNaN(v) ? 4 : Math.min(8, Math.max(2, v)))
              }}
              disabled={seedBusy}
              style={{
                width: '3.25rem', marginLeft: '0.5rem',
                fontFamily: 'monospace', padding: '0.25rem 0.4rem', fontSize: '0.875rem',
              }}
            />
          </label>
          <button
            onClick={() => void runSeed(doSeedPhase2Entry)}
            disabled={seedBusy}
            title="prep_status=complete — students start at the Phase 2 hold screen"
          >
            {seedBusy ? 'Seeding…' : 'Phase 2 entry'}
          </button>
          <button
            onClick={() => void runSeed(doSeedWaitingRoom)}
            disabled={seedBusy}
            title="All pre-matching steps done — students start in the waiting room"
          >
            {seedBusy ? 'Seeding…' : 'Skip to waiting room'}
          </button>
        </div>
        <p style={{ margin: '0 0 0.75rem', fontSize: '0.775rem', color: '#777' }}>
          "Phase 2 entry" — full Phase 2 flow (hold → gate → attendance → waiting room → match).{' '}
          "Skip to waiting room" — go straight to Match Now on the dashboard.
        </p>

        {seedError && (
          <p style={{ color: '#c00', margin: '0 0 0.5rem', fontSize: '0.875rem' }}>{seedError}</p>
        )}

        {/* Participant table */}
        <div style={{
          display: 'flex', justifyContent: 'space-between',
          alignItems: 'baseline', marginBottom: '0.5rem',
        }}>
          <strong style={{ fontSize: '0.875rem' }}>Participants in this instance</strong>
          <button
            onClick={() => void loadParticipants(instanceId)}
            disabled={loading}
            style={{ fontSize: '0.8rem' }}
          >
            {loading ? 'Loading…' : '↻ Refresh'}
          </button>
        </div>

        {loadError && (
          <p style={{
            color: '#c00', background: '#fff5f5', padding: '0.4rem 0.6rem',
            borderRadius: 4, fontSize: '0.875rem', marginBottom: '0.5rem',
          }}>
            {loadError}
          </p>
        )}

        {participants !== null && participants.length === 0 && (
          <p style={{ color: '#888', fontSize: '0.875rem', marginBottom: '0.5rem' }}>
            No participants yet. Use a seed button above.
          </p>
        )}

        {participants && participants.length > 0 && (
          <ul style={{
            listStyle: 'none', padding: 0, margin: '0 0 0.75rem',
            border: '1px solid #e0e0e0', borderRadius: 4, overflow: 'hidden',
          }}>
            {participants.map((p, i) => (
              <li key={p.id} style={{
                display: 'flex', alignItems: 'center', gap: '0.75rem',
                padding: '0.5rem 0.75rem',
                background: i % 2 === 0 ? '#fff' : '#fafafa',
                borderBottom: i < participants.length - 1 ? '1px solid #eee' : 'none',
              }}>
                <span style={{ fontWeight: 500, minWidth: '9rem', fontSize: '0.875rem' }}>
                  {p.displayName}
                </span>
                <span style={{
                  fontSize: '0.8rem', fontWeight: 600, minWidth: '2.75rem',
                  color: roleColor(p.role),
                }}>
                  {p.role}
                </span>
                <span style={{ fontSize: '0.75rem', color: '#999', flex: 1 }}>
                  {p.prepStatus}
                  {p.hasAttendance ? ' · attended' : ''}
                  {p.hasGroupId ? ' · matched' : ''}
                </span>
                <button
                  onClick={() => openPlayer(p.id)}
                  style={{ fontSize: '0.8rem', padding: '0.25rem 0.55rem', whiteSpace: 'nowrap' }}
                >
                  Open →
                </button>
              </li>
            ))}
          </ul>
        )}

        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
          <button onClick={() => { activeStudents.forEach((s) => openPlayer(s.id)) }}>
            Open All
          </button>
          <span style={{ fontSize: '0.8rem', color: '#777' }}>
            If windows don&apos;t all open, allow pop-ups for localhost.
          </span>
        </div>
      </section>

      {/* ── Dashboard ────────────────────────────────────────────────── */}
      <section>
        <button
          onClick={openDashboard}
          style={{ fontSize: '0.95rem', padding: '0.5rem 1.1rem' }}
        >
          Open Instructor Dashboard →
        </button>
      </section>
    </main>
  )
}
