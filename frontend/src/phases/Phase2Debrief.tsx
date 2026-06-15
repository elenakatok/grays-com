import { useEffect, useState } from 'react'
import { doc, getDoc } from 'firebase/firestore'
import { db } from '../firebase'
import { type CallArgs, submitDebriefOffer } from '../api'
import { parsePrice } from '../utils/parsePrice'

type Props = {
  groupId: string
  participantId: string
  gameInstanceId: string
  callArgs: CallArgs
}

const fmt = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
})

export default function Phase2Debrief({
  participantId,
  gameInstanceId,
  callArgs,
}: Props) {
  const [step, setStep] = useState<'loading' | 'question' | 'done'>('loading')
  const [priceInput, setPriceInput] = useState('')
  const [pendingConfirm, setPendingConfirm] = useState<number | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  useEffect(() => {
    getDoc(doc(db, 'game_instances', gameInstanceId, 'participants', participantId))
      .then((snap) => {
        const data = snap.data() ?? {}
        setStep(data.debrief_initial_offer != null ? 'done' : 'question')
      })
      .catch(() => setStep('question'))
  }, [gameInstanceId, participantId])

  const doSubmit = (value: number) => {
    setSubmitting(true)
    setActionError(null)
    submitDebriefOffer(callArgs, value)
      .then(() => { setSubmitting(false); setStep('done') })
      .catch((err: unknown) => {
        setActionError(err instanceof Error ? err.message : 'Something went wrong.')
        setSubmitting(false)
      })
  }

  const handleSubmit = () => {
    const result = parsePrice(priceInput)
    if (result.kind === 'invalid') {
      setActionError('Please enter a valid price (a positive number).')
      return
    }
    if (result.kind === 'confirm') {
      setActionError(null)
      setPendingConfirm(result.proposed)
      return
    }
    doSubmit(result.value)
  }

  if (step === 'loading') {
    return <main style={mainStyle}><p>Loading…</p></main>
  }

  if (step === 'done') {
    return (
      <main style={mainStyle}>
        <h1 style={{ marginTop: 0 }}>You're all done</h1>
        <p style={{ color: '#555', lineHeight: 1.6 }}>
          Your response has been recorded. Thank you for participating.
        </p>
      </main>
    )
  }

  return (
    <main style={mainStyle}>
      <h1 style={{ marginTop: 0 }}>One quick question</h1>
      <p style={{ fontSize: '1.05rem', lineHeight: 1.6, marginBottom: '1.25rem' }}>
        What was the first price offer made in your negotiation?
        <br />
        <span style={{ color: '#555', fontSize: '0.95rem' }}>
          (the actual opening number put on the table)
        </span>
      </p>

      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1rem' }}>
        <span style={{ fontSize: '1.1rem', color: '#555', userSelect: 'none' }}>$</span>
        <input
          type="text"
          inputMode="decimal"
          placeholder="e.g. 300000 or 300K"
          value={priceInput}
          onChange={(e) => {
            setPriceInput(e.target.value)
            setPendingConfirm(null)
            setActionError(null)
          }}
          disabled={submitting}
          style={{
            flex: 1,
            padding: '0.75rem',
            fontSize: '1rem',
            border: '1px solid #ccc',
            borderRadius: 4,
            fontFamily: 'inherit',
          }}
        />
      </div>

      {pendingConfirm != null ? (
        <div
          style={{
            marginBottom: '0.75rem',
            padding: '0.75rem',
            background: '#f0f7ff',
            border: '1px solid #b3d4f5',
            borderRadius: 4,
          }}
        >
          <p style={{ margin: '0 0 0.6rem', fontSize: '0.95rem' }}>
            You entered <strong>{fmt.format(pendingConfirm)}</strong>. Is that correct?
          </p>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <button
              onClick={() => { const v = pendingConfirm; setPendingConfirm(null); doSubmit(v) }}
              disabled={submitting}
            >
              {submitting ? 'Submitting…' : 'Yes'}
            </button>
            <button
              onClick={() => setPendingConfirm(null)}
              disabled={submitting}
              style={{ background: 'none', border: '1px solid #ccc' }}
            >
              No
            </button>
          </div>
        </div>
      ) : (
        <>
          {actionError && <p style={{ color: '#c00', marginBottom: '0.5rem' }}>{actionError}</p>}
          <button
            onClick={handleSubmit}
            disabled={submitting || priceInput.trim() === ''}
          >
            {submitting ? 'Submitting…' : 'Submit'}
          </button>
        </>
      )}
    </main>
  )
}

const mainStyle: React.CSSProperties = {
  padding: '2rem',
  maxWidth: '640px',
  margin: '0 auto',
  fontFamily: 'sans-serif',
}
