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
  WATCH_INTERVAL_MS,
  type ActivityEntry,
  type CommitResponse,
  type FileChangeEntry,
  type FileDiffResponse,
  type FileInclusion,
  type GenerateMessageResponse,
  type RepoStatusResponse,
  type SyncMode,
  type SyncResponse,
  type WorkspaceTreeResponse,
} from '../config.ts'
import { ApiError, api } from './api.ts'
import { buildGroups, dirKeysOf, filesOf, type DirNode, type GroupNode, type FileNode } from './tree-builder.ts'
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
  | { readonly kind: 'push', readonly origin: 'commit' }

/** The rejected push the tool window is offering to resolve. */
export interface SyncOffer {
  /** Resolved push target the integration would run against. */
  readonly target: string
  readonly branch: string
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
  /** Digest of the porcelain output the current status was built from. */
  readonly statusDigest: string | null
  readonly statusLoading: boolean
  readonly statusError: string | null
  /** When the change list was last known to be current; drives the `Updated HH:mm:ss` label. */
  readonly lastCheckedAt: number | null
  /** True while the digest probe is failing; never raises a banner. */
  readonly watchFailing: boolean
  /** Directories the Human collapsed, keyed `<repoId>:<group>:<path>`. Expanded is the absence of a key. */
  readonly collapsedNodes: readonly string[]
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
  readonly busy: 'commit' | 'rollback' | 'revertHunk' | 'sync' | null
  readonly pending: PendingAction | null
  readonly banner: Banner | null
  /** Host-side activity buffer, newest last. */
  readonly activity: readonly ActivityEntry[]
  readonly activityOpen: boolean
  /** Ids of the entries whose captured output is expanded. */
  readonly activityDetail: readonly number[]
  /** Non-null while a rejected push is waiting for the Human to choose an order. */
  readonly syncOffer: SyncOffer | null
}

