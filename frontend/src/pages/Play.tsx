import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'

/**
 * Entry point for classroom-launched sessions.
 * URL: /play?token=<JWT>
 *
 * Sends the token to a Cloud Function for RS256 verification (classroom-v1 key),
 * then routes the verified participant into the game flow.
 */

type VerifiedParticipant = {
  participant_id: string
  name: string
  game_instance_id: string
  game_config_id: string
  role: 'student' | 'instructor'
  classroom_callback_url: string
}

export default function Play() {
  const [searchParams] = useSearchParams()
  const token = searchParams.get('token')

  const [participant, setParticipant] = useState<VerifiedParticipant | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!token) {
      setError('No token provided. Please launch this game from the classroom.')
      return
    }

    // TODO: call verifyToken Cloud Function with the JWT
    // On success: setParticipant(result)
    // On failure: setError('Session link has expired or is invalid.')
    setError('Token verification not yet implemented.')
  }, [token])

  if (error) {
    return (
      <main style={{ padding: '2rem', maxWidth: '600px', margin: '0 auto' }}>
        <h1>Unable to join</h1>
        <p>{error}</p>
        <p>
          If you don't have a classroom link, you can{' '}
          <a href="/">log in directly</a>.
        </p>
      </main>
    )
  }

  if (!participant) {
    return (
      <main style={{ padding: '2rem', maxWidth: '600px', margin: '0 auto' }}>
        <p>Verifying session...</p>
      </main>
    )
  }

  // TODO: route instructor vs student, then into game phase flow
  return (
    <main style={{ padding: '2rem', maxWidth: '600px', margin: '0 auto' }}>
      <h1>Welcome, {participant.name}</h1>
      <p>Game flow not yet implemented.</p>
    </main>
  )
}
