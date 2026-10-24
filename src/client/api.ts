/**
 * Typed browser client for `/api/dsh-intellij-git/*`.
 *
 * Same-origin `fetch` carrying the browser cookie; the shared `/api` channel
 * admits the request before any handler runs, so an unauthenticated call comes
 * back as `401` and never reaches `git`.
 */
import type {
  ApiErrorBody,
  CommitRequest,
  CommitResponse,
  FileDiffResponse,
  GenerateMessageRequest,
  GenerateMessageResponse,
  RepoStatusResponse,
  RollbackRequest,
  RollbackResponse,
  WorkspaceTreeResponse,
} from '../config.ts'
import { ROUTES } from '../config.ts'

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

/** Where each route lives, keyed by its route key. */
const PATH_BY_KEY = new Map(ROUTES.map(route => [route.key, route.path]))

/**
 * Resolve one route path.
 * @param key - route key.
 * @returns the path.
 */
function pathOf(key: (typeof ROUTES)[number]['key']): string {
  const path = PATH_BY_KEY.get(key)
  if (path === undefined) throw new Error(`unknown route: ${key}`)
  return path
}

/**
 * Perform one API call.
 * @param key - route key.
 * @param init - fetch options.
 * @returns the unwrapped payload.
 */
async function call<T>(key: (typeof ROUTES)[number]['key'], init: RequestInit): Promise<T> {
  const response = await fetch(pathOf(key), {
    ...init,
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
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
}

/** Post a JSON body. */
function post<T>(key: (typeof ROUTES)[number]['key'], body: unknown): Promise<T> {
  return call<T>(key, { method: 'POST', body: JSON.stringify(body) })
}

/** The plugin's route surface. */
export const api = {
  /** Repository tree for the whole platform. */
  tree: (): Promise<WorkspaceTreeResponse> => call<WorkspaceTreeResponse>('tree', { method: 'GET' }),
  /** One repository's status. */
  status: (repoId: string): Promise<RepoStatusResponse> => post<RepoStatusResponse>('status', { repoId }),
  /** One file's diff. */
  diff: (body: { repoId: string, path: string, origPath?: string, status: string }): Promise<FileDiffResponse> => post<FileDiffResponse>('diff', body),
  /** Revert selected files or hunks. */
  rollback: (body: RollbackRequest): Promise<RollbackResponse> => post<RollbackResponse>('rollback', body),
  /** Commit the selected changes. */
  commit: (body: CommitRequest): Promise<CommitResponse> => post<CommitResponse>('commit', body),
  /** Generate a commit message from the selected changes. */
  generateMessage: (body: GenerateMessageRequest): Promise<GenerateMessageResponse> => post<GenerateMessageResponse>('generateMessage', body),
}
