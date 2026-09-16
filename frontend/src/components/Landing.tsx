import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { ArrowRight, ArrowUpRight, Check, Code2, Crown, Hash, Link2, LoaderCircle, MessageCircle, Plus, ShieldCheck, Sparkles, Users } from 'lucide-react'
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
      const session = tab === 'create' ? await api.createRoom(name.trim(), title.trim() || 'A little get-together') : await api.joinRoom(name.trim(), code)
      onOpen(session)
    } catch (error) { setError(errorMessage(error)); setBusy(false) }
  }

  return <div className="landing">
    <header className="landing-nav"><button className="brand brand-button" onClick={onHome}><span className="brand-mark"><MessageCircle size={27} /></span>gather<span className="brand-period">.</span></button><span className="no-account-pill"><span className="status-dot" /> No accounts. Just a room.</span></header>
    <main className="landing-main">
      <section className="landing-hero">
        <div className="hero-copy"><span className="eyebrow"><Sparkles size={14} /> A LITTLE CLOSER, TOGETHER</span><h1>Your people.<br /><span>One room away.</span></h1><p>A spontaneous catch-up. A shared idea. A few lines of code.<br className="desktop-break" /> Make a room, share the code, and let the conversation flow.</p><div className="hero-checks"><span><Check size={15} /> No sign-up</span><span><Check size={15} /> Instant connection</span><span><Check size={15} /> Your room, your rules</span></div>
          <div className="room-illustration" aria-hidden="true"><div className="illustration-orbit" /><span className="illustration-spark">✧</span><div className="illustration-card"><span className="illustration-icon"><MessageCircle size={24} /></span><div><strong>A space for your people</strong><span>One code. A world of conversation.</span></div><span className="illustration-live" /></div><div className="illustration-code"><Hash size={19} /> MAKE–ROOM <span><Users size={14} /> together</span></div><span className="floating-code"><Code2 size={20} /></span><span className="floating-heart">♡</span></div>
        </div>
        <div className="entry-card">
          <div className="entry-tabs" role="tablist" aria-label="Start a meeting"><button role="tab" aria-selected={tab === 'create'} disabled={busy} onClick={() => { setTab('create'); setError('') }}><Plus size={17} /> Create a room</button><button role="tab" aria-selected={tab === 'join'} disabled={busy} onClick={() => { setTab('join'); setError('') }}><Link2 size={17} /> Join a room</button></div>
          <div className="entry-body"><div className="entry-icon">{tab === 'create' ? <Sparkles size={24} /> : <Hash size={26} />}</div><h2>{tab === 'create' ? 'Make room for a good conversation.' : 'Your people are waiting.'}</h2><p>{tab === 'create' ? 'You bring the people. We’ll bring the space.' : 'A room code and your name. That’s all it takes.'}</p>
            {missingSession && <div className="inline-notice">This browser doesn’t have a session for that room. Ask the host for its invitation code.</div>}
            <form className="modal-form" onSubmit={submit}>
              <label htmlFor="entry-name">Your name</label><input id="entry-name" value={name} placeholder="What should we call you?" minLength={2} maxLength={24} autoComplete="nickname" required disabled={busy} onChange={event => setName(event.target.value)} />
              {tab === 'create' ? <><label htmlFor="entry-title">Meeting title <span className="optional">optional</span></label><input id="entry-title" value={title} placeholder="e.g. Friday ideas, project catch-up…" maxLength={60} disabled={busy} onChange={event => setTitle(event.target.value)} /></> :
                <><label htmlFor="entry-code">Room code</label><input id="entry-code" className="room-code-input" value={code} placeholder="XXXX–XXXX" maxLength={9} required autoComplete="off" spellCheck={false} disabled={busy} onChange={event => {
                  const raw = event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8)
                  setCode(raw.length > 4 ? `${raw.slice(0, 4)}-${raw.slice(4)}` : raw)
                }} /><span className="field-hint">Ask your host for the 8-character code.</span></>}
              {error && <p className="form-error" role="alert">{error}</p>}
              <button className="primary-button" disabled={busy || name.trim().length < 2 || (tab === 'join' && code.replace('-', '').length !== 8) || (tab === 'create' && title.trim().length === 1)}>{busy ? <LoaderCircle size={18} className="spin" /> : <ArrowRight size={18} />}{busy ? (tab === 'create' ? 'Making your room…' : 'Joining your people…') : (tab === 'create' ? 'Create room' : 'Join room')}</button>
              {waking && <p className="field-hint" role="status">The server may be waking up. This can take about a minute.</p>}
            </form><div className="entry-footer"><ShieldCheck size={14} />{tab === 'create' ? 'You’ll be the host. You’re in control.' : 'No passwords, profiles, or hoops to jump through.'}</div>
          </div>
        </div>
      </section>
      <section className="landing-features" aria-label="Meeting features"><div><span><Hash size={21} /></span><div><h3>One code brings you together</h3><p>Share a link or room code. Anyone you invite can join.</p></div></div><div><span><Code2 size={21} /></span><div><h3>Ideas, in their original form</h3><p>Share messages, multiline text, and neatly formatted code.</p></div></div><div><span><Crown size={21} /></span><div><h3>Your space. Your say.</h3><p>Manage participants and keep the conversation on track.</p></div></div></section>
      {sessions.length > 0 && <section className="recent-section"><div className="recent-heading"><div><span className="eyebrow">PICK UP WHERE YOU LEFT OFF</span><h2>Your recent rooms</h2></div><span>Saved on this browser</span></div><div className="recent-grid">{sessions.map(session => <button key={`${session.room.id}:${session.member.id}`} className="recent-room" onClick={() => onOpen(session)}><span className="recent-icon">{session.room.status === 'ended' ? <MessageCircle size={21} /> : <Hash size={22} />}</span><div><strong>{session.room.title}</strong><span>{session.member.name} · {session.member.id === session.room.host_id ? 'Host' : 'Guest'} · {session.room.status === 'ended' ? 'Transcript' : session.room.code}</span></div><ArrowUpRight size={18} /></button>)}</div><p className="recent-note">Your room access lives in this browser. Keep its site data to return to your meetings and transcripts.</p></section>}
    </main><footer className="landing-footer"><span>Good conversations. Less distance.</span><span>Text-first meetings, made simple <span>✦</span></span></footer>
  </div>
}
