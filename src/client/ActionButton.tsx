/**
 * A toolbar action with its tooltip, a reason when it is disabled, and the
 * running state of the write that owns it.
 *
 * A disabled button takes no focus and no hover, so a legitimately disabled
 * control is wrapped in a span anchor; the tooltip then says why it cannot be
 * used. A control that is running shows the platform's `StateDot` spinner and a
 * `TextShimmer` label instead of its own copy.
 */
import type { ReactNode } from 'react'
import { Button, StateDot, TextShimmer, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'

/** Props of {@link ActionButton}. */
export interface ActionButtonProps {
  readonly tip: string
  readonly disabledTip?: string
  readonly disabled?: boolean
  readonly variant?: 'primary' | 'outline' | 'ghost' | 'toolbar'
  readonly label?: string
  /** Leading glyph, and the only content of an icon button. */
  readonly icon?: ReactNode
  /** Accessible name of an icon-only button. */
  readonly ariaLabel?: string
  /** Phase label shown (with a spinner) while this control owns the running write. */
  readonly running?: string | null
  readonly danger?: boolean
  /** Value of `data-git-marker`, for code that must find this control again. */
  readonly marker?: string
  readonly onClick: () => void
}

/**
 * Render the button.
 * @param props - see {@link ActionButtonProps}.
 * @returns the anchored button.
 */
export function ActionButton(props: ActionButtonProps): ReactNode {
  const running = props.running !== undefined && props.running !== null
  const disabled = props.disabled === true || running
  const reason = running ? props.running : disabled && props.disabledTip !== undefined ? props.disabledTip : props.tip
  const label = running ? props.running : props.label
  const button = (
    <Button
      variant={props.variant ?? 'toolbar'}
      size="sm"
      disabled={disabled}
      aria-label={props.label === undefined ? props.ariaLabel : undefined}
      aria-busy={running ? true : undefined}
      data-git-marker={props.marker}
      className={props.danger === true ? 'git-danger' : undefined}
      onClick={props.onClick}
    >
      {running ? <StateDot state="ongoing" size={12} /> : props.icon}
      {label === undefined || label === null ? null : running ? <TextShimmer active>{label}</TextShimmer> : <span>{label}</span>}
    </Button>
  )
  return (
    <Tooltip label={reason ?? props.tip} delayMs={500} portal>
      {disabled ? <span className="git-tipAnchor">{button}</span> : button}
    </Tooltip>
  )
}
