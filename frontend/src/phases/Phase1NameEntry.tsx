import { useEffect, useRef, useState } from 'react'
import { doc, getDoc, updateDoc } from 'firebase/firestore'
import { db } from '../firebase'

type Props = {
  participantId: string
  gameInstanceId: string
  onComplete: () => void
}

export default function Phase1NameEntry({ participantId, gameInstanceId, onComplete }: Props) {
  const [name, setName] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)
  const [validationError, setValidationError] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)

  const onCompleteRef = useRef(onComplete)
  onCompleteRef.current = onComplete

  useEffect(() => {
    const load = async () => {
      const snap = await getDoc(
        doc(db, 'game_instances', gameInstanceId, 'participants', participantId),
      )
      const existing = snap.data()?.display_name
      if (typeof existing === 'string') setName(existing)
      setLoaded(true)
    }
    void load()
  }, [gameInstanceId, participantId])

  if (!loaded) {
    return (
      <main style={{ padding: '2rem', maxWidth: '640px', margin: '0 auto' }}>
        <p>Loading…</p>
      </main>
    )
  }

  const handleSubmit = async () => {
    const trimmed = name.trim()
    if (!trimmed) {
      setValidationError('Please enter your name before continuing.')
      return
    }

    setValidationError(null)
    setSaveError(null)
    setSaving(true)

    try {
      await updateDoc(
        doc(db, 'game_instances', gameInstanceId, 'participants', participantId),
        { display_name: trimmed },
      )
      onCompleteRef.current()
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Failed to save. Please try again.')
      setSaving(false)
    }
  }

  return (
    <main style={{ padding: '2rem', maxWidth: '640px', margin: '0 auto', fontFamily: 'sans-serif' }}>
      <p style={{ color: '#555', marginBottom: '0.25rem' }}>Step 6 of 7</p>
      <h1 style={{ marginTop: 0, marginBottom: '0.5rem' }}>Your name</h1>
      <p style={{ color: '#555', marginTop: 0, marginBottom: '1.75rem' }}>
        Your negotiation partner will see this name during the exercise. You can use your real
        name or the character&apos;s name — your choice.
      </p>

      <input
        type="text"
        value={name}
        onChange={(e) => {
          setName(e.target.value)
          setValidationError(null)
        }}
        onKeyDown={(e) => { if (e.key === 'Enter') void handleSubmit() }}
        placeholder="Full name"
        disabled={saving}
        autoFocus
        style={{
          width: '100%',
          padding: '0.75rem',
          fontSize: '1rem',
          border: '1px solid #ccc',
          borderRadius: '4px',
          fontFamily: 'inherit',
          boxSizing: 'border-box',
        }}
      />

      {validationError && (
        <p style={{ margin: '0.75rem 0 0', color: '#800' }}>{validationError}</p>
      )}

      {saveError && (
        <p style={{ margin: '0.75rem 0 0', color: '#800' }}>{saveError}</p>
      )}

      <div style={{ marginTop: '2rem' }}>
        <button
          onClick={() => void handleSubmit()}
          disabled={saving}
          style={{
            padding: '0.75rem 2rem',
            fontSize: '1rem',
            cursor: saving ? 'not-allowed' : 'pointer',
            backgroundColor: saving ? '#999' : '#1a1a1a',
            color: '#fff',
            border: 'none',
            borderRadius: '4px',
            transition: 'background-color 0.15s',
          }}
        >
          {saving ? 'Saving…' : 'Continue'}
        </button>
      </div>
    </main>
  )
}
