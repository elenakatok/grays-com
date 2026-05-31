/**
 * Standalone entry point — no classroom JWT.
 * Students enter a session code + personal code issued by the game itself.
 * Instructors can navigate to /dashboard after authenticating via Firebase Auth.
 *
 * When CLASSROOM_CALLBACK_URL is not configured, the game runs fully standalone:
 * results are stored in Firestore only; no callback is sent to the classroom.
 */
export default function StandaloneLogin() {
  return (
    <main style={{ padding: '2rem', maxWidth: '480px', margin: '4rem auto' }}>
      <h1>Grays.com Negotiation</h1>
      <p>
        If your instructor shared a classroom link, use that to join. Otherwise,
        enter the codes you received below.
      </p>
      {/* TODO: session code + personal code form */}
      <p style={{ color: '#888' }}>Standalone login not yet implemented.</p>
    </main>
  )
}
