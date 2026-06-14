import { useEffect, useRef } from 'react'
import { doc, onSnapshot } from 'firebase/firestore'
import { db } from '../firebase'

type Props = {
  groupId: string
  gameInstanceId: string
  participantId: string
  onReportOutcome: (isLead: boolean) => void
}

export default function Phase2OffPlatformHolding({ groupId, gameInstanceId, participantId, onReportOutcome }: Props) {
  const calledReport = useRef(false)
  const onReportRef = useRef(onReportOutcome)
  onReportRef.current = onReportOutcome
  // Populated on the first snapshot; used to compute lead status from the source of truth
  // rather than the session ref (which is set before matching writes is_lead).
  const leadParticipantIdRef = useRef<string | null>(null)

  // Auto-advance when status → reporting, branching on actual lead status from the group doc.
  useEffect(() => {
    return onSnapshot(
      doc(db, 'game_instances', gameInstanceId, 'groups', groupId),
      (snap) => {
        if (!snap.exists()) return
        const d = snap.data() as { status: string; lead_participant_id: string }
        leadParticipantIdRef.current = d.lead_participant_id
        if (d.status === 'reporting' && !calledReport.current) {
          calledReport.current = true
          onReportRef.current(d.lead_participant_id === participantId)
        }
      },
    )
  }, [groupId, gameInstanceId, participantId])

  const handleClick = () => {
    if (!calledReport.current) {
      calledReport.current = true
      onReportRef.current(leadParticipantIdRef.current === participantId)
    }
  }

  return (
    <main
      style={{
        padding: '2rem',
        maxWidth: '640px',
        margin: '0 auto',
        fontFamily: 'sans-serif',
      }}
    >
      <h1 style={{ marginTop: 0 }}>Negotiate with your partner</h1>
      <p style={{ fontSize: '1.05rem', lineHeight: 1.6, marginBottom: '1rem' }}>
        The negotiation happens face-to-face. Find your partner and negotiate a price
        — or decide to walk away.
      </p>
      <p style={{ color: '#555', marginBottom: '2.5rem' }}>
        Come back to this screen when your negotiation is complete.
      </p>
      <button
        onClick={handleClick}
        style={{ fontSize: '1rem', padding: '0.6rem 1.25rem' }}
      >
        We&apos;ve finished — report our outcome
      </button>
    </main>
  )
}
