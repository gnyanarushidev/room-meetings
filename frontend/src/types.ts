export interface Profile {
  id: string
  name: string
}

export interface Member extends Profile {
  muted: boolean
  online: boolean
  joined_at: string
}

export interface Room {
  id: string
  code: string
  title: string
  host_id: string
  locked: boolean
  status: 'active' | 'ended' | 'deleted'
  created_at: string
  ended_at: string | null
}

export interface RoomSession {
  token: string
  room: Room
  member: Member
}

export interface RoomState {
  room: Room
  members: Member[]
}

export interface SessionState extends RoomState {
  member: Member
}

export type MessageKind = 'text' | 'code'

export interface ChatMessage {
  id: string
  room_id: string
  sender: Profile
  content: string
  kind: MessageKind
  created_at: string
  client_message_id: string
}

export interface MessagePage {
  messages: ChatMessage[]
  has_more: boolean
}

export type ServerEvent =
  | ({ type: 'snapshot' } & SessionState & MessagePage)
  | ({ type: 'state' } & RoomState)
  | { type: 'message'; message: ChatMessage }
  | { type: 'message_ack'; client_message_id: string }
  | { type: 'message_deleted'; message_id: string }
  | { type: 'messages_cleared' }
  | { type: 'typing'; user: Profile; is_typing: boolean }
  | { type: 'error'; message: string }
  | { type: 'access_revoked'; message: string }
  | { type: 'pong' }

export type ConnectionStatus = 'connecting' | 'connected' | 'reconnecting' | 'offline'
export type HostAction = 'lock' | 'unlock' | 'end' | 'transfer'
export type MemberAction = 'mute' | 'unmute' | 'remove'
