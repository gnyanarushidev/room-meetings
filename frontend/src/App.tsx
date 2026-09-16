import { useCallback, useEffect, useRef, useState } from 'react'
import Landing from './components/Landing'
import Meeting from './components/Meeting'
import { mergeSessions, readSessions, saveSessions } from './storage'
import type { RoomSession } from './types'

export default function App() {
  const [sessions, setSessions] = useState(readSessions)
  const [path, setPath] = useState(window.location.pathname)
  const [storageUnavailable, setStorageUnavailable] = useState(false)
  const sessionCache = useRef(sessions)
  useEffect(() => {
    const change = () => setPath(window.location.pathname)
    window.addEventListener('popstate', change)
    return () => window.removeEventListener('popstate', change)
  }, [])
  const updateSession = useCallback((session: RoomSession) => {
    // Keep every identity's access, including a host who joins their own invitation as a guest.
    const next = mergeSessions([session], readSessions(), sessionCache.current)
    sessionCache.current = next
    setStorageUnavailable(!saveSessions(next))
    setSessions(next)
  }, [])

  function navigate(next: string) {
    window.history.pushState({}, '', next)
    setPath(next)
  }

  function open(session: RoomSession) {
    updateSession(session)
    navigate(`/room/${session.room.id}`)
  }

  function forget(id: string, memberId: string) {
    const next = mergeSessions(readSessions(), sessionCache.current).filter(item => item.room.id !== id || item.member.id !== memberId)
    sessionCache.current = next
    setStorageUnavailable(!saveSessions(next))
    setSessions(next)
    navigate('/')
  }

  const activeId = path.match(/^\/room\/([a-f\d-]+)\/?$/i)?.[1]
  const active = sessions.find(session => session.room.id === activeId)
  const invitationCode = path.match(/^\/join\/([a-z\d-]+)\/?$/i)?.[1] || ''

  return <>
    {storageUnavailable && <div className="storage-notice" role="status">Browser storage is unavailable. Keep this tab open to retain access to your rooms.</div>}
    {active ? <Meeting key={`${active.room.id}:${active.token}`} session={active} onUpdate={updateSession} onHome={() => navigate('/')} onForget={() => forget(active.room.id, active.member.id)} /> :
      <Landing key={path} initialCode={invitationCode} sessions={sessions} onOpen={open} onUpdate={updateSession}
        missingSession={Boolean(activeId)} onHome={() => navigate('/')} />}
  </>
}
