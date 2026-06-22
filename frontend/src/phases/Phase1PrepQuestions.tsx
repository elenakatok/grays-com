import { useEffect, useRef, useState } from 'react'
import { doc, updateDoc } from 'firebase/firestore'
import { db } from '../firebase'
import { type PrepTextQuestion, callFunctionWithSession } from '../api'
import { parsePrice } from '../utils/parsePrice'

// ── Defaults (fallback if config fetch fails) ──────────────────────────────────
// Mirrors SYSTEM_QUESTION_DEFAULTS + DEFAULT_PREP_TEXT_QUESTIONS in functions/src/index.ts.

const DEFAULT_QUESTIONS: PrepTextQuestion[] = [
  {
    field: 'prep_first_topic', type: 'text', system: false,
    category: 'preparation', format: 'text', role_target: 'both',
    prompt: 'When you sit down to talk, what is the first topic you will bring up with the other side?',
    placeholder: '', order: 0, hidden: false, deletable: true,
  },
  {
    field: 'prep_estimated_other_price', type: 'number', system: true,
    category: 'preparation', format: 'number', role_target: 'both',
    prompt: "What is your best guess of the other side's walk-away value (reservation price)?",
    placeholder: 'Enter an amount', order: 1, hidden: false, deletable: false,
  },
  {
    field: 'prep_question_for_other', type: 'text', system: false,
    category: 'preparation', format: 'text', role_target: 'both',
    prompt: 'What question would you most like to ask the other side? Why?',
    placeholder: '', order: 2, hidden: false, deletable: true,
  },
  {
    field: 'prep_planned_first_offer', type: 'number', system: true,
    category: 'preparation', format: 'number', role_target: 'both',
    prompt: 'Assuming you make the first offer, what number do you think you will put on the table? This is non-binding.',
    placeholder: 'Enter an amount', order: 3, hidden: false, deletable: false,
  },
  {
    field: 'prep_planned_offer_reason', type: 'text', system: false,
    category: 'preparation', format: 'text', role_target: 'both',
    prompt: 'What is the reason for the number you gave?',
    placeholder: '', order: 4, hidden: false, deletable: true,
  },
]

// ── Component ──────────────────────────────────────────────────────────────────

const fmtPrice = new Intl.NumberFormat('en-US', {
  style: 'currency', currency: 'USD', maximumFractionDigits: 0,
})

type Props = {
  participantId: string
  gameInstanceId: string
  onComplete: () => void
}

