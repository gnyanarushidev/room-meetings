import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { ArrowRight, ArrowUpRight, Hash, Link2, LoaderCircle, MessageCircle, Plus } from 'lucide-react'
import { api, errorMessage } from '../api'
import type { RoomSession } from '../types'

export default function Landing({ initialCode, sessions, missingSession, onOpen, onUpdate, onHome }: {
  initialCode: string
  sessions: RoomSession[]
  missingSession: boolean
  onOpen: (session: RoomSession) => void
  onUpdate: (session: RoomSession) => void
  onHome: () => void
}) {
  const [tab, setTab] = useState<'create' | 'join'>(initialCode ? 'join' : 'create')
  const [name, setName] = useState('')
  const [title, setTitle] = useState('')
  const [code, setCode] = useState(initialCode.toUpperCase())
  const [busy, setBusy] = useState(false)
  const [waking, setWaking] = useState(false)
  const [error, setError] = useState('')
  const [showAllRooms, setShowAllRooms] = useState(false)
  const visibleSessions = showAllRooms ? sessions : sessions.slice(0, 3)
  const originalSessions = useRef(sessions)

  useEffect(() => {
    const controller = new AbortController()
    for (const saved of originalSessions.current) {
      void api.session(saved, controller.signal).then(current => {
        if (!controller.signal.aborted) onUpdate({ token: saved.token, room: current.room, member: current.member })
      }).catch(() => { /* Opening the room shows specific access or connectivity errors. */ })
    }
    return () => controller.abort()
  }, [onUpdate])

  useEffect(() => {
    if (!busy) { setWaking(false); return }
    const timer = setTimeout(() => setWaking(true), 5000)
    return () => clearTimeout(timer)
  }, [busy])

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    setError('')
    try {
      const session = tab === 'create' ? await api.createRoom(name.trim(), title.trim() || 'New meeting') : await api.joinRoom(name.trim(), code)
      onOpen(session)
    } catch (error) { setError(errorMessage(error)); setBusy(false) }
  }

  return <div className="landing">
    <header className="landing-nav"><button className="brand brand-button" aria-label="Gather home" onClick={onHome}><span className="brand-mark"><MessageCircle size={25} /></span>gather<span className="brand-period">.</span></button></header>
    <main className="landing-main">
      <section aria-labelledby="entry-heading">
        <div className="landing-heading"><h1 id="entry-heading">Create or join a room</h1><p>A shared space for messages and code.</p></div>
        <div className="entry-card">
          <div className="entry-tabs" role="tablist" aria-label="Start a meeting"><button role="tab" aria-selected={tab === 'create'} disabled={busy} onClick={() => { setTab('create'); setError('') }}><Plus size={17} /> Create a room</button><button role="tab" aria-selected={tab === 'join'} disabled={busy} onClick={() => { setTab('join'); setError('') }}><Link2 size={17} /> Join a room</button></div>
          <div className="entry-body">
            {missingSession && <div className="inline-notice">Join with the room code to access this meeting.</div>}
            <form className="modal-form" onSubmit={submit}>
              <label htmlFor="entry-name">Your name</label><input id="entry-name" value={name} placeholder="Enter your name" minLength={2} maxLength={24} autoComplete="nickname" required disabled={busy} onChange={event => setName(event.target.value)} />
              {tab === 'create' ? <><label htmlFor="entry-title">Meeting title <span className="optional">optional</span></label><input id="entry-title" value={title} placeholder="e.g. Team catch-up" maxLength={60} disabled={busy} onChange={event => setTitle(event.target.value)} /></> :
                <><label htmlFor="entry-code">Room code</label><input id="entry-code" className="room-code-input" value={code} placeholder="XXXX–XXXX" maxLength={9} required autoComplete="off" spellCheck={false} disabled={busy} onChange={event => {
                  const raw = event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8)
                  setCode(raw.length > 4 ? `${raw.slice(0, 4)}-${raw.slice(4)}` : raw)
                }} /></>}
              {error && <p className="form-error" role="alert">{error}</p>}
              <button className="primary-button" disabled={busy || name.trim().length < 2 || (tab === 'join' && code.replace('-', '').length !== 8) || (tab === 'create' && title.trim().length === 1)}>{busy ? <LoaderCircle size={18} className="spin" /> : <ArrowRight size={18} />}{busy ? (tab === 'create' ? 'Creating…' : 'Joining…') : (tab === 'create' ? 'Create room' : 'Join room')}</button>
              {waking && <p className="field-hint" role="status">The server may be waking up. This can take about a minute.</p>}
            </form>
          </div>
        </div>
      </section>
      {sessions.length > 0 && <section className="recent-section" aria-labelledby="recent-heading">
        <div className="recent-heading"><h2 id="recent-heading">Recent rooms</h2>{sessions.length > 3 && <button className="text-button" aria-expanded={showAllRooms} aria-controls="recent-rooms" onClick={() => setShowAllRooms(value => !value)}>{showAllRooms ? 'Show less' : `View all (${sessions.length})`}</button>}</div>
        <div className="recent-list" id="recent-rooms">{visibleSessions.map(session => <button key={`${session.room.id}:${session.member.id}`} className="recent-room" onClick={() => onOpen(session)}><span className="recent-icon">{session.room.status === 'ended' ? <MessageCircle size={19} /> : <Hash size={19} />}</span><div><strong>{session.room.title}</strong><span>{session.member.name} · {session.member.id === session.room.host_id ? 'Host' : 'Guest'}{session.room.status === 'ended' ? ' · Ended' : ''}</span></div><ArrowUpRight size={17} /></button>)}</div>
      </section>}
    </main>
  </div>
}
