/**
 * The 2 px indeterminate bar on the page header's bottom edge.
 *
 * Shown while a write or a status/diff/tree load runs. Under
 * `prefers-reduced-motion` the stylesheet swaps the sweep for a static 40 % bar.
 */
import type { ReactNode } from 'react'

import type { Translate } from './locale.ts'

/**
 * Render the bar.
 * @param props.active - whether anything is running.
 * @param props.t - the locale seat.
 * @returns the bar, always mounted so the header height never jumps.
 */
export function ProcessingBar(props: { readonly active: boolean, readonly t: Translate }): ReactNode {
  return (
    <div
      className="git-bar"
      data-active={props.active}
      role="progressbar"
      aria-label={props.t('bar.label')}
      aria-busy={props.active}
      aria-hidden={!props.active}
    >
      <span className="git-barFill" />
    </div>
  )
}
