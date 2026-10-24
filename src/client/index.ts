/**
 * Browser half: register the Commit and Diff tab kinds, their bodies, their
 * copy and their stylesheet, and open the diff beside the commit tree.
 *
 * One store instance is created here and injected into both bodies, so the
 * inclusion map is literally the same object in the tree and in the viewer.
 *
 * `sidebarRight` is read through a scoped `ctx.inject` rather than declared
 * top-level: its absence then only disables opening the diff pane, instead of
 * unloading the whole tab.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: declares the `locale` member this half reads.
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: declares the `slots` member this half registers into.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: declares `sidebarRightTabs` and `sidebarRight`.
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'

import {
  COMMIT_TAB_ID,
  COMMIT_TAB_KIND,
  DIFF_TAB_ID,
  DIFF_TAB_KIND,
  GUIDE_ENTRY_ID,
  GUIDE_ENTRY_ORDER,
  LOCALE_NAMESPACE,
} from '../config.ts'
import { CommitTabBody } from './CommitTabBody.tsx'
import { DiffTabBody } from './DiffTabBody.tsx'
import { en } from './locale.ts'
import { createIntellijGitStore } from './store.ts'
import { installStyles } from './styles.ts'

/** Services this half always needs; all shell-provided. */
export const inject = ['slots', 'locale', 'sidebarRightTabs']

/** The slice of the right-sidebar controller this half calls. */
interface SidebarLike {
  tabsIn(sessionId: string): readonly { id: string, kind: string }[]
  focus(tabId: string): void
  openTabIn(sessionId: string, kind: string, options?: { preferNewPane?: boolean }): void
}

/**
 * Register the tab kinds, dictionaries, stylesheet and bodies.
 * @param ctx - browser-side plugin context owning the registry and the seats.
 */
export function apply(ctx: ClientContext): void {
  const t = ctx.locale.bind(LOCALE_NAMESPACE)
  ctx.effect(() => ctx.locale.register(LOCALE_NAMESPACE, 'en', en), 'dsh-intellij-git: dictionaries')
  installStyles(ctx)

  let sidebar: SidebarLike | undefined

  const store = createIntellijGitStore({
    openDiffTab: (sessionId) => {
      if (sidebar === undefined || sessionId === undefined) return
      // Search every pane before opening: dedupe is per pane, so a second open
      // would otherwise create a duplicate viewer in a sibling pane.
      const existing = sidebar.tabsIn(sessionId).find(tab => tab.kind === DIFF_TAB_KIND)
      if (existing !== undefined) {
        sidebar.focus(existing.id)
        return
      }
      sidebar.openTabIn(sessionId, DIFF_TAB_KIND, { preferNewPane: true })
    },
  })

  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: COMMIT_TAB_ID,
    kind: COMMIT_TAB_KIND,
    keepMounted: true,
    title: () => t('tab.title'),
    guide: [{
      id: GUIDE_ENTRY_ID,
      order: GUIDE_ENTRY_ORDER,
      title: () => t('guide.title'),
      description: () => t('guide.description'),
    }],
  }), 'dsh-intellij-git: commit tab kind')

  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: DIFF_TAB_ID,
    kind: DIFF_TAB_KIND,
    keepMounted: false,
    title: () => t('diff.titleEmpty'),
  }), 'dsh-intellij-git: diff tab kind')

  // Optional service: absent means the diff opens in place instead of beside.
  const bind = ctx as unknown as { inject: (names: string[], callback: (inner: unknown) => void) => unknown }
  bind.inject(['sidebarRight'], (inner) => {
    const scoped = inner as ClientContext & { sidebarRight: SidebarLike }
    sidebar = scoped.sidebarRight
    scoped.effect(() => () => { sidebar = undefined }, 'dsh-intellij-git: sidebar service')
  })

  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab',
    key: COMMIT_TAB_ID,
    locale: LOCALE_NAMESPACE,
    inject: () => ({ store }),
  }, CommitTabBody)), 'dsh-intellij-git: commit tab body')

  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab',
    key: DIFF_TAB_ID,
    locale: LOCALE_NAMESPACE,
    inject: () => ({ store }),
  }, DiffTabBody)), 'dsh-intellij-git: diff tab body')
}
