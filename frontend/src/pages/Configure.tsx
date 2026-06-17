/**
 * Instructor configuration entry point.
 * URL: /configure?token=<JWT>&game_instance_id=<uuid>
 *
 * Called by the classroom when an instructor edits a Grays.com session item.
 * Reads token + game_instance_id from the URL and immediately redirects to
 * the Settings page, carrying both params forward so Settings can verify the
 * instructor JWT via the extractInstructorGameId backend helper.
 */
import { useEffect } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'

export default function Configure() {
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()

  const token          = searchParams.get('token')
  const gameInstanceId = searchParams.get('game_instance_id')

  useEffect(() => {
    if (!token || !gameInstanceId) return
    navigate(
      `/settings?token=${encodeURIComponent(token)}&game_instance_id=${encodeURIComponent(gameInstanceId)}`,
      { replace: true },
    )
  }, [token, gameInstanceId, navigate])

  if (!token || !gameInstanceId) {
    return (
      <main style={{ padding: '2rem', maxWidth: '800px', margin: '0 auto', fontFamily: 'sans-serif' }}>
        <h1>Configure Grays.com</h1>
        <p style={{ color: '#c00' }}>
          Missing launch parameters. This page must be opened from the classroom with a valid
          token and game_instance_id.
        </p>
      </main>
    )
  }

  return (
    <main style={{ padding: '2rem', maxWidth: '800px', margin: '0 auto', fontFamily: 'sans-serif' }}>
      <p>Redirecting to Settings…</p>
    </main>
  )
}
