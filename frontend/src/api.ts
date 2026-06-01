const FUNCTIONS_BASE = import.meta.env.DEV
  ? 'http://127.0.0.1:5004/grays-mygames-live/us-central1'
  : 'https://us-central1-grays-mygames-live.cloudfunctions.net'

export type TestArgs = { _test: { participant_id: string; game_instance_id: string } }
export type TokenArgs = { token: string }
export type CallArgs = TokenArgs | TestArgs

async function callFunction<T>(name: string, body: object): Promise<T> {
  const res = await fetch(`${FUNCTIONS_BASE}/${name}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = (await res.json()) as T & { error?: string }
  if (!res.ok) {
    throw new Error(data.error ?? `${name} failed (${res.status})`)
  }
  return data
}

export type AssignRoleResult = {
  ok: boolean
  role: 'Chris' | 'Kelly'
  customToken: string
}

export type InfoUrlsResult = {
  ok: boolean
  role: 'Chris' | 'Kelly'
  public_info_url: string
  private_info_url: string
}

export type KnowledgeCheckResult = {
  ok: boolean
  correct: boolean
  alreadyCompleted: boolean
  score: number | null
  attempts: number
}

export const assignRole = (args: CallArgs) =>
  callFunction<AssignRoleResult>('assignRole', args)

export const getInfoUrls = (args: CallArgs) =>
  callFunction<InfoUrlsResult>('getInfoUrls', args)

export const submitKnowledgeCheck = (args: CallArgs, answer: 'Chris' | 'Kelly') =>
  callFunction<KnowledgeCheckResult>('submitKnowledgeCheck', { ...args, answer })
