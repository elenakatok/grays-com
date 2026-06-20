import { useEffect, useRef, useState } from 'react'
import { doc, getDoc } from 'firebase/firestore'
import { db } from '../firebase'
import {
  type CallArgs, type MCOption,
  submitKnowledgeCheck, submitStaticKnowledgeCheck,
  submitStaticKnowledgeCheckQuestion,
  getStudentPrepQuestions,
} from '../api'

type RoleOption = { value: 'Chris' | 'Kelly'; label: string }

const DEFAULT_ROLE_OPTIONS: RoleOption[] = [
  { value: 'Chris', label: 'Seller' },
  { value: 'Kelly', label: 'Buyer' },
]
const DEFAULT_ROLE_PROMPT = 'What is your role in the negotiation?'

type StaticQuestion = {
  field: string
  prompt: string
  options: MCOption[]
}

type SubmitResult = { correct: boolean; explanation: string }

type Step = 'loading' | 'role' | 'static'

type Props = {
  participantId: string
  gameInstanceId: string
  callArgs: CallArgs
  onComplete: () => void
}

export default function Phase1KnowledgeCheck({
  participantId,
  gameInstanceId,
  callArgs,
  onComplete,
}: Props) {
  const [step, setStep] = useState<Step>('loading')

  // Role question state
  const [rolePrompt, setRolePrompt] = useState(DEFAULT_ROLE_PROMPT)
  const [roleOptions, setRoleOptions] = useState<RoleOption[]>(DEFAULT_ROLE_OPTIONS)
  const [roleSelected, setRoleSelected] = useState<'Chris' | 'Kelly' | null>(null)
  const [wrongRole, setWrongRole] = useState(false)

  // Static stepper state
  const [staticQuestions, setStaticQuestions] = useState<StaticQuestion[]>([])
  const [questionIndex, setQuestionIndex] = useState(0)
  const [staticPhase, setStaticPhase] = useState<'pending' | 'submitted'>('pending')
  const [selectedAnswer, setSelectedAnswer] = useState<string | null>(null)
  const [submittedResult, setSubmittedResult] = useState<SubmitResult | null>(null)

  const [submitting, setSubmitting] = useState(false)
  const [serverError, setServerError] = useState<string | null>(null)

  const onCompleteRef = useRef(onComplete)
  onCompleteRef.current = onComplete

  useEffect(() => {
    let cancelled = false

    const load = async () => {
      // 1. Fetch role-filtered questions from server.
      let statics: StaticQuestion[] = []

      try {
        const result = await getStudentPrepQuestions(callArgs)
        if (cancelled) return

        const rawRoleQ = result.questions.find(q => q.field === 'knowledge_check')
        if (!rawRoleQ) {
          // Role question is hidden — skip KC entirely.
          onCompleteRef.current()
          return
        }

        if (rawRoleQ.prompt) setRolePrompt(rawRoleQ.prompt)
        if (rawRoleQ.options && rawRoleQ.options.length > 0) {
          const mapped: RoleOption[] = []
          for (const o of rawRoleQ.options) {
            if (o.value === 'Chris' || o.value === 'Kelly') {
              mapped.push({ value: o.value, label: o.label })
            }
          }
          if (mapped.length > 0) setRoleOptions(mapped)
        }

        statics = result.questions
          .filter(q => q.category === 'knowledge_check' && q.field !== 'knowledge_check' && q.type === 'mc')
          .sort((a, b) => a.order - b.order)
          .map(q => ({ field: q.field, prompt: q.prompt, options: q.options ?? [] }))

        setStaticQuestions(statics)
      } catch {
        // Config fetch failed — use defaults; statics stays empty.
      }

      if (cancelled) return

      // 2. Read participant doc to determine resume point.
      try {
        const snap = await getDoc(doc(db, 'game_instances', gameInstanceId, 'participants', participantId))
        if (cancelled) return
        const data = snap.data() ?? {}

        // Full KC already scored — skip entirely.
        if (data.knowledge_check_score != null) {
          onCompleteRef.current()
          return
        }

        // Role question already passed — find first unanswered static question.
        if (data.knowledge_check_completed_at != null) {
          if (statics.length === 0) {
            onCompleteRef.current()
            return
          }

          type KCAnswer = { answer: string; correct: boolean }
          const kcStaticAnswers = (data.kc_static_answers ?? {}) as Record<string, KCAnswer>
          const firstUnansweredIdx = statics.findIndex(q => kcStaticAnswers[q.field] == null)

          if (firstUnansweredIdx === -1) {
            // All static questions answered — score should be written; guard completion.
            onCompleteRef.current()
            return
          }

          setQuestionIndex(firstUnansweredIdx)
          setStep('static')
          return
        }
      } catch {
        // Firestore read failed — fall through to role question as safe default.
      }

      if (!cancelled) setStep('role')
    }

    void load()
    return () => { cancelled = true }
  }, [callArgs, participantId, gameInstanceId])

  // ── Role question handlers ─────────────────────────────────────────────────

  const handleRoleSubmit = async () => {
    if (!roleSelected || submitting) return
    setSubmitting(true)
    setWrongRole(false)
    setServerError(null)

    try {
      const result = await submitKnowledgeCheck(callArgs, roleSelected)
      if (result.alreadyCompleted) {
        onCompleteRef.current()
        return
      }
      if (result.correct) {
        if (staticQuestions.length === 0) {
          // No concept questions — submit empty batch to record score.
          const r = await submitStaticKnowledgeCheck(callArgs, {})
          if (!r.ok) throw new Error('Failed to record score')
          onCompleteRef.current()
        } else {
          setQuestionIndex(0)
          setStaticPhase('pending')
          setSelectedAnswer(null)
          setSubmittedResult(null)
          setStep('static')
          setSubmitting(false)
        }
      } else {
        setWrongRole(true)
        setSubmitting(false)
      }
    } catch (err) {
      setServerError(err instanceof Error ? err.message : 'Something went wrong. Please try again.')
      setSubmitting(false)
    }
  }

  // ── Static question handlers ───────────────────────────────────────────────

  const currentStaticQ = staticQuestions[questionIndex]
  const isLastStatic = questionIndex === staticQuestions.length - 1

  const handleStaticSubmit = async () => {
    if (!selectedAnswer || submitting || !currentStaticQ) return
    setSubmitting(true)
    setServerError(null)

    try {
      const result = await submitStaticKnowledgeCheckQuestion(callArgs, currentStaticQ.field, selectedAnswer)
      setSubmittedResult({ correct: result.correct, explanation: result.explanation })
      setStaticPhase('submitted')
      setSubmitting(false)
    } catch (err) {
      setServerError(err instanceof Error ? err.message : 'Something went wrong. Please try again.')
      setSubmitting(false)
    }
  }

  const handleStaticContinue = () => {
    if (isLastStatic) {
      onCompleteRef.current()
    } else {
      setQuestionIndex(qi => qi + 1)
      setStaticPhase('pending')
      setSelectedAnswer(null)
      setSubmittedResult(null)
      setServerError(null)
    }
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  if (step === 'loading') {
    return (
      <main style={{ padding: '2rem', maxWidth: '640px', margin: '0 auto' }}>
        <p>Loading…</p>
      </main>
    )
  }

  if (step === 'role') {
    return (
      <main style={{ padding: '2rem', maxWidth: '640px', margin: '0 auto', fontFamily: 'sans-serif' }}>
        <p style={{ color: '#555', marginBottom: '0.25rem' }}>Knowledge check</p>
        <h1 style={{ marginTop: 0, marginBottom: '1.75rem' }}>{rolePrompt}</h1>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          {roleOptions.map(({ value, label }) => {
            const isSelected = roleSelected === value
            return (
              <label
                key={value}
                style={{
                  display: 'flex', alignItems: 'center', gap: '0.75rem',
                  padding: '0.875rem 1rem',
                  border: `1px solid ${isSelected ? '#1a1a1a' : '#ccc'}`,
                  borderRadius: '4px', cursor: 'pointer',
                  fontWeight: isSelected ? 600 : 400, transition: 'border-color 0.1s',
                }}
              >
                <input
                  type="radio" name="role" value={value} checked={isSelected}
                  onChange={() => { setRoleSelected(value); setWrongRole(false) }}
                  style={{ accentColor: '#1a1a1a', width: '1rem', height: '1rem', flexShrink: 0 }}
                />
                {label}
              </label>
            )
          })}
        </div>

        {wrongRole && (
          <p role="alert" style={{
            marginTop: '1.25rem', padding: '0.875rem 1rem',
            backgroundColor: '#fff8f8', border: '1px solid #e0b0b0',
            borderRadius: '4px', color: '#800',
          }}>
            That&apos;s not right. Please review your role information and try again.
          </p>
        )}
        {serverError && <p style={{ marginTop: '1rem', color: '#800' }}>{serverError}</p>}

        <div style={{ marginTop: '2rem' }}>
          <button
            onClick={() => void handleRoleSubmit()}
            disabled={!roleSelected || submitting}
            style={{
              padding: '0.75rem 2rem', fontSize: '1rem',
              cursor: roleSelected && !submitting ? 'pointer' : 'not-allowed',
              backgroundColor: roleSelected && !submitting ? '#1a1a1a' : '#999',
              color: '#fff', border: 'none', borderRadius: '4px',
              transition: 'background-color 0.15s',
            }}
          >
            {submitting ? 'Checking…' : 'Submit'}
          </button>
        </div>
      </main>
    )
  }

  // step === 'static'
  if (!currentStaticQ) return null

  const conceptNum = questionIndex + 1
  const conceptTotal = staticQuestions.length
  const isSubmitted = staticPhase === 'submitted'

  return (
    <main style={{ padding: '2rem', maxWidth: '640px', margin: '0 auto', fontFamily: 'sans-serif' }}>
      <p style={{ color: '#555', marginBottom: '0.25rem' }}>
        Concept check — {conceptNum} of {conceptTotal}
      </p>
      <h1 style={{ marginTop: 0, marginBottom: '1.75rem', lineHeight: 1.3 }}>
        {currentStaticQ.prompt}
      </h1>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
        {currentStaticQ.options.map(opt => {
          const isSelected = selectedAnswer === opt.value
          return (
            <label
              key={opt.value}
              style={{
                display: 'flex', alignItems: 'center', gap: '0.75rem',
                padding: '0.875rem 1rem',
                border: `1px solid ${isSelected ? '#1a1a1a' : '#ccc'}`,
                borderRadius: '4px',
                cursor: isSubmitted ? 'default' : 'pointer',
                fontWeight: isSelected ? 600 : 400,
                opacity: isSubmitted && !isSelected ? 0.55 : 1,
                transition: 'border-color 0.1s',
              }}
            >
              <input
                type="radio"
                name={`static-${questionIndex}`}
                value={opt.value}
                checked={isSelected}
                disabled={isSubmitted}
                onChange={() => {
                  if (!isSubmitted) setSelectedAnswer(opt.value)
                }}
                style={{ accentColor: '#1a1a1a', width: '1rem', height: '1rem', flexShrink: 0 }}
              />
              {opt.label}
            </label>
          )
        })}
      </div>

      {isSubmitted && submittedResult && (
        <div style={{
          marginTop: '1.25rem',
          padding: '0.875rem 1rem',
          backgroundColor: submittedResult.correct ? '#f0fff4' : '#fff8f8',
          border: `1px solid ${submittedResult.correct ? '#a0d4b0' : '#e0b0b0'}`,
          borderRadius: '4px',
          color: submittedResult.correct ? '#1a6b2a' : '#800',
        }}>
          <p style={{ margin: '0 0 0.4rem', fontWeight: 600 }}>
            {submittedResult.correct ? '✓ Correct' : '✗ Incorrect'}
          </p>
          {submittedResult.explanation && (
            <p style={{ margin: 0, lineHeight: 1.5, fontWeight: 400 }}>
              {submittedResult.explanation}
            </p>
          )}
        </div>
      )}

      {serverError && (
        <p style={{ marginTop: '1.25rem', color: '#800' }}>{serverError}</p>
      )}

      <div style={{ marginTop: '2rem' }}>
        {isSubmitted ? (
          <button
            onClick={handleStaticContinue}
            style={{
              padding: '0.75rem 2rem', fontSize: '1rem', cursor: 'pointer',
              backgroundColor: '#1a1a1a', color: '#fff',
              border: 'none', borderRadius: '4px', transition: 'background-color 0.15s',
            }}
          >
            {isLastStatic ? 'Finish' : 'Continue'}
          </button>
        ) : (
          <button
            onClick={() => void handleStaticSubmit()}
            disabled={!selectedAnswer || submitting}
            style={{
              padding: '0.75rem 2rem', fontSize: '1rem',
              cursor: selectedAnswer && !submitting ? 'pointer' : 'not-allowed',
              backgroundColor: selectedAnswer && !submitting ? '#1a1a1a' : '#999',
              color: '#fff', border: 'none', borderRadius: '4px',
              transition: 'background-color 0.15s',
            }}
          >
            {submitting ? 'Checking…' : 'Submit'}
          </button>
        )}
      </div>
    </main>
  )
}
