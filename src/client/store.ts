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
  ACTIVITY_CAPACITY,
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
import { ApiError, createApi } from './api.ts'
import { readPref, writePref } from './layout-prefs.ts'
import { buildGroups, dirKeysOf, filesOf, type DirNode, type GroupNode, type FileNode } from './tree-builder.ts'
import type { DshIntellijGitKey } from './locale.ts'

/** A translated message the view renders once. */
export interface Banner {
  readonly kind: 'error' | 'notice'
  readonly key: DshIntellijGitKey
  readonly params?: Record<string, unknown>
}

/** A transient success the page shows as a toast. */
export interface ToastState {
  readonly key: DshIntellijGitKey
  readonly params?: Record<string, unknown>
  /** Epoch ms; also the React key, so a repeat of the same text restarts the toast. */
  readonly at: number
  /** Full commit SHA or short SHA offered by the toast's copy action. */
  readonly sha?: string
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

/** Which write is running. */
export type BusyKind = 'commit' | 'commitPush' | 'push' | 'rebase' | 'merge' | 'rollback' | 'revertHunk'

/** The write that owns the page's locks. Only its own completion releases it. */
export interface BusyState {
  /** Monotonic operation id; a release is honoured only when it still matches. */
  readonly opId: number
  readonly kind: BusyKind
  /** The repository the write captured; the repository row lock keeps it active. */
  readonly repoId: string
  readonly startedAt: number
  /** Copy parameters of the phase label (target, count). */
  readonly params?: Record<string, unknown>
}

/** The rejected push the tool window is offering to resolve. */
export interface SyncOffer {
  /** Resolved push target the integration would run against. */
  readonly target: string
  readonly branch: string
}

/** Everything the page renders from. */
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
  /** True while the main-area page is mounted; the watcher runs only then. */
  readonly pageActive: boolean
  /** Directories the Human collapsed, keyed `<repoId>:<group>:<path>`. Expanded is the absence of a key. */
  readonly collapsedNodes: readonly string[]
  readonly inclusions: Readonly<Record<string, Readonly<Record<string, FileInclusion>>>>
  readonly selected: SelectedFile | null
  readonly diff: FileDiffResponse | null
  readonly diffLoading: boolean
  readonly diffError: string | null
  readonly viewMode: 'split' | 'unified'
  readonly collapseUnchanged: boolean
  readonly wrapLines: boolean
  readonly compactFolders: boolean
  readonly amend: boolean
  readonly message: string
  readonly aiBusy: boolean
  readonly aiRoute: string | null
  /** Failure of the last message generation; touches nothing else. */
  readonly aiError: string | null
  readonly busy: BusyState | null
  readonly pending: PendingAction | null
  /** Persistent write error, rendered in the page header region. */
  readonly banner: Banner | null
  /** Transient success. */
  readonly toast: ToastState | null
  /** Host-side activity buffer, merged client-side, oldest first. */
  readonly activity: readonly ActivityEntry[]
  /** Ring identity of the last read; a change means the host restarted. */
  readonly activityBootId: string | null
  /** Highest entry id merged so far; the `after` cursor of the next read. */
  readonly activityLastSeenId: number
  /** True when entries older than the first retained one were evicted or cleared. */
  readonly activityTruncated: boolean
  readonly activityOpen: boolean
  /** Ids of the entries whose captured output is expanded. */
  readonly activityDetail: readonly number[]
  /** Keys of the request groups whose git calls are expanded. */
  readonly activityGroupsOpen: readonly string[]
  /** Whether watcher-driven groups are listed. */
  readonly showBackground: boolean
  /** A group appeared while the dock was collapsed. */
  readonly activityUnread: boolean
  readonly activityClearing: boolean
  /** The last dock read failed; the list may lag the host. */
  readonly activityStale: boolean
  /** The last Clear failed. */
  readonly activityError: string | null
  /** Non-null while a rejected push is waiting for the Human to choose an order. */
  readonly syncOffer: SyncOffer | null
}

