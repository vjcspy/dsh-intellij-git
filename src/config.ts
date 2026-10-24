/**
 * Constants, the route table and the wire types shared by both halves.
 *
 * Deliberately dependency-free: the browser bundle imports this module, so
 * anything added here ships to the page. The Host-only schema lives in
 * `./schema.ts`.
 *
 * Every JSON value below crosses the `/api` channel, so it is described as
 * plain data rather than as a class.
 */

/** Package id: the loader registration id, the Commit tab implementation id, and the tab body slot key. */
export const PLUGIN_ID = 'dsh-intellij-git'

/** Main-area page key and left-sidebar row id. */
export const PAGE_ID = 'dsh-intellij-git'

/**
 * Ascending position of the left-sidebar row. `Plugins` is 0 and the optional
 * `dshmarket` row is 1, so only 0.5 sits directly under `Plugins` in both states.
 */
export const PAGE_ROW_ORDER = 0.5

/** Locale namespace owning every product-visible string this plugin renders. */
export const LOCALE_NAMESPACE = 'dshIntellijGit'

/** Route prefix below `/api`; every path this plugin registers sits under it. */
export const API_PREFIX = '/api/dsh-intellij-git'

/** Platform marker proving a directory is an Aweave checkout. */
export const AWEAVE_MARKER_REL_PATH = 'workspaces/devtools/common/server/package.json'

/** Root repository id. */
export const ROOT_REPO_ID = 'root'

/** Root repository display label. */
export const ROOT_REPO_LABEL = 'aweave'

/** Default `git` subprocess deadline. */
export const DEFAULT_GIT_TIMEOUT_MS = 30_000

/** Longest diff payload handed to the model for a commit message, in UTF-8 bytes. */
export const MAX_AI_DIFF_BYTES = 16_000

/** Upper bound on the bytes of any single file this plugin reads for a diff. */
export const MAX_DIFF_FILE_BYTES = 4 * 1024 * 1024

/** Entries the host-side activity ring buffer keeps. */
export const ACTIVITY_CAPACITY = 500

/** Request header the browser sets to `auto` on watcher-driven calls; anything else reads as `user`. */
export const ORIGIN_HEADER = 'x-dsh-git-origin'

/** Characters of one entry's captured output that survive into the buffer. */
export const ACTIVITY_OUTPUT_LIMIT = 1024

/** Cadence of the browser's digest poll, in milliseconds. */
export const WATCH_INTERVAL_MS = 5_000

/** Deadline of every `git` call on the fetch/rebase/merge/push path, in milliseconds. */
export const INTEGRATE_TIMEOUT_MS = 120_000

/** One route this plugin registers. */
export interface RouteSpec {
  /** Route key used by the browser half. */
  readonly key: 'tree' | 'status' | 'diff' | 'rollback' | 'commit' | 'generateMessage' | 'watch' | 'sync' | 'activity' | 'activityClear'
  /** Path below the API prefix. */
  readonly path: string
  /** The one HTTP method the handler serves; the other channel verb answers 405. */
  readonly method: 'GET' | 'POST'
  /**
   * True when the request and the `git` calls it makes stay out of the activity
   * buffer, so housekeeping never evicts a real action from it.
   */
  readonly silent?: boolean
}

/** The route table. */
export const ROUTES: readonly RouteSpec[] = [
  { key: 'tree', path: `${API_PREFIX}/repos/tree`, method: 'GET' },
  { key: 'status', path: `${API_PREFIX}/repo/status`, method: 'POST' },
  { key: 'diff', path: `${API_PREFIX}/repo/diff`, method: 'POST' },
  { key: 'rollback', path: `${API_PREFIX}/repo/rollback`, method: 'POST' },
  { key: 'commit', path: `${API_PREFIX}/repo/commit`, method: 'POST' },
  { key: 'generateMessage', path: `${API_PREFIX}/repo/generate-message`, method: 'POST' },
  { key: 'watch', path: `${API_PREFIX}/repo/watch`, method: 'POST', silent: true },
  { key: 'sync', path: `${API_PREFIX}/repo/sync`, method: 'POST' },
  { key: 'activity', path: `${API_PREFIX}/activity`, method: 'GET', silent: true },
  { key: 'activityClear', path: `${API_PREFIX}/activity/clear`, method: 'POST', silent: true },
]

/** HTTP methods the shared `/api` channel dispatches to an exact Fetch route. */
export const CHANNEL_METHODS = ['GET', 'POST'] as const

/** One repository the tree knows about. */
export interface RepoNode {
  /** Stable id: `root`, or `<workspace>/<domain>/<repo>`. */
  readonly id: string
  /** Directory name shown in the tree. */
  readonly label: string
  /** Absolute path on the Host filesystem. */
  readonly path: string
}

/** One domain directory and the repositories inside it. */
export interface DomainNode {
  readonly name: string
  readonly repos: readonly RepoNode[]
}

