/**
 * Fenced `/api/dsh-intellij-git/*` routes.
 *
 * Registering through `ctx.connection.fetch.register` is what fences them: the
 * shared `/api` channel runs admission (403 foreign Host, 401 without the
 * browser cookie) before any route lookup. Each route declares both channel
 * verbs, serves the one it intends, and answers the other with 405 plus Allow.
 *
 * No route trusts a client path. `repoId` is re-derived into an absolute path
 * from a validated id, then re-checked with `realpath`, and every
 * repository-relative path is re-resolved inside that repository.
 */
import { realpath, stat } from 'node:fs/promises'
import { join } from 'node:path'

import type { Context } from '@deepseek-ai/cordis'
import type { ConnectionFetchRoute } from '@deepseek-ai/dsh-client-connection'

import {
  CHANNEL_METHODS,
  INTEGRATE_TIMEOUT_MS,
  ORIGIN_HEADER,
  ROUTES,
  type ActivityClearResponse,
  type ActivityListResponse,
  type ApiErrorBody,
  type CommitRequest,
  type FileInclusionRequest,
  type BranchesResponse,
  type GenerateMessageRequest,
  type RepoStatusResponse,
  type RollbackRequest,
  type RouteSpec,
  type SwitchRequest,
  type SwitchResponse,
  type SwitchTarget,
  type SyncMode,
  type SyncRequest,
  type WatchResponse,
  type WorkspaceTreeResponse,
} from '../config.ts'
import type { ActivityLog } from './activity-log.ts'
import { generateCommitMessage } from './commit-message-ai.ts'
import { readFileDiff } from './git-diff.ts'
import { listBranches, switchBranch as switchBranchOp } from './git-branches.ts'
import { commitRepo, integrateRepo, rollbackRepo } from './git-operations.ts'
import { readStatus, readWatch } from './git-status.ts'
import { ApiHttpError } from './http-error.ts'
import { discoverTree, isInside, resolveAweaveRoot, resolveRepoPath } from './workspace-tree.ts'

/** Host-configurable facts the handlers need. */
export interface RouteOptions {
  readonly aweaveRoot: string
  readonly gitTimeoutMs: number
  readonly llmProvider: string
  readonly llmModel: string
  /** The activity buffer every request and every `git` call is recorded in. */
  readonly activity: ActivityLog
}

/** Largest request body any route accepts. */
const MAX_BODY_BYTES = 1024 * 1024

/**
 * A JSON success response.
 * @param data - payload.
 * @returns the response.
 */
function ok(data: unknown): Response {
  return Response.json({ ok: true, data }, { headers: { 'cache-control': 'no-store' } })
}

/**
 * A JSON error response.
 * @param status - HTTP status.
 * @param error - error envelope.
 * @param headers - extra headers.
 * @returns the response.
 */
function fail(status: number, error: ApiErrorBody, headers: Record<string, string> = {}): Response {
  return Response.json({ ok: false, error }, { status, headers: { 'cache-control': 'no-store', ...headers } })
}

/**
 * Read a bounded JSON object body.
 * @param request - the incoming request.
 * @returns the parsed object, or a Response to short-circuit with.
 */
async function jsonBody(request: Request): Promise<Record<string, unknown> | Response> {
  const text = await request.text()
  if (Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) return fail(413, { code: 'TOO_LARGE', message: 'request body too large' })
  try {
    const parsed: unknown = JSON.parse(text === '' ? '{}' : text)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return fail(400, { code: 'BAD_REQUEST', message: 'body must be a JSON object' })
    return parsed as Record<string, unknown>
  } catch {
    return fail(400, { code: 'BAD_REQUEST', message: 'body is not valid JSON' })
  }
}

/**
 * Validate and resolve one repository to an absolute real path.
 * @param aweaveRoot - resolved platform root.
 * @param repoId - the id the client sent.
 * @returns the absolute repository root.
 */
async function repoRootOf(aweaveRoot: string, repoId: unknown): Promise<string> {
  if (typeof repoId !== 'string' || repoId === '') throw new ApiHttpError(400, { code: 'BAD_REPO', message: 'repoId is required' })
  const candidate = resolveRepoPath(aweaveRoot, repoId)
  if (candidate === null) throw new ApiHttpError(400, { code: 'BAD_REPO', message: `unknown repository id: ${repoId}` })
  const real = await realpath(candidate).catch(() => null)
  if (real === null || !isInside(aweaveRoot, real)) throw new ApiHttpError(404, { code: 'NO_REPO', message: `repository not found: ${repoId}` })
  const gitDir = await stat(join(real, '.git')).catch(() => null)
  if (gitDir === null) throw new ApiHttpError(404, { code: 'NO_REPO', message: `not a git repository: ${repoId}` })
  return real
}

