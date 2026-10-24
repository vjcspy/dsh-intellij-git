/**
 * The Commit tool window's state and actions.
 *
 * One instance is created in `apply` and handed to both registrations, so the
 * Commit tree and the Diff viewer read and write the same inclusion map. The
 * class holds no React: components subscribe with `useSyncExternalStore`.
 *
 * Three invariants live here rather than in the components:
 *
 * 1. **Single-Active-Repo Accordion.** At most one repository is expanded and
 *    therefore at most one repository has a loaded status; expanding another
 *    collapses the previous one and drops its status. That bounds every refresh
 *    to one `git status`.
 * 2. **Inclusion is client state.** Ticking a box never calls the host.
 * 3. **Nothing writes without a confirmation.** Commit, rollback and hunk revert
 *    only set `pending`; the effect runs from `confirmPending()`. A control that
 *    only reads state never sets it.
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
import { buildGroups, filesOf, type DirNode, type GroupNode, type FileNode } from './tree-builder.ts'
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

/** The write the Human has been asked to confirm, and the pane that asked. */
export type PendingAction =
  | { readonly kind: 'commit', readonly origin: 'commit', readonly push: boolean }
  | { readonly kind: 'rollback', readonly origin: 'commit' }
  | { readonly kind: 'revertHunk', readonly origin: 'diff', readonly contentKey: string, readonly path: string }

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
  readonly busy: 'commit' | 'rollback' | 'revertHunk' | null
  readonly pending: PendingAction | null
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
  toggleNode(node: FileNode | DirNode | GroupNode): void
  toggleFile(file: FileNode): void
  toggleCurrentVersion(): void
  toggleHunk(contentKey: string): void
  setAmend(value: boolean): void
  setMessage(value: string): void
  generateMessage(sessionId: string | undefined): Promise<void>
  /** Ask to commit; the write happens in `confirmPending`. */
  requestCommit(push: boolean): void
  /** Ask to roll back the ticked changes. */
  requestRollback(): void
  /** Ask to revert one hunk. */
  requestRevertHunk(contentKey: string, path: string): void
  /** Run the pending write. */
  confirmPending(): Promise<void>
  /** Drop the pending write without running it. */
  cancelPending(): void
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
 * Whether reverting this entry deletes the file from disk.
 *
 * Mirrors the host's own predicate, so the dialog can never say "nothing is
 * deleted" while a file disappears: `U` and `A` have no committed content, so any
 * revert of them is a delete; `R` is a delete only whole-file, because a partial
 * `R` is reversed as an edit and its file survives.
 * @param status - the change status.
 * @param partial - whether only some hunks are selected.
 * @returns true when the path is removed.
 */
