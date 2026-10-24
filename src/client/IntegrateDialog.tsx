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
import { StateDot, TextShimmer, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'

import { usePhase } from './phase.ts'
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
  const phase = usePhase(t, state.busy)
  const offer = state.syncOffer
  if (offer === null) return null
  const status = state.status
  const rebaseBlocked = status !== null && status.changes.length > 0
  const busy = state.busy !== null
  const banner = state.banner

  // Escape, the mask, the X and Cancel all reach `onClose`; git cannot be
  // interrupted safely mid-integration, so every dismiss path is a no-op while a
  // rebase, merge or push owns the lock and the dialog keeps its context.
  const dismiss = (): void => {
    if (state.busy !== null) return
    store.actions.dismissSyncOffer()
  }

  return (
    <Modal
      open
      className="dsh-git-dialog"
      onClose={dismiss}
      title={t('sync.title')}
      closeLabel={t('confirm.close')}
      footer={(
        <div className="git-confirmFooter">
          <Tooltip label={busy ? t('sync.cancel.busy.tip') : t('sync.cancel')} delayMs={500} portal>
            <span className="git-tipAnchor">
              <Button variant="outline" data-modal-autofocus="" disabled={busy} onClick={dismiss}>
                {t('sync.cancel')}
              </Button>
            </span>
          </Tooltip>
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
        {busy ? (
          <p className="git-running" role="status">
            <StateDot state="ongoing" size={12} />
            <TextShimmer active>{phase?.label ?? ''}</TextShimmer>
          </p>
        ) : null}
        {!busy && banner !== null && banner.kind === 'error' ? <p className="git-warn" role="alert">{t(banner.key, banner.params ?? {})}</p> : null}
        <p className="git-dim">{t('sync.merge.tip', { target: offer.target, branch: offer.branch })}</p>
      </div>
    </Modal>
  )
}
