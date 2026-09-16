import type { HostAction, MemberAction, MessagePage, RoomSession, RoomState, SessionState } from './types'

const baseUrl = (import.meta.env.API_URL || '').replace(/\/$/, '')
console.log(baseUrl)
export class ApiError extends Error {
  constructor(message: string, public status: number) { super(message) }
}

async function request<T>(path: string, options: RequestInit = {}, token?: string): Promise<T> {
  let response: Response
  try {
    // A Render free service can take about a minute to wake from idle.
    const timeout = AbortSignal.timeout(75000)
    response = await fetch(`${baseUrl}/api${path}`, {
      ...options,
      signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    })
  } catch (error) {
    if (options.signal?.aborted) throw error
    throw new ApiError('Cannot reach the meeting server. It may be waking up—please try again.', 0)
  }
  if (!response.ok) {
    const body = await response.json().catch(() => null)
    const detail = body?.detail
    throw new ApiError(typeof detail === 'string' ? detail :
      Array.isArray(detail) ? detail.map((item: { msg: string }) => item.msg).join(' ') :
        'The server could not complete that request. Please try again.', response.status)
  }
  return response.json() as Promise<T>
}

const path = (session: RoomSession) => `/rooms/${encodeURIComponent(session.room.id)}`

export const api = {
  createRoom: (name: string, title: string) => request<RoomSession>('/rooms', { method: 'POST', body: JSON.stringify({ name, title }) }),
  joinRoom: (name: string, code: string) => request<RoomSession>('/rooms/join', { method: 'POST', body: JSON.stringify({ name, code }) }),
  session: (session: RoomSession, signal?: AbortSignal) => request<SessionState>(`${path(session)}/session`, { signal }, session.token),
  messages: (session: RoomSession, before?: string, signal?: AbortSignal) =>
    request<MessagePage>(`${path(session)}/messages?limit=100${before ? `&before=${encodeURIComponent(before)}` : ''}`, { signal }, session.token),
  roomAction: (session: RoomSession, action: HostAction, memberId?: string) => request<RoomState>(`${path(session)}/actions`, {
    method: 'POST', body: JSON.stringify({ action, ...(memberId ? { member_id: memberId } : {}) }),
  }, session.token),
  memberAction: (session: RoomSession, memberId: string, action: MemberAction) => request<RoomState>(`${path(session)}/members/${memberId}/actions`, {
    method: 'POST', body: JSON.stringify({ action }),
  }, session.token),
  deleteMessage: (session: RoomSession, messageId: string) => request(`${path(session)}/messages/${messageId}`, { method: 'DELETE' }, session.token),
  clearMessages: (session: RoomSession) => request(`${path(session)}/messages`, { method: 'DELETE' }, session.token),
  deleteRoom: (session: RoomSession) => request(path(session), { method: 'DELETE' }, session.token),
}

export function socketUrl(roomId: string): string {
  const url = new URL(`${baseUrl}/api/ws/${encodeURIComponent(roomId)}`, window.location.origin)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return url.toString()
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong. Please try again.'
}
