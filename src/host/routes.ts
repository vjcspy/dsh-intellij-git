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
  ROUTES,
  type ApiErrorBody,
  type CommitRequest,
  type FileInclusionRequest,
  type GenerateMessageRequest,
  type RepoStatusResponse,
  type RollbackRequest,
  type RouteSpec,
  type WorkspaceTreeResponse,
} from '../config.ts'
import { generateCommitMessage } from './commit-message-ai.ts'
import { readFileDiff } from './git-diff.ts'
import { commitRepo, rollbackRepo } from './git-operations.ts'
import { readStatus } from './git-status.ts'
import { ApiHttpError } from './http-error.ts'
import { discoverTree, isInside, resolveAweaveRoot, resolveRepoPath } from './workspace-tree.ts'

/** Host-configurable facts the handlers need. */
export interface RouteOptions {
  readonly aweaveRoot: string
  readonly gitTimeoutMs: number
  readonly llmProvider: string
  readonly llmModel: string
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

  return { tree, status, diff, rollback, commit, generateMessage }
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
        try {
          return await handler(request)
        } catch (error) {
          if (error instanceof ApiHttpError) return fail(error.status, error.body)
          return fail(500, { code: 'INTERNAL', message: error instanceof Error ? error.message : String(error) })
        }
      },
    }
    ctx.effect(() => {
      const dispose = ctx.connection.fetch.register(route)
      return () => { void dispose() }
    }, `dsh-intellij-git: ${spec.path}`)
  }
}
