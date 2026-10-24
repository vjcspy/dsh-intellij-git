/**
 * The Commit tool window's state and actions.
 *
 * One instance is created in `apply` and handed to both registrations, so the
 * Commit tree and the Diff viewer read and write the same inclusion map. The
 * class holds no React: components subscribe with `useSyncExternalStore`, which
 * keeps the view layer free to re-render however it likes.
 *
 * Two invariants live here rather than in the components:
 *
 * 1. **Single-Active-Repo Accordion.** At most one repository is expanded and
 *    therefore at most one repository has a loaded status; expanding another
 *    collapses the previous one and drops its status. That is what bounds every
 *    refresh to one `git status`.
 * 2. **Inclusion is client state.** Ticking a box never calls the host. The
 *    whole selection is materialised once, at Commit time, which is why
 *    untracked files never jump between groups while the Human is ticking.
 */
import {
  ROOT_REPO_ID,
  type CommitResponse,
  type FileChangeEntry,
  type FileDiffResponse,
  type FileInclusion,
  type GenerateMessageResponse,
  type RepoStatusResponse,
  type WorkspaceTreeResponse,
} from '../config.ts'
import { ApiError, api } from './api.ts'
import { buildGroups, filesOf, type CheckState, type FileNode, type GroupNode } from './tree-builder.ts'
import type { DshIntellijGitKey } from './locale.ts'

/** A translated message the view renders once. */
export interface Banner {
  readonly kind: 'error' | 'notice'
  readonly key: DshIntellijGitKey
  readonly params?: Record<string, unknown>
}

/** The file the diff viewer is showing. */
export interface SelectedFile {
  readonly repoId: string
  readonly path: string
  readonly origPath: string | null
  readonly status: FileChangeEntry['status'] | 'U'
}

/** Everything the two tabs render from. */
export interface IntellijGitState {
  readonly tree: WorkspaceTreeResponse | null
  readonly treeLoading: boolean
  readonly treeError: string | null
  readonly activeRepoId: string | null
  readonly reposExpanded: readonly string[]
  readonly workspacesExpanded: readonly string[]
  readonly domainsExpanded: readonly string[]
  readonly status: RepoStatusResponse | null
  readonly statusLoading: boolean
  readonly statusError: string | null
  readonly inclusions: Readonly<Record<string, Readonly<Record<string, FileInclusion>>>>
  readonly selected: SelectedFile | null
  readonly diff: FileDiffResponse | null
  readonly diffLoading: boolean
  readonly diffError: string | null
  readonly viewMode: 'split' | 'unified'
  readonly collapseUnchanged: boolean
  readonly compactFolders: boolean
  readonly amend: boolean
  readonly message: string
  readonly aiBusy: boolean
  readonly aiRoute: string | null
  readonly busy: 'commit' | 'rollback' | null
  readonly banner: Banner | null
}

/** Everything the store can do. */
export interface IntellijGitActions {
  refreshTree(): Promise<void>
  toggleRepo(repoId: string): Promise<void>
  toggleWorkspace(name: string): void
  toggleDomain(key: string): void
  refreshStatus(): Promise<void>
  openFile(sessionId: string | undefined, file: SelectedFile): Promise<void>
  refreshDiff(): Promise<void>
  setViewMode(mode: 'split' | 'unified'): void
  toggleCollapse(): void
  toggleCompact(): void
  toggleGroup(group: GroupNode): void
  toggleNode(node: FileNode | GroupNode | { type: 'dir', children: readonly unknown[] }): void
  toggleFile(file: FileNode): void
  toggleCurrentVersion(): void
  toggleHunk(contentKey: string): void
  revertHunk(contentKey: string): Promise<void>
  setAmend(value: boolean): void
  setMessage(value: string): void
  generateMessage(sessionId: string | undefined): Promise<void>
  commit(push: boolean): Promise<void>
  rollback(): Promise<void>
  dismissBanner(): void
}

/** Handle the store exposes to the view layer. */
export interface IntellijGitStore {
  readonly getSnapshot: () => IntellijGitState
  readonly subscribe: (listener: () => void) => () => void
  readonly actions: IntellijGitActions
}

/** What the store needs from the plugin body. */
export interface StoreOptions {
  /** Open or focus the diff tab for the Session on screen. */
  readonly openDiffTab: (sessionId: string | undefined) => void
}

/**
 * Create the Commit tool window store.
 * @param options - the diff-tab callback owned by `apply`.
 * @returns the store handle.
 */