export function willDeleteEntry(status: FileChangeEntry['status'] | 'U', partial: boolean): boolean {
  return status === 'U' || status === 'A' || (status === 'R' && !partial)
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
    pending: null,
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
   * Turn a thrown error into a banner.
   * @param error - the failure.
   * @param key - fallback dictionary key.
   */
  const failBanner = (error: unknown, key: DshIntellijGitKey): void => {
    const detail = error instanceof ApiError ? error.message : error instanceof Error ? error.message : String(error)
    set({ banner: { kind: 'error', key, params: { reason: detail } }, busy: null, pending: null, statusLoading: false, diffLoading: false, aiBusy: false })
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
   * Seed an inclusion for every path the status reports, defaulting to included.
   *
   * IntelliJ starts a changelist fully checked; that is also what makes Commit do
   * the obvious thing without fifty clicks.
   * @param repoId - repository id.
   * @param status - the fresh status.
   * @returns the seeded map.
   */
  const seedInclusions = (repoId: string, status: RepoStatusResponse): Readonly<Record<string, FileInclusion>> => {
    const previous = inclusionsOf(repoId)
    const next: Record<string, FileInclusion> = {}
    for (const path of [...status.changes.map(entry => entry.path), ...status.unversioned]) {
      next[path] = previous[path] ?? { mode: 'all' }
    }
    return next
  }

  /**
   * Apply one inclusion value to every file under a node or group.
   * @param files - the target files.
   * @param checked - the value to write.
   */
  const applyToFiles = (files: readonly FileNode[], checked: boolean): void => {
    const repoId = state.activeRepoId
    if (repoId === null) return
    const current = { ...inclusionsOf(repoId) }
    const value: FileInclusion = checked ? { mode: 'all' } : { mode: 'none' }
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
   * @param file - the file to show.
   * @returns the diff.
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
        // Surfaced through `diffError`.
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
      applyToFiles(filesOf(group), group.check !== 'checked')
    },

    toggleNode(node) {
      const files = filesOf(node as GroupNode)
      applyToFiles(files, !files.every(file => file.check === 'checked'))
    },

    toggleFile(file) {
      applyToFiles([file], file.check !== 'checked')
    },

    toggleCurrentVersion() {
      const selected = state.selected
      const diff = state.diff
      if (selected === null || diff === null) return
      const repoId = selected.repoId
      const current = { ...inclusionsOf(repoId) }
      const existing = current[selected.path]
      current[selected.path] = existing !== undefined && existing.mode === 'all'
        ? { mode: 'none' }
        : { mode: 'all' }
      setInclusions(repoId, current)
    },

    toggleHunk(contentKey) {
      const selected = state.selected
      const diff = state.diff
      if (selected === null || diff === null) return
      const repoId = selected.repoId
      const current = { ...inclusionsOf(repoId) }
      const existing = current[selected.path]
      const included = existing === undefined || existing.mode === 'all'
        ? new Set(diff.hunks.map(hunk => hunk.contentKey))
        : existing.mode === 'none'
          ? new Set<string>()
          : new Set(existing.hunkKeys)
      if (included.has(contentKey)) included.delete(contentKey)
      else included.add(contentKey)
      current[selected.path] = included.size === diff.hunks.length
        ? { mode: 'all' }
        : included.size === 0
          ? { mode: 'none' }
          : { mode: 'partial', hunkKeys: [...included] }
      setInclusions(repoId, current)
    },

    setAmend(value) {
      // IntelliJ prefills the amended commit's own message; without this the host
      // would commit the literal 'amend' when the box is empty.
      const prefill = value && state.message.trim() === '' ? (state.status?.lastCommitMessage ?? '') : state.message
      set({ amend: value, message: prefill })
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

    requestCommit(push) {
      if (state.busy !== null || state.pending !== null) return
      set({ pending: { kind: 'commit', origin: 'commit', push }, banner: null })
    },

    requestRollback() {
      if (state.busy !== null || state.pending !== null) return
      set({ pending: { kind: 'rollback', origin: 'commit' }, banner: null })
    },

    requestRevertHunk(contentKey, path) {
      if (state.busy !== null || state.pending !== null) return
      set({ pending: { kind: 'revertHunk', origin: 'diff', contentKey, path }, banner: null })
    },

    async confirmPending() {
      const pending = state.pending
      const repoId = state.activeRepoId
      const status = state.status
      if (pending === null || repoId === null || status === null) {
        set({ pending: null })
        return
      }
      const files = selectedInclusions(state, repoId)
      set({ pending: null })
      if (pending.kind === 'commit') {
        set({ busy: 'commit', banner: null })
        try {
          const response: CommitResponse = await api.commit({
            repoId,
            expectedHeadOid: status.headOid,
            message: state.message,
            amend: state.amend,
            files,
            push: pending.push,
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
          if (pending.push && !response.pushed) {
            const key: DshIntellijGitKey = response.pushErrorCode === 'NO_PUSH_TARGET' ? 'commit.pushNoTarget' : 'commit.pushFailed'
            set({ busy: null, banner: { kind: 'error', key, params: { sha, hint: response.pushError ?? '', reason: response.pushError ?? '' } } })
            return
          }
          set({ busy: null, message: '', amend: false, banner: { kind: 'notice', key: response.pushed ? 'commit.pushed' : 'commit.done', params: { sha } } })
        } catch (error) {
          failBanner(error, 'commit.button')
        }
        return
      }

      set({ busy: pending.kind === 'rollback' ? 'rollback' : 'revertHunk', banner: null })
      try {
        if (pending.kind === 'rollback') {
          const response = await api.rollback({ repoId, expectedHeadOid: status.headOid, files, confirmDeletePaths: true })
          await refreshStatus()
          set({ busy: null, diff: null, selected: null, banner: { kind: 'notice', key: 'rollback.done', params: { count: response.rolledBack.length } } })
          return
        }
        const selected = state.selected
        if (selected !== null) {
          await api.rollback({
            repoId,
            expectedHeadOid: status.headOid,
            confirmDeletePaths: true,
            files: [{
              path: selected.path,
              ...(selected.origPath === null ? {} : { origPath: selected.origPath }),
              status: selected.status,
              partial: true,
              hunkKeys: [pending.contentKey],
            }],
          })
          await refreshStatus()
          await loadDiff(selected)
        }
        set({ busy: null })
      } catch (error) {
        failBanner(error, pending.kind === 'rollback' ? 'toolbar.rollback' : 'diff.deleteHunk')
      }
    },

    cancelPending() {
      set({ pending: null })
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

/** One inclusion as the wire expects it. */
export interface WireInclusion {
  readonly path: string
  readonly origPath?: string
  readonly status: FileChangeEntry['status'] | 'U'
  readonly partial: boolean
  readonly hunkKeys?: readonly string[]
}

/**
 * The inclusion set a commit or message request should carry.
 * @param state - current state.
 * @param repoId - active repository.
 * @returns the requested inclusions.
 */
export function selectedInclusions(state: IntellijGitState, repoId: string): WireInclusion[] {
  const status = state.status
  if (status === null) return []
  const inclusions = state.inclusions[repoId] ?? {}
  const entries: { path: string, origPath?: string, status: FileChangeEntry['status'] | 'U' }[] = [
    ...status.changes.map(change => ({ path: change.path, ...(change.origPath === undefined ? {} : { origPath: change.origPath }), status: change.status })),
    ...status.unversioned.map(path => ({ path, status: 'U' as const })),
  ]
  const result: WireInclusion[] = []
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
 * Paths the given inclusions will delete from disk.
 * @param files - the requested inclusions.
 * @returns the paths that are removed.
 */
export function deletionPaths(files: readonly WireInclusion[]): string[] {
  return files.filter(file => willDeleteEntry(file.status, file.partial)).map(file => file.path)
}

/**
 * Number of individually included hunks across a selection.
 * @param files - the requested inclusions.
 * @returns the hunk count.
 */
export function hunkCount(files: readonly WireInclusion[]): number {
  return files.reduce((total, file) => total + (file.partial ? (file.hunkKeys?.length ?? 0) : 0), 0)
}

/**
 * Build the two groups the Commit tree renders.
 * @param state - current state.
 * @param repoId - active repository.
 * @returns the groups, or null while no status is loaded.
 */
export function groupsOf(state: IntellijGitState, repoId: string): { changes: GroupNode, unversioned: GroupNode } | null {
  const status = state.status
  if (status === null) return null
  return buildGroups(status.changes, status.unversioned, state.inclusions[repoId] ?? {}, state.compactFolders)
}
