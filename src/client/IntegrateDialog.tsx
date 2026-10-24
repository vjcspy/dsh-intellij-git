/**
 * The rebase-or-merge choice offered after a rejected push.
 *
 * Two buttons, no default: the two orders produce different history shapes
 * (`rebase` replays only the unpushed local commits and keeps a linear line,
 * `merge` records a merge commit and rewrites nothing), so a default would
 * silently pick a history policy. Cancel dismisses the offer without touching
 * the repository; the commit that caused the rejection is already made and is
 * never rolled back here.
 *
 * Rebase is disabled when the change list is not empty, which approximates the
 * host's tracked-dirty pre-check; the Host stays authoritative, because the
 * client compares `git diff HEAD` while the host compares `--porcelain`, and a
 * staged-then-reverted path appears in one and not the other.
 */
import { useSyncExternalStore, type ReactNode } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'

import type { IntellijGitStore } from './store.ts'

/** Props: the shared store and the locale seat. */
export type IntegrateDialogProps = PropsLocale<'dshIntellijGit'> & { readonly store: IntellijGitStore }

/**
 * Render the integration offer while one is pending.
 * @param props - store and locale seat.
 * @returns the dialog, or null when no push was rejected.
 */
export function IntegrateDialog(props: IntegrateDialogProps): ReactNode {
  const { store, t } = props
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const offer = state.syncOffer
  if (offer === null) return null
  const status = state.status
  const rebaseBlocked = status !== null && status.changes.length > 0
  const busy = state.busy !== null

  return (
    <Modal
      open
      onClose={() => { store.actions.dismissSyncOffer() }}
      title={t('sync.title')}
      closeLabel={t('confirm.close')}
      footer={(
        <div className="git-confirmFooter">
          <Button variant="outline" data-modal-autofocus="" onClick={() => { store.actions.dismissSyncOffer() }}>
            {t('sync.cancel')}
          </Button>
          <Button variant="outline" disabled={busy} onClick={() => { void store.actions.sync('merge') }}>
            {t('sync.merge')}
          </Button>
          <Button variant="primary" disabled={busy || rebaseBlocked} onClick={() => { void store.actions.sync('rebase') }}>
            {t('sync.rebase')}
          </Button>
        </div>
      )}
    >
      <div className="git-confirmBody">
        <p>{t('sync.body', { branch: offer.branch, ahead: status?.ahead ?? 0, behind: status?.behind ?? 0, target: offer.target })}</p>
        <p className="git-dim">{t('sync.rebase.tip', { target: offer.target })}</p>
        {rebaseBlocked ? <p className="git-warn">{t('sync.rebase.blocked.tip')}</p> : null}
        <p className="git-dim">{t('sync.merge.tip', { target: offer.target, branch: offer.branch })}</p>
      </div>
    </Modal>
  )
}