/** Everything the store can do. */
export interface IntellijGitActions {
  /** Load the tree, the root repository's status and the activity list once. */
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
  /**
   * Reload one repository's status.
   * @param repoId - defaults to the active repository.
   * @param origin - `auto` marks a watcher-driven call.
   * @returns the status that was applied, or null when the call failed or was superseded.
   */
  refreshStatus(repoId?: string, origin?: 'user' | 'auto'): Promise<RepoStatusResponse | null>
  /**
   * Tell the store whether the main-area page is mounted. The watcher (the 5 s
   * digest poll plus the visibility/focus refresh) runs only while it is.
   * Activation runs one immediate status refresh.
   */
  setPageActive(active: boolean): void
  openFile(file: SelectedFile): Promise<void>
  refreshDiff(): Promise<void>
  setViewMode(mode: 'split' | 'unified'): void
  toggleCollapse(): void
  toggleWrap(): void
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
  /** Request a full snapshot read of the host buffer (the dock's Refresh button). */
  refreshActivity(): Promise<void>
  clearActivity(): Promise<void>
  toggleActivity(): void
  toggleActivityDetail(id: number): void
  toggleActivityGroup(key: string): void
  toggleShowBackground(): void
  dismissBanner(): void
  dismissToast(): void
}

/** Handle the store exposes to the view layer. */
export interface IntellijGitStore {
  readonly getSnapshot: () => IntellijGitState
  readonly subscribe: (listener: () => void) => () => void
  readonly actions: IntellijGitActions
}

/** The outcome of one diff load. */
type DiffOutcome =
  | { readonly kind: 'current', readonly diff: FileDiffResponse }
  | { readonly kind: 'failed' }
  | { readonly kind: 'superseded' }

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
 * Create the Git page store.
 * @returns the store handle.
 */