/** One workspace directory and its domains. */
export interface WorkspaceNode {
  readonly name: string
  readonly domains: readonly DomainNode[]
}

/** Answer of `repos/tree`. */
export interface WorkspaceTreeResponse {
  /** False when no Aweave root could be resolved; the browser shows an actionable empty state. */
  readonly configured: boolean
  /** Resolved root, or null when unresolved. */
  readonly aweaveRoot: string | null
  /** The platform root repository. */
  readonly rootRepo: RepoNode | null
  /** Workspace repositories grouped by `<workspace>/<domain>`. */
  readonly workspaces: readonly WorkspaceNode[]
}

/** One changed path, measured as the net difference between `HEAD` and the working tree. */
export interface FileChangeEntry {
  /** Repository-relative path. */
  readonly path: string
  /** The path this one was renamed from, when `status` is `R`. */
  readonly origPath?: string
  /** `M` modified, `A` added, `D` deleted, `R` renamed, `T` type change. */
  readonly status: 'M' | 'A' | 'D' | 'R' | 'T'
}

/** Answer of `repo/status`. */
export interface RepoStatusResponse {
  readonly repoId: string
  readonly branch: string
  /** Current `HEAD` OID, or null on an unborn branch. */
  readonly headOid: string | null
  /** Abbreviated `HEAD`, or `initial` on an unborn branch. */
  readonly headShortSha: string
  /** Message of the `HEAD` commit, empty on an unborn branch. */
  readonly lastCommitMessage: string
  /** Configured upstream of the current branch, if any. */
  readonly upstream: string | null
  /** Commits ahead of the upstream. */
  readonly ahead: number
  /** Commits behind the upstream. */
  readonly behind: number
  /** Resolved push target (`@{push}`), or null when none is configured. */
  readonly pushTarget: string | null
  /** Whether `HEAD` is already reachable from `@{push}`. */
  readonly headPublished: boolean
  /** Configured remote names. */
  readonly remotes: readonly string[]
  /** Net changed paths between `HEAD` and the working tree. */
  readonly changes: readonly FileChangeEntry[]
  /** Untracked paths. */
  readonly unversioned: readonly string[]
  /**
   * SHA-1 of the raw `git status --porcelain=v2 --branch -z --untracked-files=all`
   * output this status was built from. `repo/watch` hashes the same command with
   * the same helper, so the two routes agree by construction and the browser only
   * has to compare one string.
   */
  readonly statusDigest: string
}

/** One changed line span inside a hunk. */
export interface DiffLine {
  readonly kind: 'context' | 'add' | 'del'
  readonly text: string
  /** 1-based line number in the old side, or null when the line is an addition. */
  readonly oldLine: number | null
  /** 1-based line number in the new side, or null when the line is a deletion. */
  readonly newLine: number | null
}

/** One unified-diff hunk with a content-stable identity. */
export interface DiffHunk {
  /** Content fingerprint that survives renumbering after another hunk is reverted. */
  readonly contentKey: string
  readonly header: string
  readonly oldStart: number
  readonly oldLines: number
  readonly newStart: number
  readonly newLines: number
  readonly lines: readonly DiffLine[]
}

/** Answer of `repo/diff`. */
export interface FileDiffResponse {
  readonly repoId: string
  readonly path: string
  readonly origPath: string | null
  readonly status: FileChangeEntry['status'] | 'U'
  readonly headOid: string | null
  readonly headShortSha: string
  readonly binary: boolean
  /** Total changed lines (additions plus deletions) across every hunk. */
  readonly changedLines: number
  readonly hunks: readonly DiffHunk[]
}

/** One file's inclusion state, as the browser half reports it at commit time. */
export interface FileInclusionRequest {
  readonly path: string
  readonly origPath?: string
  readonly status: FileChangeEntry['status'] | 'U'
  /**
   * False means "whole file". True means "only `hunkKeys`".
   */
  readonly partial: boolean
  /** Content keys of the hunks to include when `partial` is true. */
  readonly hunkKeys?: readonly string[]
}

/** Body of `repo/commit`. */
export interface CommitRequest {
  readonly repoId: string
  /** The `HEAD` the browser's view was built from; the Host refuses a moved `HEAD`. */
  readonly expectedHeadOid: string | null
  readonly message: string
  readonly amend: boolean
  readonly files: readonly FileInclusionRequest[]
  readonly push: boolean
}

/**
 * Why a push did not land.
 *
 * `PUSH_REJECTED` is git's own non-fast-forward refusal, which the tool window
 * answers with the rebase-or-merge offer; everything else stays `PUSH_FAILED`.
 */
export type PushErrorCode = 'NO_PUSH_TARGET' | 'PUSH_REJECTED' | 'PUSH_FAILED'

