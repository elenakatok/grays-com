import { useState } from 'react'

type Props = {
  instanceId: string
  onValid: () => void
}

/**
 * Student enters the short attendance code the instructor displays in class.
 * Verifies the code against Firestore (via Cloud Function or direct read).
 */
export function AttendanceCodeEntry({ instanceId: _instanceId, onValid }: Props) {
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setLoading(true)
    try {
      // TODO: verify code against Firestore attendance_codes/{instanceId}
      void onValid
      setError('Code verification not yet implemented.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div style={{ padding: '2rem', maxWidth: '400px', margin: '0 auto' }}>
      <h2>Enter attendance code</h2>
      <p>Enter the code your instructor is displaying.</p>
      <form onSubmit={handleSubmit}>
        <input
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase())}
          maxLength={6}
          placeholder="_ _ _ _ _ _"
          style={{ fontSize: '1.5rem', letterSpacing: '0.2em', width: '100%', padding: '0.5rem' }}
          autoFocus
        />
        {error && <p style={{ color: 'red' }}>{error}</p>}
        <button type="submit" disabled={loading || code.length < 4} style={{ marginTop: '1rem' }}>
          {loading ? 'Checking...' : 'Submit'}
        </button>
      </form>
    </div>
  )
}
