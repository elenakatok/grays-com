interface InfoUrlProps {
  publicUrl: string
  privateUrl: string
  roleLabel: string
}

export default function GameHeader({ infoUrls }: { infoUrls?: InfoUrlProps | null }) {
  return (
    <header style={{
      background: '#18233A',
      height: '48px',
      display: 'flex',
      alignItems: 'center',
      padding: '0 1.25rem',
      position: 'sticky',
      top: 0,
      zIndex: 30,
      flexShrink: 0,
    }}>
      <img src="/logo-header.svg" alt="myGames.live" style={{ height: '28px', width: 'auto', display: 'block' }} />

      {/* PDF links — only shown for students after getInfoUrls resolves.
          publicUrl = public PDF (both roles); privateUrl = student's OWN role PDF only.
          The counterpart's URL is never present in client state. */}
      {infoUrls && (
        <nav style={{ marginLeft: 'auto', display: 'flex', gap: '1.25rem', alignItems: 'center' }}>
          {infoUrls.publicUrl && (
            <a
              href={infoUrls.publicUrl}
              target="_blank"
              rel="noreferrer"
              style={{ color: '#a8b8d8', fontSize: '0.78rem', textDecoration: 'none', opacity: 0.9, whiteSpace: 'nowrap' }}
            >
              Public Info ↗
            </a>
          )}
          {infoUrls.privateUrl && (
            <a
              href={infoUrls.privateUrl}
              target="_blank"
              rel="noreferrer"
              style={{ color: '#c4b5fd', fontSize: '0.78rem', textDecoration: 'none', opacity: 0.9, whiteSpace: 'nowrap' }}
            >
              {infoUrls.roleLabel} Info ↗
            </a>
          )}
        </nav>
      )}
    </header>
  )
}