/** One inclusion as the client sends it. */
function parseInclusions(raw: unknown): FileInclusionRequest[] {
  if (!Array.isArray(raw)) return []
  const files: FileInclusionRequest[] = []
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue
    const record = entry as Record<string, unknown>
    const path = typeof record['path'] === 'string' ? record['path'] : ''
    if (path === '') continue
    const rawStatus = typeof record['status'] === 'string' ? record['status'] : 'M'
    const status = rawStatus === 'A' || rawStatus === 'D' || rawStatus === 'R' || rawStatus === 'T' || rawStatus === 'U' ? rawStatus : 'M'
    const partial = record['partial'] === true
    const keys = Array.isArray(record['hunkKeys']) ? record['hunkKeys'].filter((key): key is string => typeof key === 'string') : []
    const origPath = typeof record['origPath'] === 'string' && record['origPath'] !== '' ? record['origPath'] : undefined
    files.push({
      path,
      ...(origPath === undefined ? {} : { origPath }),
      status,
      partial,
      ...(partial ? { hunkKeys: keys } : {}),
    })
  }
  return files
}

/**
 * One switch target as the client sends it.
 * @param raw - the request's `target` field.
 * @returns the validated target, or null when it is not one.
 */
function parseTarget(raw: unknown): SwitchTarget | null {
  if (typeof raw !== 'object' || raw === null) return null
  const record = raw as Record<string, unknown>
  const kind = record['kind']
  const name = record['name']
  if (kind !== 'local' && kind !== 'remote' && kind !== 'new') return null
  if (typeof name !== 'string' || name === '') return null
  return { kind, name }
}

/**
 * Read the optional `expectedBranch` leniently.
 *
 * Three distinct answers, deliberately: a string checks that branch, `null`
 * checks that `HEAD` was detached, and an absent field skips the branch half of
 * the compare-and-swap so a raw OID-only caller keeps the old contract.
 * @param raw - the request's `expectedBranch` field.
 * @returns the branch, null, or undefined to skip the check.
 */
function parseExpectedBranch(raw: unknown): string | null | undefined {
  if (raw === undefined) return undefined
  if (raw === null) return null
  return typeof raw === 'string' ? raw : undefined
}

/**
 * The `expectedBranch` field to spread into a request, when the client sent one.
 * @param raw - the request's `expectedBranch` field.
 * @returns an object carrying the field, or an empty object to skip the check.
 */
function expectedBranchField(raw: unknown): { readonly expectedBranch?: string | null } {
  const value = parseExpectedBranch(raw)
  return value === undefined ? {} : { expectedBranch: value }
}

/**
 * Build the handlers of every route.
 * @param options - resolved root and settings.
 * @returns one handler per route key.
 */
