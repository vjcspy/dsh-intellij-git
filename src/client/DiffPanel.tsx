/**
 * The diff column: Side-by-Side or Unified, with syntax highlighting, word-level
 * marks on paired lines, a wrap toggle, expandable hidden context and a sticky
 * hunk header carrying the two actions that make partial commits usable (revert
 * this hunk, include or exclude this hunk).
 *
 * The hunk checkbox writes the same inclusion map the changes tree reads, so
 * ticking a hunk here immediately makes its file render as partially included
 * there. Reverting a hunk is a write, so it goes through the confirmation
 * dialog like every other write, and is locked while another write runs.
 *
 * Only lines the host already returned are expandable: hunk identity is a
 * content fingerprint taken at `--unified=3`, so widening the context here would
 * change hunk boundaries and invalidate the inclusion keys.
 */
import { useId, useMemo, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react'
import {
  Checkbox,
  IconChevronDownOutlineRegular,
  IconChevronLeftOutlineRegular,
  IconChevronRightOutlineRegular,
  IconChevronUpOutlineRegular,
  IconRefreshOutlineRegular,
  IconTrashOutlineRegular,
  IconWrapLinesOutlineRegular,
  languageForPath,
  SegmentedControl,
  StateDot,
  Tag,
  TextShimmer,
  Tooltip,
  useCodeHighlighter,
  type HighlightSpan,
} from '@deepseek-ai/dsh-client-ui-primitives'

import type { DiffHunk, DiffLine } from '../config.ts'
import { ActionButton } from './ActionButton.tsx'
import type { Translate } from './locale.ts'
import { usePhase } from './phase.ts'
import type { IntellijGitStore } from './store.ts'
import { TriCheckbox } from './TriCheckbox.tsx'
import { WORD_DIFF_MAX_PAIRS, wordDiff, type CharRange } from './word-diff.ts'

/** Props: the shared store and the locale seat. */
export interface DiffPanelProps {
  readonly store: IntellijGitStore
  readonly t: Translate
}

/** Syntax highlighting is skipped above this many changed lines. */
const HIGHLIGHT_MAX_CHANGED_LINES = 3000
/** A context run of at least this many lines folds (hides at least 2). */
const FOLD_MIN_RUN = 6
/** Context lines kept on each side of a fold. */
const FOLD_KEEP = 2
const SKELETON_LINES = 8

/** One displayed item of a hunk: a line, or a folded run of context. */
type Item =
  | { readonly kind: 'line', readonly line: DiffLine }
  | { readonly kind: 'fold', readonly id: string, readonly lines: readonly DiffLine[] }

/** One visual row of the side-by-side view. */
type SplitItem =
  | { readonly kind: 'pair', readonly left: DiffLine | null, readonly right: DiffLine | null }
  | { readonly kind: 'fold', readonly id: string, readonly count: number }

/**
 * The displayed items of a hunk.
 *
 * Only a context run between two changes can fold: the edge runs are the three
 * lines git put next to the first and last change, and folding them would hide
 * what a reader needs most.
 * @param hunk - the hunk.
 * @param collapse - whether unchanged runs fold.
 * @param expanded - the fold ids the Human opened.
 * @returns the items, in order.
 */
function itemsOf(hunk: DiffHunk, collapse: boolean, expanded: ReadonlySet<string>): Item[] {
  const items: Item[] = []
  const lines = hunk.lines
  let index = 0
  while (index < lines.length) {
    const line = lines[index]
    if (line === undefined) break
    if (line.kind !== 'context') {
      items.push({ kind: 'line', line })
      index += 1
      continue
    }
    let end = index
    while (end < lines.length && lines[end]?.kind === 'context') end += 1
    const run = lines.slice(index, end)
    const middle = index > 0 && end < lines.length
    const id = `${hunk.contentKey}:${index}`
    if (collapse && middle && run.length >= FOLD_MIN_RUN && !expanded.has(id)) {
      for (const kept of run.slice(0, FOLD_KEEP)) items.push({ kind: 'line', line: kept })
      items.push({ kind: 'fold', id, lines: run.slice(FOLD_KEEP, run.length - FOLD_KEEP) })
      for (const kept of run.slice(run.length - FOLD_KEEP)) items.push({ kind: 'line', line: kept })
    } else {
      for (const kept of run) items.push({ kind: 'line', line: kept })
    }
    index = end
  }
  return items
}

/**
 * Pair deletions with additions so both sides stay aligned.
 * @param items - the hunk's displayed items.
 * @returns one entry per rendered row.
 */
function splitItems(items: readonly Item[]): SplitItem[] {
  const rows: SplitItem[] = []
  let deletions: DiffLine[] = []
  let additions: DiffLine[] = []
  const flush = (): void => {
    const max = Math.max(deletions.length, additions.length)
    for (let index = 0; index < max; index += 1) {
      rows.push({ kind: 'pair', left: deletions[index] ?? null, right: additions[index] ?? null })
    }
    deletions = []
    additions = []
  }
  for (const item of items) {
    if (item.kind === 'fold') {
      flush()
      rows.push({ kind: 'fold', id: item.id, count: item.lines.length })
    } else if (item.line.kind === 'context') {
      flush()
      rows.push({ kind: 'pair', left: item.line, right: item.line })
    } else if (item.line.kind === 'del') {
      deletions.push(item.line)
    } else {
      additions.push(item.line)
    }
  }
  flush()
  return rows
}

/**
 * Render one line's text with its syntax colours and word marks composed: the
 * marks are a background layered over the highlighter's foreground spans.
 * @param text - the line text.
 * @param spans - the highlighter's spans for the line, when available.
 * @param marks - the changed character ranges of the line, when it has a pair.
 * @param side - which side the marks belong to.
 * @returns the line content.
 */
function lineContent(text: string, spans: readonly HighlightSpan[] | undefined, marks: readonly CharRange[] | undefined, side: 'add' | 'del'): ReactNode {
  const usable = spans !== undefined && spans.map(span => span.text).join('') === text
  if (!usable && (marks === undefined || marks.length === 0)) return text
  const base: readonly HighlightSpan[] = usable ? spans : [{ text, style: {} }]
  if (marks === undefined || marks.length === 0) {
    return base.map((span, index) => <span key={index} style={span.style}>{span.text}</span>)
  }
  const nodes: ReactNode[] = []
  let offset = 0
  for (const span of base) {
    const spanEnd = offset + span.text.length
    let cursor = offset
    const cuts = marks.flatMap(range => [range[0], range[1]]).filter(point => point > offset && point < spanEnd)
    const points = [...new Set([...cuts, spanEnd])].sort((a, b) => a - b)
    for (const point of points) {
      const piece = span.text.slice(cursor - offset, point - offset)
      const marked = marks.some(range => cursor >= range[0] && point <= range[1])
      nodes.push(marked
        ? <mark key={`${nodes.length}`} className="git-mark" data-side={side} style={span.style}>{piece}</mark>
        : <span key={`${nodes.length}`} style={span.style}>{piece}</span>)
      cursor = point
    }
    offset = spanEnd
  }
  return nodes
}

/**
 * The diff column body.
 * @param props - the store and the locale seat.
 * @returns the panel.
 */
export function DiffPanel(props: DiffPanelProps): ReactNode {
  const { store, t } = props
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const phase = usePhase(t, state.busy)
  const [activeHunk, setActiveHunk] = useState(0)
  const [folds, setFolds] = useState<{ readonly key: string, readonly ids: ReadonlySet<string> }>({ key: '', ids: new Set() })
  const prefix = useId()
  const diff = state.diff
  const selected = state.selected
  const repoId = state.activeRepoId
  const busy = state.busy !== null
  const waitTip = t('busy.wait', { phase: phase?.text ?? '' })
  const highlighter = useCodeHighlighter(selected === null ? undefined : languageForPath(selected.path))
  const fileKey = selected === null ? '' : `${selected.repoId}:${selected.path}`
  const expanded = folds.key === fileKey ? folds.ids : new Set<string>()

  const syntax = useMemo(() => {
    const oldSpans = new Map<DiffLine, readonly HighlightSpan[]>()
    const newSpans = new Map<DiffLine, readonly HighlightSpan[]>()
    if (diff === null || diff.binary || diff.changedLines > HIGHLIGHT_MAX_CHANGED_LINES) return { oldSpans, newSpans }
    for (const hunk of diff.hunks) {
      const oldSide = hunk.lines.filter(line => line.kind !== 'add')
      const newSide = hunk.lines.filter(line => line.kind !== 'del')
      const oldLines = highlighter(oldSide.map(line => line.text).join('\n'))
      const newLines = highlighter(newSide.map(line => line.text).join('\n'))
      oldSide.forEach((line, index) => { const spans = oldLines?.[index]; if (spans !== undefined) oldSpans.set(line, spans) })
      newSide.forEach((line, index) => { const spans = newLines?.[index]; if (spans !== undefined) newSpans.set(line, spans) })
    }
    return { oldSpans, newSpans }
  }, [diff, highlighter])

  const marks = useMemo(() => {
    const result = new Map<DiffLine, readonly CharRange[]>()
    if (diff === null || diff.binary) return result
    let pairs = 0
    for (const hunk of diff.hunks) {
      let deletions: DiffLine[] = []
      let additions: DiffLine[] = []
      const flush = (): void => {
        const count = Math.min(deletions.length, additions.length)
        for (let index = 0; index < count && pairs < WORD_DIFF_MAX_PAIRS; index += 1) {
          const before = deletions[index]
          const after = additions[index]
          if (before === undefined || after === undefined) continue
          pairs += 1
          const words = wordDiff(before.text, after.text)
          if (words === null) continue
          result.set(before, words.old)
          result.set(after, words.next)
        }
        deletions = []
        additions = []
      }
      for (const line of hunk.lines) {
        if (line.kind === 'del') {
          if (additions.length > 0) flush()
          deletions.push(line)
        } else if (line.kind === 'add') {
          additions.push(line)
        } else {
          flush()
        }
      }
      flush()
    }
    return result
  }, [diff])

  if (selected === null) {
    return (
      <div className="git-panel" data-dsh-git="diff">
        <div className="git-empty git-emptyDiff">{t('diff.empty')}</div>
      </div>
    )
  }

  const inclusion = repoId === null ? undefined : state.inclusions[repoId]?.[selected.path]
  const hunks = diff?.hunks ?? []
  const includedKeys = new Set<string>(
    inclusion === undefined || inclusion.mode === 'all'
      ? hunks.map(hunk => hunk.contentKey)
      : inclusion.mode === 'none'
        ? []
        : inclusion.hunkKeys,
  )
  const includedCount = hunks.filter(hunk => includedKeys.has(hunk.contentKey)).length
  const allIncluded = hunks.length > 0 && includedCount === hunks.length

  const fileList: { path: string, origPath: string | null, status: string }[] = state.status === null
    ? []
    : [
      ...state.status.changes.map(change => ({ path: change.path, origPath: change.origPath ?? null, status: change.status })),
      ...state.status.unversioned.map(path => ({ path, origPath: null, status: 'U' })),
    ]
  const fileIndex = fileList.findIndex(entry => entry.path === selected.path)

  /**
   * Open the changed file at an index.
   * @param index - position in the repository's changed-file list.
   */
  const openAt = (index: number): void => {
    const entry = fileList[index]
    if (entry === undefined) return
    const status = entry.status
    void store.actions.openFile({
      repoId: selected.repoId,
      path: entry.path,
      origPath: entry.origPath,
      status: status === 'A' || status === 'D' || status === 'R' || status === 'T' || status === 'U' ? status : 'M',
    })
  }

  /**
   * Scroll to a hunk, used by the previous and next difference buttons.
   * @param index - the hunk index.
   */
  const goToHunk = (index: number): void => {
    if (hunks.length === 0) return
    const clamped = Math.min(Math.max(index, 0), hunks.length - 1)
    setActiveHunk(clamped)
    document.getElementById(`${prefix}-hunk-${clamped}`)?.scrollIntoView({ block: 'nearest' })
  }

  /**
   * Open one folded run.
   * @param id - the fold id.
   */
  const unfold = (id: string): void => {
    setFolds({ key: fileKey, ids: new Set([...expanded, id]) })
  }

  const columns = state.viewMode === 'split' ? 4 : 3

  const hunkHeader = (hunk: DiffHunk, index: number): ReactNode => {
    const included = includedKeys.has(hunk.contentKey)
    return (
      <tr key={`h:${hunk.contentKey}`} className="git-hunkHead" id={`${prefix}-hunk-${index}`}>
        <th colSpan={columns} scope="colgroup">
          <div className="git-hunkBar">
            <span className="git-hunkHeader git-mono">{hunk.header}</span>
            <span className={included ? 'git-included' : 'git-excluded'}>{index + 1}/{hunks.length}</span>
            <ActionButton
              tip={t('diff.deleteHunk.tip')}
              disabledTip={busy ? waitTip : undefined}
              disabled={busy}
              ariaLabel={t('diff.deleteHunk')}
              icon={<IconTrashOutlineRegular size={14} />}
              onClick={() => { store.actions.requestRevertHunk(hunk.contentKey, selected.path) }}
            />
            <Tooltip label={busy ? waitTip : included ? t('diff.excludeHunk') : t('diff.includeHunk')} delayMs={500} portal>
              <span className="git-tipAnchor">
                <TriCheckbox
                  state={included ? 'checked' : 'unchecked'}
                  disabled={busy}
                  aria-label={included ? t('diff.excludeHunk') : t('diff.includeHunk')}
                  onChange={() => { store.actions.toggleHunk(hunk.contentKey) }}
                />
              </span>
            </Tooltip>
          </div>
        </th>
      </tr>
    )
  }

  const gapRow = (hunk: DiffHunk, previous: DiffHunk | undefined): ReactNode => {
    if (previous === undefined) return null
    const hidden = hunk.oldStart - (previous.oldStart + previous.oldLines)
    if (hidden <= 0) return null
    return (
      <tr key={`g:${hunk.contentKey}`} className="git-gapRow">
        <td colSpan={columns}>{t('diff.gap', { count: hidden })}</td>
      </tr>
    )
  }

  const foldRow = (id: string, count: number): ReactNode => (
    <tr key={`f:${id}`} className="git-foldRow">
      <td colSpan={columns}>
        <button type="button" className="git-foldBtn" onClick={() => { unfold(id) }}>
          {t('diff.fold', { count })}
        </button>
      </td>
    </tr>
  )

  const renderSplit = (hunk: DiffHunk, index: number): ReactNode[] => {
    const rows = splitItems(itemsOf(hunk, state.collapseUnchanged, expanded))
    return [
      gapRow(hunk, hunks[index - 1]),
      hunkHeader(hunk, index),
      ...rows.map((row, rowIndex) => {
        if (row.kind === 'fold') return foldRow(row.id, row.count)
        const { left, right } = row
        return (
          <tr key={`r:${hunk.contentKey}:${rowIndex}`}>
            <td className={`git-num ${left?.kind === 'del' ? 'git-numDel' : ''}`}>{left?.oldLine ?? ''}</td>
            <td className={`git-code ${left?.kind === 'del' ? 'git-lineDel' : ''}`}>
              {left === null ? '' : lineContent(left.text, syntax.oldSpans.get(left), marks.get(left), 'del')}
            </td>
            <td className={`git-num git-numRight ${right?.kind === 'add' ? 'git-numAdd' : ''}`}>{right?.newLine ?? ''}</td>
            <td className={`git-code ${right?.kind === 'add' ? 'git-lineAdd' : ''}`}>
              {right === null ? '' : lineContent(right.text, syntax.newSpans.get(right), marks.get(right), 'add')}
            </td>
          </tr>
        )
      }),
    ]
  }

  const renderUnified = (hunk: DiffHunk, index: number): ReactNode[] => {
    const items = itemsOf(hunk, state.collapseUnchanged, expanded)
    return [
      gapRow(hunk, hunks[index - 1]),
      hunkHeader(hunk, index),
      ...items.map((item, rowIndex) => {
        if (item.kind === 'fold') return foldRow(item.id, item.lines.length)
        const { line } = item
        const spans = line.kind === 'del' ? syntax.oldSpans.get(line) : syntax.newSpans.get(line)
        return (
          <tr key={`u:${hunk.contentKey}:${rowIndex}`}>
            <td className={`git-num ${line.kind === 'add' ? 'git-numAdd' : line.kind === 'del' ? 'git-numDel' : ''}`}>{line.kind === 'add' ? '' : line.oldLine ?? ''}</td>
            <td className={`git-num git-numSecond ${line.kind === 'add' ? 'git-numAdd' : line.kind === 'del' ? 'git-numDel' : ''}`}>{line.kind === 'del' ? '' : line.newLine ?? ''}</td>
            <td className={`git-code ${line.kind === 'add' ? 'git-lineAdd' : line.kind === 'del' ? 'git-lineDel' : ''}`}>
              {lineContent(line.text, spans, marks.get(line), line.kind === 'del' ? 'del' : 'add')}
            </td>
          </tr>
        )
      }),
    ]
  }

  return (
    <div className="git-panel" data-dsh-git="diff">
      <div className="git-diffHead">
        <ActionButton
          tip={t('diff.toolbar.previous.tip')}
          disabled={hunks.length === 0}
          ariaLabel={t('diff.toolbar.previous')}
          icon={<IconChevronUpOutlineRegular size={14} />}
          onClick={() => { goToHunk(activeHunk - 1) }}
        />
        <ActionButton
          tip={t('diff.toolbar.next.tip')}
          disabled={hunks.length === 0}
          ariaLabel={t('diff.toolbar.next')}
          icon={<IconChevronDownOutlineRegular size={14} />}
          onClick={() => { goToHunk(activeHunk + 1) }}
        />
        <ActionButton
          tip={t('diff.toolbar.prevFile.tip')}
          disabled={fileIndex <= 0}
          ariaLabel={t('diff.toolbar.prevFile')}
          icon={<IconChevronLeftOutlineRegular size={14} />}
          onClick={() => { openAt(fileIndex - 1) }}
        />
        <ActionButton
          tip={t('diff.toolbar.nextFile.tip')}
          disabled={fileIndex === -1 || fileIndex >= fileList.length - 1}
          ariaLabel={t('diff.toolbar.nextFile')}
          icon={<IconChevronRightOutlineRegular size={14} />}
          onClick={() => { openAt(fileIndex + 1) }}
        />
        <span className="git-dim git-mono">{fileList.length === 0 || fileIndex === -1 ? '' : `${fileIndex + 1}/${fileList.length}`}</span>
        {diff === null ? null : <span className="git-dim">{t('diff.summary', { total: diff.changedLines, included: includedCount })}</span>}
        {state.busy?.kind === 'revertHunk' ? (
          <span className="git-running"><StateDot state="ongoing" size={12} /><TextShimmer active>{phase?.label ?? ''}</TextShimmer></span>
        ) : null}
        <span className="git-grow" />
        <SegmentedControl
          id={`${prefix}-mode`}
          value={state.viewMode}
          label={t('diff.toolbar.mode')}
          options={[
            { value: 'split', label: t('diff.toolbar.split'), title: t('diff.toolbar.split.tip') },
            { value: 'unified', label: t('diff.toolbar.unified'), title: t('diff.toolbar.unified.tip') },
          ]}
          onChange={mode => { store.actions.setViewMode(mode) }}
        />
        <ActionButton
          variant={state.wrapLines ? 'outline' : 'toolbar'}
          tip={t('diff.toolbar.wrap.tip')}
          ariaLabel={t('diff.toolbar.wrap')}
          icon={<IconWrapLinesOutlineRegular size={14} />}
          onClick={() => { store.actions.toggleWrap() }}
        />
        <ActionButton
          variant={state.collapseUnchanged ? 'outline' : 'toolbar'}
          tip={t('diff.toolbar.collapse.tip')}
          label={t('diff.toolbar.collapse')}
          onClick={() => { store.actions.toggleCollapse() }}
        />
        <ActionButton
          tip={t('diff.toolbar.refresh')}
          ariaLabel={t('diff.toolbar.refresh')}
          icon={<IconRefreshOutlineRegular size={14} />}
          onClick={() => { void store.actions.refreshDiff() }}
        />
      </div>

      <div className="git-diffSub">
        {diff === null ? null : <Tag tone="quiet">{diff.headShortSha}</Tag>}
        <Tooltip label={t('diff.path.tip')} delayMs={500} portal>
          <span className="git-path git-mono">{selected.path}</span>
        </Tooltip>
        <span className="git-grow" />
        <Tooltip label={busy ? waitTip : t('diff.currentVersion.tip')} delayMs={500} portal>
          <span className="git-tipAnchor">
            <Checkbox
              checked={allIncluded}
              disabled={hunks.length === 0 || busy}
              label={t('diff.currentVersion')}
              onChange={() => { store.actions.toggleCurrentVersion() }}
            />
          </span>
        </Tooltip>
      </div>

      <div className="git-diffBody" data-wrap={state.wrapLines} style={{ '--git-cols': columns } as CSSProperties}>
        {state.diffError !== null ? <div className="git-inlineError" role="alert"><span>{state.diffError}</span></div> : null}
        {diff === null && state.diffError === null ? (
          <div className="git-diffSkeleton" aria-busy="true" aria-label={t('state.loading')}>
            {Array.from({ length: SKELETON_LINES }, (_unused, index) => (
              <div key={index} className="git-skelRow"><span className="git-skel" style={{ width: `${30 + ((index * 23) % 60)}%` }} /></div>
            ))}
          </div>
        ) : null}
        {diff !== null && diff.binary ? <div className="git-empty">{t('diff.binary')}</div> : null}
        {diff !== null && !diff.binary && hunks.length === 0 ? <div className="git-empty">{t('state.noChanges')}</div> : null}
        {diff !== null && !diff.binary && hunks.length > 0 ? (
          <table className="git-table" data-mode={state.viewMode}>
            <tbody>
              {hunks.map((hunk, index) => (state.viewMode === 'split' ? renderSplit(hunk, index) : renderUnified(hunk, index)))}
            </tbody>
          </table>
        ) : null}
      </div>
    </div>
  )
}
