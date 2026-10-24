/**
 * The diff viewer: Side-by-Side or Unified, with a per-hunk gutter carrying the
 * two actions that make partial commits usable, revert this hunk and include or
 * exclude this hunk.
 *
 * The hunk checkbox writes the same inclusion map the Commit tree reads, so
 * ticking a hunk here immediately makes its file render as partially included
 * there, and unticks the `Current version` box accordingly. Reverting a hunk is a
 * write, so it goes through the confirmation dialog like every other write.
 */
import { useId, useState, useSyncExternalStore, type ReactNode } from 'react'
import { Button, Checkbox, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'

import type { DiffHunk, DiffLine } from '../config.ts'
import { ConfirmDialog } from './ConfirmDialog.tsx'
import type { IntellijGitStore } from './store.ts'
import { TriCheckbox } from './TriCheckbox.tsx'

/** Props the renderer hands this body plus the store its inject face supplies. */
export type DiffTabProps = PropsRuntime<'sidebar.right.pane.tab'> & PropsLocale<'dshIntellijGit'> & { readonly store: IntellijGitStore }

/** One visual row of the side-by-side view. */
interface SplitRow {
  readonly left: DiffLine | null
  readonly right: DiffLine | null
}

/**
 * Pair deletions with additions so both sides stay aligned.
 * @param lines - the hunk's lines.
 * @returns one entry per rendered row.
 */
function splitRows(lines: readonly DiffLine[]): SplitRow[] {
  const rows: SplitRow[] = []
  let deletions: DiffLine[] = []
  let additions: DiffLine[] = []
  const flush = (): void => {
    const max = Math.max(deletions.length, additions.length)
    for (let index = 0; index < max; index += 1) {
      rows.push({ left: deletions[index] ?? null, right: additions[index] ?? null })
    }
    deletions = []
    additions = []
  }
  for (const line of lines) {
    if (line.kind === 'context') {
      flush()
      rows.push({ left: line, right: line })
    } else if (line.kind === 'del') {
      deletions.push(line)
    } else {
      additions.push(line)
    }
  }
  flush()
  return rows
}

/**
 * Keep only the context lines next to a change.
 * @param lines - the hunk's lines.
 * @returns the visible lines.
 */
function collapseContext(lines: readonly DiffLine[]): DiffLine[] {
  const visible: DiffLine[] = []
  let run: DiffLine[] = []
  const flush = (): void => {
    if (run.length <= 6) visible.push(...run)
    else visible.push(...run.slice(0, 2), ...run.slice(run.length - 2))
    run = []
  }
  for (const line of lines) {
    if (line.kind === 'context') {
      run.push(line)
      continue
    }
    flush()
    visible.push(line)
  }
  flush()
  return visible
}

/**
 * The diff viewer body.
 * @param props - runtime and locale seats plus the shared store.
 * @returns the panel.
 */
export function DiffTabBody(props: DiffTabProps): ReactNode {
  const { store, t } = props
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const [activeHunk, setActiveHunk] = useState(0)
  const prefix = useId()
  const diff = state.diff
  const selected = state.selected
  const repoId = state.activeRepoId

  if (selected === null || diff === null) {
    return (
      <div data-dsh-git="diff">
        <div className="git-diff">
          <div className="git-empty">{state.diffLoading ? t('state.loading') : t('diff.empty')}</div>
        </div>
      </div>
    )
  }

  const inclusion = repoId === null ? undefined : state.inclusions[repoId]?.[selected.path]
  const includedKeys = new Set<string>(
    inclusion === undefined || inclusion.mode === 'all'
      ? diff.hunks.map(hunk => hunk.contentKey)
      : inclusion.mode === 'none'
        ? []
        : inclusion.hunkKeys,
  )
  const includedCount = diff.hunks.filter(hunk => includedKeys.has(hunk.contentKey)).length
  const allIncluded = diff.hunks.length > 0 && includedCount === diff.hunks.length

  const fileList: { path: string, status: string }[] = state.status === null
    ? []
    : [
      ...state.status.changes.map(change => ({ path: change.path, status: change.status })),
      ...state.status.unversioned.map(path => ({ path, status: 'U' })),
    ]
  const fileIndex = fileList.findIndex(entry => entry.path === selected.path)

  /**
   * Open the changed file at an index, keeping the current pane.
   * @param index - position in the repository's changed-file list.
   */
  const openAt = (index: number): void => {
    const entry = fileList[index]
    if (entry === undefined) return
    const status = entry.status
    void store.actions.openFile(undefined, {
      repoId: selected.repoId,
      path: entry.path,
      origPath: null,
      status: status === 'A' || status === 'D' || status === 'R' || status === 'T' || status === 'U' ? status : 'M',
    })
  }

  /**
   * Scroll to a hunk, used by the previous and next difference buttons.
   * @param index - the hunk index.
   */
  const goToHunk = (index: number): void => {
    if (diff.hunks.length === 0) return
    const clamped = Math.min(Math.max(index, 0), diff.hunks.length - 1)
    setActiveHunk(clamped)
    const element = document.getElementById(`${prefix}-hunk-${clamped}`)
    if (element !== null) element.scrollIntoView({ block: 'center' })
  }

  const hunkRow = (hunk: DiffHunk, index: number): ReactNode => {
    const included = includedKeys.has(hunk.contentKey)
    return (
      <div className="git-hunkRow" id={`${prefix}-hunk-${index}`}>
        <div className="git-gutter">
          <span className="git-hunkHeader git-mono">{hunk.header}</span>
          <Tooltip label={t('diff.deleteHunk.tip')} delayMs={500} portal>
            <Button size="sm" variant="toolbar" onClick={() => { store.actions.requestRevertHunk(hunk.contentKey, selected.path) }}>
              &gt;&gt;
            </Button>
          </Tooltip>
          <Tooltip label={included ? t('diff.excludeHunk') : t('diff.includeHunk')} delayMs={500} portal>
            <TriCheckbox
              state={included ? 'checked' : 'unchecked'}
              aria-label={included ? t('diff.excludeHunk') : t('diff.includeHunk')}
              onChange={() => { store.actions.toggleHunk(hunk.contentKey) }}
            />
          </Tooltip>
          <span className={included ? 'git-included' : 'git-excluded'}>{index + 1}/{diff.hunks.length}</span>
        </div>
      </div>
    )
  }

  const renderSplit = (hunk: DiffHunk, index: number): ReactNode => {
    const lines = state.collapseUnchanged ? collapseContext(hunk.lines) : hunk.lines
    return [
      <tr key={`h:${hunk.contentKey}`}><td colSpan={4}>{hunkRow(hunk, index)}</td></tr>,
      ...splitRows(lines).map((row, rowIndex) => (
        <tr key={`r:${hunk.contentKey}:${rowIndex}`}>
          <td className="git-num">{row.left?.oldLine ?? ''}</td>
          <td className={`git-half ${row.left?.kind === 'del' ? 'git-lineDel' : ''}`}>{row.left?.text ?? ''}</td>
          <td className="git-num">{row.right?.newLine ?? ''}</td>
          <td className={`git-half ${row.right?.kind === 'add' ? 'git-lineAdd' : ''}`}>{row.right?.text ?? ''}</td>
        </tr>
      )),
    ]
  }

  const renderUnified = (hunk: DiffHunk, index: number): ReactNode => {
    const lines = state.collapseUnchanged ? collapseContext(hunk.lines) : hunk.lines
    return [
      <tr key={`h:${hunk.contentKey}`}><td colSpan={3}>{hunkRow(hunk, index)}</td></tr>,
      ...lines.map((line, rowIndex) => (
        <tr key={`u:${hunk.contentKey}:${rowIndex}`}>
          <td className="git-num">{line.kind === 'add' ? '' : line.oldLine ?? ''}</td>
          <td className="git-num">{line.kind === 'del' ? '' : line.newLine ?? ''}</td>
          <td className={line.kind === 'add' ? 'git-lineAdd' : line.kind === 'del' ? 'git-lineDel' : ''}>{line.text}</td>
        </tr>
      )),
    ]
  }

  return (
    <div data-dsh-git="diff">
      <div className="git-diff">
        <div className="git-diffHead">
          <Tooltip label={t('diff.toolbar.previous.tip')} delayMs={500} portal>
            <Button size="sm" variant="toolbar" disabled={diff.hunks.length === 0} onClick={() => { goToHunk(activeHunk - 1) }}>↑</Button>
          </Tooltip>
          <Tooltip label={t('diff.toolbar.next.tip')} delayMs={500} portal>
            <Button size="sm" variant="toolbar" disabled={diff.hunks.length === 0} onClick={() => { goToHunk(activeHunk + 1) }}>↓</Button>
          </Tooltip>
          <Tooltip label={t('diff.toolbar.prevFile.tip')} delayMs={500} portal>
            <Button size="sm" variant="toolbar" disabled={fileIndex <= 0} onClick={() => { openAt(fileIndex - 1) }}>←</Button>
          </Tooltip>
          <Tooltip label={t('diff.toolbar.nextFile.tip')} delayMs={500} portal>
            <Button size="sm" variant="toolbar" disabled={fileIndex === -1 || fileIndex >= fileList.length - 1} onClick={() => { openAt(fileIndex + 1) }}>→</Button>
          </Tooltip>
          <span className="git-dim git-mono">{fileList.length === 0 ? '' : `${fileIndex + 1}/${fileList.length}`}</span>
          <span className="git-dim">{t('diff.summary', { total: diff.changedLines, included: includedCount })}</span>
          <span className="git-grow" />
          <Tooltip label={t('diff.toolbar.split.tip')} delayMs={500} portal>
            <Button size="sm" variant={state.viewMode === 'split' ? 'outline' : 'ghost'} onClick={() => { store.actions.setViewMode('split') }}>
              {t('diff.toolbar.split')}
            </Button>
          </Tooltip>
          <Tooltip label={t('diff.toolbar.unified.tip')} delayMs={500} portal>
            <Button size="sm" variant={state.viewMode === 'unified' ? 'outline' : 'ghost'} onClick={() => { store.actions.setViewMode('unified') }}>
              {t('diff.toolbar.unified')}
            </Button>
          </Tooltip>
          <Tooltip label={t('diff.toolbar.collapse.tip')} delayMs={500} portal>
            <Button size="sm" variant="toolbar" onClick={() => { store.actions.toggleCollapse() }}>⌄</Button>
          </Tooltip>
          <Tooltip label={t('diff.toolbar.refresh')} delayMs={500} portal>
            <Button size="sm" variant="toolbar" onClick={() => { void store.actions.refreshDiff() }}>⟳</Button>
          </Tooltip>
        </div>

        <div className="git-diffSub">
          <span className="git-lock git-mono">🔒 {diff.headShortSha}</span>
          <Tooltip label={t('diff.path.tip')} delayMs={500} portal>
            <span className="git-path git-mono">{selected.path}</span>
          </Tooltip>
          <span className="git-grow" />
          <Tooltip label={t('diff.currentVersion.tip')} delayMs={500} portal>
            <span className="git-tipAnchor">
              <Checkbox
                checked={allIncluded}
                disabled={diff.hunks.length === 0}
                label={t('diff.currentVersion')}
                onChange={() => { store.actions.toggleCurrentVersion() }}
              />
            </span>
          </Tooltip>
        </div>

        <div className="git-diffBody">
          {state.diffError !== null ? <div className="git-empty">{state.diffError}</div> : null}
          {diff.binary ? <div className="git-empty">{t('diff.binary')}</div> : null}
          {!diff.binary && diff.hunks.length === 0 ? <div className="git-empty">{t('state.noChanges')}</div> : null}
          {!diff.binary && diff.hunks.length > 0 ? (
            <table className="git-table">
              <tbody>
                {diff.hunks.map((hunk, index) => (state.viewMode === 'split' ? renderSplit(hunk, index) : renderUnified(hunk, index)))}
              </tbody>
            </table>
          ) : null}
        </div>
      </div>

      <ConfirmDialog store={store} origin="diff" t={t} />
    </div>
  )
}