export function createHandlers(ctx: Context, options: RouteOptions): Record<RouteSpec['key'], (request: Request) => Promise<Response>> {
  const timeoutMs = options.gitTimeoutMs

  const tree = async (): Promise<Response> => {
    const root = await resolveAweaveRoot(options.aweaveRoot)
    const response: WorkspaceTreeResponse = await discoverTree(root)
    return ok(response)
  }

  const status = async (request: Request): Promise<Response> => {
    const body = await jsonBody(request)
    if (body instanceof Response) return body
    const root = await requireRoot(options.aweaveRoot)
    const repoRoot = await repoRootOf(root, body['repoId'])
    const response: RepoStatusResponse = await readStatus(repoRoot, String(body['repoId']), timeoutMs)
    return ok(response)
  }

  const diff = async (request: Request): Promise<Response> => {
    const body = await jsonBody(request)
    if (body instanceof Response) return body
    const root = await requireRoot(options.aweaveRoot)
    const repoId = typeof body['repoId'] === 'string' ? body['repoId'] : ''
    const repoRoot = await repoRootOf(root, repoId)
    const path = typeof body['path'] === 'string' ? body['path'] : ''
    if (path === '') return fail(400, { code: 'BAD_PATH', message: 'path is required' })
    const rawStatus = typeof body['status'] === 'string' ? body['status'] : 'M'
    const status = rawStatus === 'A' || rawStatus === 'D' || rawStatus === 'R' || rawStatus === 'T' || rawStatus === 'U' ? rawStatus : 'M'
    const origPath = typeof body['origPath'] === 'string' && body['origPath'] !== '' ? body['origPath'] : null
    const response = await readFileDiff({ repoRoot, path, origPath, status, timeoutMs })
    return ok({ ...response, repoId })
  }

  const rollback = async (request: Request): Promise<Response> => {
    const body = await jsonBody(request)
    if (body instanceof Response) return body
    const root = await requireRoot(options.aweaveRoot)
    const repoRoot = await repoRootOf(root, body['repoId'])
    const payload: RollbackRequest = {
      repoId: String(body['repoId']),
      expectedHeadOid: typeof body['expectedHeadOid'] === 'string' ? body['expectedHeadOid'] : null,
      ...expectedBranchField(body['expectedBranch']),
      files: parseInclusions(body['files']),
      confirmDeletePaths: body['confirmDeletePaths'] === true,
    }
    if (payload.files.length === 0) return fail(400, { code: 'NO_SELECTION', message: 'select at least one change first' })
    return ok(await rollbackRepo({ repoRoot, request: payload, timeoutMs }))
  }

  const commit = async (request: Request): Promise<Response> => {
    const body = await jsonBody(request)
    if (body instanceof Response) return body
    const root = await requireRoot(options.aweaveRoot)
    const repoRoot = await repoRootOf(root, body['repoId'])
    const payload: CommitRequest = {
      repoId: String(body['repoId']),
      expectedHeadOid: typeof body['expectedHeadOid'] === 'string' ? body['expectedHeadOid'] : null,
      ...expectedBranchField(body['expectedBranch']),
      message: typeof body['message'] === 'string' ? body['message'] : '',
      amend: body['amend'] === true,
      files: parseInclusions(body['files']),
      push: body['push'] === true,
    }
    if (payload.files.length === 0) return fail(400, { code: 'NO_SELECTION', message: 'select at least one change first' })
    return ok(await commitRepo({ repoRoot, request: payload, timeoutMs }))
  }

  const generateMessage = async (request: Request): Promise<Response> => {
    const body = await jsonBody(request)
    if (body instanceof Response) return body
    const root = await requireRoot(options.aweaveRoot)
    const repoRoot = await repoRootOf(root, body['repoId'])
    const payload: GenerateMessageRequest = {
      repoId: String(body['repoId']),
      files: parseInclusions(body['files']),
      ...(typeof body['sessionId'] === 'string' && body['sessionId'] !== '' ? { sessionId: body['sessionId'] } : {}),
    }
    return ok(await generateCommitMessage({
      ctx,
      config: { llmProvider: options.llmProvider, llmModel: options.llmModel },
      repoRoot,
      files: payload.files,
      sessionId: payload.sessionId,
      timeoutMs,
    }))
  }

  /**
   * The silent probe: one `git status` compared by digest on the browser side.
   *
   * The whole handler runs `silenced`, not just the record call, or the tick's
   * own `git status` would still reach the observer and evict real entries from
   * the bounded buffer.
   */
  const watch = async (request: Request): Promise<Response> => {
    const body = await jsonBody(request)
    if (body instanceof Response) return body
    const root = await requireRoot(options.aweaveRoot)
    options.activity.setRoot(root)
    const repoRoot = await repoRootOf(root, body['repoId'])
    const response: WatchResponse = await options.activity.silenced(() => readWatch(repoRoot, timeoutMs))
    return ok(response)
  }

  const sync = async (request: Request): Promise<Response> => {
    const body = await jsonBody(request)
    if (body instanceof Response) return body
    const root = await requireRoot(options.aweaveRoot)
    options.activity.setRoot(root)
    const repoRoot = await repoRootOf(root, body['repoId'])
    const rawMode = typeof body['mode'] === 'string' ? body['mode'] : ''
    if (rawMode !== 'push' && rawMode !== 'rebase' && rawMode !== 'merge') {
      return fail(400, { code: 'BAD_MODE', message: 'mode must be push, rebase or merge' })
    }
    const payload: SyncRequest = {
      repoId: String(body['repoId']),
      expectedHeadOid: typeof body['expectedHeadOid'] === 'string' ? body['expectedHeadOid'] : null,
      ...expectedBranchField(body['expectedBranch']),
      mode: rawMode as SyncMode,
    }
    return ok(await integrateRepo({ repoRoot, request: payload, timeoutMs: INTEGRATE_TIMEOUT_MS }))
  }

  const branches = async (request: Request): Promise<Response> => {
    const body = await jsonBody(request)
    if (body instanceof Response) return body
    const root = await requireRoot(options.aweaveRoot)
    const repoId = typeof body['repoId'] === 'string' ? body['repoId'] : ''
    const repoRoot = await repoRootOf(root, repoId)
    options.activity.setRoot(repoRoot)
    const response: BranchesResponse = await listBranches(repoRoot, repoId, timeoutMs)
    return ok(response)
  }

  const switchBranch = async (request: Request): Promise<Response> => {
    const body = await jsonBody(request)
    if (body instanceof Response) return body
    const root = await requireRoot(options.aweaveRoot)
    const repoId = typeof body['repoId'] === 'string' ? body['repoId'] : ''
    const repoRoot = await repoRootOf(root, repoId)
    options.activity.setRoot(repoRoot)
    const target = parseTarget(body['target'])
    if (target === null) {
      return fail(400, { code: 'INVALID_REQUEST', message: 'target must be {kind: local|remote|new, name: <non-empty string>}' })
    }
    const payload: SwitchRequest = {
      repoId,
      target,
      expectedHeadOid: typeof body['expectedHeadOid'] === 'string' ? body['expectedHeadOid'] : null,
      ...expectedBranchField(body['expectedBranch']),
    }
    const response: SwitchResponse = await switchBranchOp(repoRoot, payload, timeoutMs)
    return ok(response)
  }

  const activity = async (request: Request): Promise<Response> => {
    const raw = new URL(request.url).searchParams.get('after')
    let after: number | undefined
    if (raw !== null) {
      if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
        return fail(400, { code: 'INVALID_REQUEST', message: 'after must be a non-negative integer' })
      }
      after = Number(raw)
    }
    // Entries first, metadata second, with no await between: both describe the same instant.
    const entries = options.activity.list(after)
    const response: ActivityListResponse = { entries, ...options.activity.meta() }
    return ok(response)
  }

  const activityClear = async (): Promise<Response> => {
    const cleared = options.activity.clear()
    const { bootId, latestId } = options.activity.meta()
    const response: ActivityClearResponse = { cleared, bootId, latestId }
    return ok(response)
  }

  return { tree, status, diff, rollback, commit, generateMessage, watch, sync, branches, switchBranch, activity, activityClear }
}