/** Everything the store can do. */
export interface IntellijGitActions {
  /** Load the tree, the root repository's status and the activity list once, on open. */
  bootstrap(): Promise<void>
  refreshTree(): Promise<void>
  /** Reload the tree, the open repository's status and the open diff. */
  refreshAll(): Promise<void>
  toggleRepo(repoId: string): Promise<void>
  toggleWorkspace(name: string): void
  toggleDomain(key: string): void
  /** Collapse or expand one directory row, keyed `<repoId>:<group>:<path>`. */
  toggleDir(key: string): void
  collapseAllDirs(): void
  expandAllDirs(): void
  refreshStatus(): Promise<void>
  /**
   * Start the digest poll and the visibility/focus refresh.
   * @returns the disposer that stops both.
   */
  startWatch(): () => void
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
  /** Ask to push the commits that are already made; runs from `confirmPending`. */
  requestPush(): void
  /** Ask to roll back the ticked changes. */
  requestRollback(): void
  /** Ask to revert one hunk. */
  requestRevertHunk(contentKey: string, path: string): void
  /** Run the pending write. */
  confirmPending(): Promise<void>
  /** Drop the pending write without running it. */
  cancelPending(): void
  /** Integrate the push target with one of the two offered orders, then push. */
  sync(mode: SyncMode): Promise<void>
  /** Dismiss the push offer without integrating. */
  dismissSyncOffer(): void
  refreshActivity(): Promise<void>
  clearActivity(): Promise<void>
  toggleActivity(): void
  toggleActivityDetail(id: number): void
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
    statusDigest: null,
    statusLoading: false,
    statusError: null,
    lastCheckedAt: null,
    watchFailing: false,
    collapsedNodes: [],
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
    activity: [],
    activityOpen: true,
    activityDetail: [],
    syncOffer: null,
  }
  const listeners = new Set<() => void>()

  /**
   * Monotonic token of the latest status request.
   *
   * The watcher introduces a second writer of `status` on a 5 s cadence, so a
   * tick can land after the post-commit refresh and reinstate the stale list, or
   * land after the accordion moved and paint repository A's files under B. A
   * response is applied only while its token is the latest and its repository is
   * still the active one; the host's `HEAD` compare-and-swap protects writes, not
   * the view.
   */
  let statusRequestSeq = 0

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
   * Keep a file's hunk inclusion to the hunks a fresh diff still has.
   *
   * A committed or reverted hunk's key is dead: leaving it in makes the row render
   * indeterminate, sends the dead key on the next commit, and makes the host
   * answer `STALE_HUNKS` forever because every refresh reseeds the same key.
   * @param repoId - repository id.
   * @param path - the file whose inclusion to prune.
   * @param diff - the fresh diff, or null when it could not be read.
   */
  const pruneHunksTo = (repoId: string, path: string, diff: FileDiffResponse | null): void => {
    if (diff === null) return
    const current = { ...inclusionsOf(repoId) }
    const existing = current[path]
    if (existing === undefined || existing.mode !== 'partial') return
    const alive = new Set(diff.hunks.map(hunk => hunk.contentKey))
    const kept = existing.hunkKeys.filter(key => alive.has(key))
    if (kept.length === existing.hunkKeys.length) return
    current[path] = kept.length === 0
      ? { mode: 'none' }
      : kept.length === diff.hunks.length
        ? { mode: 'all' }
        : { mode: 'partial', hunkKeys: kept }
    setInclusions(repoId, current)
  }

  /**
   * Prune the hunks a `409 STALE_HUNKS` answer named, so the next attempt works.
   *
   * The dead keys belong to a file that may not be the selected one, so a refresh
   * cannot be the answer: the host sends exactly which keys are missing, and this
   * removes them from that path's inclusion in one round trip.
   * @param repoId - repository id.
   * @param path - the path the answer named.
   * @param missing - the hunk keys that no longer exist.
   */
  const pruneStaleHunks = (repoId: string, path: string, missing: readonly string[]): void => {
    const current = { ...inclusionsOf(repoId) }
    const existing = current[path]
    if (existing === undefined || existing.mode !== 'partial') return
    const kept = existing.hunkKeys.filter(key => !missing.includes(key))
    current[path] = kept.length === 0 ? { mode: 'none' } : { mode: 'partial', hunkKeys: kept }
    setInclusions(repoId, current)
  }

  /**
   * Whether a path is still in the fresh change or untracked list.
   * @param snapshot - current state.
   * @param path - repository-relative path.
   * @returns true when the change list still explains it.
   */
  const stillListed = (snapshot: IntellijGitState, path: string): boolean => {
    const status = snapshot.status
    if (status === null) return false
    return status.changes.some(entry => entry.path === path) || status.unversioned.includes(path)
  }

  /**
   * Recover from a `409 STALE_HUNKS` answer where it actually bites.
   *
   * The host already names the path and the dead keys, but they may belong to a
   * file that is not the selected one, and a 409 means the post-commit drop never
   * ran - so the fix is to prune that path's inclusion and say which path it was,
   * not to re-read the wrong file.
   * @param error - the thrown failure.
   * @param repoId - the active repository.
   * @param fallback - the banner key to use when the answer carries no path.
   * @returns true when the error was a stale-hunk answer and is now handled.
   */
  const handleStaleHunks = (error: unknown, repoId: string, fallback: DshIntellijGitKey): boolean => {
    if (!(error instanceof ApiError) || error.code !== 'STALE_HUNKS') return false
    const path = typeof error.details?.['path'] === 'string' ? error.details['path'] : ''
    if (path === '') {
      failBanner(error, fallback)
      return true
    }
    const rawMissing = error.details?.['missing']
    const missing = Array.isArray(rawMissing) ? rawMissing.filter((key): key is string => typeof key === 'string') : []
    pruneStaleHunks(repoId, path, missing)
    set({ busy: null, banner: { kind: 'error', key: 'commit.stalePruned', params: { path } } })
    return true
  }

  /**
   * Load the selected repository's status.
   *
   * Sequenced: the token and the repository are captured before the call and
   * re-checked after it, so a slow tick can neither overwrite a newer status nor
   * paint one repository's list under another.
   */
  const refreshStatus: IntellijGitActions['refreshStatus'] = async () => {
    const repoId = state.activeRepoId
    if (repoId === null) return
    statusRequestSeq += 1
    const token = statusRequestSeq
    set({ statusLoading: true, statusError: null })
    try {
      const status = await api.status(repoId)
      if (token !== statusRequestSeq || state.activeRepoId !== repoId) return
      const digestChanged = state.statusDigest !== status.statusDigest
      const previous = state.selected
      const listed = new Set<string>([
        ...status.changes.map(entry => entry.path),
        ...status.unversioned,
      ])
      const keep = previous !== null && previous.repoId === repoId && listed.has(previous.path) ? previous : null
      set({
        status,
        statusDigest: status.statusDigest,
        statusLoading: false,
        statusError: null,
        lastCheckedAt: Date.now(),
        inclusions: { ...state.inclusions, [repoId]: seedInclusions(repoId, status) },
        selected: keep,
        ...(keep === null ? { diff: null, diffError: null } : {}),
      })
      // A kept selection whose content moved is re-read, and its hunk keys are
      // pruned to what the fresh diff still has. An unchanged file costs nothing.
      if (digestChanged && keep !== null) {
        try {
          const diff = await loadDiff(keep)
          pruneHunksTo(repoId, keep.path, diff)
        } catch {
          // Surfaced through `diffError`.
        }
      }
    } catch (error) {
      if (token !== statusRequestSeq || state.activeRepoId !== repoId) return
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

  /**
   * Run one sync leg and turn its outcome into state.
   *
   * A refusal or a conflict keeps `syncOffer` so the Human can pick the other
   * order; only a success or an explicit dismiss clears it. The offer is the same
   * shape whether it came from a rejected commit-and-push or from the persistent
   * `Push…` action, so an unpushed commit is never a dead end.
   * @param repoId - the repository to integrate.
   * @param mode - the leg to run.
   */
  const runSync = async (repoId: string, mode: SyncMode): Promise<void> => {
    const status = state.status
    if (status === null) return
    set({ busy: 'sync', banner: null })
    try {
      const response: SyncResponse = await api.sync({ repoId, expectedHeadOid: status.headOid, mode })
      await refreshStatus()
      const branch = state.status?.branch ?? status.branch
      if (response.pushErrorCode === 'PUSH_REJECTED') {
        set({ busy: null, syncOffer: { target: response.pushTarget ?? status.pushTarget ?? '', branch } })
        return
      }
      if (!response.pushed) {
        const key: DshIntellijGitKey = response.pushErrorCode === 'NO_PUSH_TARGET' ? 'commit.pushNoTarget' : 'commit.pushFailed'
        set({
          busy: null,
          ...(response.pushErrorCode === 'NO_PUSH_TARGET' ? { syncOffer: null } : {}),
          banner: { kind: 'error', key, params: { sha: response.headShortSha, hint: response.pushError ?? '', reason: response.pushError ?? '' } },
        })
        return
      }
      set({ busy: null, syncOffer: null, banner: { kind: 'notice', key: 'sync.done', params: { mode, sha: response.headShortSha } } })
    } catch (error) {
      const code = error instanceof ApiError ? error.code : ''
      const rawPaths = error instanceof ApiError ? error.details?.['paths'] : undefined
      const paths = Array.isArray(rawPaths) ? rawPaths.filter((path): path is string => typeof path === 'string') : []
      const reason = error instanceof Error ? error.message : String(error)
      const key: DshIntellijGitKey = code === 'INTEGRATE_CONFLICT'
        ? 'sync.conflict'
        : code === 'WORKTREE_DIRTY'
          ? 'sync.dirty'
          : code === 'INTEGRATION_STUCK'
            ? 'sync.stuck'
            : code === 'INTEGRATION_IN_PROGRESS'
              ? 'sync.inProgress'
              : 'sync.failed'
      set({ busy: null, banner: { kind: 'error', key, params: { paths: paths.join(', '), reason } } })
    } finally {
      void actions.refreshActivity()
    }
  }

  const actions: IntellijGitActions = {
    async bootstrap() {
      await actions.refreshTree()
      // `refreshTree` already loads the status when it selects the root; this
      // covers the case where a repository was open before the first load, and
      // gives the watcher an active repository either way.
      if (state.activeRepoId !== null && state.status === null) await refreshStatus()
      await actions.refreshActivity()
    },

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

    async refreshAll() {
      // What the tooltip has always promised: the repository list, the change
      // list of the open repository, and the diff currently on screen.
      await actions.refreshTree()
      await refreshStatus()
      if (state.selected !== null) {
        try {
          await loadDiff(state.selected)
        } catch {
          // Surfaced through `diffError`.
        }
      }
      await actions.refreshActivity()
    },

    async toggleRepo(repoId) {
      // Collapse keys are reset on both branches: the requirement is "always
      // expanded when that repository is selected", so a collapse the Human made
      // in an earlier visit must not survive into the next one.
      if (state.activeRepoId === repoId && state.reposExpanded.includes(repoId)) {
        set({ reposExpanded: [], status: null, statusDigest: null, selected: null, diff: null, collapsedNodes: [] })
        return
      }
      // Single-Active-Repo Accordion: the previous repository collapses with its status.
      set({
        activeRepoId: repoId,
        reposExpanded: [repoId],
        status: null,
        statusDigest: null,
        statusError: null,
        selected: null,
        diff: null,
        diffError: null,
        amend: false,
        message: '',
        collapsedNodes: [],
      })
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

    toggleDir(key) {
      set({
        collapsedNodes: state.collapsedNodes.includes(key)
          ? state.collapsedNodes.filter(item => item !== key)
          : [...state.collapsedNodes, key],
      })
    },

    collapseAllDirs() {
      const repoId = state.activeRepoId
      if (repoId === null) return
      const groups = groupsOf(state, repoId)
      if (groups === null) return
      const keys = new Set<string>([
        ...dirKeysOf(groups.changes).map(key => `${repoId}:changes:${key}`),
        ...dirKeysOf(groups.unversioned).map(key => `${repoId}:unversioned:${key}`),
      ])
      set({ collapsedNodes: [...keys] })
    },

    expandAllDirs() {
      set({ collapsedNodes: [] })
    },

    refreshStatus,

    startWatch() {
      let inFlight = false
      let disposed = false
      /**
       * One tick: probe the digest and refresh only when it moved.
       *
       * The tick is skipped while a write is in flight, while a confirmation is
       * open, and while a status load is running, so a background refresh can
       * never interleave with something the Human is doing.
       */
      const tick = async (): Promise<void> => {
        if (disposed || inFlight) return
        if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return
        const repoId = state.activeRepoId
        if (repoId === null || state.busy !== null || state.pending !== null || state.statusLoading) return
        inFlight = true
        try {
          const watch = await api.watch({ repoId })
          if (disposed || state.activeRepoId !== repoId) return
          if (state.watchFailing) set({ watchFailing: false })
          if (watch.digest !== state.statusDigest) await refreshStatus()
        } catch {
          // A failing probe is reported in the toolbar, never as a banner: the
          // Human's own actions still work.
          if (!disposed) set({ watchFailing: true })
        } finally {
          inFlight = false
        }
      }
      const timer = setInterval(() => { void tick() }, WATCH_INTERVAL_MS)
      const onWake = (): void => { void tick() }
      if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onWake)
      if (typeof window !== 'undefined') window.addEventListener('focus', onWake)
      return () => {
        disposed = true
        clearInterval(timer)
        if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onWake)
        if (typeof window !== 'undefined') window.removeEventListener('focus', onWake)
      }
    },

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

    requestPush() {
      // Available whenever a commit is already waiting to be published: both
      // commit buttons are disabled when nothing is ticked, so without this an
      // unpushed commit would have no way back to the dialog.
      const status = state.status
      if (status === null || status.ahead <= 0) return
      if (state.busy !== null || state.pending !== null) return
      set({ pending: { kind: 'push', origin: 'commit' }, banner: null })
    },

    async sync(mode) {
      if (state.busy !== null || state.activeRepoId === null) return
      await runSync(state.activeRepoId, mode)
    },

    dismissSyncOffer() {
      set({ syncOffer: null })
    },

    async refreshActivity() {
      try {
        const response = await api.activity()
        set({ activity: response.entries })
      } catch {
        // The dock stays on its last snapshot; a probe failure never raises a banner.
      }
    },

    async clearActivity() {
      try {
        await api.clearActivity()
        set({ activity: [], activityDetail: [] })
      } catch (error) {
        failBanner(error, 'activity.clear')
      }
    },

    toggleActivity() {
      set({ activityOpen: !state.activityOpen })
    },

    toggleActivityDetail(id) {
      set({
        activityDetail: state.activityDetail.includes(id)
          ? state.activityDetail.filter(item => item !== id)
          : [...state.activityDetail, id],
      })
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
      if (pending.kind === 'push') {
        await runSync(repoId, 'push')
        return
      }
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
          // Inclusion hygiene before the refresh seeds anything: a partially
          // committed path reseeds as 'none' so the hunks the Human deliberately
          // left out stay out (`seedInclusions` would otherwise default a missing
          // entry back to 'all'), and a whole-file path is dropped because it
          // leaves the list and returns as a new, fully ticked change.
          const after = { ...inclusionsOf(repoId) }
          for (const file of files) {
            if (file.partial) after[file.path] = { mode: 'none' }
            else delete after[file.path]
          }
          setInclusions(repoId, after)
          await refreshStatus()
          void actions.refreshActivity()
          if (response.headMovedDuringCommit) {
            set({ busy: null, banner: { kind: 'error', key: 'commit.headMoved' } })
            return
          }
          const sha = (response.commitSha ?? '').slice(0, 7)
          if (!response.indexSynced) {
            set({ busy: null, banner: { kind: 'error', key: 'commit.indexWarning', params: { reason: response.indexSyncError ?? '' } } })
            return
          }
          const leftBehind = files.filter(file => !file.partial).map(file => file.path).filter(path => stillListed(state, path))
          if (leftBehind.length > 0) {
            set({ busy: null, banner: { kind: 'error', key: 'commit.notApplied', params: { paths: leftBehind.join(', ') } } })
            return
          }
          if (pending.push && !response.pushed) {
            if (response.pushErrorCode === 'PUSH_REJECTED') {
              // The commit is kept; the offer is what turns the rejection into a choice.
              set({ busy: null, syncOffer: { target: response.pushTarget ?? status.pushTarget ?? '', branch: state.status?.branch ?? status.branch } })
              return
            }
            const key: DshIntellijGitKey = response.pushErrorCode === 'NO_PUSH_TARGET' ? 'commit.pushNoTarget' : 'commit.pushFailed'
            set({ busy: null, banner: { kind: 'error', key, params: { sha, hint: response.pushError ?? '', reason: response.pushError ?? '' } } })
            return
          }
          set({ busy: null, message: '', amend: false, banner: { kind: 'notice', key: response.pushed ? 'commit.pushed' : 'commit.done', params: { sha } } })
        } catch (error) {
          if (handleStaleHunks(error, repoId, 'commit.button')) return
          failBanner(error, 'commit.button')
        }
        return
      }

      set({ busy: pending.kind === 'rollback' ? 'rollback' : 'revertHunk', banner: null })
      try {
        if (pending.kind === 'rollback') {
          const response = await api.rollback({ repoId, expectedHeadOid: status.headOid, files, confirmDeletePaths: true })
          await refreshStatus()
          void actions.refreshActivity()
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
          void actions.refreshActivity()
          await loadDiff(selected)
        }
        set({ busy: null })
      } catch (error) {
        if (handleStaleHunks(error, repoId, pending.kind === 'rollback' ? 'toolbar.rollback' : 'diff.deleteHunk')) return
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
