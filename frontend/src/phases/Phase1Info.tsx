type Props = {
  role: 'Chris' | 'Kelly'
  sellerName: string
  buyerName: string
  publicUrl: string
  privateUrl: string
  onContinue: () => void
}

export default function Phase1Info({ role, sellerName, buyerName, publicUrl, privateUrl, onContinue }: Props) {
  const roleLabel = role === 'Chris'
    ? `${sellerName} — Seller`
    : `${buyerName} — Buyer`
  const roleDisplayName = role === 'Chris' ? sellerName : buyerName
  return (
    <main style={{ padding: '2rem', maxWidth: '640px', margin: '0 auto', fontFamily: 'sans-serif' }}>
      <p style={{ color: '#555', marginBottom: '0.25rem' }}>Your role</p>
      <h1 style={{ marginTop: 0 }}>{roleLabel}</h1>

      <section style={{ marginTop: '2rem' }}>
        <h2>Public Information</h2>
        <p>
          Read this before the negotiation. Both sides have access to this document.
        </p>
        {publicUrl ? (
          <a href={publicUrl} target="_blank" rel="noreferrer">
            Open Public Information PDF →
          </a>
        ) : (
          <p style={{ color: '#888' }}>
            <em>Public information document not yet available.</em>
          </p>
        )}
      </section>

      <section style={{ marginTop: '2rem' }}>
        <h2>Your Confidential Role Information</h2>
        <p>
          <strong>This document is for your eyes only.</strong> Do not share its
          contents with other students — it includes information your negotiation
          partner does not have.
        </p>
        {privateUrl ? (
          <a href={privateUrl} target="_blank" rel="noreferrer">
            Open {roleDisplayName} Role Information PDF →
          </a>
        ) : (
          <p style={{ color: '#888' }}>
            <em>Role information document not yet available.</em>
          </p>
        )}
      </section>

      <div style={{ marginTop: '2.5rem' }}>
        <button
          onClick={onContinue}
          style={{
            padding: '0.75rem 2rem',
            fontSize: '1rem',
            cursor: 'pointer',
            backgroundColor: '#1a1a1a',
            color: '#fff',
            border: 'none',
            borderRadius: '4px',
          }}
        >
          Continue
        </button>
      </div>
    </main>
  )
}
