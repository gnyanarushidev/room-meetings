import type { RoomSession } from './types'

const key = 'gather.room-sessions.v2'
const uuid = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i

export function readSessions(): RoomSession[] {
  try {
    const value = JSON.parse(localStorage.getItem(key) || '[]')
    if (!Array.isArray(value)) return []
    return value.filter(item => item && typeof item.token === 'string' && item.token.length >= 40 &&
      typeof item.room?.id === 'string' && uuid.test(item.room.id) && typeof item.room.title === 'string' &&
      typeof item.room.code === 'string' && typeof item.room.host_id === 'string' &&
      ['active', 'ended'].includes(item.room.status) && typeof item.member?.id === 'string' && uuid.test(item.member.id) &&
      typeof item.member.name === 'string')
  } catch { return [] }
}

export function saveSessions(sessions: RoomSession[]): boolean {
  try { localStorage.setItem(key, JSON.stringify(sessions)); return true }
  catch { return false }
}

export function mergeSessions(...groups: RoomSession[][]): RoomSession[] {
  const unique = new Map<string, RoomSession>()
  for (const session of groups.flat()) {
    const key = `${session.room.id}:${session.member.id}`
    if (!unique.has(key)) unique.set(key, session)
  }
  return [...unique.values()]
}
