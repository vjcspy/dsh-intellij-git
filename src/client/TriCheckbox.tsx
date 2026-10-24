/**
 * A checkbox that can show a third state and that a `Tooltip` can anchor to.
 *
 * The shell's `Checkbox` primitive cannot be used for the tree: it exposes only
 * `checked`/`onChange`/`label`, has no `indeterminate`, no ref and no prop
 * spread, and it always renders a visible label. The tree needs all three of the
 * missing things, because a folder whose children are partly included must show
 * the indeterminate state and every row already draws its own name.
 *
 * So this is a native input, restyled on `--dsw-*` tokens to match the primitive,
 * and it forwards its ref so `Tooltip` can clone it.
 */
import { forwardRef, useEffect, useImperativeHandle, useRef, type InputHTMLAttributes } from 'react'

import type { CheckState } from './tree-builder.ts'

/** Props: the tri-state value plus the native input attributes. */
export type TriCheckboxProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'checked'> & {
  readonly state: CheckState
}

/**
 * Render a tri-state checkbox.
 * @param props.state - checked, indeterminate or unchecked.
 * @param ref - the native input, so a Tooltip can anchor to it.
 * @returns the input element.
 */
export const TriCheckbox = forwardRef<HTMLInputElement, TriCheckboxProps>(function TriCheckbox({ state, ...rest }, ref) {
  const inner = useRef<HTMLInputElement | null>(null)
  useImperativeHandle(ref, () => inner.current as HTMLInputElement, [])
  useEffect(() => {
    if (inner.current !== null) inner.current.indeterminate = state === 'indeterminate'
  }, [state])
  return (
    <input
      ref={inner}
      type="checkbox"
      className="git-check"
      checked={state === 'checked'}
      {...rest}
    />
  )
})
