/**
 * The Git main-area page: a header bar, two columns (changes and diff) over a
 * full-width activity dock.
 *
 * Below `NARROW_MAX_PX` of page width the diff column goes away: the list takes
 * the whole body and a tapped file opens its diff as an in-page full-screen sheet.
 * The width is measured once, in JavaScript, and drives both the CSS
 * (`data-layout`) and the behaviour, so the two can never disagree.
 *
 * The page owns layout only. Mounting it tells the store the page is visible, so
 * the 5 s watcher runs exactly while somebody can see the result; unmounting
 * (back to the Conversation) stops it, and the store keeps its state for the next
 * open. Split ratio and dock height are per-viewer conveniences in
 * `localStorage`, guarded so a blocked store falls back to the defaults.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react'
import {
  IconCloseOutlineRegular,
  IconRefreshOutlineRegular,
  IconSendOutlineRegular,
  Tag,
  Toast,
  Tooltip,
  writeClipboard,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'

import { ROOT_REPO_ID } from '../config.ts'
import { ActionButton } from './ActionButton.tsx'
import { ActivityDock } from './ActivityDock.tsx'
import { branchLabelOf } from './branch-label.ts'
import { BranchDialog } from './BranchDialog.tsx'
import { CommitPanel } from './CommitPanel.tsx'
import { ConfirmDialog } from './ConfirmDialog.tsx'
import { DiffPanel } from './DiffPanel.tsx'
import { IntegrateDialog } from './IntegrateDialog.tsx'
import { readPref, writePref } from './layout-prefs.ts'
import { usePhase } from './phase.ts'
import { ProcessingBar } from './ProcessingBar.tsx'
import { Splitter } from './Splitter.tsx'
import { dockOpenOf, type IntellijGitState, type IntellijGitStore } from './store.ts'

/** Props the renderer hands the page plus the store its inject face supplies. */
export type GitPageProps = PropsLocale<'dshIntellijGit'> & { readonly store: IntellijGitStore }

const DEFAULT_SPLIT_PCT = 38
const MIN_COLUMN_PX = 280
/** A page narrower than this many px uses the single-column layout and the diff sheet. */
const NARROW_MAX_PX = 760
const DEFAULT_DOCK_PX = 200
const MIN_DOCK_PX = 96
/** Toast hold before the fade, in ms. */
const TOAST_HOLD_MS = 4000

/**
 * Clamp a number into a range.
 * @param value - the number.
 * @param min - lower bound.
 * @param max - upper bound.
 * @returns the clamped number.
 */
function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max))
}

/**
 * The label of the repository the page is showing.
 * @param state - current state.
 * @returns the label, or an empty string before the tree loads.
 */
function repoLabelOf(state: IntellijGitState): string {
  const tree = state.tree
  const id = state.activeRepoId
  if (tree === null || id === null) return ''
  if (id === ROOT_REPO_ID) return tree.rootRepo?.label ?? ''
  for (const workspace of tree.workspaces) {
    for (const domain of workspace.domains) {
      const repo = domain.repos.find(candidate => candidate.id === id)
      if (repo !== undefined) return repo.label
    }
  }
  return id
}

/**
 * A `HH:mm:ss` clock label.
 * @param at - epoch milliseconds.
 * @returns the formatted time.
 */