export function createIntellijGitStore(options: StoreOptions): IntellijGitStore {
  let state: IntellijGitState = {
    tree: null,
    treeLoading: false,
    treeError: null,
    activeRepoId: null,
    reposExpanded: [],
    workspacesExpanded: [],
    domainsExpanded: [],
    status: null,
    statusLoading: false,
    statusError: null,
    inclusions: {},
    selected: null,
    diff: null,
    diffLoading: false,
    diffError: null,
    viewMode: 'split',
    collapseUnchanged: true,
    compactFolders: true,
    amend: false,
    message: '',
    aiBusy: false,
    aiRoute: null,
    busy: null,
    banner: null,
  }
  const listeners = new Set<() => void>()

  /**
   * Publish a state patch.
   * @param patch - the changed fields.
   */
  const set = (patch: Partial<IntellijGitState>): void => {
    state = { ...state, ...patch }
    for (const listener of listeners) listener()
  }

  /**
   * Turn a thrown error into a banner key while keeping the message readable.
   * @param error - the failure.
   * @param key - fallback dictionary key.
   */
  const failBanner = (error: unknown, key: DshIntellijGitKey): void => {
    const detail = error instanceof ApiError ? error.message : error instanceof Error ? error.message : String(error)
    set({ banner: { kind: 'error', key, params: { reason: detail } }, busy: null, statusLoading: false, diffLoading: false, aiBusy: false })
  }

  /**
   * The inclusion map of one repository.
   * @param repoId - repository id.
   * @returns the map, never undefined.
   */
  const inclusionsOf = (repoId: string): Readonly<Record<string, FileInclusion>> => state.inclusions[repoId] ?? {}

  /**
   * Replace one repository's inclusion map.
   * @param repoId - repository id.
   * @param next - the new map.
   */
  const setInclusions = (repoId: string, next: Readonly<Record<string, FileInclusion>>): void => {
    set({ inclusions: { ...state.inclusions, [repoId]: next } })
  }

  /**
   * Seed an inclusion for every path the status reports, defaulting to fully included.
   *
   * IntelliJ starts a changelist fully checked; defaulting to `all` is also what
   * makes `Commit` do the obvious thing without fifty clicks.
   * @param repoId - repository id.
   * @param status - the fresh status.
   * @returns the seeded map.
   */
  const seedInclusions = (repoId: string, status: RepoStatusResponse): Readonly<Record<string, FileInclusion>> => {
    const previous = inclusionsOf(repoId)
    const next: Record<string, FileInclusion> = {}
    const paths = [...status.changes.map(entry => entry.path), ...status.unversioned]
    for (const path of paths) next[path] = previous[path] ?? { mode: 'all' }
    return next
  }

  /**
   * Apply the same inclusion to every file under a node or group.
   * @param files - the target files.
   * @param mode - the value to write.
   */
  const applyToFiles = (files: readonly FileNode[], mode: CheckState): void => {
    const repoId = state.activeRepoId
    if (repoId === null) return
    const current = { ...inclusionsOf(repoId) }
    const value: FileInclusion = mode === 'checked' ? { mode: 'all' } : { mode: 'none' }
    for (const file of files) current[file.path] = value
    setInclusions(repoId, current)
  }

  /**
   * Load the selected repository's status.
   */
  const refreshStatus: IntellijGitActions['refreshStatus'] = async () => {
    const repoId = state.activeRepoId
    if (repoId === null) return
    set({ statusLoading: true, statusError: null })
    try {
      const status = await api.status(repoId)
      set({ status, statusLoading: false, inclusions: { ...state.inclusions, [repoId]: seedInclusions(repoId, status) } })
    } catch (error) {
      set({ statusLoading: false, statusError: error instanceof Error ? error.message : String(error) })
    }
  }

  /**
   * Load one file's diff and reveal it.
   */
  const loadDiff = async (file: SelectedFile): Promise<FileDiffResponse> => {
    set({ diffLoading: true, diffError: null })
    try {
      const diff = await api.diff({
        repoId: file.repoId,
        path: file.path,
        ...(file.origPath === null ? {} : { origPath: file.origPath }),
        status: file.status,
      })
      set({ diff, diffLoading: false, selected: file })
      return diff
    } catch (error) {
      set({ diffLoading: false, diffError: error instanceof Error ? error.message : String(error) })
      throw error
    }
  }

  const actions: IntellijGitActions = {
    async refreshTree() {
      set({ treeLoading: true, treeError: null })
      try {
        const tree = await api.tree()
        set({ tree, treeLoading: false })
        if (tree.configured && tree.rootRepo !== null && state.activeRepoId === null) {
          set({ activeRepoId: ROOT_REPO_ID, reposExpanded: [ROOT_REPO_ID] })
          await refreshStatus()
        }
      } catch (error) {
        set({ treeLoading: false, treeError: error instanceof Error ? error.message : String(error) })
      }
    },

    async toggleRepo(repoId) {
      if (state.activeRepoId === repoId && state.reposExpanded.includes(repoId)) {
        set({ reposExpanded: [], status: null, selected: null, diff: null })
        return
      }
      // Single-Active-Repo Accordion: the previous repository collapses with its status.
      set({ activeRepoId: repoId, reposExpanded: [repoId], status: null, statusError: null, selected: null, diff: null, diffError: null, amend: false, message: '' })
      await refreshStatus()
    },

    toggleWorkspace(name) {
      const open = state.workspacesExpanded.includes(name)
      set({ workspacesExpanded: open ? state.workspacesExpanded.filter(item => item !== name) : [...state.workspacesExpanded, name] })
    },

    toggleDomain(key) {
      const open = state.domainsExpanded.includes(key)
      set({ domainsExpanded: open ? state.domainsExpanded.filter(item => item !== key) : [...state.domainsExpanded, key] })
    },

    refreshStatus,

    async openFile(sessionId, file) {
      set({ selected: file })
      options.openDiffTab(sessionId)
      try {
        await loadDiff(file)
      } catch {
        // The diff view renders `diffError`; nothing else to do here.
      }
    },

    async refreshDiff() {
      const selected = state.selected
      if (selected === null) return
      try {
        await loadDiff(selected)
      } catch {
        // Surfaced through `diffError`.
      }
    },

    setViewMode(mode) {
      set({ viewMode: mode })
    },

    toggleCollapse() {
      set({ collapseUnchanged: !state.collapseUnchanged })
    },

    toggleCompact() {
      set({ compactFolders: !state.compactFolders })
    },

    toggleGroup(group) {
      applyToFiles(filesOf(group), group.check === 'checked' ? 'unchecked' : 'checked')
    },

    toggleNode(node) {
      const files = filesOf(node as GroupNode)
      const checked = files.every(file => file.check === 'checked')
      applyToFiles(files, checked ? 'unchecked' : 'checked')
    },

    toggleFile(file) {
      applyToFiles([file], file.check === 'checked' ? 'unchecked' : 'checked')
    },

    toggleCurrentVersion() {
      const selected = state.selected
      const diff = state.diff
      if (selected === null || diff === null) return
      const repoId = selected.repoId
      const current = { ...inclusionsOf(repoId) }
      const existing = current[selected.path]
      const allIncluded = existing !== undefined && existing.mode === 'all'
      current[selected.path] = allIncluded
        ? { mode: 'none' }
        : { mode: 'partial', hunkKeys: diff.hunks.map(hunk => hunk.contentKey) }
      setInclusions(repoId, current)
    },

    toggleHunk(contentKey) {
      const selected = state.selected
      const diff = state.diff
      if (selected === null || diff === null) return
      const repoId = selected.repoId
      const current = { ...inclusionsOf(repoId) }
      const existing = current[selected.path]
      const included = existing === undefined
        ? new Set(diff.hunks.map(hunk => hunk.contentKey))
        : existing.mode === 'all'
          ? new Set(diff.hunks.map(hunk => hunk.contentKey))
          : existing.mode === 'none'
            ? new Set<string>()
            : new Set(existing.hunkKeys)
      if (included.has(contentKey)) included.delete(contentKey)
      else included.add(contentKey)
      // All hunks selected collapses back to `all`, which keeps the box's meaning obvious.
      current[selected.path] = included.size === diff.hunks.length
        ? { mode: 'all' }
        : included.size === 0
          ? { mode: 'none' }
          : { mode: 'partial', hunkKeys: [...included] }
      setInclusions(repoId, current)
    },

    async revertHunk(contentKey) {
      const selected = state.selected
      const status = state.status
      const repoId = state.activeRepoId
      if (selected === null || status === null || repoId === null) return
      try {
        await api.rollback({
          repoId,
          expectedHeadOid: status.headOid,
          confirmDeletePaths: true,
          files: [{
            path: selected.path,
            ...(selected.origPath === null ? {} : { origPath: selected.origPath }),
            status: selected.status,
            partial: true,
            hunkKeys: [contentKey],
          }],
        })
        await refreshStatus()
        await loadDiff(selected)
      } catch (error) {
        failBanner(error, 'diff.deleteHunk')
      }
    },

    setAmend(value) {
      set({ amend: value })
    },

    setMessage(value) {
      set({ message: value })
    },

    async generateMessage(sessionId) {
      const repoId = state.activeRepoId
      if (repoId === null) return
      set({ aiBusy: true, banner: null })
      try {
        const response: GenerateMessageResponse = await api.generateMessage({
          repoId,
          files: selectedInclusions(state, repoId),
          ...(sessionId === undefined ? {} : { sessionId }),
        })
        set({ message: response.message, aiRoute: `${response.route.provider}/${response.route.model}`, aiBusy: false })
      } catch (error) {
        failBanner(error, 'commit.generate')
      }
    },

    async commit(push) {
      const repoId = state.activeRepoId
      const status = state.status
      if (repoId === null || status === null) return
      set({ busy: 'commit', banner: null })
      try {
        const response: CommitResponse = await api.commit({
          repoId,
          expectedHeadOid: status.headOid,
          message: state.message,
          amend: state.amend,
          files: selectedInclusions(state, repoId),
          push,
        })
        await refreshStatus()
        if (response.headMovedDuringCommit) {
          set({ busy: null, banner: { kind: 'error', key: 'commit.headMoved' } })
          return
        }
        const sha = (response.commitSha ?? '').slice(0, 7)
        if (!response.indexSynced) {
          set({ busy: null, banner: { kind: 'error', key: 'commit.indexWarning', params: { reason: response.indexSyncError ?? '' } } })
          return
        }
        if (push && !response.pushed) {
          const key: DshIntellijGitKey = response.pushErrorCode === 'NO_PUSH_TARGET' ? 'commit.pushNoTarget' : 'commit.pushFailed'
          set({ busy: null, banner: { kind: 'error', key, params: { sha, hint: response.pushError ?? '', reason: response.pushError ?? '' } } })
          return
        }
        set({ busy: null, message: '', amend: false, banner: { kind: 'notice', key: response.pushed ? 'commit.pushed' : 'commit.done', params: { sha } } })
      } catch (error) {
        failBanner(error, 'commit.button')
      }
    },

    async rollback() {
      const repoId = state.activeRepoId
      const status = state.status
      if (repoId === null || status === null) return
      set({ busy: 'rollback', banner: null })
      try {
        const files = selectedInclusions(state, repoId)
        const response = await api.rollback({ repoId, expectedHeadOid: status.headOid, files, confirmDeletePaths: true })
        await refreshStatus()
        set({ busy: null, diff: null, selected: null, banner: { kind: 'notice', key: 'rollback.done', params: { count: response.rolledBack.length } } })
      } catch (error) {
        failBanner(error, 'rollback.title')
      }
    },

    dismissBanner() {
      set({ banner: null })
    },
  }

  return {
    getSnapshot: () => state,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    actions,
  }
}

