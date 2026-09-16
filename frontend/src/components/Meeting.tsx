import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ArrowDown, ArrowLeft, ChevronRight, Code2, Crown, Download, LoaderCircle, LockKeyhole, LogOut, Menu, MessageCircle, MessageCircleOff, RefreshCw, ShieldCheck, Square, Trash2, UnlockKeyhole, UserMinus, Users, X } from 'lucide-react'
import { api, errorMessage } from '../api'
import { useChat } from '../hooks/useChat'
import type { ChatMessage, Member, MessageKind, RoomSession } from '../types'
import Avatar from './Avatar'
import Composer from './Composer'
import CopyButton from './CopyButton'
import Modal from './Modal'

type Confirmation =
  | { kind: 'leave' | 'end' | 'clear' | 'delete-room' }
  | { kind: 'remove' | 'transfer'; member: Member }
  | { kind: 'delete-message'; message: ChatMessage }

function dayLabel(value: string) {
  const date = new Date(value)
  if (date.toDateString() === new Date().toDateString()) return 'Today'
  return date.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' })
}

export default function Meeting({ session, onUpdate, onHome, onForget }: {
  session: RoomSession
  onUpdate: (session: RoomSession) => void
  onHome: () => void
  onForget: () => void
}) {
  const chat = useChat(session)
  const { room, member } = chat
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [membersOpen, setMembersOpen] = useState(false)
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null)
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState('')
  const [exporting, setExporting] = useState(false)
  const [atBottom, setAtBottom] = useState(true)
  const scroll = useRef<HTMLDivElement>(null)
  const follow = useRef(true)
  const anchor = useRef<{ height: number; top: number } | null>(null)
  const exportRequest = useRef<AbortController | null>(null)
  const isHost = room.host_id === member.id
  const ended = room.status === 'ended'
  const connected = chat.status === 'connected'
  const online = chat.members.filter(item => item.online)
  const invitation = `${window.location.origin}/join/${room.code}`

  useEffect(() => {
    if (!chat.terminal) onUpdate({ token: session.token, room, member })
  }, [room, member, session.token, chat.terminal, onUpdate])

  useEffect(() => () => exportRequest.current?.abort(), [])
  useEffect(() => { if (chat.terminal) exportRequest.current?.abort() }, [chat.terminal])

  useLayoutEffect(() => {
    const node = scroll.current
    if (!node) return
    if (anchor.current && !chat.loadingOlder) {
      node.scrollTop = anchor.current.top + node.scrollHeight - anchor.current.height
      anchor.current = null
    } else if (follow.current && !anchor.current) node.scrollTop = node.scrollHeight
  }, [chat.messages, chat.loadingOlder])

  function ask(value: Confirmation) {
    setActionError('')
    setConfirmation(value)
    setSidebarOpen(false)
  }

  async function perform(operation: () => Promise<unknown>) {
    if (busy) return
    setBusy(true)
    setActionError('')
    try { await operation(); setConfirmation(null) }
    catch (error) { setActionError(errorMessage(error)) }
    finally { setBusy(false) }
  }

  async function confirm() {
    if (!confirmation) return
    if (confirmation.kind === 'leave') { onHome(); return }
    await perform(async () => {
      switch (confirmation.kind) {
        case 'end': await api.roomAction(session, 'end'); break
        case 'clear': await api.clearMessages(session); break
        case 'remove': await api.memberAction(session, confirmation.member.id, 'remove'); break
        case 'transfer': await api.roomAction(session, 'transfer', confirmation.member.id); break
        case 'delete-message': await api.deleteMessage(session, confirmation.message.id); break
        case 'delete-room': await api.deleteRoom(session); onForget(); break
      }
    })
  }

  async function exportTranscript() {
    if (exporting) return
    const controller = new AbortController()
    exportRequest.current = controller
    setExporting(true)
    setActionError('')
    try {
      let before: string | undefined
      let all: ChatMessage[] = []
      while (true) {
        const page = await api.messages(session, before, controller.signal)
        all = [...page.messages, ...all]
        if (!page.has_more || !page.messages.length) break
        before = page.messages[0].id
      }
      if (controller.signal.aborted) return
      const text = `${room.title}\nRoom: ${room.code}\nExported: ${new Date().toLocaleString()}\n\n` +
        all.map(message => `[${new Date(message.created_at).toLocaleString()}] ${message.sender.name}${message.kind === 'code' ? ' (code)' : ''}\n${message.content}`).join('\n\n')
      const downloadUrl = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }))
      const link = document.createElement('a')
      link.href = downloadUrl
      link.download = `gather-${room.code}.txt`
      link.click()
      setTimeout(() => URL.revokeObjectURL(downloadUrl), 1000)
    } catch (error) {
      if (!controller.signal.aborted) setActionError(errorMessage(error))
    } finally { setExporting(false); exportRequest.current = null }
  }

  const confirmationCopy = confirmation && {
    leave: ['Leave this meeting?', isHost && !ended ? 'The room stays open and you keep your host role on this browser. You can also transfer it to someone in Participants.' : 'You can return from your recent rooms on this browser.', 'Leave for now'],
    end: ['End the meeting for everyone?', 'New joins and messages will stop. Existing participants can still read and export the transcript until you delete it.', 'End meeting'],
    clear: ['Clear the conversation?', 'All shared messages and code will be permanently removed for everyone.', 'Clear messages'],
    'delete-room': ['Permanently delete this room?', 'The room, transcript, and all participant access will be removed. This cannot be undone.', 'Delete room permanently'],
    remove: ['Remove this participant?', confirmation.kind === 'remove' ? `${confirmation.member.name} will be disconnected and lose access to this room and its transcript. Lock entry to prevent a fresh anonymous join.` : '', 'Remove participant'],
    transfer: ['Pass the host role?', confirmation.kind === 'transfer' ? `${confirmation.member.name} will control the room and participants. You’ll remain in the room as a guest.` : '', 'Transfer host'],
    'delete-message': ['Delete this message?', 'This message will be removed from the conversation for everyone.', 'Delete message'],
  }[confirmation.kind]

  if (chat.terminal) return <div className="terminal-screen"><div className="terminal-card"><span className="terminal-icon"><MessageCircleOff size={32} /></span><h1>Room unavailable</h1><p role="alert">{chat.terminal}</p><button className="primary-button" onClick={onForget}><ArrowLeft size={17} /> Back to home</button></div></div>

  return <div className="app-shell">
    {sidebarOpen && <button className="sidebar-backdrop" aria-label="Close navigation" onClick={() => setSidebarOpen(false)} />}
    <aside className={`sidebar ${sidebarOpen ? 'sidebar-open' : ''}`} aria-label="Room navigation">
      <button className="brand brand-button" aria-label="Back to your rooms" onClick={() => ask({ kind: 'leave' })}><span className="brand-mark"><MessageCircle size={25} /></span>gather<span className="brand-period">.</span></button>
      <div className="invite-card"><div className="sidebar-label">ROOM CODE</div><div className="invite-code"><strong data-testid="room-code">{room.code}</strong><CopyButton text={room.code} label="Copy room code" compact /></div>{!ended && <CopyButton text={invitation} label="Copy invitation link" />}</div>
      <nav className="workspace-links" aria-label="Room views"><button className={`workspace-nav ${!membersOpen ? 'nav-selected' : ''}`} onClick={() => { setMembersOpen(false); setSidebarOpen(false) }}><MessageCircle size={18} /><span>{ended ? 'Transcript' : 'Conversation'}</span></button><button className={`workspace-nav ${membersOpen ? 'nav-selected' : ''}`} onClick={() => { setMembersOpen(true); setSidebarOpen(false) }}><Users size={18} /><span>Participants</span><span className="nav-count">{chat.members.length}</span></button></nav>
      {isHost && <section className="host-controls" aria-label="Host controls"><div className="sidebar-label"><span>HOST CONTROLS</span><Crown size={13} /></div>{!ended && <button disabled={busy || !connected} onClick={() => void perform(() => api.roomAction(session, room.locked ? 'unlock' : 'lock'))}>{room.locked ? <UnlockKeyhole size={16} /> : <LockKeyhole size={16} />}{room.locked ? 'Unlock room entry' : 'Lock room entry'}<span className={`toggle-dot ${room.locked ? 'toggle-on' : ''}`} /></button>}<button disabled={busy || !connected || !chat.messages.length} onClick={() => ask({ kind: 'clear' })}><Trash2 size={16} /> Clear conversation</button>{ended ? <button className="danger-link" disabled={busy || !connected} onClick={() => ask({ kind: 'delete-room' })}><Trash2 size={16} /> Delete room permanently</button> : <button className="danger-link" disabled={busy || !connected} onClick={() => ask({ kind: 'end' })}><Square size={15} /> End meeting</button>}</section>}
      <div className="sidebar-bottom"><div className="profile-card"><Avatar user={member} /><div><strong>{member.name}</strong><span>{isHost ? 'Host' : member.muted ? 'Muted by host' : 'Guest'}</span></div><button className="icon-button" aria-label="Leave meeting" title="Leave meeting" onClick={() => ask({ kind: 'leave' })}><LogOut size={17} /></button></div></div>
    </aside>

    <main className="main-panel">
      <header className="room-header">
        <button className="icon-button mobile-menu" aria-label="Open navigation" onClick={() => setSidebarOpen(true)}><Menu size={21} /></button>
        <div className="room-heading-text"><div className="room-title-line"><h1 title={room.title}>{room.title}</h1>{(ended || room.locked) && <span className="room-badge">{ended ? 'READ-ONLY' : 'LOCKED'}</span>}</div><span className={`connection-label ${connected ? 'is-connected' : ''}`} role="status"><span className="status-dot" />{connected ? 'Connected' : chat.status === 'reconnecting' ? 'Reconnecting…' : 'Connecting…'}</span></div>
        <button className={`members-button ${membersOpen ? 'selected' : ''}`} aria-label="Toggle participants" aria-expanded={membersOpen} onClick={() => setMembersOpen(value => !value)}><Users size={16} /><span>{online.length}<span className="online-word"> online</span></span></button>
        <button className="icon-button" aria-label={exporting ? 'Exporting…' : 'Export transcript'} title="Export transcript" disabled={exporting || !connected} onClick={() => void exportTranscript()}>{exporting ? <LoaderCircle className="spin" size={18} /> : <Download size={18} />}</button>
      </header>
      {!ended && member.muted && <div className="notice mute-notice" role="status"><MessageCircleOff size={17} /><span>The host has muted you. You can still read and export messages.</span></div>}
      {!connected && <div className="notice connection-notice"><LoaderCircle size={16} className="spin" /><span>{chat.status === 'reconnecting' ? 'Connection lost. Reconnecting automatically…' : 'Connecting to your room. The server may need a moment to wake up.'}</span><button onClick={chat.retry}>Retry</button></div>}
      {(chat.error || actionError) && !confirmation && <div className="notice error-notice" role="alert"><span>{actionError || chat.error}</span><button aria-label="Dismiss error" onClick={() => { chat.clearError(); setActionError('') }}><X size={16} /></button></div>}
      <div className="conversation-layout"><div className="conversation">
        <div className={`message-scroll ${chat.messages.length === 0 ? 'message-scroll-empty' : ''}`} ref={scroll} onScroll={() => {
          const node = scroll.current!
          follow.current = node.scrollHeight - node.scrollTop - node.clientHeight < 100
          setAtBottom(follow.current)
        }}>
          {chat.hasMore && <button className="load-older" disabled={chat.loadingOlder} onClick={() => {
            const node = scroll.current!
            anchor.current = { height: node.scrollHeight, top: node.scrollTop }
            void chat.loadOlder()
          }}>{chat.loadingOlder ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />}{chat.loadingOlder ? 'Loading…' : 'Load earlier messages'}</button>}
          {chat.messages.length === 0 && <div className="empty-conversation"><MessageCircle size={30} strokeWidth={1.5} /><h2>{ended ? 'No saved messages' : 'No messages yet'}</h2><p>{ended ? 'This meeting has ended.' : 'Send a message or invite someone to join.'}</p></div>}
          <div className="messages" role="log" aria-label="Messages" aria-live="polite" aria-relevant="additions text">{chat.messages.map((message, index) => {
            const previous = chat.messages[index - 1]
            const newDay = !previous || new Date(previous.created_at).toDateString() !== new Date(message.created_at).toDateString()
            const own = message.sender.id === member.id
            return <div key={message.id}>{newDay && <div className="date-divider"><span>{dayLabel(message.created_at)}</span></div>}<article className={`message ${own ? 'own-message' : ''}`}><Avatar user={message.sender} /><div className="message-body"><div className="message-meta"><strong>{message.sender.name}</strong>{message.sender.id === room.host_id && <Crown size={12} className="host-crown" aria-label="Host" />}<time dateTime={message.created_at} title={new Date(message.created_at).toLocaleString()}>{new Date(message.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></div>{message.kind === 'code' ? <div className="shared-code"><span><Code2 size={13} /> Code snippet</span><pre><code>{message.content}</code></pre></div> : <p>{message.content}</p>}</div><div className="message-actions"><CopyButton text={message.content} label="Copy message" compact />{isHost && <button className="icon-button delete-message" aria-label={`Delete message from ${message.sender.name}`} disabled={busy || !connected} onClick={() => ask({ kind: 'delete-message', message })}><Trash2 size={14} /></button>}</div></article></div>
          })}</div>
        </div>
        {!atBottom && <button className="jump-latest" onClick={() => { follow.current = true; scroll.current?.scrollTo({ top: scroll.current.scrollHeight, behavior: 'smooth' }) }}><ArrowDown size={14} /> Latest messages</button>}
        <div className="typing-indicator" role="status">{chat.typingNames.length > 0 && <><span className="typing-dots"><i /><i /><i /></span>{chat.typingNames.slice(0, 2).join(' and ')}{chat.typingNames.length > 2 ? ' and others are' : chat.typingNames.length === 1 ? ' is' : ' are'} typing…</>}</div>
        {ended ? <div className="transcript-footer"><LockKeyhole size={15} /><span>Transcript available until the host deletes it.</span></div> : <Composer roomName={room.title} connected={chat.canSend} disabledReason={member.muted ? 'Muted by host. Your draft is saved here.' : 'Waiting for the connection…'} sendTyping={chat.sendTyping} sendMessage={(content: string, kind: MessageKind) => { follow.current = true; return chat.sendMessage(content, kind) }} />}
      </div>
      {membersOpen && <aside className="members-panel" aria-label="Participants"><div className="members-heading"><h2>Participants <span>{chat.members.length}</span></h2><button className="icon-button" aria-label="Close participants" onClick={() => setMembersOpen(false)}><X size={18} /></button></div><p className="members-description">{online.length} online</p><div className="member-list">{[...chat.members].sort((a, b) => Number(b.id === room.host_id) - Number(a.id === room.host_id) || Number(b.online) - Number(a.online)).map(person => <div className="member-card" key={person.id}><div className="member"><Avatar user={person} /><div><strong>{person.name} {person.id === member.id && <span>(you)</span>}</strong><span><span className={`status-dot ${!person.online ? 'dot-muted' : ''}`} />{person.id === room.host_id ? 'Host' : person.muted ? 'Muted' : 'Guest'} · {person.online ? 'Online' : 'Offline'}</span></div>{person.id === room.host_id && <Crown size={15} className="host-crown" />}</div>{isHost && person.id !== member.id && <div className="member-controls">{!ended && <><button disabled={busy || !connected} aria-label={`${person.muted ? 'Unmute' : 'Mute'} ${person.name}`} onClick={() => void perform(() => api.memberAction(session, person.id, person.muted ? 'unmute' : 'mute'))}>{person.muted ? <MessageCircle size={13} /> : <MessageCircleOff size={13} />}{person.muted ? 'Unmute' : 'Mute'}</button><button disabled={busy || !connected || !person.online} aria-label={`Make ${person.name} host`} onClick={() => ask({ kind: 'transfer', member: person })}><Crown size={13} /> Make host</button></>}<button className="remove-member" disabled={busy || !connected} aria-label={`Remove ${person.name}`} onClick={() => ask({ kind: 'remove', member: person })}><UserMinus size={13} /> Remove</button></div>}</div>)}</div></aside>}
      </div>
    </main>
    {confirmation && confirmationCopy && <Modal title={confirmationCopy[0]} onClose={busy ? undefined : () => setConfirmation(null)}><div className="modal-icon">{confirmation.kind === 'transfer' ? <Crown size={26} /> : confirmation.kind === 'leave' ? <LogOut size={25} /> : <ShieldCheck size={26} />}</div><h2>{confirmationCopy[0]}</h2><p className="muted">{confirmationCopy[1]}</p>{actionError && <p className="form-error" role="alert">{actionError}</p>}<div className="confirmation-buttons"><button className="secondary-button" disabled={busy} onClick={() => setConfirmation(null)}>Cancel</button><button className={`primary-button ${['remove', 'end', 'clear', 'delete-room', 'delete-message'].includes(confirmation.kind) ? 'danger-button' : ''}`} disabled={busy} onClick={() => void confirm()}>{busy && <LoaderCircle size={16} className="spin" />}{confirmationCopy[2]}</button></div>{confirmation.kind === 'leave' && isHost && !ended && <button className="text-button manage-before-leaving" onClick={() => { setConfirmation(null); setMembersOpen(true) }}>Manage participants before leaving <ChevronRight size={14} /></button>}</Modal>}
  </div>
}