function clockOf(at: number): string {
  const date = new Date(at)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/**
 * The page.
 * @param props - the locale seat and the shared store.
 * @returns the page.
 */
export function GitPage(props: GitPageProps): ReactNode {
  const { store, t } = props
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const phase = usePhase(t, state.busy)
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const mainRef = useRef<HTMLDivElement | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const sheetRef = useRef<HTMLDivElement | null>(null)
  /** Path of the file whose tap opened the sheet, to return focus to on exit. */
  const openerPathRef = useRef<string | null>(null)
  const wasSheetOpenRef = useRef(false)
  const [splitPct, setSplitPct] = useState<number>(() => readPref<number>('splitPct', DEFAULT_SPLIT_PCT, value => typeof value === 'number' && value >= 10 && value <= 90))
  const [dockPx, setDockPx] = useState<number>(() => readPref<number>('dockPx', DEFAULT_DOCK_PX, value => typeof value === 'number' && value >= MIN_DOCK_PX))

  useEffect(() => {
    store.actions.setPageActive(true)
    return () => { store.actions.setPageActive(false) }
  }, [store])

  // One measurement source for CSS and behaviour. A zero width means the page is
  // not laid out (hidden), which says nothing about the layout, so it is skipped.
  useLayoutEffect(() => {
    const root = rootRef.current
    if (root === null) return undefined
    const apply = (width: number): void => {
      if (width > 0) store.actions.setNarrow(width < NARROW_MAX_PX)
    }
    apply(root.getBoundingClientRect().width)
    if (typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver(entries => {
      const last = entries[entries.length - 1]
      if (last !== undefined) apply(last.contentRect.width)
    })
    observer.observe(root)
    return () => { observer.disconnect() }
  }, [store])

  const narrow = state.narrow
  const sheetOpen = narrow && state.selected !== null

  // Sheet focus lifecycle: enter on open, restore on every exit path.
  useLayoutEffect(() => {
    const was = wasSheetOpenRef.current
    wasSheetOpenRef.current = sheetOpen
    if (sheetOpen === was) return
    const root = rootRef.current
    if (root === null) return
    if (sheetOpen) {
      openerPathRef.current = state.selected?.path ?? null
      const back = sheetRef.current?.querySelector<HTMLButtonElement>('[data-git-marker="sheet-back"]') ?? null
      if (back !== null && !back.disabled) back.focus()
      else sheetRef.current?.focus()
      return
    }
    // Focus the shell or a body-portaled Modal owns is never moved; only focus
    // that was lost with the sheet (it now sits on the body) is restored.
    const active = document.activeElement
    if (active !== null && active !== document.body) return
    if (state.selected !== null) {
      // Widened past the threshold with the file still open: the diff column shows it.
      root.querySelector<HTMLElement>('.git-colDiff .git-diffHead button:not(:disabled)')?.focus()
      return
    }
    const opener = openerPathRef.current
    const target = opener === null
      ? undefined
      : Array.from(root.querySelectorAll<HTMLElement>('[data-git-path]')).find(element => element.dataset['gitPath'] === opener)
    if (target !== undefined) target.focus()
    else root.querySelector<HTMLElement>('.git-tree')?.focus()
  }, [sheetOpen, state.selected])

  const persistLayout = useCallback((): void => {
    writePref('splitPct', splitPct)
    writePref('dockPx', dockPx)
  }, [splitPct, dockPx])

  const onColumnDelta = (px: number): void => {
    const width = mainRef.current?.clientWidth ?? 0
    if (width === 0) return
    const minPct = (MIN_COLUMN_PX / width) * 100
    setSplitPct(current => clamp(current + (px / width) * 100, minPct, 100 - minPct))
  }
  const onDockDelta = (px: number): void => {
    const height = bodyRef.current?.clientHeight ?? 0
    setDockPx(current => clamp(current - px, MIN_DOCK_PX, height - 160))
  }

  const status = state.status
  const busy = state.busy !== null
  const working = busy || state.statusLoading || state.diffLoading || state.treeLoading
  const label = repoLabelOf(state)
  const banner = state.banner
  const dockOpen = dockOpenOf(state)
  // While the sheet covers the page, what it covers leaves the tab order and the
  // accessibility tree. React 18 passes the string form through; its types lack `inert`.
  const covered: Record<string, string> = sheetOpen ? { inert: '' } : {}
  const sheetName = state.selected?.path.split('/').pop() ?? ''

  return (
    <div className="git-page" data-dsh-git="page" data-layout={narrow ? 'narrow' : 'wide'} ref={rootRef}>
      <header className="git-head" {...covered}>
        <div className="git-headMain">
          <span className="git-title">{t('page.title')}</span>
          {label === '' ? null : <span className="git-repoName git-mono">{label}</span>}
          {status === null ? null : (
            <Tooltip
              label={busy
                ? t('busy.wait', { phase: phase?.text ?? '' })
                : status.detached
                  ? t('branch.badge.detached.tip', { sha: status.headShortSha })
                  : t('branch.badge.tip', { branch: status.branch })}
              delayMs={500}
              portal
              side="bottom"
            >
              <span className={busy ? 'git-branchTag git-tipAnchor' : 'git-branchTag'}>
                <button
                  type="button"
                  className="git-branchBtn"
                  aria-haspopup="dialog"
                  aria-label={t('branch.badge.aria')}
                  disabled={busy || state.activeRepoId === null}
                  onClick={() => { store.actions.openBranchDialog() }}
                >
                  <span className="git-branchBtnName git-mono">{branchLabelOf(status, t)}</span>
                  {status.ahead > 0 ? <Tag tone="success">{`↑${status.ahead}`}</Tag> : null}
                  {status.behind > 0 ? <Tag tone="warning">{`↓${status.behind}`}</Tag> : null}
                </button>
              </span>
            </Tooltip>
          )}
          <span className="git-grow" />
          {state.watchFailing ? <span className="git-warn">{t('state.watchFailed')}</span> : null}
          {state.lastCheckedAt === null ? null : <span className="git-dim git-mono">{t('toolbar.updated', { time: clockOf(state.lastCheckedAt) })}</span>}
          <ActionButton
            tip={t('toolbar.refresh.tip')}
            label={t('toolbar.refresh')}
            icon={<IconRefreshOutlineRegular size={14} />}
            onClick={() => { void store.actions.refreshAll() }}
          />
          {status !== null && status.ahead > 0 ? (
            <ActionButton
              variant="outline"
              tip={t('commit.pushRetry.tip')}
              disabledTip={t('busy.wait', { phase: phase?.text ?? '' })}
              disabled={state.busy !== null}
              running={state.busy !== null && (state.busy.kind === 'push' || state.busy.kind === 'rebase' || state.busy.kind === 'merge') ? (phase?.label ?? null) : null}
              label={t('commit.pushRetry')}
              icon={<IconSendOutlineRegular size={14} />}
              onClick={() => { store.actions.requestPush() }}
            />
          ) : null}
        </div>
        <ProcessingBar active={working} t={t} />
      </header>

      {banner === null ? null : (
        <div className="git-banner" data-kind={banner.kind} role="status" {...covered}>
          <span>{t(banner.key, banner.params ?? {})}</span>
          <button type="button" className="git-bannerClose" aria-label={t('confirm.close')} onClick={() => { store.actions.dismissBanner() }}>
            <IconCloseOutlineRegular size={12} />
          </button>
        </div>
      )}

      <div
        className="git-body"
        ref={bodyRef}
        {...covered}
        style={{ '--git-split': `${splitPct}%`, '--git-dock': `${dockPx}px` } as CSSProperties}
      >
        <div className="git-main" ref={mainRef}>
          <section className="git-col git-colChanges" aria-label={t('page.changes')}>
            <CommitPanel store={store} t={t} />
          </section>
          {narrow ? null : (
            <>
              <Splitter
                className="git-splitCol"
                orientation="vertical"
                value={splitPct}
                min={10}
                max={90}
                label={t('splitter.columns')}
                onDelta={onColumnDelta}
                onEnd={persistLayout}
              />
              <section className="git-col git-colDiff" aria-label={t('page.diff')}>
                <DiffPanel store={store} t={t} />
              </section>
            </>
          )}
        </div>
        {dockOpen ? (
          <Splitter
            className="git-splitDock"
            orientation="horizontal"
            value={dockPx}
            min={MIN_DOCK_PX}
            max={Math.max(MIN_DOCK_PX, (bodyRef.current?.clientHeight ?? 0) - 160)}
            label={t('splitter.dock')}
            onDelta={onDockDelta}
            onEnd={persistLayout}
          />
        ) : null}
        <ActivityDock store={store} t={t} />
      </div>

      {sheetOpen ? (
        <div
          className="git-diffSheet"
          role="region"
          aria-label={t('diff.sheet.label', { name: sheetName })}
          tabIndex={-1}
          ref={sheetRef}
        >
          <DiffPanel store={store} t={t} compact onClose={store.actions.closeDiff} />
        </div>
      ) : null}

      <ConfirmDialog store={store} origin="commit" t={t} />
      <ConfirmDialog store={store} origin="diff" t={t} />
      <IntegrateDialog store={store} t={t} />
      <BranchDialog store={store} t={t} />

      {state.toast === null ? null : (
        <Toast
          key={state.toast.at}
          text={t(state.toast.key, state.toast.params ?? {})}
          tone="success"
          holdMs={TOAST_HOLD_MS}
          {...(state.toast.sha === undefined
            ? {}
            : { actions: [{ label: t('toast.copySha'), onClick: () => { void writeClipboard(state.toast?.sha ?? '') } }] })}
          onDone={() => { store.actions.dismissToast() }}
        />
      )}
    </div>
  )
}
