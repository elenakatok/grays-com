/**
 * DEV-ONLY test launcher — not included in production builds.
 *
 * Opens student /play windows and the instructor dashboard with the correct
 * _dev_* query params pre-filled, so you don't have to copy-paste URLs by hand.
 * Also seeds standard test participants into the Firestore emulator.
 *
 * Reads participants via the Firestore emulator admin endpoint
 * (Authorization: Bearer owner — bypasses security rules).
 * Writes RTDB attending records via the RTDB emulator admin endpoint
 * (?access_token=owner&ns=grays-mygames-live).
 */

import { useCallback, useEffect, useState } from 'react'

// These constants match the emulator ports in firebase.json
const FS_EMULATOR  = 'http://127.0.0.1:8081'
const RTDB_EMULATOR = 'http://127.0.0.1:9001'
const PROJECT_ID   = 'grays-mygames-live'
const RTDB_NS      = 'grays-mygames-live'
const DEFAULT_INSTANCE = 'dd000000-0000-0000-0000-000000000000'
const STORAGE_KEY  = 'dev_launcher_instance_id'

type Participant = {
  id: string
  displayName: string
  role: 'Chris' | 'Kelly' | string
  prepStatus: string
  hasGroupId: boolean
  hasAttendance: boolean
}

// ── Emulator helpers ──────────────────────────────────────────────────────────

function fsBase(instanceId: string) {
  return `${FS_EMULATOR}/v1/projects/${PROJECT_ID}/databases/(default)/documents/game_instances/${instanceId}/participants`
}

async function fsPatch(url: string, fields: Record<string, unknown>) {
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { 'Authorization': 'Bearer owner', 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields }),
  })
  if (!res.ok) throw new Error(`Firestore PATCH failed: ${res.status}`)
}

async function rtdbPut(path: string, data: unknown) {
  const url = `${RTDB_EMULATOR}${path}?ns=${RTDB_NS}&access_token=owner`
  const res = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
  if (!res.ok) throw new Error(`RTDB PUT failed: ${res.status}`)
}

// ── Seed definitions ──────────────────────────────────────────────────────────

const SEED_MEMBERS = [
  { id: 'p-alice', role: 'Chris', name: 'Alice Johnson' },
  { id: 'p-carol', role: 'Chris', name: 'Carol Davis'   },
  { id: 'p-bob',   role: 'Kelly', name: 'Bob Smith'     },
  { id: 'p-dan',   role: 'Kelly', name: 'Dan Lee'       },
]

const FIXED_TS = '2026-06-01T10:00:00Z'

async function fsDelete(url: string) {
  await fetch(url, { method: 'DELETE', headers: { 'Authorization': 'Bearer owner' } })
}

async function seedPhase2Entry(instanceId: string) {
  const base = fsBase(instanceId)
  // Delete first so existing Phase 2 fields (confirmed_ready_at, attendance_confirmed_at,
  // group_id, etc.) are fully cleared — Firestore PATCH merges on the emulator.
  await Promise.all(SEED_MEMBERS.map(({ id }) => fsDelete(`${base}/${id}`)))
  await Promise.all(SEED_MEMBERS.map(({ id, role, name }) =>
    fsPatch(`${base}/${id}`, {
      participant_id:   { stringValue: id },
      game_instance_id: { stringValue: instanceId },
      role:             { stringValue: role },
      display_name:     { stringValue: name },
      prep_status:      { stringValue: 'complete' },
    }),
  ))
}

