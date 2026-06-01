type Props = {
  onReportOutcome: () => void
}

export default function Phase2OffPlatformHolding({ onReportOutcome }: Props) {
  return (
    <main
      style={{
        padding: '2rem',
        maxWidth: '640px',
        margin: '0 auto',
        fontFamily: 'sans-serif',
      }}
    >
      <h1 style={{ marginTop: 0 }}>Negotiate with your partner</h1>
      <p style={{ fontSize: '1.05rem', lineHeight: 1.6, marginBottom: '1rem' }}>
        The negotiation happens face-to-face. Find your partner and negotiate a price
        — or decide to walk away.
      </p>
      <p style={{ color: '#555', marginBottom: '2.5rem' }}>
        Come back to this screen when your negotiation is complete.
      </p>
      <button
        onClick={onReportOutcome}
        style={{ fontSize: '1rem', padding: '0.6rem 1.25rem' }}
      >
        We&apos;ve finished — report our outcome
      </button>
    </main>
  )
}
