import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { generateAttendanceCode, type InstructorDevArgs } from '../api'

/**
 * Live instructor dashboard.
 * Reached via classroom-launched JWT (role: "instructor") from /play,
 * or directly via /dashboard for standalone mode.
 *
 * Dev URL: /dashboard?_dev_game_instance_id=<uuid>
 */
export default function InstructorDashboard() {
  const [searchParams] = useSearchParams()
  const devGameInstanceId = import.meta.env.DEV
    ? searchParams.get('_dev_game_instance_id')
    : null

  const [code, setCode] = useState<string | null>(null)
  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleGenerate = () => {
    if (!devGameInstanceId) {
      setError(
        'No game instance ID. Add ?_dev_game_instance_id=<uuid> to the URL.',
      )
      return
    }
    setGenerating(true)
    setError(null)
    const args: InstructorDevArgs = { _dev: { game_instance_id: devGameInstanceId } }
    generateAttendanceCode(args)
      .then((result) => {
        setCode(result.code)
        setGenerating(false)
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Failed to generate code.')
        setGenerating(false)
      })
  }

  return (
    <main
      style={{
        padding: '2rem',
        maxWidth: '1200px',
        margin: '0 auto',
        fontFamily: 'sans-serif',
      }}
    >
      <h1 style={{ marginTop: 0 }}>Instructor Dashboard — Grays.com</h1>

      <section style={{ marginTop: '2rem', maxWidth: '640px' }}>
        <h2 style={{ borderBottom: '1px solid #ddd', paddingBottom: '0.5rem' }}>
          Attendance Code
        </h2>

        {code ? (
          <div>
            <p style={{ color: '#555', marginBottom: '0.5rem' }}>
              Display this code to your class:
            </p>
            <div
              style={{
                fontSize: '5rem',
                fontFamily: 'monospace',
                fontWeight: 'bold',
                letterSpacing: '0.2em',
                color: '#111',
                lineHeight: 1.1,
                marginBottom: '1.5rem',
              }}
            >
              {code}
            </div>
            <button onClick={handleGenerate} disabled={generating}>
              {generating ? 'Generating…' : 'Regenerate code'}
            </button>
            <p style={{ color: '#888', fontSize: '0.875rem', marginTop: '0.75rem' }}>
              Regenerating will invalidate the current code. Students who
              haven&apos;t entered it yet will need to use the new one.
            </p>
          </div>
        ) : (
          <div>
            <p style={{ color: '#555' }}>No code has been generated yet.</p>
            <button onClick={handleGenerate} disabled={generating}>
              {generating ? 'Generating…' : 'Generate code'}
            </button>
          </div>
        )}

        {error && (
          <p style={{ color: '#c00', marginTop: '0.75rem' }}>{error}</p>
        )}
      </section>
    </main>
  )
}
