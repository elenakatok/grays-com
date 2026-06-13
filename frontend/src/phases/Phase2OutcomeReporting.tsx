import { useEffect, useRef, useState } from 'react'
import { doc, onSnapshot } from 'firebase/firestore'
import { db } from '../firebase'
import { type CallArgs, submitLeadOutcome, submitConfirmation } from '../api'

type LeadOutcome = { price: number | null; no_deal: boolean }
type Confirmation = 'pending' | 'confirmed' | 'disagreed'

type GroupData = {
  status: string
  disagree_count: number
  lead_outcome: LeadOutcome | null
  confirmations: Record<string, Confirmation>
  agreement_reached: boolean | null
  final_price: number | null
  chris_participants: string[]
  kelly_participants: string[]
  lead_participant_id: string
}

type Props = {
  groupId: string
  participantId: string
  gameInstanceId: string
  isLead: boolean
  callArgs: CallArgs
  onComplete: () => void
}

function formatPrice(p: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(p)
}

function outcomeLabel(lo: LeadOutcome): string {
  return lo.no_deal ? 'No deal reached.' : `Agreement at ${formatPrice(lo.price!)}`
}

export default function Phase2OutcomeReporting({
  groupId,
  participantId,
  gameInstanceId,
  isLead,
  callArgs,
  onComplete,
}: Props) {
  const [groupData, setGroupData] = useState<GroupData | null>(null)
  const [priceInput, setPriceInput] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const calledComplete = useRef(false)
  const onCompleteRef = useRef(onComplete)
  onCompleteRef.current = onComplete

  useEffect(() => {
    return onSnapshot(
      doc(db, 'game_instances', gameInstanceId, 'groups', groupId),
      (snap) => {
        if (!snap.exists()) return
        const d = snap.data() as GroupData
        setGroupData(d)
        if (d.status === 'completed' && !calledComplete.current) {
          calledComplete.current = true
          onCompleteRef.current()
        }
      },
    )
  }, [groupId, gameInstanceId]) // onComplete intentionally omitted — held via ref above

  // ── Shared action helpers ────────────────────────────────────────
  const withSubmit = (fn: () => Promise<unknown>) => {
    setSubmitting(true)
    setActionError(null)
    fn()
      .catch((err: unknown) => {
        setActionError(err instanceof Error ? err.message : 'Something went wrong.')
      })
      .finally(() => setSubmitting(false))
  }

  const handleSubmitPrice = () => {
    const raw = priceInput.replace(/[,$\s]/g, '')
    const price = parseFloat(raw)
    if (isNaN(price) || price <= 0) {
      setActionError('Please enter a valid price (a positive number).')
      return
    }
    withSubmit(() => submitLeadOutcome(callArgs, Math.round(price)).then(() => setPriceInput('')))
  }

  const handleNoDeal = () => withSubmit(() => submitLeadOutcome(callArgs, null))

  const handleConfirm = () => withSubmit(() => submitConfirmation(callArgs, true))
  const handleDisagree = () => withSubmit(() => submitConfirmation(callArgs, false))

  // ── Loading ──────────────────────────────────────────────────────
  if (!groupData) {
    return (
      <main style={mainStyle}>
        <p>Loading…</p>
      </main>
    )
  }

  const { status, disagree_count, lead_outcome, confirmations } = groupData
  const role: 'Chris' | 'Kelly' = groupData.chris_participants.includes(participantId) ? 'Chris' : 'Kelly'

  // ── Deadlock ─────────────────────────────────────────────────────
  if (status === 'deadlocked') {
    return (
      <main style={mainStyle}>
        <p style={{ color: '#555', marginTop: 0, marginBottom: '1.25rem' }}>You are {role}</p>
        <h1 style={{ marginTop: 0 }}>Instructor intervention needed</h1>
        <p style={{ fontSize: '1.05rem', lineHeight: 1.6, marginBottom: '1rem' }}>
          Your group was unable to agree on the outcome after 3 attempts.
        </p>
        <p style={{ color: '#555' }}>
          Your instructor has been notified and will enter the outcome manually.
          Stay on this screen.
        </p>
      </main>
    )
  }

  // ── LEAD view ────────────────────────────────────────────────────
  if (isLead) {
    if (lead_outcome == null) {
      // Entry form
      const retrying = disagree_count > 0
      return (
        <main style={mainStyle}>
          <p style={{ color: '#555', marginTop: 0, marginBottom: '1.25rem' }}>You are {role}</p>
          <h1 style={{ marginTop: 0 }}>Report outcome</h1>
          {retrying && (
            <p
              style={{
                color: '#c00',
                background: '#fff5f5',
                padding: '0.6rem 0.8rem',
                borderRadius: 4,
                marginBottom: '1rem',
                fontSize: '0.95rem',
              }}
            >
              A group member disagreed. Please coordinate and re-enter the outcome.
            </p>
          )}
          <p style={{ fontSize: '1.05rem', lineHeight: 1.6, marginBottom: '1rem' }}>
            Enter the agreed price (in US dollars):
          </p>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '1rem',
              flexWrap: 'wrap',
              marginBottom: '1rem',
            }}
          >
            <input
              type="number"
              min="0"
              step="1"
              placeholder="Enter a whole dollar amount"
              value={priceInput}
              onChange={(e) => setPriceInput(e.target.value)}
              disabled={submitting}
              style={{
                fontSize: '1.25rem',
                padding: '0.4rem 0.6rem',
                width: '12rem',
                fontFamily: 'monospace',
              }}
            />
            <button
              onClick={handleNoDeal}
              disabled={submitting}
              style={{ background: 'none', border: '1px solid #ccc', marginLeft: 'auto' }}
            >
              No deal
            </button>
          </div>
          {actionError && <p style={{ color: '#c00', marginBottom: '0.5rem' }}>{actionError}</p>}
          <button onClick={handleSubmitPrice} disabled={submitting || priceInput.trim() === ''}>
            {submitting ? 'Submitting…' : 'Submit'}
          </button>
        </main>
      )
    }

    // Lead has submitted — waiting for confirmations
    const total = Object.keys(confirmations).length
    const confirmed = Object.values(confirmations).filter((v) => v === 'confirmed').length
    return (
      <main style={mainStyle}>
        <p style={{ color: '#555', marginTop: 0, marginBottom: '1.25rem' }}>You are {role}</p>
        <h1 style={{ marginTop: 0 }}>Waiting for your group</h1>
        <p style={{ fontSize: '1.05rem', lineHeight: 1.6, marginBottom: '1rem' }}>
          You reported: <strong>{outcomeLabel(lead_outcome)}</strong>
        </p>
        <p style={{ color: '#555' }}>
          {confirmed} of {total} group member{total !== 1 ? 's' : ''} confirmed.
        </p>
        {actionError && <p style={{ color: '#c00', marginTop: '0.5rem' }}>{actionError}</p>}
      </main>
    )
  }

  // ── NON-LEAD view ────────────────────────────────────────────────
  if (lead_outcome == null) {
    // Waiting for lead
    const retrying = disagree_count > 0
    return (
      <main style={mainStyle}>
        <p style={{ color: '#555', marginTop: 0, marginBottom: '1.25rem' }}>You are {role}</p>
        <h1 style={{ marginTop: 0 }}>Waiting for the outcome</h1>
        <p style={{ fontSize: '1.05rem', lineHeight: 1.6, color: '#555' }}>
          {retrying
            ? 'A disagreement was logged. The lead is re-entering the outcome.'
            : 'Your group lead is reporting the negotiation result. Stay on this page.'}
        </p>
      </main>
    )
  }

  // Non-lead has a report to review
  const myConf = confirmations[participantId]

  if (myConf === 'pending') {
    return (
      <main style={mainStyle}>
        <p style={{ color: '#555', marginTop: 0, marginBottom: '1.25rem' }}>You are {role}</p>
        <h1 style={{ marginTop: 0 }}>Confirm the outcome</h1>
        <p style={{ fontSize: '1.05rem', lineHeight: 1.6, marginBottom: '1.5rem' }}>
          Your lead reported:{' '}
          <strong>{outcomeLabel(lead_outcome)}</strong>
        </p>
        <p style={{ color: '#555', marginBottom: '1.5rem' }}>
          Does this match what you negotiated?
        </p>
        {actionError && <p style={{ color: '#c00', marginBottom: '0.75rem' }}>{actionError}</p>}
        <div style={{ display: 'flex', gap: '1rem' }}>
          <button onClick={handleConfirm} disabled={submitting}>
            {submitting ? '…' : 'Confirm'}
          </button>
          <button
            onClick={handleDisagree}
            disabled={submitting}
            style={{ background: 'none', border: '1px solid #ccc' }}
          >
            Disagree
          </button>
        </div>
      </main>
    )
  }

  // Already responded — waiting for others
  const total = Object.keys(confirmations).length
  const confirmed = Object.values(confirmations).filter((v) => v === 'confirmed').length
  return (
    <main style={mainStyle}>
      <p style={{ color: '#555', marginTop: 0, marginBottom: '1.25rem' }}>You are {role}</p>
      <h1 style={{ marginTop: 0 }}>Waiting for your group</h1>
      <p style={{ fontSize: '1.05rem', lineHeight: 1.6, marginBottom: '1rem' }}>
        You confirmed: <strong>{outcomeLabel(lead_outcome)}</strong>
      </p>
      <p style={{ color: '#555' }}>
        {confirmed} of {total} member{total !== 1 ? 's' : ''} confirmed.
      </p>
    </main>
  )
}

const mainStyle: React.CSSProperties = {
  padding: '2rem',
  maxWidth: '640px',
  margin: '0 auto',
  fontFamily: 'sans-serif',
}
