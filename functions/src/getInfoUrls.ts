import * as admin from 'firebase-admin'

export type InfoUrlsResult = {
  role: 'Chris' | 'Kelly'
  public_info_url: string
  private_info_url: string
}

type GameConfig = {
  public_info_url?: string
  chris_info_url?: string
  kelly_info_url?: string
}

/**
 * Returns the PDF URLs a participant is authorized to see.
 *
 * Reads the participant's role from their Firestore record (written server-side
 * by assignRole; clients cannot modify it). Returns only the private URL for
 * their own role — the other role's URL is never sent to the client.
 *
 * Config lives at: game_instances/{gameInstanceId}/config/main
 * Participant lives at: game_instances/{gameInstanceId}/participants/{participantId}
 */
export async function getInfoUrlsForParticipant(
  gameInstanceId: string,
  participantId: string,
): Promise<InfoUrlsResult> {
  const db = admin.firestore()

  const [participantSnap, configSnap] = await Promise.all([
    db
      .collection('game_instances')
      .doc(gameInstanceId)
      .collection('participants')
      .doc(participantId)
      .get(),
    db
      .collection('game_instances')
      .doc(gameInstanceId)
      .collection('config')
      .doc('main')
      .get(),
  ])

  if (!participantSnap.exists) {
    throw Object.assign(new Error('Participant not found.'), { status: 404 })
  }

  const role = participantSnap.data()?.role as 'Chris' | 'Kelly' | undefined
  if (!role) {
    throw Object.assign(new Error('Role not yet assigned. Please try again in a moment.'), {
      status: 503,
    })
  }

  const config = (configSnap.data() ?? {}) as GameConfig

  return {
    role,
    public_info_url: config.public_info_url ?? '',
    private_info_url: role === 'Chris' ? (config.chris_info_url ?? '') : (config.kelly_info_url ?? ''),
  }
}