/**
 * The inclusion set a commit or message request should carry.
 * @param state - current state.
 * @param repoId - active repository.
 * @returns the requested inclusions.
 */
export function selectedInclusions(state: IntellijGitState, repoId: string): {
  path: string,
  origPath?: string,
  status: FileChangeEntry['status'] | 'U',
  partial: boolean,
  hunkKeys?: string[],
}[] {
  const status = state.status
  if (status === null) return []
  const inclusions = state.inclusions[repoId] ?? {}
  const entries: { path: string, origPath?: string, status: FileChangeEntry['status'] | 'U' }[] = [
    ...status.changes.map(change => ({ path: change.path, ...(change.origPath === undefined ? {} : { origPath: change.origPath }), status: change.status })),
    ...status.unversioned.map(path => ({ path, status: 'U' as const })),
  ]
  const result: ReturnType<typeof selectedInclusions> = []
  for (const entry of entries) {
    const inclusion = inclusions[entry.path]
    if (inclusion === undefined || inclusion.mode === 'none') continue
    if (inclusion.mode === 'all') {
      result.push({ ...entry, partial: false })
      continue
    }
    if (inclusion.hunkKeys.length === 0) continue
    result.push({ ...entry, partial: true, hunkKeys: [...inclusion.hunkKeys] })
  }
  return result
}

/**
 * Build the two groups the Commit tree renders.
 * @param state - current state.
 * @returns the groups, or null while no status is loaded.
 */
export function groupsOf(state: IntellijGitState, repoId: string): { changes: GroupNode, unversioned: GroupNode } | null {
  const status = state.status
  if (status === null) return null
  return buildGroups(status.changes, status.unversioned, state.inclusions[repoId] ?? {}, state.compactFolders)
}