export function createIntellijGitStore(): IntellijGitStore {
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
    pageActive: false,
    collapsedNodes: [],
    inclusions: {},
    selected: null,
    diff: null,
    diffLoading: false,
    diffError: null,
    viewMode: readPref<'split' | 'unified'>('viewMode', 'split', value => value === 'split' || value === 'unified'),
    collapseUnchanged: readPref('collapseUnchanged', true),
    wrapLines: readPref('wrap', false),
    compactFolders: true,
    amend: false,
    message: '',
    aiBusy: false,
    aiRoute: null,
    aiError: null,
    busy: null,
    pending: null,
    banner: null,
    toast: null,
    activity: [],
    activityBootId: null,
    activityLastSeenId: 0,
    activityTruncated: false,
    activityOpen: readPref('dockOpen', true),
    activityDetail: [],
    activityGroupsOpen: [],
    showBackground: readPref('showBackground', false),
    activityUnread: false,
    activityClearing: false,
    activityStale: false,
    activityError: null,
    syncOffer: null,
  }
  const listeners = new Set<() => void>()

  /**
   * Monotonic token of the latest status request.
   *
   * The watcher is a second writer of `status`, so a tick can land after the
   * post-commit refresh and reinstate the stale list, or land after the accordion
   * moved and paint repository A's files under B. A response is applied only
   * while its token is the latest and its repository is still the active one.
   */
  let statusRequestSeq = 0

  /**
   * Monotonic token of the latest diff request. Incremented by every `loadDiff`,
   * by every selection clear and by every repository switch, so a response that
   * resolves after a newer one (or after the selection moved) is `superseded` and
   * neither published nor used for any derived mutation.
   */
  let diffRequestSeq = 0

  /** Operation ids of writes; see {@link BusyState}. */
  let opSeq = 0

  /** Bumped by every message edit, a commit's message reset and a repository switch. */
  let draftGeneration = 0

  /**
   * Publish a state patch.
   * @param patch - the changed fields.
   */
  const set = (patch: Partial<IntellijGitState>): void => {
    state = { ...state, ...patch }
    for (const listener of listeners) listener()
  }

  /**
   * The single route surface. Every non-silent call settles into the activity
   * refresh, so no call site has to remember it.
   */
  const api = createApi({ onSettled: () => { void scheduleActivityRefresh() } })

  /**
   * Take the page's write lock for one write.
   * @param kind - which write.
   * @param repoId - the repository it captured.
   * @param params - copy parameters of its phase label.
   * @returns the operation id its completion must present.
   */
  const beginOp = (kind: BusyKind, repoId: string, params?: Record<string, unknown>): number => {
    opSeq += 1
    const opId = opSeq
    set({
      busy: { opId, kind, repoId, startedAt: Date.now(), ...(params === undefined ? {} : { params }) },
      banner: null,
      toast: null,
    })
    return opId
  }

  /**
   * Release the lock and publish the write's outcome in one update.
   *
   * Only the owning operation releases: an unrelated failure (Clear, AI) never
   * reaches this, and a completion whose id no longer matches publishes its
   * patch without touching `busy`.
   * @param opId - the id from `beginOp`.
   * @param patch - the outcome (banner, toast, offer, resets).
   */
  const finishOp = (opId: number, patch: Partial<IntellijGitState> = {}): void => {
    set(state.busy?.opId === opId ? { ...patch, busy: null } : patch)
  }

  /**
   * Describe a thrown error for a banner.
   * @param error - the failure.
   * @param key - dictionary key naming what failed.
   * @returns the banner patch; it touches nothing but the banner.
   */
  const errorBanner = (error: unknown, key: DshIntellijGitKey): Partial<IntellijGitState> => {
    const detail = error instanceof Error ? error.message : String(error)
    return { banner: { kind: 'error', key, params: { reason: detail } } }
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
   * Prune and report a `409 STALE_HUNKS` answer where it actually bites.
   *
   * The host already names the path and the dead keys, but they may belong to a
   * file that is not the selected one, and a 409 means the post-commit drop never
   * ran: prune that path's inclusion and say which path it was.
   * @param error - the thrown failure.
   * @param repoId - the repository the write captured.
   * @returns the banner patch when the error was a stale-hunk answer, else null.
   */
  const staleHunksPatch = (error: unknown, repoId: string): Partial<IntellijGitState> | null => {
    if (!(error instanceof ApiError) || error.code !== 'STALE_HUNKS') return null
    const path = typeof error.details?.['path'] === 'string' ? error.details['path'] : ''
    if (path === '') return null
    const rawMissing = error.details?.['missing']
    const missing = Array.isArray(rawMissing) ? rawMissing.filter((key): key is string => typeof key === 'string') : []
    pruneStaleHunks(repoId, path, missing)
    return { banner: { kind: 'error', key: 'commit.stalePruned', params: { path } } }
  }

  // ---------------------------------------------------------------- activity

  /**
   * Bumped by Clear at entry; a read that started earlier is dropped on publish.
   */
  let activityGeneration = 0
  /** The activity operation holding the owner (a read, or Clear's POST), or null. */
  let owner: Promise<void> | null = null
  /** True from Clear's entry until it settles: no trailing read starts meanwhile. */
  let clearing = false
  /** One trailing read, requested while another operation held the owner. */
  let readPending: { full: boolean } | null = null
  let clearInFlight: Promise<void> | null = null

  /**
   * Merge one read into the client list.
   * @param full - whether a full snapshot was requested.
   * @param generation - `activityGeneration` at the read's start.
   */
  const readActivity = async (full: boolean, generation: number): Promise<void> => {
    const lastSeen = state.activityLastSeenId
    const bootId = state.activityBootId
    const cursor = full || bootId === null ? undefined : lastSeen
    try {
      let response = await api.activity(cursor)
      if (generation !== activityGeneration) return
      let replace = cursor === undefined
      if (cursor !== undefined && (response.bootId !== bootId || (response.oldestId !== null && response.oldestId > lastSeen + 1))) {
        // A new ring (host restart: ids restart at 1) or eviction past the cursor:
        // the cursor slice would skip entries, so take a whole snapshot.
        response = await api.activity(undefined)
        if (generation !== activityGeneration) return
        replace = true
      }
      let list: readonly ActivityEntry[]
      let truncated = state.activityTruncated
      if (replace) {
        list = response.entries
        truncated = response.oldestId === null ? response.latestId > 0 : response.oldestId > 1
      } else {
        list = [...state.activity, ...response.entries]
        if (list.length > ACTIVITY_CAPACITY) {
          list = list.slice(list.length - ACTIVITY_CAPACITY)
          truncated = true
        }
      }
      const grew = response.entries.length > 0
      set({
        activity: list,
        activityBootId: response.bootId,
        activityLastSeenId: response.latestId,
        activityTruncated: truncated,
        activityStale: false,
        ...(grew && !state.activityOpen ? { activityUnread: true } : {}),
      })
    } catch {
      if (generation === activityGeneration) set({ activityStale: true })
    }
  }

  /** Start the trailing read when nothing holds the owner. */
  const drain = (): void => {
    if (readPending === null || owner !== null || clearing) return
    const { full } = readPending
    readPending = null
    hold(readActivity(full, activityGeneration))
  }

  /**
   * Hold the owner for one operation; release drains the trailing read.
   * @param operation - the in-flight read or Clear POST.
   */
  const hold = (operation: Promise<void>): void => {
    owner = operation.then(release, release)
  }

  const release = (): void => {
    owner = null
    drain()
  }

  /**
   * Request an activity read. One serial owner means at most one `GET activity`
   * or `POST activity/clear` is in flight; a request made meanwhile collapses
   * into one trailing read, and a full request upgrades it to full.
   * @param options - `full` asks for a whole snapshot.
   * @returns resolves once no read is held or queued.
   */
  const scheduleActivityRefresh = async (options: { full?: boolean } = {}): Promise<void> => {
    const full = options.full === true
    if (owner !== null || clearing) readPending = { full: full || (readPending?.full ?? false) }
    else hold(readActivity(full, activityGeneration))
    while (owner !== null || readPending !== null || clearing) {
      if (owner === null) await new Promise<void>(resolve => { setTimeout(resolve, 0) })
      else await owner
    }
  }

  // ------------------------------------------------------------ diff + status

  /**
   * Load one file's diff and reveal it.
   *
   * Every call takes a new `diffRequestSeq`; a response that is no longer the
   * latest is `superseded` and published nowhere, so a slow response can neither
   * reinstate a file the Human left nor drive a derived mutation.
   * @param file - the file to show.
   * @returns the tagged outcome.
   */
  const loadDiff = async (file: SelectedFile): Promise<DiffOutcome> => {
    diffRequestSeq += 1
    const seq = diffRequestSeq
    set({ diffLoading: true, diffError: null })
    try {
      const diff = await api.diff({
        repoId: file.repoId,
        path: file.path,
        ...(file.origPath === null ? {} : { origPath: file.origPath }),
        status: file.status,
      })
      if (seq !== diffRequestSeq) return { kind: 'superseded' }
      set({ diff, diffLoading: false, selected: file })
      return { kind: 'current', diff }
    } catch (error) {
      if (seq !== diffRequestSeq) return { kind: 'superseded' }
      set({ diffLoading: false, diffError: error instanceof Error ? error.message : String(error) })
      return { kind: 'failed' }
    }
  }

  /**
   * Load one repository's status.
   *
   * Sequenced: the token and the repository are captured before the call and
   * re-checked after it, so a slow tick can neither overwrite a newer status nor
   * paint one repository's list under another.
   * @param repoIdArg - defaults to the active repository.
   * @param origin - `auto` marks a watcher-driven call (no spinner, dimmed in the dock).
   * @returns the applied status, or null when the call failed or was superseded.
   */
  const refreshStatus: IntellijGitActions['refreshStatus'] = async (repoIdArg, origin = 'user') => {
    const repoId = repoIdArg ?? state.activeRepoId
    if (repoId === null || repoId !== state.activeRepoId) return null
    statusRequestSeq += 1
    const token = statusRequestSeq
    set(origin === 'auto' ? { statusError: null } : { statusLoading: true, statusError: null })
    try {
      const status = await api.status(repoId, origin === 'auto' ? { origin } : undefined)
      if (token !== statusRequestSeq || state.activeRepoId !== repoId) return null
      const digestChanged = state.statusDigest !== status.statusDigest
      const previous = state.selected
      const listed = new Set<string>([
        ...status.changes.map(entry => entry.path),
        ...status.unversioned,
      ])
      const keep = previous !== null && previous.repoId === repoId && listed.has(previous.path) ? previous : null
      if (keep === null && previous !== null) diffRequestSeq += 1
      set({
        status,
        statusDigest: status.statusDigest,
        statusLoading: false,
        statusError: null,
        lastCheckedAt: Date.now(),
        inclusions: { ...state.inclusions, [repoId]: seedInclusions(repoId, status) },
        selected: keep,
        ...(keep === null ? { diff: null, diffError: null, diffLoading: false } : {}),
      })
      // A kept selection whose content moved is re-read, and its hunk keys are
      // pruned to what the fresh diff still has. The prune is a derived mutation,
      // so it runs only when the outcome is current, this status is still the
      // latest and the selection is still the same file.
      if (digestChanged && keep !== null) {
        const outcome = await loadDiff(keep)
        const now = state.selected
        if (
          outcome.kind === 'current'
          && token === statusRequestSeq
          && now !== null
          && now.repoId === repoId
          && now.path === keep.path
        ) {
          pruneHunksTo(repoId, keep.path, outcome.diff)
        }
      }
      return status
    } catch (error) {
      if (token !== statusRequestSeq || state.activeRepoId !== repoId) return null
      set({ statusLoading: false, statusError: error instanceof Error ? error.message : String(error) })
      return null
    }
  }

  /**
   * Run one sync leg and turn its outcome into a state patch.
   *
   * A refusal or a conflict keeps `syncOffer` so the Human can pick the other
   * order; only a success or an explicit dismiss clears it. The offer is the same
   * shape whether it came from a rejected commit-and-push or from the persistent
   * `Push...` action, so an unpushed commit is never a dead end. The caller owns
   * the `busy` descriptor and releases it with the returned patch.
   * @param repoId - the repository to integrate.
   * @param mode - the leg to run.
   * @param status - the status the write captured.
   * @returns the outcome patch.
   */
  const syncLeg = async (repoId: string, mode: SyncMode, status: RepoStatusResponse): Promise<Partial<IntellijGitState>> => {
    try {
      const response: SyncResponse = await api.sync({ repoId, expectedHeadOid: status.headOid, mode })
      await refreshStatus()
      const branch = state.status?.branch ?? status.branch
      if (response.pushErrorCode === 'PUSH_REJECTED') {
        return { syncOffer: { target: response.pushTarget ?? status.pushTarget ?? '', branch } }
      }
      if (!response.pushed) {
        const key: DshIntellijGitKey = response.pushErrorCode === 'NO_PUSH_TARGET' ? 'commit.pushNoTarget' : 'commit.pushFailed'
        return {
          ...(response.pushErrorCode === 'NO_PUSH_TARGET' ? { syncOffer: null } : {}),
          banner: { kind: 'error', key, params: { sha: response.headShortSha, hint: response.pushError ?? '', reason: response.pushError ?? '' } },
        }
      }
      return {
        syncOffer: null,
        toast: {
          key: mode === 'push' ? 'push.done' : 'sync.done',
          params: { mode, sha: response.headShortSha },
          at: Date.now(),
          sha: response.headShortSha,
        },
      }
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
      return { banner: { kind: 'error', key, params: { paths: paths.join(', '), reason, mode } } }
    }
  }

  /**
   * Run one push/rebase/merge leg under the write lock.
   * @param repoId - the repository to integrate.
   * @param mode - the leg to run.
   * @param status - the status the write captured.
   */
  const runSync = async (repoId: string, mode: SyncMode, status: RepoStatusResponse): Promise<void> => {
    const opId = beginOp(mode, repoId, { target: status.pushTarget ?? '', count: status.ahead })
    let patch: Partial<IntellijGitState> = {}
    try {
      patch = await syncLeg(repoId, mode, status)
    } finally {
      finishOp(opId, patch)
    }
  }

  // ----------------------------------------------------------------- watcher

  /**
   * Start the 5 s digest poll plus the visibility/focus refresh.
   * @returns the stop function.
   */
  const startWatcher = (): (() => void) => {
    let inFlight = false
    let disposed = false
    /**
     * One tick: probe the digest and refresh only when it moved.
     *
     * Skipped while a write is in flight, while a confirmation is open and while
     * a status load is running, so a background refresh never interleaves with
     * something the Human is doing.
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
        if (watch.digest !== state.statusDigest) await refreshStatus(repoId, 'auto')
      } catch {
        // A failing probe is reported in the toolbar, never as a banner.
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
  }
  let stopWatcher: (() => void) | null = null

  const actions: IntellijGitActions = {
    async bootstrap() {
      await actions.refreshTree()
      // `refreshTree` already loads the status when it selects the root; this
      // covers the case where a repository was open before the first load.
      if (state.activeRepoId !== null && state.status === null) await refreshStatus()
      await scheduleActivityRefresh({ full: true })
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
      // The repository list, the change list of the open repository, and the
      // diff currently on screen.
      await actions.refreshTree()
      await refreshStatus()
      if (state.selected !== null) await loadDiff(state.selected)
      await scheduleActivityRefresh({ full: true })
    },

    async toggleRepo(repoId) {
      // The repository is locked while a write runs: switching would drop the
      // status the write captured and its completion would repaint the wrong list.
      if (state.busy !== null) return
      // Collapse keys are reset on both branches: the requirement is "always
      // expanded when that repository is selected", so a collapse the Human made
      // in an earlier visit must not survive into the next one.
      if (state.activeRepoId === repoId && state.reposExpanded.includes(repoId)) {
        diffRequestSeq += 1
        set({ reposExpanded: [], status: null, statusDigest: null, selected: null, diff: null, diffLoading: false, collapsedNodes: [] })
        return
      }
      // Single-Active-Repo Accordion: the previous repository collapses with its status.
      diffRequestSeq += 1
      draftGeneration += 1
      set({
        activeRepoId: repoId,
        reposExpanded: [repoId],
        status: null,
        statusDigest: null,
        statusError: null,
        selected: null,
        diff: null,
        diffError: null,
        diffLoading: false,
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

    setPageActive(active) {
      if (state.pageActive === active) return
      set({ pageActive: active })
      if (active) {
        if (state.activeRepoId !== null && state.busy === null) void refreshStatus()
        stopWatcher = startWatcher()
      } else {
        stopWatcher?.()
        stopWatcher = null
      }
    },

    async openFile(file) {
      set({ selected: file, diff: null })
      await loadDiff(file)
    },

    async refreshDiff() {
      const selected = state.selected
      if (selected === null) return
      await loadDiff(selected)
    },

    setViewMode(mode) {
      writePref('viewMode', mode)
      set({ viewMode: mode })
    },

    toggleCollapse() {
      writePref('collapseUnchanged', !state.collapseUnchanged)
      set({ collapseUnchanged: !state.collapseUnchanged })
    },

    toggleWrap() {
      writePref('wrap', !state.wrapLines)
      set({ wrapLines: !state.wrapLines })
    },

    toggleCompact() {
      set({ compactFolders: !state.compactFolders })
    },

    toggleGroup(group) {
      if (state.busy !== null) return
      applyToFiles(filesOf(group), group.check !== 'checked')
    },

    toggleNode(node) {
      if (state.busy !== null) return
      const files = filesOf(node as GroupNode)
      applyToFiles(files, !files.every(file => file.check === 'checked'))
    },

    toggleFile(file) {
      if (state.busy !== null) return
      applyToFiles([file], file.check !== 'checked')
    },

    toggleCurrentVersion() {
      if (state.busy !== null) return
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
      if (state.busy !== null) return
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
      if (state.busy !== null) return
      // IntelliJ prefills the amended commit's own message; without this the host
      // would commit the literal 'amend' when the box is empty.
      const prefill = value && state.message.trim() === '' ? (state.status?.lastCommitMessage ?? '') : state.message
      draftGeneration += 1
      set({ amend: value, message: prefill })
    },

    setMessage(value) {
      if (state.busy !== null) return
      draftGeneration += 1
      set({ message: value })
    },

    async generateMessage(sessionId) {
      const repoId = state.activeRepoId
      if (repoId === null || state.busy !== null || state.aiBusy) return
      const generation = draftGeneration
      set({ aiBusy: true, aiError: null })
      try {
        const response: GenerateMessageResponse = await api.generateMessage({
          repoId,
          files: selectedInclusions(state, repoId),
          ...(sessionId === undefined ? {} : { sessionId }),
        })
        // A message typed, a repository switch or a commit since the request
        // started makes this answer stale: drop it rather than overwrite the draft.
        if (generation !== draftGeneration || state.busy !== null || state.activeRepoId !== repoId) {
          set({ aiBusy: false })
          return
        }
        draftGeneration += 1
        set({ message: response.message, aiRoute: `${response.route.provider}/${response.route.model}`, aiBusy: false })
      } catch (error) {
        set({ aiBusy: false, aiError: error instanceof Error ? error.message : String(error) })
      }
    },

    requestCommit(push) {
      if (state.busy !== null || state.pending !== null) return
      set({ pending: { kind: 'commit', origin: 'commit', push }, banner: null, toast: null })
    },

    requestPush() {
      // Available whenever a commit is already waiting to be published: both
      // commit buttons are disabled when nothing is ticked, so without this an
      // unpushed commit would have no way back to the dialog.
      const status = state.status
      if (status === null || status.ahead <= 0) return
      if (state.busy !== null || state.pending !== null) return
      set({ pending: { kind: 'push', origin: 'commit' }, banner: null, toast: null })
    },

    async sync(mode) {
      const repoId = state.activeRepoId
      const status = state.status
      if (state.busy !== null || repoId === null || status === null) return
      await runSync(repoId, mode, status)
    },

    dismissSyncOffer() {
      if (state.busy !== null) return
      set({ syncOffer: null })
    },

    async refreshActivity() {
      await scheduleActivityRefresh({ full: true })
    },

    async clearActivity() {
      if (clearInFlight !== null) return clearInFlight
      clearing = true
      activityGeneration += 1
      set({ activityClearing: true, activityError: null })
      clearInFlight = (async () => {
        let cleared = false
        try {
          // The held read (if any) was started in the old generation and drops its
          // own publish; waiting for it keeps one request in flight at a time.
          if (owner !== null) await owner
          const post = api.clearActivity()
          hold(post.then(() => undefined, () => undefined))
          try {
            const response = await post
            set({
              activity: [],
              activityDetail: [],
              activityGroupsOpen: [],
              activityBootId: response.bootId,
              activityLastSeenId: response.latestId,
              activityTruncated: true,
              activityUnread: false,
              activityStale: false,
            })
            cleared = true
          } catch (error) {
            set({ activityError: error instanceof Error ? error.message : String(error) })
          }
        } finally {
          clearing = false
          clearInFlight = null
          set({ activityClearing: false })
          // Always one trailing read. After a successful Clear it is a cursor read
          // (Clear takes precedence over a queued full upgrade: the list is empty and
          // the cursor is the clear response's latestId); after a failed Clear it
          // stays full only if a full read was queued meanwhile.
          const full = cleared ? false : (readPending?.full ?? false)
          if (cleared) readPending = null
          void scheduleActivityRefresh({ full })
        }
      })()
      return clearInFlight
    },

    toggleActivity() {
      const open = !state.activityOpen
      writePref('dockOpen', open)
      set({ activityOpen: open, ...(open ? { activityUnread: false } : {}) })
    },

    toggleActivityDetail(id) {
      set({
        activityDetail: state.activityDetail.includes(id)
          ? state.activityDetail.filter(item => item !== id)
          : [...state.activityDetail, id],
      })
    },

    toggleActivityGroup(key) {
      set({
        activityGroupsOpen: state.activityGroupsOpen.includes(key)
          ? state.activityGroupsOpen.filter(item => item !== key)
          : [...state.activityGroupsOpen, key],
      })
    },

    toggleShowBackground() {
      writePref('showBackground', !state.showBackground)
      set({ showBackground: !state.showBackground })
    },

    requestRollback() {
      if (state.busy !== null || state.pending !== null) return
      set({ pending: { kind: 'rollback', origin: 'commit' }, banner: null, toast: null })
    },

    requestRevertHunk(contentKey, path) {
      if (state.busy !== null || state.pending !== null) return
      set({ pending: { kind: 'revertHunk', origin: 'diff', contentKey, path }, banner: null, toast: null })
    },

    async confirmPending() {
      const pending = state.pending
      const repoId = state.activeRepoId
      const status = state.status
      if (state.busy !== null) return
      if (pending === null || repoId === null || status === null) {
        set({ pending: null })
        return
      }
      const files = selectedInclusions(state, repoId)
      set({ pending: null })
      if (pending.kind === 'push') {
        await runSync(repoId, 'push', status)
        return
      }
      if (pending.kind === 'commit') {
        const opId = beginOp(pending.push ? 'commitPush' : 'commit', repoId, { count: files.length, target: status.pushTarget ?? '' })
        // A generation answer that lands after the commit must not refill the box.
        draftGeneration += 1
        let patch: Partial<IntellijGitState> = {}
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
          const sha = (response.commitSha ?? '').slice(0, 7)
          if (response.headMovedDuringCommit) {
            patch = { banner: { kind: 'error', key: 'commit.headMoved' } }
          } else if (!response.indexSynced) {
            patch = { banner: { kind: 'error', key: 'commit.indexWarning', params: { reason: response.indexSyncError ?? '' } } }
          } else {
            const leftBehind = files.filter(file => !file.partial).map(file => file.path).filter(path => stillListed(state, path))
            if (leftBehind.length > 0) {
              patch = { banner: { kind: 'error', key: 'commit.notApplied', params: { paths: leftBehind.join(', ') } } }
            } else if (pending.push && !response.pushed) {
              if (response.pushErrorCode === 'PUSH_REJECTED') {
                // The commit is kept; the offer is what turns the rejection into a choice.
                patch = { syncOffer: { target: response.pushTarget ?? status.pushTarget ?? '', branch: state.status?.branch ?? status.branch } }
              } else {
                const key: DshIntellijGitKey = response.pushErrorCode === 'NO_PUSH_TARGET' ? 'commit.pushNoTarget' : 'commit.pushFailed'
                patch = { banner: { kind: 'error', key, params: { sha, hint: response.pushError ?? '', reason: response.pushError ?? '' } } }
              }
            } else {
              patch = {
                message: '',
                amend: false,
                toast: { key: response.pushed ? 'commit.pushed' : 'commit.done', params: { sha }, at: Date.now(), ...(sha === '' ? {} : { sha }) },
              }
            }
          }
        } catch (error) {
          patch = staleHunksPatch(error, repoId) ?? errorBanner(error, 'commit.button')
        } finally {
          finishOp(opId, patch)
        }
        return
      }

      const isRollback = pending.kind === 'rollback'
      const opId = beginOp(isRollback ? 'rollback' : 'revertHunk', repoId, { count: files.length })
      let patch: Partial<IntellijGitState> = {}
      try {
        if (isRollback) {
          const response = await api.rollback({ repoId, expectedHeadOid: status.headOid, files, confirmDeletePaths: true })
          diffRequestSeq += 1
          await refreshStatus()
          patch = {
            diff: null,
            selected: null,
            diffLoading: false,
            toast: { key: 'rollback.done', params: { count: response.rolledBack.length }, at: Date.now() },
          }
        } else {
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
            if (state.selected !== null) await loadDiff(state.selected)
          }
        }
      } catch (error) {
        patch = staleHunksPatch(error, repoId) ?? errorBanner(error, isRollback ? 'toolbar.rollback' : 'diff.deleteHunk')
      } finally {
        finishOp(opId, patch)
      }
    },

    cancelPending() {
      set({ pending: null })
    },

    dismissBanner() {
      set({ banner: null })
    },

    dismissToast() {
      set({ toast: null })
    },
  }

  // The apply-level teardown stops the watcher through this when the page is gone.

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
