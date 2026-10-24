/** The left sidebar row's icon; the sidebar owns the button, label and selected state around it. */
import type { ReactNode } from 'react'
import { IconBranchOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'

/**
 * Render the branch glyph at the size the sidebar asks for.
 * @param props.size - the requested edge in px.
 * @returns the icon element.
 */
export function NavIcon(props: { readonly size?: number }): ReactNode {
  return <IconBranchOutlineRegular size={props.size ?? 16} />
}
