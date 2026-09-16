import { useRef, useState } from 'react'
import type { FormEvent, KeyboardEvent } from 'react'
import { ArrowUp, Code2, LoaderCircle, Smile } from 'lucide-react'
import { errorMessage } from '../api'
import type { MessageKind } from '../types'

const emojis = ['👋', '😊', '🎉', '❤️', '👍', '🚀', '☕', '✨']

export default function Composer({ roomName, connected, disabledReason, sendMessage, sendTyping }: {
  roomName: string
  connected: boolean
  disabledReason: string
  sendMessage: (content: string, kind: MessageKind) => Promise<void>
  sendTyping: (typing: boolean) => void
}) {
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  const [showEmoji, setShowEmoji] = useState(false)
  const [kind, setKind] = useState<MessageKind>('text')
  const textarea = useRef<HTMLTextAreaElement>(null)

  function resize() {
    requestAnimationFrame(() => {
      if (textarea.current) {
        textarea.current.style.height = 'auto'
        textarea.current.style.height = `${Math.min(textarea.current.scrollHeight, 160)}px`
      }
    })
  }

  async function submit(event?: FormEvent) {
    event?.preventDefault()
    if (!draft.trim() || !connected || sending) return
    setSending(true)
    setError('')
    setShowEmoji(false)
    sendTyping(false)
    try {
      await sendMessage(draft, kind)
      setDraft('')
      resize()
    } catch (error) {
      setError(errorMessage(error))
    } finally {
      setSending(false)
      requestAnimationFrame(() => textarea.current?.focus())
    }
  }

  function keyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      void submit()
    }
  }

  return (
    <div className="composer-wrap">
      {error && <p className="composer-error" role="alert">{error}</p>}
      <form className={`composer ${kind === 'code' ? 'code-composer' : ''} ${!connected ? 'composer-offline' : ''}`} onSubmit={submit}>
        <textarea ref={textarea} value={draft} maxLength={20000} rows={1} disabled={sending}
          aria-label={`Message ${roomName}`} placeholder={connected ? (kind === 'code' ? 'Paste code here. Your formatting stays intact…' : `Message ${roomName}…`) : disabledReason}
          onChange={event => { setDraft(event.target.value); sendTyping(Boolean(event.target.value.trim())); resize() }}
          onBlur={() => sendTyping(false)} onKeyDown={keyDown} />
        <div className="composer-toolbar">
          <div className="composer-tools"><div className="emoji-container">
            <button type="button" className={`icon-button ${showEmoji ? 'selected' : ''}`} aria-label="Choose an emoji" aria-expanded={showEmoji}
              disabled={sending} onClick={() => setShowEmoji(value => !value)}><Smile size={20} /></button>
            {showEmoji && <div className="emoji-picker" aria-label="Emoji picker">
              {emojis.map(emoji => <button type="button" key={emoji} aria-label={`Insert ${emoji}`} onClick={() => {
                setDraft(value => value.length + emoji.length <= 20000 ? value + emoji : value); setShowEmoji(false); textarea.current?.focus(); resize()
              }}>{emoji}</button>)}
            </div>}
          </div><button type="button" className={`code-toggle ${kind === 'code' ? 'selected' : ''}`} aria-label="Code formatting" aria-pressed={kind === 'code'} disabled={sending} onClick={() => setKind(value => value === 'code' ? 'text' : 'code')}><Code2 size={17} /><span>{kind === 'code' ? 'Code' : 'Text / code'}</span></button></div>
          <div className="send-group">
            {draft.length > 18000 && <span className="character-count">{draft.length}/20000</span>}
            <span className="send-hint">a little hello goes a long way</span>
            <button className="send-button" type="submit" aria-label="Send message" disabled={!connected || !draft.trim() || sending}>
              {sending ? <LoaderCircle size={19} className="spin" /> : <ArrowUp size={21} />}
            </button>
          </div>
        </div>
      </form>
      <p className="composer-caption"><span><kbd>Enter</kbd> to send <span className="caption-dot">·</span> <kbd>Shift + Enter</kbd> for a new line</span><span>Made for real conversations <span className="caption-spark">✦</span></span></p>
    </div>
  )
}
