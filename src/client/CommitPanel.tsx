/**
 * The changes column: repository accordion, change tree and commit box.
 *
 * Built from the shell's own controls, so geometry, focus ring and theme tokens
 * are the platform's rather than an approximation. Every control carries a
 * tooltip; a control that is disabled is wrapped in a span anchor so it still
 * explains why, because a disabled button takes no focus.
 *
 * Rows carry no state of their own: every box is derived from the file's
 * inclusion in the store, so the section header, a folder and the diff header
 * can never disagree. While a write runs, everything that would change what the
 * host commits is locked, and the tooltips say which phase to wait for.
 */
import { useSyncExternalStore, type ReactElement, type ReactNode } from 'react'
import {
  Checkbox,
  FileTypeIcon,
  IconChevronDownOutlineRegular,
  IconChevronRightOutlineRegular,
  IconSparkleRegular,
  IconTrashOutlineRegular,
  Tag,
  Tooltip,
  type TagTone,
} from '@deepseek-ai/dsh-client-ui-primitives'

import { ROOT_REPO_ID, type FileChangeEntry } from '../config.ts'
import { ActionButton } from './ActionButton.tsx'
import { branchLabelOf } from './branch-label.ts'
import type { DshIntellijGitKey, Translate } from './locale.ts'
import { usePhase } from './phase.ts'
import { groupsOf, selectedInclusions, type IntellijGitStore } from './store.ts'
import { TriCheckbox } from './TriCheckbox.tsx'
import type { DirNode, FileNode, GroupNode } from './tree-builder.ts'

/** Props: the shared store and the locale seat. */
export interface CommitPanelProps {
  readonly store: IntellijGitStore
  readonly t: Translate
}

/** Number of skeleton rows shown while a repository's first status loads. */
const SKELETON_ROWS = 6

const STATUS_TONES: Record<FileChangeEntry['status'] | 'U', TagTone> = {
  M: 'info',
  A: 'success',
  D: 'danger',
  R: 'warning',
  T: 'warning',
  U: 'neutral',
}

/**
 * The status letter as a `Tag`, with the status spoken for assistive tech.
 * @param props.status - the change status.
 * @returns the tag.
 */
function StatusTag(props: { readonly status: FileChangeEntry['status'] | 'U' }): ReactNode {
  return (
    <Tag tone={STATUS_TONES[props.status] ?? 'outline'} className="git-statusTag">
      <span className="git-visuallyHidden">{props.status}</span>
      <span aria-hidden="true">{props.status === 'U' ? '?' : props.status}</span>
    </Tag>
  )
}

/**
 * Anchor a tooltip to a control; a locked control gets a span anchor.
 * @param label - the tooltip text.
 * @param element - the control.
 * @param locked - whether the control is disabled.
 * @returns the anchored control.
 */
function tip(label: string, element: ReactElement, locked = false): ReactNode {
  return (
    <Tooltip label={label} delayMs={500} portal>
      {locked ? <span className="git-tipAnchor">{element}</span> : element}
    </Tooltip>
  )
}

/**
 * The changes column.
 * @param props - the store and the locale seat.
 * @returns the panel.
 */
