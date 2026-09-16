import { useEffect, useState } from 'react'
import { Check, Copy } from 'lucide-react'

export default function CopyButton({ text, label, compact = false }: { text: string; label: string; compact?: boolean }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')
  useEffect(() => {
    if (state === 'idle') return
    const timer = setTimeout(() => setState('idle'), 2500)
    return () => clearTimeout(timer)
  }, [state])
  return <span className="copy-control">
    <button type="button" className={compact ? 'icon-button' : 'secondary-button'} title={label} aria-label={label} onClick={async () => {
      try { await navigator.clipboard.writeText(text); setState('copied') }
      catch { setState('failed') }
    }}>{state === 'copied' ? <Check size={16} /> : <Copy size={16} />}{!compact && (state === 'copied' ? 'Copied!' : label)}</button>
    {state === 'failed' && <span className="copy-error" role="status">Select the text and copy it manually.</span>}
  </span>
}
