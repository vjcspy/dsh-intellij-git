/**
 * A pointer-drag and keyboard splitter.
 *
 * The owner holds the value; this reports pointer-equivalent pixel deltas, so the
 * same component drives the column ratio and the dock height whichever way the
 * owner converts them. Arrow keys move 16 px, `Home`/`End` are not bound.
 */
import { useRef, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react'

/** Keyboard step in pixels. */
const KEY_STEP = 16

/** Props of {@link Splitter}. */
export interface SplitterProps {
  /** `vertical` separates two columns, `horizontal` separates a row from the dock. */
  readonly orientation: 'vertical' | 'horizontal'
  readonly value: number
  readonly min: number
  readonly max: number
  readonly label: string
  readonly className?: string
  /** Pointer-equivalent delta in px: positive is right or down. */
  readonly onDelta: (px: number) => void
  readonly onEnd?: () => void
}

/**
 * Render the separator.
 * @param props - see {@link SplitterProps}.
 * @returns a focusable `role="separator"` element.
 */
export function Splitter(props: SplitterProps): ReactNode {
  const { orientation, onDelta, onEnd } = props
  const last = useRef<number | null>(null)
  const vertical = orientation === 'vertical'

  const onPointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    event.currentTarget.setPointerCapture(event.pointerId)
    last.current = vertical ? event.clientX : event.clientY
    event.preventDefault()
  }
  const onPointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    if (last.current === null) return
    const now = vertical ? event.clientX : event.clientY
    const delta = now - last.current
    last.current = now
    if (delta !== 0) onDelta(delta)
  }
  const stop = (event: PointerEvent<HTMLDivElement>): void => {
    if (last.current === null) return
    last.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    onEnd?.()
  }
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const keys = vertical ? { back: 'ArrowLeft', forward: 'ArrowRight' } : { back: 'ArrowUp', forward: 'ArrowDown' }
    if (event.key !== keys.back && event.key !== keys.forward) return
    event.preventDefault()
    onDelta(event.key === keys.forward ? KEY_STEP : -KEY_STEP)
    onEnd?.()
  }

  return (
    <div
      className={`git-splitter ${props.className ?? ''}`}
      data-orientation={orientation}
      role="separator"
      aria-orientation={orientation}
      aria-label={props.label}
      aria-valuenow={Math.round(props.value)}
      aria-valuemin={Math.round(props.min)}
      aria-valuemax={Math.round(props.max)}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={stop}
      onPointerCancel={stop}
      onKeyDown={onKeyDown}
    />
  )
}
