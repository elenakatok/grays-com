type Props = {
  title: string
  body: string
  confirmLabel?: string
  cancelLabel?: string
  onConfirm: () => void
  onCancel: () => void
}

/**
 * Shown before a student enters the live phase.
 * Makes explicit that joining is a commitment — their partner is counting on them.
 */
export function ConfirmationGate({
  title,
  body,
  confirmLabel = 'Yes, I\'m ready',
  cancelLabel = 'Not now',
  onConfirm,
  onCancel,
}: Props) {
  return (
    <div style={{ padding: '2rem', maxWidth: '540px', margin: '0 auto' }}>
      <h2>{title}</h2>
      <p style={{ whiteSpace: 'pre-line' }}>{body}</p>
      <div style={{ display: 'flex', gap: '1rem', marginTop: '1.5rem' }}>
        <button onClick={onConfirm}>{confirmLabel}</button>
        <button onClick={onCancel} style={{ background: 'none', border: '1px solid #ccc' }}>
          {cancelLabel}
        </button>
      </div>
    </div>
  )
}
