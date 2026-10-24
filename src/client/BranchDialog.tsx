/**
 * The Branches dialog: filter, Local and Remote groups, and New branch.
 *
 * This dialog is the single confirmation of a branch write (Human decision M4).
 * Rather than asking twice, it names the exact effect in a state-generated line
 * beside the primary button, computed from the loaded status and the selection:
 * `Switch <from> → <to>; <n> changed files carry over`, or `Create <name> at <sha>`.
 * There is no second dialog and no double-click submit: the primary is the only
 * control that submits, and it is disabled while a write runs.
 *
 * `Modal` portals to `document.body`, outside `[data-dsh-git]`, so every selector
 * this dialog relies on is scoped by the `dsh-git-dialog` class passed to it.
 * Rows are plain buttons because the plugin owns its controls here rather than
 * taking a new primitive dependency for one list.
 */
import { useSyncExternalStore, type ReactNode } from 'react'
import { Button, Modal, StateDot, TextShimmer, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'

import type { BranchEntry } from '../config.ts'
import { branchLabelOf } from './branch-label.ts'
import type { DshIntellijGitKey } from './locale.ts'
import type { BranchFailure, IntellijGitStore } from './store.ts'

/** Props: the shared store and the locale seat. */
export type BranchDialogProps = PropsLocale<'dshIntellijGit'> & { readonly store: IntellijGitStore }

/** Dictionary key and parameters of one inline switch failure. */
interface FailureCopy {
  readonly key: DshIntellijGitKey
  readonly params: Record<string, unknown>
}

/**
 * Turn a host failure into one sentence.
 *
 * The codes are the host's own, so the copy can name the exact recovery rather
 * than echo a message that was written for a log.
 * @param failure - the classified failure.
 * @returns the dictionary key and its parameters.
 */
export function failureCopy(failure: BranchFailure): FailureCopy {
  const paths = Array.isArray(failure.details['paths'])
    ? failure.details['paths'].filter((path): path is string => typeof path === 'string')
    : []
  const reason = typeof failure.details['stderr'] === 'string' && failure.details['stderr'] !== ''
    ? failure.details['stderr']
    : failure.message
  switch (failure.code) {
    case 'LOCAL_CHANGES_BLOCK_SWITCH':
      return { key: 'branch.error.localChanges', params: { paths: paths.join(', '), count: failure.details['total'] ?? paths.length } }
    case 'BRANCH_CHECKED_OUT_ELSEWHERE':
      return { key: 'branch.error.checkedOutElsewhere', params: { path: String(failure.details['path'] ?? '') } }
    case 'HEAD_MOVED':
      return { key: 'branch.error.headMoved', params: {} }
    case 'BRANCH_NOT_FOUND':
      return { key: 'branch.error.notFound', params: {} }
    case 'BRANCH_EXISTS':
      return {
        key: 'branch.error.exists',
        params: {
          local: String(failure.details['local'] ?? ''),
          upstream: String(failure.details['upstream'] ?? failure.details['name'] ?? ''),
        },
      }
    case 'INVALID_BRANCH_NAME':
      return { key: 'branch.error.invalidName', params: { reason: String(failure.details['name'] ?? '') } }
    case 'INTEGRATION_IN_PROGRESS':
      return { key: 'branch.error.inProgress', params: { reason: reason } }
    case 'SWITCH_FAILED':
      return { key: 'branch.error.switchFailed', params: { reason: reason } }
    default:
      return { key: 'branch.error.generic', params: { reason: failure.message } }
  }
}

/**
 * Whether a row survives the filter.
 * @param row - the branch row.
 * @param needle - lowercased filter text; empty matches everything.
 * @returns true when the row is kept.
 */
function matches(row: BranchEntry, needle: string): boolean {
  if (needle === '') return true
  return row.name.toLowerCase().includes(needle) || row.subject.toLowerCase().includes(needle)
}

/**
 * The dialog.
 * @param props - store and locale seat.
 * @returns the dialog, or null while it is closed.
 */
export function BranchDialog(props: BranchDialogProps): ReactNode {
  const { store, t } = props
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const dialog = state.branchDialog
  if (!dialog.open) return null

  const status = state.status
  const listing = dialog.listing
  const needle = dialog.filter.trim().toLowerCase()
  const localRows = (listing?.local ?? []).filter(row => matches(row, needle))
  const remoteRows = (listing?.remote ?? []).filter(row => matches(row, needle))
  const headShort = listing?.headShortSha ?? null
  const detached = listing?.detached ?? false
  const fromLabel = status === null ? '' : branchLabelOf(status, t)
  const carryOver = status?.changes.length ?? 0
  const selected = dialog.selected
  const newName = dialog.newName.trim()

  const targetName = dialog.mode === 'create' ? newName : (selected?.name ?? '')
  const canSubmit = !dialog.submitting && !dialog.loading && targetName !== '' && (dialog.mode === 'create' || selected !== null)

  const effectLine = dialog.mode === 'create'
    ? t('branch.effect.create', { name: newName === '' ? '…' : newName, sha: headShort ?? t('branch.noCommit') })
    : selected === null
      ? t('branch.effect.none')
      : t('branch.effect.switch', { from: fromLabel, to: selected.name, count: carryOver })

  const failure = dialog.submitError === null ? null : failureCopy(dialog.submitError)

  /**
   * One row.
   * @param row - the branch.
   * @returns the row button, wrapped in a tooltip when it is refused.
   */
  const renderRow = (row: BranchEntry): ReactNode => {
    const blocked = row.localConflict !== null || row.checkedOutAt !== null
    const selectedRow = selected !== null && selected.name === row.name && dialog.mode === 'list'
    const reason = row.checkedOutAt !== null
      ? t('branch.worktree.tip', { path: row.checkedOutAt })
      : row.localConflict !== null
        ? t('branch.conflict.tip', { name: row.localConflict.name, upstream: row.localConflict.upstream ?? t('branch.conflict.none') })
        : ''
    const button = (
      <button
        type="button"
        className="git-branchRow"
        data-selected={selectedRow}
        aria-current={row.current ? 'true' : undefined}
        disabled={blocked || dialog.submitting}
        onClick={() => { store.actions.selectBranchTarget({ kind: row.kind, name: row.name }) }}
      >
        <span className="git-branchName git-mono">{row.name}</span>
        {row.localName === null
          ? null
          : <span className="git-branchUnit">{t('branch.remoteCreates', { name: row.localName })}</span>}
        {row.current ? <span className="git-branchCurrent">{t('branch.current')}</span> : null}
        <span className="git-branchUnit git-mono">{row.headShortSha ?? '—'}</span>
        <span className="git-branchUnit">{row.committedAt === 0 ? '' : new Date(row.committedAt * 1000).toLocaleDateString()}</span>
      </button>
    )
    return reason === ''
      ? <div key={`${row.kind}:${row.name}`}>{button}</div>
      : (
        <div key={`${row.kind}:${row.name}`}>
          <Tooltip label={reason} delayMs={400} portal>
            <span className="git-tipAnchor">{button}</span>
          </Tooltip>
        </div>
      )
  }

  return (
    <Modal
      open
      className="dsh-git-dialog"
      onClose={() => { store.actions.closeBranchDialog() }}
      title={t('branch.dialog.title')}
      closeLabel={t('confirm.close')}
      footer={(
        <div className="git-branchFooter">
          <span className="git-branchEffect" role="status">{effectLine}</span>
          <div className="git-branchFooterRow">
            <Button variant="outline" data-modal-autofocus="" disabled={dialog.submitting} onClick={() => { store.actions.closeBranchDialog() }}>
              {t('branch.cancel')}
            </Button>
            <Button variant="primary" disabled={!canSubmit} onClick={() => { void store.actions.submitSwitch() }}>
              {dialog.submitting
                ? <TextShimmer active>{t('branch.switching')}</TextShimmer>
                : dialog.mode === 'create' ? t('branch.create') : t('branch.switch')}
            </Button>
          </div>
        </div>
      )}
    >
      <div className="git-branchBody">
        <input
          type="text"
          className="git-branchFilter"
          value={dialog.filter}
          placeholder={t('branch.filter.placeholder')}
          aria-label={t('branch.filter.aria')}
          disabled={dialog.submitting}
          onChange={event => { store.actions.setBranchFilter(event.target.value) }}
        />
        {failure === null ? null : (
          <div className="git-branchError" role="alert">
            <span>{t(failure.key, failure.params)}</span>
            <Button variant="outline" onClick={() => { void store.actions.reloadBranches() }}>{t('branch.reload')}</Button>
          </div>
        )}
        {dialog.error === null ? null : (
          <div className="git-branchError" role="alert">
            <span>{dialog.error}</span>
            <Button variant="outline" onClick={() => { void store.actions.reloadBranches() }}>{t('branch.reload')}</Button>
          </div>
        )}
        {dialog.loading ? (
          <p className="git-running" role="status">
            <StateDot state="ongoing" size={12} />
            <TextShimmer active>{t('branch.loading')}</TextShimmer>
          </p>
        ) : (
          <div className="git-branchScroll">
            {detached ? <p className="git-branchHint">{t('branch.detachedHint', { sha: headShort ?? '—' })}</p> : null}
            <div className="git-branchGroup">
              <div className="git-branchGroupLabel">{t('branch.group.local')}</div>
              {localRows.length === 0 ? <p className="git-branchEmpty git-dim">{t('branch.empty.local')}</p> : null}
              {localRows.map(renderRow)}
            </div>
            {remoteRows.length === 0 ? null : (
              <div className="git-branchGroup">
                <div className="git-branchGroupLabel">{t('branch.group.remote')}</div>
                <p className="git-branchHint">{t('branch.remoteHint')}</p>
                {remoteRows.map(renderRow)}
              </div>
            )}
          </div>
        )}

        {dialog.mode === 'create' ? (
          <div className="git-branchNew">
            <label className="git-branchGroupLabel" htmlFor="dsh-git-new-branch">{t('branch.newName')}</label>
            <input
              id="dsh-git-new-branch"
              type="text"
              className="git-branchFilter"
              value={dialog.newName}
              placeholder={t('branch.newNamePlaceholder')}
              aria-label={t('branch.newName')}
              disabled={dialog.submitting}
              onChange={event => { store.actions.setNewBranchName(event.target.value) }}
            />
            <span className="git-branchHint">{t('branch.newFrom', { branch: fromLabel, sha: headShort ?? t('branch.noCommit') })}</span>
          </div>
        ) : (
          <Button variant="outline" disabled={dialog.submitting || listing === null} onClick={() => { store.actions.showCreateBranch() }}>
            {t('branch.new')}
          </Button>
        )}
      </div>
    </Modal>
  )
}
