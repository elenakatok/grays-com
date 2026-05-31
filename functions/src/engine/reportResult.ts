import * as https from 'https'
import * as http from 'http'

export type GameResult = {
  game_instance_id: string
  participant_id: string
  status: 'completed' | 'no_show' | 'partial' | 'excluded'
  role: string | null
  raw_score: number | null
  normalized_score: number | null
  knowledge_check_score: number | null
  details: Record<string, unknown>
}

/**
 * Pushes a GameResult record to the classroom callback URL.
 * Silently skips when callbackUrl is empty — standalone mode.
 *
 * Authenticated via Bearer token (CLASSROOM_CALLBACK_SECRET).
 */
export async function reportResult(
  result: GameResult,
  callbackUrl: string,
  callbackSecret: string,
): Promise<void> {
  if (!callbackUrl || !callbackSecret) return

  const body = JSON.stringify(result)
  const url = new URL(callbackUrl)
  const isHttps = url.protocol === 'https:'
  const lib = isHttps ? https : http

  await new Promise<void>((resolve, reject) => {
    const req = lib.request(
      {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          Authorization: `Bearer ${callbackSecret}`,
        },
      },
      (res) => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          resolve()
        } else {
          reject(new Error(`Classroom callback returned HTTP ${res.statusCode}`))
        }
      },
    )
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}
