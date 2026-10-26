/**
 * The one confirmation every write goes through.
 *
 * One dialog rather than four near-identical ones: the body is generated from
 * `pending`, so the sentences cannot drift apart as actions change. It also owns
 * the deletion wording, which is the part that must never be wrong: the paths it
 * lists come from the same predicate the host uses, so it cannot promise that
 * nothing is deleted while a file disappears.
 *
 * `Modal` registers its own modal layer, so Escape and focus restoration are its
 * job; `useModalLayer` must not be imported here. The destructive actions put the
 * initial focus on Cancel, so Enter cannot confirm a deletion.
 */
import { useSyncExternalStore, type ReactNode } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'

import type { DshIntellijGitKey } from './locale.ts'
import { deletionPaths, hunkCount, selectedInclusions, willDeleteEntry, type IntellijGitStore } from './store.ts'

/** Props: the shared store, the locale seat, and which pane owns the dialog. */
export type ConfirmDialogProps = PropsLocale<'dshIntellijGit'> & {
  readonly store: IntellijGitStore
  readonly origin: 'commit' | 'diff'
}

/**
 * The first line of a message, with an ellipsis when more lines follow.
 * @param message - the full message.
 * @returns the one-line form.
 */
function firstLineOf(message: string): string {
  const lines = message.trim().split('\n')
  const first = lines[0] ?? ''
  return lines.length > 1 ? `${first}...` : first
}

/**
 * Render the confirmation for the pending write, when this pane owns it.
 * @param props - store, locale seat and the owning pane.
 * @returns the dialog, or null when there is nothing to confirm here.
 */
export function ConfirmDialog(props: ConfirmDialogProps): ReactNode {
  const { store, origin, t } = props
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const pending = state.pending
  if (pending === null || pending.origin !== origin) return null

  const repoId = state.activeRepoId
  const status = state.status
  const files = repoId === null ? [] : selectedInclusions(state, repoId)
  const deletions = deletionPaths(files)
  const hunks = hunkCount(files)
  const branch = status?.branch ?? ''

  /** Title, body, confirm label and whether the action is destructive. */
  let title: string
  let body: ReactNode
  let confirmLabel: string
  let destructive = false

  if (pending.kind === 'commit') {
    title = t('confirm.commit.title')
    const key: DshIntellijGitKey = hunks > 0 ? 'confirm.commit.bodyHunks' : 'confirm.commit.body'
    body = (
      <div className="git-confirmBody">
        <p>{t(key, { files: files.length, branch, hunks })}</p>
        <p className="git-mono">{t(pending.stamped ? 'confirm.commit.messageStamp' : 'confirm.commit.message', { message: firstLineOf(pending.message) })}</p>
        {state.amend ? <p className="git-warn">{t('confirm.commit.amend')}</p> : null}
        <p>
          {pending.push
            ? (status?.pushTarget === null || status?.pushTarget === undefined
              ? t('confirm.commit.pushNone')
              : t('confirm.commit.push', { target: status.pushTarget }))
            : null}
        </p>
        {pending.push && status !== null && status.behind > 0
          // The tracking ref is never fetched before committing, so this says
          // "may be refused" rather than guessing at a rejection.
          ? <p className="git-warn">{t('confirm.commit.pushBehind', { behind: status.behind })}</p>
          : null}
      </div>
    )
    confirmLabel = pending.push ? t('confirm.push.action') : t('confirm.commit.action')
  } else if (pending.kind === 'push') {
    title = t('confirm.push.title')
    body = (
      <div className="git-confirmBody">
        {status === null
          ? null
          : (
            <p>
              {t('confirm.push.body', {
                branch: status.branch,
                ahead: status.ahead,
                target: status.pushTarget ?? t('confirm.commit.pushNone'),
              })}
            </p>
          )}
      </div>
    )
    confirmLabel = t('confirm.pushNow.action')
  } else if (pending.kind === 'rollback') {
    title = t('confirm.rollback.title')
    destructive = true
    body = (
      <div className="git-confirmBody">
        <p>{t('confirm.rollback.body', { files: files.length })}</p>
        {deletions.length > 0 ? <p className="git-warn">{t('confirm.rollback.delete', { paths: deletions.join(', ') })}</p> : null}
      </div>
    )
    confirmLabel = t('confirm.rollback.action')
  } else {
    const selected = state.selected
    const deletes = selected !== null && willDeleteEntry(selected.status, true)
    title = t('confirm.revertHunk.title')
    destructive = deletes
    body = (
      <div className="git-confirmBody">
        <p>{t('confirm.revertHunk.body', { path: pending.path })}</p>
        {deletes ? <p className="git-warn">{t('confirm.revertHunk.delete', { path: pending.path })}</p> : null}
      </div>
    )
    confirmLabel = t('confirm.revertHunk.action')
  }

  return (
    <Modal
      open
      className="dsh-git-dialog"
      onClose={() => { store.actions.cancelPending() }}
      title={title}
      closeLabel={t('confirm.close')}
      footer={(
        <div className="git-confirmFooter">
          <Button variant="outline" data-modal-autofocus="" onClick={() => { store.actions.cancelPending() }}>
            {t('confirm.cancel')}
          </Button>
          <Button
            variant="primary"
            className={destructive ? 'git-danger' : undefined}
            onClick={() => { void store.actions.confirmPending() }}
          >
            {confirmLabel}
          </Button>
        </div>
      )}
    >
      {body}
    </Modal>
  )
}
