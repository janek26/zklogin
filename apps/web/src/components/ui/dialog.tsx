import { useEffect, useRef, type ReactNode } from 'react'

/**
 * Minimal shadcn-style Dialog: dark overlay, centered panel, close button,
 * Escape-to-close, click-outside-to-close, and body scroll lock. Matches the
 * app's dark theme (see `.dialog-*` styles in style.css).
 */
export function Dialog(props: {
  open: boolean
  onClose: () => void
  children: ReactNode
  labelledBy?: string
}) {
  const panelRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!props.open) return
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') props.onClose()
    }
    document.addEventListener('keydown', onKey)
    panelRef.current?.focus()
    return () => {
      document.body.style.overflow = previous
      document.removeEventListener('keydown', onKey)
    }
  }, [props.open, props.onClose])

  if (!props.open) return null

  return (
    <div
      className="dialog-overlay"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) props.onClose()
      }}
    >
      <div
        ref={panelRef}
        className="dialog-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={props.labelledBy}
        tabIndex={-1}
      >
        <button
          type="button"
          className="dialog-close"
          onClick={props.onClose}
          aria-label="Close"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
        {props.children}
      </div>
    </div>
  )
}
