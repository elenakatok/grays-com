import { useState } from 'react'
import { callFunctionWithSession } from '../api'

type Props = {
  onValid: () => void
}

export default function Phase2AttendanceCode({ onValid }: Props) {
  const [code, setCode] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    const trimmed = code.trim()
    if (trimmed.length < 4) return
    setSubmitting(true)
    setError(null)
    callFunctionWithSession<{ ok: boolean }>('verifyAttendanceCode', { code: trimmed })
      .then(() => onValid())
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Something went wrong. Please try again.')
        setSubmitting(false)
      })
  }

  return (
    <main
      style={{
        padding: '2rem',
        maxWidth: '540px',
        margin: '0 auto',
        fontFamily: 'sans-serif',
      }}
    >
      <h1 style={{ marginTop: 0 }}>Enter attendance code</h1>
      <p style={{ fontSize: '1.05rem', lineHeight: 1.6, marginBottom: '1.5rem' }}>
        Enter the code your instructor is displaying.
      </p>
      <form onSubmit={handleSubmit}>
        <input
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase())}
          maxLength={6}
          placeholder="e.g. ABJKM"
          autoFocus
          autoCapitalize="characters"
          spellCheck={false}
          disabled={submitting}
          style={{
            fontSize: '2rem',
            letterSpacing: '0.25em',
            width: '100%',
            padding: '0.5rem 0.75rem',
            boxSizing: 'border-box',
            fontFamily: 'monospace',
            textTransform: 'uppercase',
          }}
        />
        {error && (
          <p style={{ color: '#c00', marginTop: '0.75rem', lineHeight: 1.4 }}>{error}</p>
        )}
        <button
          type="submit"
          disabled={submitting || code.trim().length < 4}
          style={{ marginTop: '1.25rem' }}
        >
          {submitting ? 'Checking…' : 'Submit'}
        </button>
      </form>
    </main>
  )
}