/**
 * Require a resolved Aweave root.
 * @param configured - the `aweaveRoot` config value.
 * @returns the resolved root.
 */
async function requireRoot(configured: string): Promise<string> {
  const root = await resolveAweaveRoot(configured)
  if (root === null) {
    throw new ApiHttpError(409, {
      code: 'AWEAVE_ROOT_UNRESOLVED',
      message: 'no Aweave root was resolved; set aweaveRoot in the profile patch',
    })
  }
  return root
}

/**
 * Register every route, owned by this context.
 * @param ctx - Host context owning the `connection` service.
 * @param options - resolved root and settings.
 */
export function registerRoutes(ctx: Context, options: RouteOptions): void {
  const handlers = createHandlers(ctx, options)
  for (const spec of ROUTES) {
    const handler = handlers[spec.key]
    const route: ConnectionFetchRoute = {
      path: spec.path,
      methods: CHANNEL_METHODS,
      requestBody: 'buffered',
      fetch: async (request) => {
        if (request.method !== spec.method) {
          return fail(405, { code: 'METHOD_NOT_ALLOWED', message: `use ${spec.method}` }, { allow: spec.method })
        }
        // A silent route opens no request scope: it records nothing, and its id would only be noise.
        const origin = request.headers.get(ORIGIN_HEADER) === 'auto' ? 'auto' : 'user'
        const run = async (): Promise<Response> => {
          const startedAt = Date.now()
          let response: Response
          try {
            response = await handler(request)
          } catch (error) {
            response = error instanceof ApiHttpError
              ? fail(error.status, error.body)
              : fail(500, { code: 'INTERNAL', message: error instanceof Error ? error.message : String(error) })
          }
          if (spec.silent !== true) {
            // Cloning before reading keeps the caller's body intact: consuming the
            // original would hand the browser an empty response.
            const body = await response.clone().text().catch(() => '')
            options.activity.recordApi({
              key: spec.key,
              method: request.method,
              path: new URL(request.url).pathname,
              status: response.status,
              durationMs: Date.now() - startedAt,
              output: body,
            })
          }
          return response
        }
        return spec.silent === true ? run() : options.activity.withRequest(origin, run)
      },
    }
    ctx.effect(() => {
      const dispose = ctx.connection.fetch.register(route)
      return () => { void dispose() }
    }, `dsh-intellij-git: ${spec.path}`)
  }
}