export function CommitPanel(props: CommitPanelProps): ReactNode {
  const { store, t } = props
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const phase = usePhase(t, state.busy)
  const tree = state.tree
  const repoId = state.activeRepoId
  const groups = repoId === null ? null : groupsOf(state, repoId)
  const selectedCount = repoId === null ? 0 : selectedInclusions(state, repoId).length
  const status = state.status
  const busy = state.busy !== null
  const waitTip = t('busy.wait', { phase: phase?.text ?? '' })
  const anyCollapsed = state.collapsedNodes.length > 0
  const kind = state.busy?.kind
  const canCommit = selectedCount > 0 && !busy && (state.message.trim() !== '' || state.amend)

  const twisty = (open: boolean): ReactNode => (
    <span className="git-twistyGlyph" data-open={open}>
      {open ? <IconChevronDownOutlineRegular size={12} /> : <IconChevronRightOutlineRegular size={12} />}
    </span>
  )

  /**
   * Render one file or directory row.
   *
   * Expansion is a denylist: a directory is expanded unless its key is in
   * `collapsedNodes`, so a folder that appears only in a later status is expanded
   * by construction rather than waiting for a click.
   * @param node - the row.
   * @param depth - indent depth.
   * @param groupKey - which of the two groups the row belongs to.
   * @returns the row.
   */
  const renderNode = (node: FileNode | DirNode, depth: number, groupKey: GroupNode['key']): ReactNode => {
    if (node.type === 'file') {
      const selected = state.selected?.path === node.path
      return (
        <div key={`f:${node.path}`} className="git-row" data-selected={selected} style={{ paddingLeft: `${10 + depth * 12}px` }}>
          {tip(
            busy ? waitTip : t('file.check.tip', { name: node.name }),
            <TriCheckbox state={node.check} aria-label={node.name} disabled={busy} onChange={() => { store.actions.toggleFile(node) }} />,
            busy,
          )}
          {tip(
            t('file.open.tip', { name: node.name }),
            <button
              type="button"
              className="git-fileBtn"
              onClick={() => { void store.actions.openFile({ repoId: repoId ?? ROOT_REPO_ID, path: node.path, origPath: node.origPath, status: node.status }) }}
            >
              <FileTypeIcon path={node.path} size={14} />
              <span className="git-fileName">{node.name}</span>
            </button>,
          )}
          <StatusTag status={node.status} />
        </div>
      )
    }
    const dirKey = `${repoId ?? ROOT_REPO_ID}:${groupKey}:${node.key}`
    const expanded = !state.collapsedNodes.includes(dirKey)
    return (
      <div key={`d:${dirKey}`}>
        <div className="git-row" style={{ paddingLeft: `${6 + depth * 12}px` }}>
          {tip(
            expanded ? t('dir.open.tip', { name: node.name }) : t('dir.close.tip', { name: node.name }),
            <button type="button" className="git-twisty" aria-expanded={expanded} onClick={() => { store.actions.toggleDir(dirKey) }}>
              {twisty(expanded)}
            </button>,
          )}
          {tip(
            busy ? waitTip : t('section.check.tip', { name: node.name }),
            <TriCheckbox state={node.check} aria-label={node.name} disabled={busy} onChange={() => { store.actions.toggleNode(node) }} />,
            busy,
          )}
          <FileTypeIcon kind="folder" size={14} />
          <span className="git-label git-mono">{node.name}</span>
          <span className="git-count">{node.count}</span>
        </div>
        {expanded ? node.children.map(child => renderNode(child, depth + 1, groupKey)) : null}
      </div>
    )
  }

  const renderGroup = (group: GroupNode, labelKey: DshIntellijGitKey): ReactNode => (
    <div key={group.key}>
      <div className="git-row git-rowGroup" style={{ paddingLeft: '6px' }}>
        {tip(
          busy ? waitTip : t('section.check.tip', { name: t(labelKey) }),
          <TriCheckbox state={group.check} aria-label={t(labelKey)} disabled={busy} onChange={() => { store.actions.toggleGroup(group) }} />,
          busy,
        )}
        <span className="git-label git-groupLabel">{t(labelKey)}</span>
        <span className="git-count">{group.count === 1 ? t('section.file') : t('section.files', { count: group.count })}</span>
      </div>
      {group.children.map(child => renderNode(child, 1, group.key))}
    </div>
  )

  /**
   * What sits under an open repository row: the groups, a skeleton while the
   * first status loads, or the load error with a retry.
   * @returns the body.
   */
  const repoBody = (): ReactNode => {
    if (groups === null) {
      if (state.statusError !== null) {
        return (
          <div className="git-children">
            <div className="git-inlineError" role="alert">
              <span>{state.statusError}</span>
              <ActionButton tip={t('state.retry.tip')} label={t('state.retry')} onClick={() => { void store.actions.refreshStatus() }} />
            </div>
          </div>
        )
      }
      if (state.statusLoading) {
        return (
          <div className="git-children" aria-busy="true" aria-label={t('state.loading')}>
            {Array.from({ length: SKELETON_ROWS }, (_unused, index) => (
              <div key={index} className="git-skelRow"><span className="git-skel" style={{ width: `${40 + ((index * 17) % 45)}%` }} /></div>
            ))}
          </div>
        )
      }
      return null
    }
    return (
      <div className="git-children">
        {state.statusError !== null ? (
          <div className="git-inlineError" role="alert">
            <span>{state.statusError}</span>
            <ActionButton tip={t('state.retry.tip')} label={t('state.retry')} onClick={() => { void store.actions.refreshStatus() }} />
          </div>
        ) : null}
        {groups.changes.count > 0 ? renderGroup(groups.changes, 'section.changes') : null}
        {groups.unversioned.count > 0 ? renderGroup(groups.unversioned, 'section.unversioned') : null}
        {groups.changes.count === 0 && groups.unversioned.count === 0 ? <div className="git-empty">{t('state.noChanges')}</div> : null}
      </div>
    )
  }

  const repoHeader = (id: string, label: string): ReactNode => {
    const open = state.reposExpanded.includes(id)
    const active = state.activeRepoId === id
    return (
      <div className="git-row git-rowRepo" data-active={active && open}>
        {tip(
          busy ? waitTip : open ? t('repo.close.tip', { name: label }) : t('repo.open.tip', { name: label }),
          <button type="button" className="git-twisty" aria-expanded={open} disabled={busy} onClick={() => { void store.actions.toggleRepo(id) }}>
            {twisty(open)}
          </button>,
          busy,
        )}
        <FileTypeIcon kind="folder" size={14} />
        <span className={active ? 'git-label git-repo' : 'git-label'}>{label}</span>
        {active && status !== null ? (
          <Tooltip
            label={status.detached
              ? t('branch.badge.detached.tip', { sha: status.headShortSha })
              : t('repo.branch.tip', { branch: status.branch, ahead: status.ahead, behind: status.behind })}
            delayMs={500}
            portal
          >
            <span className="git-branch git-mono">
              <span>{branchLabelOf(status, t)}</span>
              {status.ahead > 0 ? <span className="git-ahead">{`↑${status.ahead}`}</span> : null}
              {status.behind > 0 ? <span className="git-behind">{`↓${status.behind}`}</span> : null}
            </span>
          </Tooltip>
        ) : null}
      </div>
    )
  }

  return (
    <div className="git-panel" data-dsh-git="commit">
      <div className="git-toolbar">
        <ActionButton
          tip={t('toolbar.rollback.tip')}
          disabledTip={busy ? waitTip : t('commit.button.disabled.tip')}
          disabled={selectedCount === 0 || busy}
          running={kind === 'rollback' ? (phase?.label ?? null) : null}
          label={t('toolbar.rollback')}
          icon={<IconTrashOutlineRegular size={14} />}
          onClick={() => { store.actions.requestRollback() }}
        />
        <ActionButton tip={t('toolbar.compact.tip')} label={t('toolbar.compact')} onClick={() => { store.actions.toggleCompact() }} />
        <ActionButton
          tip={anyCollapsed ? t('toolbar.expandAll.tip') : t('toolbar.collapseAll.tip')}
          label={anyCollapsed ? t('toolbar.expandAll') : t('toolbar.collapseAll')}
          onClick={() => { if (anyCollapsed) store.actions.expandAllDirs(); else store.actions.collapseAllDirs() }}
        />
      </div>

      <div className="git-tree">
        {state.treeLoading && tree === null ? <div className="git-empty">{t('state.loading')}</div> : null}
        {state.treeError !== null ? <div className="git-empty">{state.treeError}</div> : null}
        {tree !== null && !tree.configured ? (
          <div className="git-empty">
            <div>{t('state.noRoot')}</div>
            <div className="git-dim">{t('state.noRootHint')}</div>
          </div>
        ) : null}

        {tree !== null && tree.configured && tree.rootRepo !== null ? (
          <div className="git-card">
            <div className="git-sectionLabel">{t('section.root')}</div>
            {repoHeader(ROOT_REPO_ID, tree.rootRepo.label)}
            {state.reposExpanded.includes(ROOT_REPO_ID) ? repoBody() : null}
          </div>
        ) : null}

        {tree !== null && tree.configured ? (
          <div className="git-card">
            <div className="git-sectionLabel">{t('section.workspaces')}</div>
            {tree.workspaces.map(workspace => {
              const wsOpen = state.workspacesExpanded.includes(workspace.name)
              return (
                <div key={workspace.name}>
                  <div className="git-row">
                    {tip(
                      t('section.twisty.tip'),
                      <button type="button" className="git-twisty" aria-expanded={wsOpen} onClick={() => { store.actions.toggleWorkspace(workspace.name) }}>
                        {twisty(wsOpen)}
                      </button>,
                    )}
                    <FileTypeIcon kind="folder" size={14} />
                    <span className="git-label git-dim">{workspace.name}</span>
                  </div>
                  {wsOpen ? workspace.domains.map(domain => {
                    const domainKey = `${workspace.name}/${domain.name}`
                    const domainOpen = state.domainsExpanded.includes(domainKey)
                    return (
                      <div key={domainKey}>
                        <div className="git-row" style={{ paddingLeft: '18px' }}>
                          {tip(
                            t('section.twisty.tip'),
                            <button type="button" className="git-twisty" aria-expanded={domainOpen} onClick={() => { store.actions.toggleDomain(domainKey) }}>
                              {twisty(domainOpen)}
                            </button>,
                          )}
                          <span className="git-label git-dim">{domain.name}</span>
                        </div>
                        {domainOpen ? domain.repos.map(repo => {
                          const active = state.activeRepoId === repo.id && state.reposExpanded.includes(repo.id)
                          return (
                            <div key={repo.id}>
                              <div style={{ paddingLeft: '26px' }}>{repoHeader(repo.id, repo.label)}</div>
                              {active ? repoBody() : null}
                            </div>
                          )
                        }) : null}
                      </div>
                    )
                  }) : null}
                </div>
              )
            })}
          </div>
        ) : null}
      </div>

      <div className="git-commitbox">
        <div className="git-amendRow">
          {tip(
            busy ? waitTip : t('commit.amend.tip'),
            <span className="git-tipAnchor">
              <Checkbox checked={state.amend} disabled={busy} label={t('commit.amend')} onChange={next => { store.actions.setAmend(next) }} />
            </span>,
          )}
          {status !== null && status.headOid !== null ? (
            <span className="git-dim git-mono">{t('commit.amendLast')} {status.headShortSha}</span>
          ) : null}
          {state.amend && status !== null && status.headPublished ? <span className="git-warn">{t('commit.amendPublished')}</span> : null}
        </div>
        {tip(
          busy ? waitTip : t('commit.message.tip'),
          <textarea
            className="git-message"
            value={state.message}
            readOnly={busy}
            placeholder={t('commit.messagePlaceholder')}
            aria-label={t('commit.message')}
            onChange={event => { store.actions.setMessage(event.target.value) }}
          />,
        )}
        {state.aiError === null ? null : <div className="git-fieldError" role="alert">{t('commit.generateFailed', { reason: state.aiError })}</div>}
        <div className="git-actions">
          <ActionButton
            variant="outline"
            tip={t('commit.generate.tip')}
            disabledTip={busy ? waitTip : t('commit.generate.disabled.tip')}
            disabled={state.aiBusy || selectedCount === 0 || busy}
            running={state.aiBusy ? t('commit.generating') : null}
            label={t('commit.generate')}
            icon={<IconSparkleRegular size={14} />}
            onClick={() => { void store.actions.generateMessage(undefined) }}
          />
          {state.aiRoute !== null ? (
            <span className="git-route">{t('commit.aiRoute', { provider: state.aiRoute.split('/')[0] ?? '', model: state.aiRoute.split('/')[1] ?? '' })}</span>
          ) : null}
        </div>
        <div className="git-actions">
          <ActionButton
            variant="primary"
            tip={t('commit.button.tip')}
            disabledTip={busy ? waitTip : t('commit.button.disabled.tip')}
            disabled={!canCommit}
            running={kind === 'commit' ? (phase?.label ?? null) : null}
            label={t('commit.button')}
            onClick={() => { store.actions.requestCommit(false) }}
          />
          <ActionButton
            variant="outline"
            tip={t('commit.pushButton.tip')}
            disabledTip={busy ? waitTip : t('commit.button.disabled.tip')}
            disabled={!canCommit}
            running={kind === 'commitPush' ? (phase?.label ?? null) : null}
            label={t('commit.pushButton')}
            onClick={() => { store.actions.requestCommit(true) }}
          />
        </div>
      </div>
    </div>
  )
}