async function seedWaitingRoom(instanceId: string) {
  const base = fsBase(instanceId)
  const now = Date.now()
  await Promise.all(SEED_MEMBERS.map(async ({ id, role, name }) => {
    await fsPatch(`${base}/${id}`, {
      participant_id:           { stringValue: id },
      game_instance_id:         { stringValue: instanceId },
      role:                     { stringValue: role },
      display_name:             { stringValue: name },
      prep_status:              { stringValue: 'complete' },
      confirmed_ready_at:       { timestampValue: FIXED_TS },
      attendance_confirmed_at:  { timestampValue: FIXED_TS },
    })
    await rtdbPut(
      `/attending/${instanceId}/${id}.json`,
      { display_name: name, role, confirmed_at: now },
    )
  }))
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function DevLauncher() {
  // Belt-and-suspenders: component refuses to render in production even if the
  // route somehow survived tree-shaking.
  if (!import.meta.env.DEV) {
    return (
      <main style={{ padding: '2rem', fontFamily: 'sans-serif' }}>
        <p>Not available.</p>
      </main>
    )
  }

  const [instanceId, setInstanceId] = useState(
    () => localStorage.getItem(STORAGE_KEY) ?? DEFAULT_INSTANCE,
  )
  const [inputId, setInputId] = useState(instanceId)
  const [participants, setParticipants] = useState<Participant[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [seedBusy, setSeedBusy] = useState(false)
  const [seedError, setSeedError] = useState<string | null>(null)

  const loadParticipants = useCallback(async (iid: string) => {
    setLoading(true)
    setLoadError(null)
    try {
      const res = await fetch(
        `${FS_EMULATOR}/v1/projects/${PROJECT_ID}/databases/(default)/documents/game_instances/${iid}/participants?pageSize=50`,
        { headers: { 'Authorization': 'Bearer owner' } },
      )
      const data = await res.json() as { documents?: Array<{ name: string; fields: Record<string, unknown> }> }
      const docs = data.documents ?? []

      const parsed: Participant[] = docs.map((d) => {
        const f = d.fields as Record<string, { stringValue?: string; booleanValue?: boolean }>
        const pid = f.participant_id?.stringValue ?? d.name.split('/').pop() ?? '?'
        return {
          id: pid,
          displayName: f.display_name?.stringValue ?? '(unnamed)',
          role: f.role?.stringValue ?? '?',
          prepStatus: f.prep_status?.stringValue ?? '?',
          hasGroupId: Boolean(f.group_id?.stringValue),
          hasAttendance: Boolean(f.attendance_confirmed_at),
        }
      })

      parsed.sort((a, b) =>
        a.role.localeCompare(b.role) || a.displayName.localeCompare(b.displayName),
      )
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

  const applyInstanceId = () => {
    const trimmed = inputId.trim()
    if (!trimmed || trimmed === instanceId) return
    localStorage.setItem(STORAGE_KEY, trimmed)
    setInstanceId(trimmed)
    setInputId(trimmed)
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

  const seed = async (fn: (iid: string) => Promise<void>) => {
    setSeedBusy(true)
    setSeedError(null)
    try {
      await fn(instanceId)
      await loadParticipants(instanceId)
    } catch (err) {
      setSeedError(
        err instanceof Error ? err.message : 'Seeding failed — are both emulators running?',
      )
    } finally {
      setSeedBusy(false)
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────

  const roleColor = (role: string) =>
    role === 'Chris' ? '#1a56db' : role === 'Kelly' ? '#7e3af2' : '#555'

  return (
    <main style={{ padding: '2rem', maxWidth: '660px', margin: '0 auto', fontFamily: 'sans-serif' }}>

      {/* Dev-only banner */}
      <div style={{
        background: '#fff3cd', border: '1px solid #ffc107', borderRadius: 4,
        padding: '0.5rem 0.85rem', marginBottom: '1.75rem', fontSize: '0.9rem',
      }}>
        <strong>Dev / emulator only.</strong> This page is excluded from production builds.
        It opens <code>/play</code> with <code>_dev_*</code> params and reads/writes the
        local Firestore + RTDB emulators directly.
      </div>

      <h1 style={{ marginTop: 0 }}>Test Launcher</h1>

      {/* Instance ID */}
      <section style={{ marginBottom: '1.75rem' }}>
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

      {/* Seed controls */}
      <section style={{ marginBottom: '1.75rem' }}>
        <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', alignItems: 'center' }}>
          <strong style={{ fontSize: '0.9rem' }}>Seed 4 test students (2C + 2K):</strong>
          <button
            onClick={() => void seed(seedPhase2Entry)}
            disabled={seedBusy}
            title="prep_status=complete, no Phase 2 fields — students start at the Phase 2 hold screen"
          >
            {seedBusy ? 'Seeding…' : 'Phase 2 entry'}
          </button>
          <button
            onClick={() => void seed(seedWaitingRoom)}
            disabled={seedBusy}
            title="All pre-matching steps done — students start in the waiting room, ready for Match Now"
          >
            {seedBusy ? 'Seeding…' : 'Skip to waiting room'}
          </button>
        </div>
        {seedError && (
          <p style={{ color: '#c00', marginTop: '0.4rem', fontSize: '0.875rem' }}>{seedError}</p>
        )}
        <p style={{ margin: '0.4rem 0 0', fontSize: '0.8rem', color: '#777' }}>
          "Phase 2 entry" — full Phase 2 flow (hold → gate → attendance code → waiting room → match).
          "Skip to waiting room" — go straight to Match Now on the dashboard.
          Both presets overwrite any existing record for these 4 participant IDs.
        </p>
      </section>

      {/* Participant list */}
      <section style={{ marginBottom: '1.75rem' }}>
        <div style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
          marginBottom: '0.6rem',
        }}>
          <h2 style={{ margin: 0, fontSize: '1.1rem' }}>
            Participants in this instance
          </h2>
          <button
            onClick={() => void loadParticipants(instanceId)}
            disabled={loading}
            style={{ fontSize: '0.825rem' }}
          >
            {loading ? 'Loading…' : '↻ Refresh'}
          </button>
        </div>

        {loadError && (
          <p style={{
            color: '#c00', background: '#fff5f5',
            padding: '0.5rem 0.75rem', borderRadius: 4, fontSize: '0.875rem',
          }}>
            {loadError}
          </p>
        )}

        {participants !== null && participants.length === 0 && (
          <p style={{ color: '#888', fontSize: '0.9rem' }}>
            No participants yet. Use a Seed button above to add test students.
          </p>
        )}

        {participants && participants.length > 0 && (
          <ul style={{
            listStyle: 'none', padding: 0, margin: 0,
            border: '1px solid #e0e0e0', borderRadius: 4, overflow: 'hidden',
          }}>
            {participants.map((p, i) => (
              <li key={p.id} style={{
                display: 'flex', alignItems: 'center', gap: '0.75rem',
                padding: '0.55rem 0.75rem',
                background: i % 2 === 0 ? '#fff' : '#fafafa',
                borderBottom: '1px solid #eee',
              }}>
                <span style={{ fontWeight: 500, minWidth: '10rem' }}>{p.displayName}</span>
                <span style={{
                  fontSize: '0.825rem', fontWeight: 600, minWidth: '2.75rem',
                  color: roleColor(p.role),
                }}>
                  {p.role}
                </span>
                <span style={{ fontSize: '0.775rem', color: '#999', flex: 1 }}>
                  {p.prepStatus}
                  {p.hasAttendance ? ' · attended' : ''}
                  {p.hasGroupId ? ' · matched' : ''}
                </span>
                <button
                  onClick={() => openPlayer(p.id)}
                  style={{ fontSize: '0.825rem', padding: '0.3rem 0.65rem', whiteSpace: 'nowrap' }}
                >
                  Open →
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Dashboard button */}
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