export default function Phase1PrepQuestions({
  participantId,
  gameInstanceId,
  onComplete,
}: Props) {
  const [step, setStep]       = useState(0)
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [loaded, setLoaded]   = useState(false)
  const [saving, setSaving]   = useState(false)
  const [validationError, setValidationError] = useState<string | null>(null)
  const [saveError, setSaveError]             = useState<string | null>(null)
  const [pendingConfirm, setPendingConfirm]   = useState<number | null>(null)

  // Only category=preparation questions (KC and debrief handled elsewhere)
  const [questions, setQuestions] = useState<PrepTextQuestion[]>(DEFAULT_QUESTIONS)

  const onCompleteRef = useRef(onComplete)
  onCompleteRef.current = onComplete

  useEffect(() => {
    let cancelled = false

    const load = async () => {
      // ── 1. Fetch all visible questions from config ──────────────────────────
      let qs: PrepTextQuestion[] = DEFAULT_QUESTIONS
      try {
        const result = await callFunctionWithSession<{ ok: boolean; questions: PrepTextQuestion[] }>('getStudentPrepQuestions', {})
        if (!cancelled && result.questions.length > 0) {
          // Only preparation-category questions — KC and debrief are handled elsewhere.
          qs = result.questions
            .filter(q => q.category === 'preparation')
            .sort((a, b) => a.order - b.order)
        }
      } catch {
        // Config fetch failed — stay on defaults; student flow continues.
      }

      if (!cancelled) setQuestions(qs)

      // ── 2. Read participant doc for already-answered fields ─────────────────
      try {
        const { getDoc } = await import('firebase/firestore')
        const snap = await getDoc(doc(db, 'game_instances', gameInstanceId, 'participants', participantId))
        if (cancelled) return
        const data = snap.data() ?? {}

        const existing: Record<string, string> = {}
        for (const q of qs) {
          if (data[q.field] != null) existing[q.field] = String(data[q.field])
        }

        const firstUnanswered = qs.findIndex(
          q => existing[q.field] == null || existing[q.field] === '',
        )
        if (firstUnanswered === -1) {
          onCompleteRef.current()
          return
        }

        setAnswers(existing)
        setStep(firstUnanswered)
        setLoaded(true)
      } catch {
        if (!cancelled) setLoaded(true)
      }
    }

    void load()
    return () => { cancelled = true }
  }, [gameInstanceId, participantId])

  if (!loaded) {
    return (
      <main style={{ padding: '2rem', maxWidth: '640px', margin: '0 auto' }}>
        <p>Loading…</p>
      </main>
    )
  }

  // All non-MC questions hidden — onComplete already called in load(), but guard the render.
  if (questions.length === 0) return null

  const question = questions[step]
  const currentValue = answers[question.field] ?? ''
  const isLast = step === questions.length - 1
  const displayLabel = `Question ${step + 1} of ${questions.length}`

  // ── Handlers ──────────────────────────────────────────────────────────────

  const persistAnswer = async (valueToStore: string | number) => {
    setSaveError(null)
    setSaving(true)
    try {
      await updateDoc(
        doc(db, 'game_instances', gameInstanceId, 'participants', participantId),
        { [question.field]: valueToStore },
      )
      if (isLast) {
        onCompleteRef.current()
      } else {
        setStep(s => s + 1)
        setSaving(false)
      }
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Failed to save. Please try again.')
      setSaving(false)
    }
  }

  const handleContinue = async () => {
    const trimmed = currentValue.trim()
    if (!trimmed) {
      setValidationError('Please enter an answer before continuing.')
      return
    }

    if (question.type === 'number') {
      const result = parsePrice(trimmed)
      if (result.kind === 'invalid') {
        setValidationError('Please enter a valid dollar amount (positive number).')
        return
      }
      if (result.kind === 'confirm') {
        setValidationError(null)
        setPendingConfirm(result.proposed)
        return
      }
      await persistAnswer(result.value)
    } else {
      await persistAnswer(trimmed)
    }
    setValidationError(null)
  }

  const handleConfirmProposed = async () => {
    if (pendingConfirm == null) return
    const value = pendingConfirm
    setPendingConfirm(null)
    setValidationError(null)
    await persistAnswer(value)
  }

  const handleBack = () => {
    setStep(s => s - 1)
    setValidationError(null)
    setSaveError(null)
    setPendingConfirm(null)
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <main style={{ padding: '2rem', maxWidth: '640px', margin: '0 auto', fontFamily: 'sans-serif' }}>
      <p style={{ color: '#555', marginBottom: '0.25rem' }}>{displayLabel}</p>
      <h1 style={{ marginTop: 0, marginBottom: '1.75rem', lineHeight: 1.3 }}>
        {question.prompt}
      </h1>

      {question.type === 'text' ? (
        <textarea
          value={currentValue}
          onChange={e => {
            setAnswers(prev => ({ ...prev, [question.field]: e.target.value }))
            setValidationError(null)
          }}
          rows={4}
          disabled={saving}
          style={{
            width: '100%', padding: '0.75rem', fontSize: '1rem',
            border: '1px solid #ccc', borderRadius: '4px',
            resize: 'vertical', fontFamily: 'inherit', boxSizing: 'border-box',
          }}
        />
      ) : (
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <span style={{ fontSize: '1.1rem', color: '#555', userSelect: 'none' }}>$</span>
          <input
            type="text"
            inputMode="decimal"
            value={currentValue}
            placeholder={question.placeholder}
            onChange={e => {
              setAnswers(prev => ({ ...prev, [question.field]: e.target.value }))
              setValidationError(null)
              setPendingConfirm(null)
            }}
            disabled={saving}
            style={{
              flex: 1, padding: '0.75rem', fontSize: '1rem',
              border: '1px solid #ccc', borderRadius: '4px', fontFamily: 'inherit',
            }}
          />
        </div>
      )}

      {saveError && (
        <p style={{ marginTop: '0.75rem', color: '#800', margin: '0.75rem 0 0' }}>{saveError}</p>
      )}

      {pendingConfirm != null ? (
        <div style={{
          marginTop: '1rem', padding: '0.75rem',
          background: '#f0f7ff', border: '1px solid #b3d4f5', borderRadius: 4,
        }}>
          <p style={{ margin: '0 0 0.6rem', fontSize: '0.95rem' }}>
            You entered <strong>{fmtPrice.format(pendingConfirm)}</strong>. Is that correct?
          </p>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <button
              onClick={() => void handleConfirmProposed()}
              disabled={saving}
              style={{
                padding: '0.75rem 2rem', fontSize: '1rem',
                cursor: saving ? 'not-allowed' : 'pointer',
                backgroundColor: saving ? '#999' : '#1a1a1a',
                color: '#fff', border: 'none', borderRadius: '4px',
              }}
            >
              {saving ? 'Saving…' : 'Yes'}
            </button>
            <button
              onClick={() => setPendingConfirm(null)}
              disabled={saving}
              style={{
                padding: '0.75rem 1.5rem', fontSize: '1rem',
                background: 'none', border: '1px solid #ccc',
                borderRadius: '4px', color: '#555',
                cursor: saving ? 'not-allowed' : 'pointer',
              }}
            >
              No
            </button>
          </div>
        </div>
      ) : (
        <>
          {validationError && (
            <p style={{ marginTop: '0.75rem', color: '#800', margin: '0.75rem 0 0' }}>
              {validationError}
            </p>
          )}
          <div style={{ marginTop: '2rem', display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
            {step > 0 && (
              <button
                onClick={handleBack}
                disabled={saving}
                style={{
                  padding: '0.75rem 1.5rem', fontSize: '1rem',
                  cursor: saving ? 'not-allowed' : 'pointer',
                  background: 'none', border: '1px solid #ccc',
                  borderRadius: '4px', color: '#555',
                }}
              >
                Back
              </button>
            )}
            <button
              onClick={() => void handleContinue()}
              disabled={saving}
              style={{
                padding: '0.75rem 2rem', fontSize: '1rem',
                cursor: saving ? 'not-allowed' : 'pointer',
                backgroundColor: saving ? '#999' : '#1a1a1a',
                color: '#fff', border: 'none', borderRadius: '4px',
                transition: 'background-color 0.15s',
              }}
            >
              {saving ? 'Saving…' : isLast ? 'Complete' : 'Continue'}
            </button>
          </div>
        </>
      )}
    </main>
  )
}
