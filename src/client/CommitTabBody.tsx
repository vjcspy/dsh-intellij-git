/**
 * The Commit tool window: repository accordion, change tree and commit box.
 *
 * Built from the shell's own controls, so geometry, focus ring and theme tokens
 * are the platform's rather than an approximation. Every control carries a
 * tooltip; a control that is legitimately disabled is wrapped in a span anchor so
 * it still explains why it cannot be used, because a disabled button takes no
 * focus and the anchor would otherwise be missing.
 *
 * Rows carry no state of their own: every box is derived from the file's
 * inclusion in the store, so the section header, a folder and the diff
 * sub-header can never disagree.
 */
import { useEffect, useRef, useSyncExternalStore, type ReactNode } from 'react'
import { Button, Checkbox, FileTypeIcon, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'

import { ROOT_REPO_ID, type ActivityEntry } from '../config.ts'
import { ConfirmDialog } from './ConfirmDialog.tsx'
import { IntegrateDialog } from './IntegrateDialog.tsx'
import type { DshIntellijGitKey } from './locale.ts'
import { groupsOf, selectedInclusions, type IntellijGitStore } from './store.ts'
import { TriCheckbox } from './TriCheckbox.tsx'
import type { DirNode, FileNode, GroupNode } from './tree-builder.ts'

/** Props the renderer hands this body plus the store its inject face supplies. */
export type CommitTabProps = PropsRuntime<'sidebar.right.pane.tab'> & PropsLocale<'dshIntellijGit'> & { readonly store: IntellijGitStore }

/**
 * A toolbar action with its tooltip, and a reason when it is disabled.
 * @param props - label, optional disabled reason, variant, state and handler.
 * @returns the anchored button.
 */
function ActionButton(props: {
  readonly tip: string
  readonly disabledTip?: string
  readonly disabled?: boolean
  readonly variant?: 'primary' | 'secondary' | 'outline' | 'ghost' | 'toolbar'
  readonly label: string
  readonly onClick: () => void
}): ReactNode {
  const disabled = props.disabled === true
  const reason = disabled && props.disabledTip !== undefined ? props.disabledTip : props.tip
  const button = (
    <Button
      variant={props.variant === 'secondary' ? 'outline' : (props.variant ?? 'toolbar')}
      size="sm"
      disabled={disabled}
      onClick={props.onClick}
    >
      {props.label}
    </Button>
  )
  return (
    <Tooltip label={reason} delayMs={500} portal>
      {disabled && props.disabledTip !== undefined ? <span className="git-tipAnchor">{button}</span> : button}
    </Tooltip>
  )
}

/**
 * A `HH:mm:ss.SSS` clock label for one activity entry.
 * @param at - epoch milliseconds.
 * @returns the formatted time.
 */
function clockOf(at: number): string {
  const date = new Date(at)
  const pad = (value: number, width = 2): string => String(value).padStart(width, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`
}

/**
 * One row of the activity dock, with its output behind a click.
 * @param props - the entry, its expansion state, the locale seat and the toggle.
 * @returns the row.
 */
function ActivityRow(props: {
  readonly entry: ActivityEntry
  readonly open: boolean
  readonly t: PropsLocale<'dshIntellijGit'>['t']
  readonly onToggle: () => void
}): ReactNode {
  const { entry, open, t } = props
  return (
    <div className="git-activityRow" data-ok={entry.ok}>
      <Tooltip label={t('activity.expand.tip')} delayMs={600} portal>
        <button type="button" className="git-activityBtn" aria-expanded={open} onClick={props.onToggle}>
          <span className="git-activityTime git-mono">{clockOf(entry.at)}</span>
          <span className="git-activityBadge" data-kind={entry.kind}>{entry.kind === 'api' ? t('activity.kind.api') : t('activity.kind.git')}</span>
          <span className="git-activityLabel git-mono">{entry.label}</span>
          <span className="git-activityDetail">{entry.detail}</span>
          <span className="git-activityMs">{entry.durationMs} ms</span>
          <span className="git-activityState" data-ok={entry.ok}>{entry.ok ? t('activity.ok') : t('activity.error')}</span>
        </button>
      </Tooltip>
      {open ? (
        <pre className="git-activityOutput">
          {entry.output === undefined || entry.output === '' ? t('activity.noOutput') : entry.output}
          {entry.truncated === true ? `\n${t('activity.truncated')}` : ''}
        </pre>
      ) : null}
    </div>
  )
}

/**
 * The Commit tool window body.
 * @param props - runtime and locale seats plus the shared store.
 * @returns the panel.
 */
export function CommitTabBody(props: CommitTabProps): ReactNode {
  const { store, t } = props
  const sessionId = (props as { sessionId?: string }).sessionId
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const tree = state.tree
  const repoId = state.activeRepoId
  const groups = repoId === null ? null : groupsOf(state, repoId)
  const selectedCount = repoId === null ? 0 : selectedInclusions(state, repoId).length
  const status = state.status
  const busy = state.busy !== null
  const anyCollapsed = state.collapsedNodes.length > 0
  const logRef = useRef<HTMLDivElement | null>(null)

  // Follow new entries only while the Human is already at the bottom, so reading
  // an older entry is never interrupted by a tick.
  useEffect(() => {
    const element = logRef.current
    if (element === null) return
    if (element.dataset['atBottom'] !== 'false') element.scrollTop = element.scrollHeight
  }, [state.activity.length, state.activityOpen])

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
          <Tooltip label={t('file.check.tip', { name: node.name })} delayMs={500} portal>
            <TriCheckbox state={node.check} aria-label={node.name} onChange={() => { store.actions.toggleFile(node) }} />
          </Tooltip>
          <Tooltip label={t('file.open.tip', { name: node.name })} delayMs={500} portal>
            <button
              type="button"
              className="git-fileBtn"
              onClick={() => { void store.actions.openFile(sessionId, { repoId: repoId ?? ROOT_REPO_ID, path: node.path, origPath: node.origPath, status: node.status }) }}
            >
              <FileTypeIcon path={node.path} size={14} />
              <span className="git-fileName">{node.name}</span>
            </button>
          </Tooltip>
          <span className="git-badge" data-kind={node.status}><span className="git-visuallyHidden">{node.status}</span>{node.status === 'U' ? '?' : node.status}</span>
        </div>
      )
    }
    const dirKey = `${repoId ?? ROOT_REPO_ID}:${groupKey}:${node.key}`
    const expanded = !state.collapsedNodes.includes(dirKey)
    return (
      <div key={`d:${dirKey}`}>
        <div className="git-row" style={{ paddingLeft: `${6 + depth * 12}px` }}>
          <Tooltip label={expanded ? t('dir.open.tip', { name: node.name }) : t('dir.close.tip', { name: node.name })} delayMs={500} portal>
            <button type="button" className="git-twisty" aria-expanded={expanded} onClick={() => { store.actions.toggleDir(dirKey) }}>
              <span className="git-twistyGlyph" data-open={expanded}>{expanded ? '▾' : '▸'}</span>
            </button>
          </Tooltip>
          <Tooltip label={t('section.check.tip', { name: node.name })} delayMs={500} portal>
            <TriCheckbox state={node.check} aria-label={node.name} onChange={() => { store.actions.toggleNode(node) }} />
          </Tooltip>
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
        <Tooltip label={t('section.check.tip', { name: t(labelKey) })} delayMs={500} portal>
          <TriCheckbox state={group.check} aria-label={t(labelKey)} onChange={() => { store.actions.toggleGroup(group) }} />
        </Tooltip>
        <span className="git-label git-groupLabel">{t(labelKey)}</span>
        <span className="git-count">{group.count === 1 ? t('section.file') : t('section.files', { count: group.count })}</span>
      </div>
      {group.children.map(child => renderNode(child, 1, group.key))}
    </div>
  )

  const banner = state.banner === null ? null : (
    <div className="git-banner" data-kind={state.banner.kind} role="status">
      <span>{t(state.banner.key, state.banner.params ?? {})}</span>
      <button type="button" className="git-bannerClose" aria-label={t('confirm.close')} onClick={() => { store.actions.dismissBanner() }}>×</button>
    </div>
  )

  const repoHeader = (id: string, label: string): ReactNode => {
    const open = state.reposExpanded.includes(id)
    const active = state.activeRepoId === id
    return (
      <div className="git-row git-rowRepo">
        <Tooltip label={open ? t('repo.close.tip', { name: label }) : t('repo.open.tip', { name: label })} delayMs={500} portal>
          <button type="button" className="git-twisty" onClick={() => { void store.actions.toggleRepo(id) }}>
            <span className="git-twistyGlyph" data-open={open}>{open ? '▾' : '▸'}</span>
          </button>
        </Tooltip>
        <FileTypeIcon kind="folder" size={14} />
        <span className={active ? 'git-label git-repo' : 'git-label'}>{label}</span>
        {active && status !== null ? (
          <Tooltip
            label={t('repo.branch.tip', { branch: status.branch, ahead: status.ahead, behind: status.behind })}
            delayMs={500}
            portal
          >
            <span className="git-branch git-mono">
              <span>{status.branch}</span>
              {status.ahead > 0 ? <span className="git-ahead">↑{status.ahead}</span> : null}
              {status.behind > 0 ? <span className="git-behind">↓{status.behind}</span> : null}
            </span>
          </Tooltip>
        ) : null}
      </div>
    )
  }

  return (
    <div data-dsh-git="commit">
      <div className="git-toolbar">
        <ActionButton tip={t('toolbar.refresh.tip')} label={t('toolbar.refresh')} onClick={() => { void store.actions.refreshAll() }} />
        <ActionButton
          tip={t('toolbar.rollback.tip')}
          disabledTip={t('commit.button.disabled.tip')}
          disabled={selectedCount === 0 || busy}
          label={t('toolbar.rollback')}
          onClick={() => { store.actions.requestRollback() }}
        />
        <ActionButton
          tip={t('toolbar.compact.tip')}
          label={t('toolbar.compact')}
          onClick={() => { store.actions.toggleCompact() }}
        />
        <ActionButton
          tip={anyCollapsed ? t('toolbar.expandAll.tip') : t('toolbar.collapseAll.tip')}
          label={anyCollapsed ? t('toolbar.expandAll') : t('toolbar.collapseAll')}
          onClick={() => { if (anyCollapsed) store.actions.expandAllDirs(); else store.actions.collapseAllDirs() }}
        />
        <span className="git-grow" />
        {state.watchFailing ? <span className="git-warn">{t('state.watchFailed')}</span> : null}
        {state.statusLoading
          ? <span className="git-dim">{t('state.loading')}</span>
          : state.lastCheckedAt === null
            ? null
            : <span className="git-dim git-mono">{t('toolbar.updated', { time: clockOf(state.lastCheckedAt).slice(0, 8) })}</span>}
      </div>
      {banner}

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
          <div>
            <div className="git-sectionLabel">{t('section.root')}</div>
            {repoHeader(ROOT_REPO_ID, tree.rootRepo.label)}
            {state.reposExpanded.includes(ROOT_REPO_ID) && groups !== null ? (
              <div className="git-children">
                {groups.changes.count > 0 ? renderGroup(groups.changes, 'section.changes') : null}
                {groups.unversioned.count > 0 ? renderGroup(groups.unversioned, 'section.unversioned') : null}
                {groups.changes.count === 0 && groups.unversioned.count === 0 ? <div className="git-empty">{t('state.noChanges')}</div> : null}
              </div>
            ) : null}
          </div>
        ) : null}

        {tree !== null && tree.configured ? (
          <div>
            <div className="git-sectionLabel">{t('section.workspaces')}</div>
            {tree.workspaces.map(workspace => {
              const wsOpen = state.workspacesExpanded.includes(workspace.name)
              return (
                <div key={workspace.name}>
                  <div className="git-row">
                    <Tooltip label={t('section.twisty.tip')} delayMs={500} portal>
                      <button type="button" className="git-twisty" onClick={() => { store.actions.toggleWorkspace(workspace.name) }}>
                        <span className="git-twistyGlyph" data-open={wsOpen}>{wsOpen ? '▾' : '▸'}</span>
                      </button>
                    </Tooltip>
                    <FileTypeIcon kind="folder" size={14} />
                    <span className="git-label git-dim">{workspace.name}</span>
                  </div>
                  {wsOpen ? workspace.domains.map(domain => {
                    const domainKey = `${workspace.name}/${domain.name}`
                    const domainOpen = state.domainsExpanded.includes(domainKey)
                    return (
                      <div key={domainKey}>
                        <div className="git-row" style={{ paddingLeft: '18px' }}>
                          <Tooltip label={t('section.twisty.tip')} delayMs={500} portal>
                            <button type="button" className="git-twisty" onClick={() => { store.actions.toggleDomain(domainKey) }}>
                              <span className="git-twistyGlyph" data-open={domainOpen}>{domainOpen ? '▾' : '▸'}</span>
                            </button>
                          </Tooltip>
                          <span className="git-label git-dim">{domain.name}</span>
                        </div>
                        {domainOpen ? domain.repos.map(repo => {
                          const active = state.activeRepoId === repo.id && state.reposExpanded.includes(repo.id)
                          return (
                            <div key={repo.id}>
                              <div style={{ paddingLeft: '26px' }}>{repoHeader(repo.id, repo.label)}</div>
                              {active && groups !== null ? (
                                <div className="git-children">
                                  {groups.changes.count > 0 ? renderGroup(groups.changes, 'section.changes') : null}
                                  {groups.unversioned.count > 0 ? renderGroup(groups.unversioned, 'section.unversioned') : null}
                                  {groups.changes.count === 0 && groups.unversioned.count === 0 ? <div className="git-empty">{t('state.noChanges')}</div> : null}
                                </div>
                              ) : null}
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
          <Tooltip label={t('commit.amend.tip')} delayMs={500} portal>
            <span className="git-tipAnchor">
              <Checkbox
                checked={state.amend}
                label={t('commit.amend')}
                onChange={next => { store.actions.setAmend(next) }}
              />
            </span>
          </Tooltip>
          {status !== null && status.headOid !== null ? (
            <span className="git-dim git-mono">{t('commit.amendLast')} {status.headShortSha}</span>
          ) : null}
          {state.amend && status !== null && status.headPublished ? <span className="git-warn">{t('commit.amendPublished')}</span> : null}
        </div>
        <Tooltip label={t('commit.message.tip')} delayMs={500} portal>
          <textarea
            className="git-message"
            value={state.message}
            placeholder={t('commit.messagePlaceholder')}
            aria-label={t('commit.message')}
            onChange={event => { store.actions.setMessage(event.target.value) }}
          />
        </Tooltip>
        <div className="git-actions">
          <ActionButton
            variant="outline"
            tip={t('commit.generate.tip')}
            disabledTip={t('commit.generate.disabled.tip')}
            disabled={state.aiBusy || selectedCount === 0}
            label={state.aiBusy ? t('commit.generating') : t('commit.generate')}
            onClick={() => { void store.actions.generateMessage(sessionId) }}
          />
          {state.aiRoute !== null ? (
            <span className="git-route">{t('commit.aiRoute', { provider: state.aiRoute.split('/')[0] ?? '', model: state.aiRoute.split('/')[1] ?? '' })}</span>
          ) : null}
        </div>
        <div className="git-actions">
          <ActionButton
            variant="primary"
            tip={t('commit.button.tip')}
            disabledTip={t('commit.button.disabled.tip')}
            disabled={selectedCount === 0 || busy || (state.message.trim() === '' && !state.amend)}
            label={state.busy === 'commit' ? t('commit.busy') : t('commit.button')}
            onClick={() => { store.actions.requestCommit(false) }}
          />
          <ActionButton
            variant="outline"
            tip={t('commit.pushButton.tip')}
            disabledTip={t('commit.button.disabled.tip')}
            disabled={selectedCount === 0 || busy || (state.message.trim() === '' && !state.amend)}
            label={t('commit.pushButton')}
            onClick={() => { store.actions.requestCommit(true) }}
          />
          {status !== null && status.ahead > 0 ? (
            // The commit already exists, so this stays available with nothing
            // ticked: it publishes what the branch is ahead by, through the same
            // confirmation every other write uses.
            <ActionButton
              variant="outline"
              tip={t('commit.pushRetry.tip')}
              disabledTip={t('toolbar.busy.tip')}
              disabled={busy}
              label={state.busy === 'sync' ? t('toolbar.busy.tip') : t('commit.pushRetry')}
              onClick={() => { store.actions.requestPush() }}
            />
          ) : null}
        </div>
      </div>

      <div className="git-activity" data-open={state.activityOpen}>
        <div className="git-activityHead">
          <Tooltip label={t('activity.toggle.tip')} delayMs={500} portal>
            <button type="button" className="git-twisty" aria-expanded={state.activityOpen} onClick={() => { store.actions.toggleActivity() }}>
              <span className="git-twistyGlyph" data-open={state.activityOpen}>{state.activityOpen ? '▾' : '▸'}</span>
            </button>
          </Tooltip>
          <span className="git-label git-groupLabel">{t('activity.title')}</span>
          <span className="git-count">{t('activity.count', { count: state.activity.length })}</span>
          <span className="git-grow" />
          <ActionButton tip={t('activity.refresh.tip')} label={t('activity.refresh')} onClick={() => { void store.actions.refreshActivity() }} />
          <ActionButton
            tip={t('activity.clear.tip')}
            disabledTip={t('activity.empty')}
            disabled={state.activity.length === 0}
            label={t('activity.clear')}
            onClick={() => { void store.actions.clearActivity() }}
          />
        </div>
        {state.activityOpen ? (
          <div
            className="git-activityBody"
            role="log"
            ref={logRef}
            onScroll={event => {
              const element = event.currentTarget
              element.dataset['atBottom'] = element.scrollHeight - element.scrollTop - element.clientHeight > 8 ? 'false' : 'true'
            }}
          >
            {state.activity.length === 0
              ? <div className="git-activityEmpty">{t('activity.empty')}</div>
              : state.activity.map(entry => (
                <ActivityRow
                  key={entry.id}
                  entry={entry}
                  open={state.activityDetail.includes(entry.id)}
                  t={t}
                  onToggle={() => { store.actions.toggleActivityDetail(entry.id) }}
                />
              ))}
          </div>
        ) : null}
      </div>

      <ConfirmDialog store={store} origin="commit" t={t} />
      <IntegrateDialog store={store} t={t} />
    </div>
  )
}
