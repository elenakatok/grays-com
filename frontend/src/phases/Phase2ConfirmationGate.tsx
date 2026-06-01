import { useState } from 'react'
import { type CallArgs, confirmReady } from '../api'
import { ConfirmationGate } from '../engine/ConfirmationGate'

type Props = {
  callArgs: CallArgs
  onConfirm: () => void
  onCancel: () => void
}

const BODY =
  "You'll be paired with another student for a face-to-face negotiation. " +
  "If you don't show up, your partner has nobody to negotiate with.\n\n" +
  "Only continue if you are in class and ready to negotiate right now."

export default function Phase2ConfirmationGate({ callArgs, onConfirm, onCancel }: Props) {
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleConfirm = () => {
    setSubmitting(true)
    setError(null)
    confirmReady(callArgs)
      .then(() => onConfirm())
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Something went wrong. Please try again.')
        setSubmitting(false)
      })
  }

  return (
    <div>
      <ConfirmationGate
        title="Ready to play?"
        body={BODY}
        confirmLabel={submitting ? 'Confirming…' : "Yes, I'm ready"}
        cancelLabel="Not now"
        disabled={submitting}
        onConfirm={handleConfirm}
        onCancel={onCancel}
      />
      {error && (
        <p style={{ color: '#c00', padding: '0 2rem', marginTop: '0.5rem' }}>{error}</p>
      )}
    </div>
  )
}