/** Answer of `repo/commit`. */
export interface CommitResponse {
  readonly committed: boolean
  readonly commitSha: string | null
  readonly indexSynced: boolean
  readonly indexSyncError?: string
  /** True when `HEAD` was not the expected commit after the commit ran. */
  readonly headMovedDuringCommit: boolean
  readonly pushed: boolean
  readonly pushTarget?: string
  readonly pushErrorCode?: PushErrorCode
  readonly pushError?: string
}

/** Body of `repo/watch`. */
export interface WatchRequest {
  readonly repoId: string
}

/** Answer of `repo/watch`: the digest and the branch facts, never the file lists. */
export interface WatchResponse {
  /** SHA-1 of the raw porcelain output, the same value `RepoStatusResponse.statusDigest` carries. */
  readonly digest: string
  readonly headOid: string | null
  readonly branch: string
  readonly ahead: number
  readonly behind: number
}

/**
 * How `repo/sync` integrates the push target.
 *
 * `push` is the push-only leg the persistent `Push…` action uses; `rebase` and
 * `merge` are the two orders offered after a rejected push.
 */
export type SyncMode = 'push' | 'rebase' | 'merge'

/** Body of `repo/sync`. */
export interface SyncRequest {
  readonly repoId: string
  /** The `HEAD` the browser's view was built from; the Host refuses a moved `HEAD`. */
  readonly expectedHeadOid: string | null
  readonly mode: SyncMode
}

/** Answer of `repo/sync`. */
export interface SyncResponse {
  readonly mode: SyncMode
  readonly headOid: string | null
  readonly headShortSha: string
  readonly pushed: boolean
  readonly pushTarget?: string
  readonly pushErrorCode?: PushErrorCode
  readonly pushError?: string
  /** Paths left unmerged by an integration that then aborted; always null on success. */
  readonly conflictPaths?: readonly string[]
}

/** One recorded action: an `/api` request or a `git` invocation. */
export interface ActivityEntry {
  /** Monotonic per-host-process id; also the React row key. */
  readonly id: number
  /** Epoch milliseconds when the action settled. */
  readonly at: number
  readonly kind: 'api' | 'git'
  /** Short name: the route key, or `git <subcommand>`. */
  readonly label: string
  /** One line of context: method/path/status, or argv/cwd/exit code. */
  readonly detail: string
  readonly ok: boolean
  readonly durationMs: number
  /** Captured output, already truncated to `ACTIVITY_OUTPUT_LIMIT` characters. */
  readonly output?: string
  /** True when `output` was cut. */
  readonly truncated?: boolean
  /** Id of the request that caused this entry; absent for entries recorded outside a request scope. */
  readonly requestId?: number
  /** `auto` for watcher-driven requests, `user` otherwise; absent outside a request scope. */
  readonly origin?: 'user' | 'auto'
}

/** Whole-ring facts every activity answer carries, independent of the `after` cursor. */
export interface ActivityMeta {
  /** Random per ring (one per host process and plugin instance); a change means ids restarted. */
  readonly bootId: string
  /** Oldest retained entry id, or null when the ring is empty. */
  readonly oldestId: number | null
  /** Last allocated entry id, 0 before the first entry. */
  readonly latestId: number
}

/** Answer of `activity`. */
export interface ActivityListResponse extends ActivityMeta {
  /** Entries with `id > after` (all entries without a cursor), oldest first. */
  readonly entries: readonly ActivityEntry[]
}

/** Answer of `activity/clear`. */
export interface ActivityClearResponse {
  readonly cleared: number
  readonly bootId: string
  readonly latestId: number
}

/** Body of `repo/rollback`. */
export interface RollbackRequest {
  readonly repoId: string
  readonly expectedHeadOid: string | null
  readonly files: readonly FileInclusionRequest[]
  /** Required to delete an untracked path from disk, or a path absent from `HEAD`. */
  readonly confirmDeletePaths: boolean
}

/** Answer of `repo/rollback`. */
export interface RollbackResponse {
  readonly rolledBack: readonly string[]
  readonly headOid: string | null
}

/** Body of `repo/generate-message`. */
export interface GenerateMessageRequest {
  readonly repoId: string
  readonly files: readonly FileInclusionRequest[]
  /** The Session on screen, used to reuse its model route. */
  readonly sessionId?: string
}

/** Answer of `repo/generate-message`. */
export interface GenerateMessageResponse {
  readonly message: string
  readonly route: { readonly provider: string; readonly model: string }
  /** True when the diff had to be cut to stay inside the byte budget. */
  readonly truncated: boolean
}

/** Error envelope every route returns on failure. */
export interface ApiErrorBody {
  readonly code: string
  readonly message: string
  /** Extra machine-readable detail, for example the recovery command. */
  readonly details?: Record<string, unknown>
}

/** Inclusion state of one file in the browser store. */
export type FileInclusion =
  | { readonly mode: 'all' }
  | { readonly mode: 'none' }
  | { readonly mode: 'partial'; readonly hunkKeys: readonly string[] }
