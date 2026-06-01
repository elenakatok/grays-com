import { useState } from 'react'
import { type CallArgs, submitKnowledgeCheck } from '../api'

type Props = {
  callArgs: CallArgs
  onComplete: () => void
}

const OPTIONS: Array<{ value: 'Chris' | 'Kelly'; label: string }> = [
  { value: 'Chris', label: 'Chris Gray, the seller' },
  { value: 'Kelly', label: 'Kelly Kaplan, the buyer' },
]

export default function Phase1KnowledgeCheck({ callArgs, onComplete }: Props) {
  const [selected, setSelected] = useState<'Chris' | 'Kelly' | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [wrongAnswer, setWrongAnswer] = useState(false)
  const [serverError, setServerError] = useState<string | null>(null)

  const handleSubmit = async () => {
    if (!selected || submitting) return
    setSubmitting(true)
    setWrongAnswer(false)
    setServerError(null)

    try {
      const result = await submitKnowledgeCheck(callArgs, selected)
      if (result.correct) {
        onComplete()
      } else {
        setWrongAnswer(true)
        setSubmitting(false)
      }
    } catch (err) {
      setServerError(err instanceof Error ? err.message : 'Something went wrong. Please try again.')
      setSubmitting(false)
    }
  }

  return (
    <main style={{ padding: '2rem', maxWidth: '640px', margin: '0 auto', fontFamily: 'sans-serif' }}>
      <p style={{ color: '#555', marginBottom: '0.25rem' }}>Knowledge check</p>
      <h1 style={{ marginTop: 0, marginBottom: '1.75rem' }}>
        What is your role in the negotiation?
      </h1>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
        {OPTIONS.map(({ value, label }) => {
          const isSelected = selected === value
          return (
            <label
              key={value}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.75rem',
                padding: '0.875rem 1rem',
                border: `1px solid ${isSelected ? '#1a1a1a' : '#ccc'}`,
                borderRadius: '4px',
                cursor: 'pointer',
                fontWeight: isSelected ? 600 : 400,
                transition: 'border-color 0.1s',
              }}
            >
              <input
                type="radio"
                name="role"
                value={value}
                checked={isSelected}
                onChange={() => {
                  setSelected(value)
                  setWrongAnswer(false)
                }}
                style={{ accentColor: '#1a1a1a', width: '1rem', height: '1rem', flexShrink: 0 }}
              />
              {label}
            </label>
          )
        })}
      </div>

      {wrongAnswer && (
        <p
          role="alert"
          style={{
            marginTop: '1.25rem',
            padding: '0.875rem 1rem',
            backgroundColor: '#fff8f8',
            border: '1px solid #e0b0b0',
            borderRadius: '4px',
            color: '#800',
          }}
        >
          That&apos;s not right. Please review your role information and try again.
        </p>
      )}

      {serverError && (
        <p style={{ marginTop: '1rem', color: '#800' }}>{serverError}</p>
      )}

      <div style={{ marginTop: '2rem' }}>
        <button
          onClick={() => void handleSubmit()}
          disabled={!selected || submitting}
          style={{
            padding: '0.75rem 2rem',
            fontSize: '1rem',
            cursor: selected && !submitting ? 'pointer' : 'not-allowed',
            backgroundColor: selected && !submitting ? '#1a1a1a' : '#999',
            color: '#fff',
            border: 'none',
            borderRadius: '4px',
            transition: 'background-color 0.15s',
          }}
        >
          {submitting ? 'Checking…' : 'Submit'}
        </button>
      </div>
    </main>
  )
}
