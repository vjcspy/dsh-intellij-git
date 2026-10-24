/**
 * The diff viewer: Side-by-Side or Unified, with a per-hunk gutter carrying the
 * two IntelliJ actions that make partial commits usable, revert this hunk and
 * include or exclude this hunk.
 *
 * The hunk checkbox writes the same inclusion map the Commit tree reads, so
 * ticking a hunk here immediately makes its file render as partially included
 * over there, and ticks the `Current version` box accordingly.
 */
import { useSyncExternalStore, type ReactNode } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'

import type { DiffHunk, DiffLine } from '../config.ts'
import type { IntellijGitStore } from './store.ts'

/** Props the renderer hands this body plus the store its inject face supplies. */
export type DiffTabProps = PropsRuntime<'sidebar.right.pane.tab'> & PropsLocale<'dshIntellijGit'> & { store: IntellijGitStore }

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
 * @param props - runtime + locale seats and the shared store.
 * @returns the panel.
 */
export function DiffTabBody(props: DiffTabProps): ReactNode {
  const { store, t } = props
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot)
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
  const noneIncluded = includedCount === 0

  const fileList: { path: string, status: string }[] = state.status === null
    ? []
    : [
      ...state.status.changes.map(change => ({ path: change.path, status: change.status })),
      ...state.status.unversioned.map(path => ({ path, status: 'U' })),
    ]
  const fileIndex = fileList.findIndex(entry => entry.path === selected.path)

  const openAt = (index: number): void => {
    const entry = fileList[index]
    if (entry === undefined) return
    void store.actions.openFile(undefined, {
      repoId: selected.repoId,
      path: entry.path,
      origPath: null,
      status: entry.status === 'A' || entry.status === 'D' || entry.status === 'R' || entry.status === 'T' || entry.status === 'U' ? entry.status : 'M',
    })
  }

  const hunkRow = (hunk: DiffHunk, index: number, total: number): ReactNode => {
    const included = includedKeys.has(hunk.contentKey)
    return (
      <div className="git-hunk-row" key={hunk.contentKey}>
        <div className="git-gutter">
          <span>{hunk.header}</span>
          <button
            type="button"
            title={t('diff.deleteHunk')}
            onClick={() => { void store.actions.revertHunk(hunk.contentKey) }}
          >
            &gt;&gt;
          </button>
          <input
            type="checkbox"
            checked={included}
            onChange={() => { store.actions.toggleHunk(hunk.contentKey) }}
            aria-label={included ? t('diff.excludeHunk') : t('diff.includeHunk')}
          />
          <span className={included ? 'git-included' : 'git-excluded'}>{index + 1}/{total}</span>
        </div>
      </div>
    )
  }

  const renderSplit = (hunk: DiffHunk, index: number): ReactNode => {
    const lines = state.collapseUnchanged ? collapseContext(hunk.lines) : hunk.lines
    const rows = splitRows(lines)
    return [
      <tr key={`h:${hunk.contentKey}`}><td colSpan={4}>{hunkRow(hunk, index, diff.hunks.length)}</td></tr>,
      ...rows.map((row, rowIndex) => (
        <tr key={`r:${hunk.contentKey}:${rowIndex}`}>
          <td className="git-num">{row.left?.oldLine ?? ''}</td>
          <td className={`git-half ${row.left?.kind === 'del' ? 'git-line-del' : ''}`}>{row.left?.text ?? ''}</td>
          <td className="git-num">{row.right?.newLine ?? ''}</td>
          <td className={`git-half ${row.right?.kind === 'add' ? 'git-line-add' : ''}`}>{row.right?.text ?? ''}</td>
        </tr>
      )),
    ]
  }

  const renderUnified = (hunk: DiffHunk, index: number): ReactNode => {
    const lines = state.collapseUnchanged ? collapseContext(hunk.lines) : hunk.lines
    return [
      <tr key={`h:${hunk.contentKey}`}><td colSpan={3}>{hunkRow(hunk, index, diff.hunks.length)}</td></tr>,
      ...lines.map((line, rowIndex) => (
        <tr key={`u:${hunk.contentKey}:${rowIndex}`}>
          <td className="git-num">{line.kind === 'add' ? '' : line.oldLine ?? ''}</td>
          <td className="git-num">{line.kind === 'del' ? '' : line.newLine ?? ''}</td>
          <td className={line.kind === 'add' ? 'git-line-add' : line.kind === 'del' ? 'git-line-del' : ''}>{line.text}</td>
        </tr>
      )),
    ]
  }

  return (
    <div data-dsh-git="diff">
      <div className="git-diff">
        <div className="git-diff-head">
          <button type="button" disabled={fileIndex <= 0} onClick={() => { openAt(fileIndex - 1) }} title={t('diff.toolbar.prevFile')}>←</button>
          <button type="button" disabled={fileIndex === -1 || fileIndex >= fileList.length - 1} onClick={() => { openAt(fileIndex + 1) }} title={t('diff.toolbar.nextFile')}>→</button>
          <span className="git-dim">{fileList.length === 0 ? '' : `${fileIndex + 1}/${fileList.length}`}</span>
          <span className="git-dim">{t('diff.summary', { total: diff.changedLines, included: includedCount })}</span>
          <span className="git-grow" style={{ flex: 1 }} />
          <span className="git-seg">
            <button type="button" data-on={state.viewMode === 'split'} onClick={() => { store.actions.setViewMode('split') }}>{t('diff.toolbar.split')}</button>
            <button type="button" data-on={state.viewMode === 'unified'} onClick={() => { store.actions.setViewMode('unified') }}>{t('diff.toolbar.unified')}</button>
          </span>
          <button type="button" data-on={state.collapseUnchanged} onClick={() => { store.actions.toggleCollapse() }} title={t('diff.toolbar.collapse')}>⌄</button>
          <button type="button" onClick={() => { void store.actions.refreshDiff() }} title={t('diff.toolbar.refresh')}>⟳</button>
        </div>

        <div className="git-diff-sub">
          <span className="git-mono">🔒 {diff.headShortSha}</span>
          <span className="git-label git-mono">{selected.path}</span>
          <span style={{ flex: 1 }} />
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <input
              type="checkbox"
              checked={allIncluded}
              disabled={diff.hunks.length === 0}
              onChange={() => { store.actions.toggleCurrentVersion() }}
              aria-label={t('diff.currentVersion')}
            />
            <span>{t('diff.currentVersion')}</span>
          </label>
        </div>

        <div className="git-diff-body">
          {state.diffError !== null ? <div className="git-empty">{state.diffError}</div> : null}
          {diff.binary ? <div className="git-empty">{t('diff.binary')}</div> : null}
          {!diff.binary && diff.hunks.length === 0 ? <div className="git-empty">{noneIncluded ? t('state.noChanges') : t('diff.empty')}</div> : null}
          {!diff.binary && diff.hunks.length > 0 ? (
            <table className="git-table">
              <tbody>
                {diff.hunks.map((hunk, index) => (state.viewMode === 'split' ? renderSplit(hunk, index) : renderUnified(hunk, index)))}
              </tbody>
            </table>
          ) : null}
        </div>
      </div>
    </div>
  )
}
