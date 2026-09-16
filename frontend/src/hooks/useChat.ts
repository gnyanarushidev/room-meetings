import { useCallback, useEffect, useRef, useState } from 'react'
import { api, errorMessage, socketUrl } from '../api'
import type { ChatMessage, ConnectionStatus, Member, MessageKind, RoomSession, ServerEvent } from '../types'

interface PendingMessage {
  id: string
  resolve: () => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

function mergeMessages(existing: ChatMessage[], incoming: ChatMessage[]) {
  return [...new Map([...existing, ...incoming].map(message => [message.id, message])).values()]
    .sort((a, b) => a.id.localeCompare(b.id))
}

export function useChat(session: RoomSession) {
  const [room, setRoom] = useState(session.room)
  const [member, setMember] = useState(session.member)
  const [members, setMembers] = useState<Member[]>([])
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [typing, setTyping] = useState<Record<string, { name: string; until: number }>>({})
  const [status, setStatus] = useState<ConnectionStatus>('connecting')
  const [error, setError] = useState('')
  const [terminal, setTerminal] = useState('')
  const [hasMore, setHasMore] = useState(false)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const socket = useRef<WebSocket | null>(null)
  const ready = useRef(false)
  const pending = useRef<PendingMessage | null>(null)
  const retryMessage = useRef<{ id: string; content: string; kind: MessageKind } | null>(null)
  const historyRequest = useRef<AbortController | null>(null)
  const lastTyping = useRef(0)
  const roomId = session.room.id
  const memberId = session.member.id
  const token = session.token

  const rejectPending = useCallback((reason: string) => {
    if (pending.current) {
      clearTimeout(pending.current.timer)
      pending.current.reject(new Error(reason))
      pending.current = null
    }
  }, [])

  useEffect(() => {
    let disposed = false
    let blocked = false
    let retries = 0
    let lastReceived = Date.now()
    let reconnectTimer: ReturnType<typeof setTimeout>
    let heartbeat: ReturnType<typeof setInterval>
    let handshakeTimer: ReturnType<typeof setTimeout>
    setStatus('connecting')
    setError('')
    setTerminal('')

    function abortHistory() {
      historyRequest.current?.abort()
      historyRequest.current = null
      setLoadingOlder(false)
    }

    function acknowledge(id: string) {
      if (retryMessage.current?.id === id) retryMessage.current = null
      if (pending.current?.id === id) {
        clearTimeout(pending.current.timer)
        pending.current.resolve()
        pending.current = null
      }
    }

    function revoke(reason: string) {
      blocked = true
      ready.current = false
      setStatus('offline')
      setTerminal(reason)
      setMessages([])
      setMembers([])
      setTyping({})
      abortHistory()
      rejectPending(reason)
      socket.current?.close()
    }

    function connect() {
      if (disposed || blocked) return
      setStatus(retries ? 'reconnecting' : 'connecting')
      const ws = new WebSocket(socketUrl(roomId))
      socket.current = ws
      handshakeTimer = setTimeout(() => ws.close(), 75000)
      ws.onopen = () => {
        if (disposed) { ws.close(); return }
        ws.send(JSON.stringify({ type: 'session', token }))
      }
      ws.onmessage = ({ data }) => {
        if (disposed || blocked) return
        lastReceived = Date.now()
        let event: ServerEvent
        try { event = JSON.parse(data) as ServerEvent } catch { return }
        switch (event.type) {
          case 'snapshot':
            abortHistory()
            clearTimeout(handshakeTimer)
            ready.current = true
            retries = 0
            setStatus('connected')
            setError('')
            setRoom(event.room)
            setMember(event.member)
            setMembers(event.members)
            setMessages(event.messages)
            setHasMore(event.has_more)
            event.messages.filter(message => message.sender.id === memberId).forEach(message => acknowledge(message.client_message_id))
            heartbeat = setInterval(() => {
              if (ws.readyState !== WebSocket.OPEN) return
              if (Date.now() - lastReceived > 65000) ws.close()
              else ws.send(JSON.stringify({ type: 'ping' }))
            }, 25000)
            break
          case 'state': {
            setRoom(event.room)
            setMembers(event.members)
            const self = event.members.find(item => item.id === memberId)
            if (!self) { revoke('Your room access is no longer available.'); break }
            setMember(self)
            setTyping(current => Object.fromEntries(Object.entries(current).filter(([id]) =>
              event.room.status === 'active' && event.members.some(item => item.id === id && item.online && !item.muted),
            )))
            if (event.room.status !== 'active' || self.muted) rejectPending('Messaging is now disabled. Your draft has been kept.')
            break
          }
          case 'message':
            setMessages(current => mergeMessages(current, [event.message]))
            if (event.message.sender.id === memberId) acknowledge(event.message.client_message_id)
            setTyping(current => {
              const next = { ...current }; delete next[event.message.sender.id]; return next
            })
            break
          case 'message_ack':
            acknowledge(event.client_message_id)
            break
          case 'message_deleted':
            abortHistory()
            setMessages(current => current.filter(message => message.id !== event.message_id))
            break
          case 'messages_cleared':
            abortHistory()
            setMessages([])
            setHasMore(false)
            break
          case 'typing':
            if (event.user.id === memberId) break
            setTyping(current => {
              const next = { ...current }
              if (event.is_typing) next[event.user.id] = { name: event.user.name, until: Date.now() + 3500 }
              else delete next[event.user.id]
              return next
            })
            break
          case 'access_revoked':
            revoke(event.message)
            break
          case 'error':
            setError(event.message)
            rejectPending(event.message)
            break
        }
      }
      ws.onclose = event => {
        clearInterval(heartbeat)
        clearTimeout(handshakeTimer)
        if (disposed || blocked) return
        ready.current = false
        setMembers(current => current.map(item => ({ ...item, online: false })))
        setTyping({})
        abortHistory()
        rejectPending('Connection interrupted. Your draft is here; retry after reconnecting.')
        if ([1008, 4401, 4403].includes(event.code)) {
          revoke(event.reason || 'Your room session is no longer available.')
          return
        }
        setStatus('reconnecting')
        reconnectTimer = setTimeout(connect, Math.min(1000 * 2 ** retries++, 20000))
      }
      ws.onerror = () => ws.close()
    }

    connect()
    const typingTimer = setInterval(() => {
      setTyping(current => {
        const entries = Object.entries(current).filter(([, value]) => value.until > Date.now())
        return entries.length === Object.keys(current).length ? current : Object.fromEntries(entries)
      })
    }, 1000)

    return () => {
      disposed = true
      ready.current = false
      clearTimeout(reconnectTimer)
      clearTimeout(handshakeTimer)
      clearInterval(heartbeat)
      clearInterval(typingTimer)
      historyRequest.current?.abort()
      socket.current?.close()
      socket.current = null
      rejectPending('You left the conversation.')
    }
  }, [roomId, token, memberId, attempt, rejectPending])

  const canSend = status === 'connected' && room.status === 'active' && !member.muted && !terminal

  const sendMessage = useCallback((content: string, kind: MessageKind): Promise<void> => {
    const ws = socket.current
    if (!canSend || !ready.current || ws?.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('Messaging is currently unavailable.'))
    }
    if (pending.current) return Promise.reject(new Error('Your previous message is still sending.'))
    const previous = retryMessage.current
    const id = previous?.content === content && previous.kind === kind ? previous.id : crypto.randomUUID()
    retryMessage.current = { id, content, kind }
    setError('')
    return new Promise((resolve, reject) => {
      pending.current = { id, resolve, reject,
        timer: setTimeout(() => rejectPending('Delivery could not be confirmed. You can safely retry this message.'), 12000),
      }
      try { ws.send(JSON.stringify({ type: 'message', content, kind, client_message_id: id })) }
      catch { rejectPending('Your message could not be sent. Please try again.') }
    })
  }, [canSend, rejectPending])

  const sendTyping = useCallback((isTyping: boolean) => {
    if (!canSend || !ready.current || socket.current?.readyState !== WebSocket.OPEN) return
    if (isTyping && Date.now() - lastTyping.current < 1200) return
    lastTyping.current = Date.now()
    socket.current.send(JSON.stringify({ type: 'typing', is_typing: isTyping }))
  }, [canSend])

  async function loadOlder() {
    if (!messages.length || loadingOlder || !hasMore || terminal) return
    const controller = new AbortController()
    historyRequest.current = controller
    setLoadingOlder(true)
    try {
      const page = await api.messages(session, messages[0].id, controller.signal)
      if (controller.signal.aborted) return
      setMessages(current => mergeMessages(page.messages, current))
      setHasMore(page.has_more)
    } catch (error) {
      if (!controller.signal.aborted) setError(errorMessage(error))
    } finally {
      if (!controller.signal.aborted) { setLoadingOlder(false); historyRequest.current = null }
    }
  }

  return {
    room, member, members, messages, typingNames: Object.values(typing).map(user => user.name),
    status, error, terminal, hasMore, loadingOlder, canSend, sendMessage, sendTyping, loadOlder,
    retry: () => setAttempt(value => value + 1), clearError: () => setError(''),
  }
}
