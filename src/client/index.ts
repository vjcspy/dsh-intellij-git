/**
 * Browser half: register the Git page in the main column, its row in the left
 * sidebar directly under `Plugins`, its copy and its stylesheet.
 *
 * One store is created here and injected into the page, so the inclusion map is
 * literally the same object in the tree and in the viewer. The store lives in
 * `apply`, so its state survives the page unmounting; only the watcher follows
 * the page (`setPageActive`), so `git status` runs every 5 s only while someone
 * can see the result.
 *
 * `layout` is read through a scoped `ctx.inject`, as `dshmarket` does: its
 * absence then only disables the tidy-up on teardown, instead of unloading the
 * whole page.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: declares the `locale` member this half reads.
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: declares the `slots` member this half registers into.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: the root `main` keyed slot and its panel id brand, and the
// `sidebar.panellist` list the row registers into.
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'

import { LOCALE_NAMESPACE, PAGE_ID, PAGE_ROW_ORDER } from '../config.ts'
import { GitPage } from './GitPage.tsx'
import { en } from './locale.ts'
import { NavIcon } from './NavIcon.tsx'
import { createIntellijGitStore } from './store.ts'
import { installStyles } from './styles.ts'

/** Services this half always needs; all shell-provided. */
export const inject = ['slots', 'locale']

/** The slice of the layout service this half calls. */
interface LayoutLike {
  selectPanel(panelId: MainPanelId | null): void
  panelInfo: { getSnapshot(): { activePanelId?: string | null } }
}

/**
 * Register the page, the sidebar row, the dictionaries and the stylesheet.
 * @param ctx - browser-side plugin context owning the registry and the seats.
 */
export function apply(ctx: ClientContext): void {
  const t = ctx.locale.bind(LOCALE_NAMESPACE)
  ctx.effect(() => ctx.locale.register(LOCALE_NAMESPACE, 'en', en), 'dsh-intellij-git: dictionaries')
  installStyles(ctx)

  const store = createIntellijGitStore()

  // The first load runs once, here; the watcher belongs to the page and is
  // stopped when this plugin goes away so a reload never leaves a timer behind.
  ctx.effect(() => {
    void store.actions.bootstrap()
    return () => { store.actions.setPageActive(false) }
  }, 'dsh-intellij-git: bootstrap and watcher teardown')

  let layout: LayoutLike | undefined
  const bind = ctx as unknown as { inject: (names: string[], callback: (inner: unknown) => void) => unknown }
  bind.inject(['layout'], (inner) => {
    const scoped = inner as ClientContext & { layout: LayoutLike }
    layout = scoped.layout
    scoped.effect(() => () => { layout = undefined }, 'dsh-intellij-git: layout service')
  })

  const panelId = PAGE_ID as MainPanelId

  ctx.effect(() => ctx.slots.inject('main', () => {
    const dispose = ctx.slots.register({
      name: 'main',
      key: panelId,
      locale: LOCALE_NAMESPACE,
      inject: () => ({ store }),
    }, GitPage)
    return () => {
      // Leave the page before its panel goes: a selection pointing at a key that
      // no longer exists would strand the main column on nothing.
      if (layout?.panelInfo.getSnapshot().activePanelId === PAGE_ID) layout.selectPanel(null)
      dispose()
    }
  }), 'dsh-intellij-git: main page')

  // `order: 0.5` is directly under `Plugins` (0) whether or not the optional
  // market row (1) is enabled.
  ctx.effect(() => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: panelId,
    order: PAGE_ROW_ORDER,
    label: () => t('nav.label'),
    locale: LOCALE_NAMESPACE,
  }, NavIcon)), 'dsh-intellij-git: sidebar row')
}
