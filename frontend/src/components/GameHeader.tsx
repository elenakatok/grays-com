export default function GameHeader() {
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
    </header>
  )
}
