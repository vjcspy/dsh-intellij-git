/**
 * The Commit tool window: repository accordion, change tree and commit box.
 *
 * Rows carry no state of their own. Every checkbox is derived from the file's
 * inclusion in the store, so the section header, a folder and the diff
 * sub-header can never disagree.
 */
import { useSyncExternalStore, useEffect, useRef, type ReactNode } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'

import { ROOT_REPO_ID } from '../config.ts'
import type { DshIntellijGitKey } from './locale.ts'
import { groupsOf, selectedInclusions, type IntellijGitStore } from './store.ts'
import type { CheckState, DirNode, FileNode, GroupNode } from './tree-builder.ts'

/** Props the renderer hands this body plus the store its inject face supplies. */
export type CommitTabProps = PropsRuntime<'sidebar.right.pane.tab'> & PropsLocale<'dshIntellijGit'> & { store: IntellijGitStore }

/**
 * A checkbox that can also render the indeterminate state.
 * @param props - state, label and change handler.
 * @returns the input element.
 */
function TriCheckbox(props: { state: CheckState, label: string, onChange: () => void, disabled?: boolean }): ReactNode {
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (ref.current !== null) ref.current.indeterminate = props.state === 'indeterminate'
  }, [props.state])
  return (
    <input
      ref={ref}
      type="checkbox"
      checked={props.state === 'checked'}
      disabled={props.disabled === true}
      onChange={props.onChange}
      aria-label={props.label}
    />
  )
}

