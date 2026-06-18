import { useEffect, useRef, useState } from 'react'
import { type CallArgs, type MCOption, submitKnowledgeCheck, submitStaticKnowledgeCheck, getStudentPrepQuestions } from '../api'

type RoleOption = { value: 'Chris' | 'Kelly'; label: string }

const DEFAULT_ROLE_OPTIONS: RoleOption[] = [
  { value: 'Chris', label: 'Chris Gray, the seller' },
  { value: 'Kelly', label: 'Kelly Kaplan, the buyer' },
]
const DEFAULT_ROLE_PROMPT = 'What is your role in the negotiation?'

type StaticQuestion = {
  field: string
  prompt: string
  options: MCOption[]
}

type Step = 'loading' | 'role' | 'static' | 'submitting'

type Props = {
  callArgs: CallArgs
  onComplete: () => void
}

export default function Phase1KnowledgeCheck({ callArgs, onComplete }: Props) {
  const [step, setStep] = useState<Step>('loading')

  // Role question state
  const [rolePrompt, setRolePrompt] = useState(DEFAULT_ROLE_PROMPT)
  const [roleOptions, setRoleOptions] = useState<RoleOption[]>(DEFAULT_ROLE_OPTIONS)
  const [roleSelected, setRoleSelected] = useState<'Chris' | 'Kelly' | null>(null)
  const [wrongRole, setWrongRole] = useState(false)

  // Static question state
  const [staticQuestions, setStaticQuestions] = useState<StaticQuestion[]>([])
  const [staticAnswers, setStaticAnswers] = useState<Record<string, string>>({})

  const [submitting, setSubmitting] = useState(false)
  const [serverError, setServerError] = useState<string | null>(null)

  const onCompleteRef = useRef(onComplete)
  onCompleteRef.current = onComplete

  useEffect(() => {
    let cancelled = false

    const load = async () => {
      try {
        const result = await getStudentPrepQuestions(callArgs)
        if (cancelled) return

        const roleQ = result.questions.find(q => q.field === 'knowledge_check')
        if (!roleQ) {
          // Role question is hidden — skip KC entirely.
          onCompleteRef.current()
          return
        }

        if (roleQ.prompt) setRolePrompt(roleQ.prompt)
        if (roleQ.options && roleQ.options.length > 0) {
          const mapped: RoleOption[] = []
          for (const o of roleQ.options) {
            if (o.value === 'Chris' || o.value === 'Kelly') {
              mapped.push({ value: o.value, label: o.label })
            }
          }
          if (mapped.length > 0) setRoleOptions(mapped)
        }

        const statics: StaticQuestion[] = result.questions
          .filter(q => q.category === 'knowledge_check' && q.field !== 'knowledge_check' && q.type === 'mc')
          .sort((a, b) => a.order - b.order)
          .map(q => ({ field: q.field, prompt: q.prompt, options: q.options ?? [] }))

        setStaticQuestions(statics)
      } catch {
        // Config fetch failed — use defaults.
      }

      if (!cancelled) setStep('role')
    }

    void load()
    return () => { cancelled = true }
  }, [callArgs])

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
          // No concept questions configured — submit empty answers to record score.
          const r = await submitStaticKnowledgeCheck(callArgs, {})
          if (!r.ok) throw new Error('Failed to record score')
          onCompleteRef.current()
        } else {
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

  const handleStaticSubmit = async () => {
    if (submitting) return
    setSubmitting(true)
    setServerError(null)

    try {
      const result = await submitStaticKnowledgeCheck(callArgs, staticAnswers)
      if (!result.ok) throw new Error('Failed to record answers')
      onCompleteRef.current()
    } catch (err) {
      setServerError(err instanceof Error ? err.message : 'Something went wrong. Please try again.')
      setSubmitting(false)
    }
  }

  const allStaticAnswered = staticQuestions.every(q => !!staticAnswers[q.field])

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
  return (
    <main style={{ padding: '2rem', maxWidth: '640px', margin: '0 auto', fontFamily: 'sans-serif' }}>
      <p style={{ color: '#555', marginBottom: '0.25rem' }}>Concept check</p>
      <p style={{ marginTop: 0, marginBottom: '2rem', color: '#444' }}>
        Answer each question below. You have one submission — choose carefully.
      </p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>
        {staticQuestions.map((q, qi) => (
          <div key={q.field}>
            <p style={{ margin: '0 0 0.75rem', fontWeight: 600, lineHeight: 1.4 }}>
              {qi + 1}. {q.prompt}
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              {q.options.map(opt => {
                const isSelected = staticAnswers[q.field] === opt.value
                return (
                  <label
                    key={opt.value}
                    style={{
                      display: 'flex', alignItems: 'center', gap: '0.75rem',
                      padding: '0.75rem 1rem',
                      border: `1px solid ${isSelected ? '#1a1a1a' : '#ccc'}`,
                      borderRadius: '4px', cursor: 'pointer',
                      fontWeight: isSelected ? 600 : 400, transition: 'border-color 0.1s',
                    }}
                  >
                    <input
                      type="radio" name={q.field} value={opt.value} checked={isSelected}
                      onChange={() => setStaticAnswers(prev => ({ ...prev, [q.field]: opt.value }))}
                      style={{ accentColor: '#1a1a1a', width: '1rem', height: '1rem', flexShrink: 0 }}
                    />
                    {opt.label}
                  </label>
                )
              })}
            </div>
          </div>
        ))}
      </div>

      {serverError && <p style={{ marginTop: '1.25rem', color: '#800' }}>{serverError}</p>}

      <div style={{ marginTop: '2.5rem' }}>
        <button
          onClick={() => void handleStaticSubmit()}
          disabled={!allStaticAnswered || submitting}
          style={{
            padding: '0.75rem 2rem', fontSize: '1rem',
            cursor: allStaticAnswered && !submitting ? 'pointer' : 'not-allowed',
            backgroundColor: allStaticAnswered && !submitting ? '#1a1a1a' : '#999',
            color: '#fff', border: 'none', borderRadius: '4px',
            transition: 'background-color 0.15s',
          }}
        >
          {submitting ? 'Submitting…' : 'Submit answers'}
        </button>
      </div>
    </main>
  )
}
