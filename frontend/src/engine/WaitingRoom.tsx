type PresenceStatus = 'active' | 'idle' | 'disconnected'

type Participant = {
  participant_id: string
  name: string
  role: string
  presence: PresenceStatus
}

type Props = {
  participants: Participant[]
  message?: string
}

const presenceIcon: Record<PresenceStatus, string> = {
  active: '🟢',
  idle: '🟡',
  disconnected: '🔴',
}

/**
 * Shown to students after attendance verification, while waiting for the
 * instructor to trigger matching.
 */
export function WaitingRoom({ participants, message = 'Waiting to be matched...' }: Props) {
  return (
    <div style={{ padding: '2rem', maxWidth: '600px', margin: '0 auto' }}>
      <h2>{message}</h2>
      <p>Verified present:</p>
      <ul style={{ listStyle: 'none', padding: 0 }}>
        {participants.map((p) => (
          <li key={p.participant_id} style={{ marginBottom: '0.25rem' }}>
            {presenceIcon[p.presence]} {p.name} ({p.role})
          </li>
        ))}
      </ul>
    </div>
  )
}
