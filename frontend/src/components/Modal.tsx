import { useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import { X } from 'lucide-react'

export default function Modal({ children, title, onClose, className = '' }: {
  children: ReactNode
  title: string
  onClose?: () => void
  className?: string
}) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const dialog = ref.current!
    dialog.showModal()
    return () => dialog.close()
  }, [])

  return (
    <dialog ref={ref} className={`modal ${className}`} aria-label={title}
      onCancel={event => { event.preventDefault(); onClose?.() }}
      onClick={event => { if (event.target === ref.current && onClose) onClose() }}>
      <div className="modal-content">
        {onClose && <button className="icon-button modal-close" onClick={onClose} aria-label="Close dialog"><X size={20} /></button>}
        {children}
      </div>
    </dialog>
  )
}
