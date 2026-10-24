/**
 * Typed browser client for `/api/dsh-intellij-git/*`.
 *
 * Same-origin `fetch` carrying the browser cookie; the shared `/api` channel
 * admits the request before any handler runs, so an unauthenticated call comes
 * back as `401` and never reaches `git`.
 */
import type {
  ActivityClearResponse,
  ActivityListResponse,
  ApiErrorBody,
  CommitRequest,
  CommitResponse,
  FileDiffResponse,
  GenerateMessageRequest,
  GenerateMessageResponse,
  RepoStatusResponse,
  RollbackRequest,
  RollbackResponse,
  SyncRequest,
  SyncResponse,
  WatchResponse,
  WorkspaceTreeResponse,
} from '../config.ts'
import { ORIGIN_HEADER, ROUTES } from '../config.ts'

/** One failed API call. */
export class ApiError extends Error {
  /** Machine-readable code from the envelope. */
  readonly code: string
  /** HTTP status. */
  readonly status: number
  /** Extra detail, for example the recovery command. */
  readonly details: Record<string, unknown> | undefined

  /**
   * @param status - HTTP status.
   * @param body - the error envelope.
   */
  constructor(status: number, body: ApiErrorBody) {
    super(body.message)
    this.name = 'ApiError'
    this.status = status
    this.code = body.code
    this.details = body.details
  }
}

/** A route key of this plugin. */
export type RouteKey = (typeof ROUTES)[number]['key']

/** Where each route lives, keyed by its route key. */
const SPEC_BY_KEY = new Map(ROUTES.map(route => [route.key, route]))

/**
 * Resolve one route spec.
 * @param key - route key.
 * @returns the spec.
 */
function specOf(key: RouteKey): (typeof ROUTES)[number] {
  const spec = SPEC_BY_KEY.get(key)
  if (spec === undefined) throw new Error(`unknown route: ${key}`)
  return spec
}

/** Options of {@link createApi}. */
export interface ApiOptions {
  /**
   * Called in a `finally` after every call whose route is not `silent`, success
   * or failure. This is the single choke point the activity dock hangs off, so it
   * cannot drift as actions are added. Silent routes never fire it, which is what
   * stops the dock's own refresh from looping.
   */
  readonly onSettled?: (key: RouteKey) => void
}

/** Extra per-call options. */
export interface CallOptions {
  /** `auto` tags a watcher-driven request so the dock can dim it. */
  readonly origin?: 'user' | 'auto'
  /** Query string without the leading `?`. */
  readonly query?: string
}

/**
 * Create the plugin's route surface.
 * @param options - the settle hook.
 * @returns the typed API.
 */
export function createApi(options: ApiOptions = {}) {
  /**
   * Perform one API call.
   * @param key - route key.
   * @param init - fetch options.
   * @param extra - origin and query.
   * @returns the unwrapped payload.
   */
  async function call<T>(key: RouteKey, init: RequestInit, extra: CallOptions = {}): Promise<T> {
    const spec = specOf(key)
    try {
      const response = await fetch(extra.query === undefined ? spec.path : `${spec.path}?${extra.query}`, {
        ...init,
        credentials: 'same-origin',
        headers: {
          'content-type': 'application/json',
          ...(extra.origin === 'auto' ? { [ORIGIN_HEADER]: 'auto' } : {}),
          ...(init.headers ?? {}),
        },
      })
      const text = await response.text()
      let parsed: unknown
      try {
        parsed = text === '' ? null : JSON.parse(text)
      } catch {
        throw new ApiError(response.status, { code: 'MALFORMED', message: 'the host returned a non-JSON response' })
      }
      if (typeof parsed !== 'object' || parsed === null) {
        throw new ApiError(response.status, { code: 'MALFORMED', message: 'the host returned an empty response' })
      }
      const envelope = parsed as { ok?: boolean, data?: unknown, error?: ApiErrorBody }
      if (envelope.ok === true) return envelope.data as T
      throw new ApiError(response.status, envelope.error ?? { code: 'UNKNOWN', message: `request failed with ${response.status}` })
    } finally {
      if (spec.silent !== true) options.onSettled?.(key)
    }
  }

  /** Post a JSON body. */
  const post = <T>(key: RouteKey, body: unknown, extra?: CallOptions): Promise<T> =>
    call<T>(key, { method: 'POST', body: JSON.stringify(body) }, extra)

  return {
    /** Repository tree for the whole platform. */
    tree: (): Promise<WorkspaceTreeResponse> => call<WorkspaceTreeResponse>('tree', { method: 'GET' }),
    /** One repository's status; `origin: 'auto'` marks a watcher-driven call. */
    status: (repoId: string, extra?: CallOptions): Promise<RepoStatusResponse> => post<RepoStatusResponse>('status', { repoId }, extra),
    /** One file's diff. */
    diff: (body: { repoId: string, path: string, origPath?: string, status: string }): Promise<FileDiffResponse> => post<FileDiffResponse>('diff', body),
    /** Revert selected files or hunks. */
    rollback: (body: RollbackRequest): Promise<RollbackResponse> => post<RollbackResponse>('rollback', body),
    /** Commit the selected changes. */
    commit: (body: CommitRequest): Promise<CommitResponse> => post<CommitResponse>('commit', body),
    /** Generate a commit message from the selected changes. */
    generateMessage: (body: GenerateMessageRequest): Promise<GenerateMessageResponse> => post<GenerateMessageResponse>('generateMessage', body),
    /** The silent digest probe the watcher ticks with. */
    watch: (body: { repoId: string }): Promise<WatchResponse> => post<WatchResponse>('watch', body),
    /** Push, or integrate the push target and push. */
    sync: (body: SyncRequest): Promise<SyncResponse> => post<SyncResponse>('sync', body),
    /** The host-side activity buffer: everything, or only entries newer than `after`. */
    activity: (after?: number): Promise<ActivityListResponse> =>
      call<ActivityListResponse>('activity', { method: 'GET' }, after === undefined ? {} : { query: `after=${after}` }),
    /** Drop every recorded activity entry. */
    clearActivity: (): Promise<ActivityClearResponse> => post<ActivityClearResponse>('activityClear', {}),
  }
}

/** The route surface type. */
export type Api = ReturnType<typeof createApi>