/**
 * The Commit tool window body.
 * @param props - runtime + locale seats and the shared store.
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

  const renderNode = (node: FileNode | DirNode, depth: number): ReactNode => {
    if (node.type === 'file') {
      const selected = state.selected?.path === node.path
      return (
        <div
          key={`f:${node.path}`}
          className="git-row"
          data-selected={selected}
          style={{ paddingLeft: `${8 + depth * 12}px` }}
        >
          <TriCheckbox
            state={node.check}
            label={node.name}
            onChange={() => { store.actions.toggleFile(node) }}
          />
          <button
            type="button"
            className="git-label git-mono"
            style={{ background: 'none', border: 0, padding: 0, textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis' }}
            onClick={() => { void store.actions.openFile(sessionId, { repoId: repoId ?? ROOT_REPO_ID, path: node.path, origPath: node.origPath, status: node.status }) }}
          >
            {node.name}
          </button>
          <span className="git-badge" data-kind={node.status}>{node.status === 'U' ? '?' : node.status}</span>
        </div>
      )
    }
    const expanded = state.domainsExpanded.includes(`node:${node.key}`)
    return (
      <div key={`d:${node.key}`}>
        <div className="git-row" style={{ paddingLeft: `${4 + depth * 12}px` }}>
          <button type="button" className="git-twisty" onClick={() => { store.actions.toggleDomain(`node:${node.key}`) }}>
            {expanded ? '▾' : '▸'}
          </button>
          <TriCheckbox
            state={node.check}
            label={node.name}
            onChange={() => { store.actions.toggleNode(node) }}
          />
          <span className="git-label git-mono">{node.name}</span>
          <span className="git-count">{node.count}</span>
        </div>
        {expanded ? node.children.map(child => renderNode(child, depth + 1)) : null}
      </div>
    )
  }

  const renderGroup = (group: GroupNode, labelKey: DshIntellijGitKey): ReactNode => (
    <div key={group.key}>
      <div className="git-row" style={{ paddingLeft: '4px' }}>
        <TriCheckbox
          state={group.check}
          label={t(labelKey)}
          onChange={() => { store.actions.toggleGroup(group) }}
        />
        <span className="git-label">{t(labelKey)}</span>
        <span className="git-count">{group.count === 1 ? t('section.file', {}) : t('section.files', { count: group.count })}</span>
      </div>
      {group.children.map(child => renderNode(child, 1))}
    </div>
  )

  const banner = state.banner === null ? null : (
    <div className="git-banner" data-kind={state.banner.kind}>
      {t(state.banner.key, state.banner.params ?? {})}
      {' '}
      <button type="button" style={{ background: 'none', border: 0, textDecoration: 'underline' }} onClick={() => { store.actions.dismissBanner() }}>×</button>
    </div>
  )

  return (
    <div data-dsh-git="commit">
      <div className="git-toolbar">
        <button type="button" onClick={() => { void store.actions.refreshTree() }} title={t('toolbar.refresh')}>⟳</button>
        <button
          type="button"
          disabled={selectedCount === 0 || state.busy !== null}
          onClick={() => { void store.actions.rollback() }}
          title={t('toolbar.rollback')}
        >
          ↺
        </button>
        <button type="button" onClick={() => { store.actions.toggleCompact() }} title={t('toolbar.compact')} data-on={state.compactFolders}>⊟</button>
        <span className="git-grow" />
        {state.statusLoading ? <span className="git-dim">{t('state.loading')}</span> : null}
      </div>
      {banner}

      <div className="git-tree">
        {state.treeLoading && tree === null ? <div className="git-empty">{t('state.loading')}</div> : null}
        {state.treeError !== null ? <div className="git-empty">{state.treeError}</div> : null}
        {tree !== null && !tree.configured ? (
          <div className="git-empty">
            <div>{t('state.noRoot')}</div>
            <div style={{ marginTop: 6 }}>{t('state.noRootHint')}</div>
          </div>
        ) : null}

        {tree !== null && tree.configured && tree.rootRepo !== null ? (
          <div>
            <div className="git-section-label">{t('section.root')}</div>
            <div className="git-row" style={{ paddingLeft: '4px' }}>
              <button type="button" className="git-twisty" onClick={() => { void store.actions.toggleRepo(ROOT_REPO_ID) }}>
                {state.reposExpanded.includes(ROOT_REPO_ID) ? '▾' : '▸'}
              </button>
              <span className="git-label git-repo">{tree.rootRepo.label}</span>
              {status !== null && repoId === ROOT_REPO_ID ? (
                <span className="git-branch">
                  <span>{status.branch}</span>
                  {status.ahead > 0 ? <span>↑{status.ahead}</span> : null}
                  {status.behind > 0 ? <span>↓{status.behind}</span> : null}
                </span>
              ) : null}
            </div>
            {state.reposExpanded.includes(ROOT_REPO_ID) && groups !== null ? (
              <div style={{ paddingLeft: '8px' }}>
                {groups.changes.count > 0 ? renderGroup(groups.changes, 'section.changes') : null}
                {groups.unversioned.count > 0 ? renderGroup(groups.unversioned, 'section.unversioned') : null}
                {groups.changes.count === 0 && groups.unversioned.count === 0 ? <div className="git-empty">{t('state.noChanges')}</div> : null}
              </div>
            ) : null}
          </div>
        ) : null}

        {tree !== null && tree.configured ? (
          <div>
            <div className="git-section-label">{t('section.workspaces')}</div>
            {tree.workspaces.map(workspace => {
              const wsOpen = state.workspacesExpanded.includes(workspace.name)
              return (
                <div key={workspace.name}>
                  <div className="git-row" style={{ paddingLeft: '4px' }}>
                    <button type="button" className="git-twisty" onClick={() => { store.actions.toggleWorkspace(workspace.name) }}>
                      {wsOpen ? '▾' : '▸'}
                    </button>
                    <span className="git-label git-dim">{workspace.name}</span>
                  </div>
                  {wsOpen ? workspace.domains.map(domain => {
                    const domainKey = `${workspace.name}/${domain.name}`
                    const domainOpen = state.domainsExpanded.includes(domainKey)
                    return (
                      <div key={domainKey}>
                        <div className="git-row" style={{ paddingLeft: '16px' }}>
                          <button type="button" className="git-twisty" onClick={() => { store.actions.toggleDomain(domainKey) }}>
                            {domainOpen ? '▾' : '▸'}
                          </button>
                          <span className="git-label git-dim">{domain.name}</span>
                        </div>
                        {domainOpen ? domain.repos.map(repo => {
                          const active = state.activeRepoId === repo.id && state.reposExpanded.includes(repo.id)
                          return (
                            <div key={repo.id}>
                              <div className="git-row" style={{ paddingLeft: '28px' }}>
                                <button type="button" className="git-twisty" onClick={() => { void store.actions.toggleRepo(repo.id) }}>
                                  {active ? '▾' : '▸'}
                                </button>
                                <span className={active ? 'git-label git-repo' : 'git-label'}>{repo.label}</span>
                                {active && status !== null ? (
                                  <span className="git-branch">
                                    <span>{status.branch}</span>
                                    {status.ahead > 0 ? <span>↑{status.ahead}</span> : null}
                                    {status.behind > 0 ? <span>↓{status.behind}</span> : null}
                                  </span>
                                ) : null}
                              </div>
                              {active && groups !== null ? (
                                <div style={{ paddingLeft: '32px' }}>
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
        <label className="git-amend">
          <input
            type="checkbox"
            checked={state.amend}
            onChange={event => { store.actions.setAmend(event.target.checked) }}
          />
          <span>{t('commit.amend')}</span>
          {status !== null && status.headOid !== null ? <span className="git-dim git-mono">{t('commit.amendLast')} {status.headShortSha}</span> : null}
          {state.amend && status !== null && status.headPublished ? <span className="git-warn">{t('commit.amendPublished')}</span> : null}
        </label>
        <textarea
          className="git-message"
          value={state.message}
          placeholder={t('commit.messagePlaceholder')}
          aria-label={t('commit.message')}
          onChange={event => { store.actions.setMessage(event.target.value) }}
        />
        <div className="git-actions">
          <button type="button" className="git-secondary" disabled={state.aiBusy || selectedCount === 0} onClick={() => { void store.actions.generateMessage(sessionId) }}>
            {state.aiBusy ? t('commit.generating') : t('commit.generate')}
          </button>
          {state.aiRoute !== null ? <span className="git-route">{t('commit.aiRoute', { provider: state.aiRoute.split('/')[0] ?? '', model: state.aiRoute.split('/')[1] ?? '' })}</span> : null}
        </div>
        <div className="git-actions">
          <button
            type="button"
            className="git-primary"
            disabled={selectedCount === 0 || state.busy !== null || (state.message.trim() === '' && !state.amend)}
            onClick={() => { void store.actions.commit(false) }}
          >
            {state.busy === 'commit' ? t('commit.busy') : t('commit.button')}
          </button>
          <button
            type="button"
            className="git-secondary"
            disabled={selectedCount === 0 || state.busy !== null || (state.message.trim() === '' && !state.amend)}
            onClick={() => { void store.actions.commit(true) }}
          >
            {t('commit.pushButton')}
          </button>
        </div>
      </div>
    </div>
  )
}
