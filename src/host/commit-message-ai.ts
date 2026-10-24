/**
 * Commit-message generation from the CURRENTLY INCLUDED changes only.
 *
 * Two deliberate properties. The diff handed to the model is rebuilt from the
 * inclusion set, so the message never describes a change the Human excluded.
 * And the call carries no `sessionId`, which keeps it out of the conversation
 * transcript and out of the checkpoint policy, exactly as the Session
 * classifier does for its own hidden call.
 *
 * The route is resolved in tiers so the feature works with no configuration:
 * plugin config, then the on-screen Session's own logged route, then the
 * deployment default, then any advertised provider.
 */
import {
  MAX_AI_DIFF_BYTES,
  type FileInclusionRequest,
  type GenerateMessageResponse,
} from '../config.ts'
import { buildPatch, readFileDiff } from './git-diff.ts'
import { ApiHttpError } from './http-error.ts'

/** The slice of one stream chunk this module reads. */
interface StreamChunk {
  readonly type: string
  readonly text?: string
  readonly delta?: string
}

/** The slice of the model service this module calls. */
interface LlmLike {
  stream(options: Record<string, unknown>): AsyncIterable<StreamChunk>
  listProviders?(): Promise<readonly { id?: string, provider?: string, models?: readonly string[] }[]> | readonly { id?: string, provider?: string, models?: readonly string[] }[]
  listModels?(provider: string): Promise<readonly (string | { id?: string, model?: string })[]> | readonly (string | { id?: string, model?: string })[]
}

/** A resolved model route. */
interface Route {
  readonly provider: string
  readonly model: string
}

/** The system instruction sent with the diff. */
const SYSTEM_PROMPT = [
  'You write git commit messages.',
  'Answer with ONE conventional-commit subject line, at most 72 characters, in the imperative mood.',
  'Do not add a body, commentary, quotes or code fences. Reply with the subject line only.',
].join(' ')

/**
 * Read an optional service without declaring it as a required injection.
 * @param ctx - Host context.
 * @param name - service name.
 * @returns the service, or undefined when it is not mounted.
 */
function optionalService<T>(ctx: unknown, name: string): T | undefined {
  const holder = ctx as { get?: (key: string) => unknown }
  if (typeof holder.get !== 'function') return undefined
  return holder.get(name) as T | undefined
}

/**
 * Build the bounded diff text for a set of inclusions.
 * @param repoRoot - absolute repository root.
 * @param files - the requested inclusions.
 * @param timeoutMs - deadline of each `git` call.
 * @returns the diff text and whether it had to be cut.
 */
async function collectDiff(repoRoot: string, files: readonly FileInclusionRequest[], timeoutMs: number): Promise<{ text: string, truncated: boolean }> {
  const parts: string[] = []
  let used = 0
  let truncated = false
  for (const file of files) {
    const diff = await readFileDiff({
      repoRoot,
      path: file.path,
      origPath: file.origPath ?? null,
      status: file.status,
      timeoutMs,
    })
    const keys = file.partial ? file.hunkKeys ?? [] : null
    const hunks = keys === null ? diff.hunks : diff.hunks.filter(hunk => keys.includes(hunk.contentKey))
    if (hunks.length === 0) continue
    const kind = file.status === 'U' || file.status === 'A' ? 'new' : file.status === 'D' ? 'delete' : 'edit'
    const patch = buildPatch(file.path, hunks, kind)
    const size = Buffer.byteLength(patch, 'utf8')
    if (used + size > MAX_AI_DIFF_BYTES) {
      truncated = true
      const room = MAX_AI_DIFF_BYTES - used
      if (room > 0) parts.push(patch.slice(0, room))
      break
    }
    parts.push(patch)
    used += size
  }
  return { text: parts.join('\n'), truncated }
}

/**
 * Resolve the model route in tiers.
 * @param ctx - Host context.
 * @param config - plugin configuration.
 * @param sessionId - the Session on screen, when the browser sent one.
 * @returns the route to use.
 */
async function resolveRoute(ctx: unknown, config: { llmProvider: string, llmModel: string }, sessionId: string | undefined): Promise<Route> {
  if (config.llmProvider !== '' && config.llmModel !== '') return { provider: config.llmProvider, model: config.llmModel }

  if (sessionId !== undefined) {
    const sessions = optionalService<{ get(id: string): { requestHeader?(): { config?: { provider?: string, model?: string } } | undefined } | undefined }>(ctx, 'sessions')
    const header = sessions?.get(sessionId)?.requestHeader?.()
    const provider = header?.config?.provider ?? ''
    const model = header?.config?.model ?? ''
    if (provider !== '' && model !== '') return { provider, model }
  }

  const defaults = optionalService<{ currentSelection?(): { provider?: string, model?: string } | undefined }>(ctx, 'agentDefaultModel')
  const selection = defaults?.currentSelection?.()
  if (selection?.provider !== undefined && selection.provider !== '' && selection.model !== undefined && selection.model !== '') {
    return { provider: selection.provider, model: selection.model }
  }

  const llm = optionalService<LlmLike>(ctx, 'llm')
  if (llm === undefined) throw new ApiHttpError(503, { code: 'NO_LLM', message: 'no model service is mounted; cannot generate a commit message' })
  const providers = (await llm.listProviders?.()) ?? []
  for (const entry of providers) {
    const provider = entry.id ?? entry.provider ?? ''
    if (provider === '') continue
    if (entry.models !== undefined && entry.models.length > 0) return { provider, model: entry.models[0] ?? '' }
    const models = (await llm.listModels?.(provider)) ?? []
    const first = models[0]
    const model = typeof first === 'string' ? first : first?.id ?? first?.model ?? ''
    if (model !== '') return { provider, model }
  }
  throw new ApiHttpError(503, { code: 'NO_ROUTE', message: 'no usable provider/model route is available; configure llmProvider and llmModel' })
}

/**
 * Generate a commit message for the included changes.
 * @param options - context, config, repository root, inclusions, Session and deadline.
 * @returns the message and the route that produced it.
 */
export async function generateCommitMessage(options: {
  readonly ctx: unknown
  readonly config: { llmProvider: string, llmModel: string }
  readonly repoRoot: string
  readonly files: readonly FileInclusionRequest[]
  readonly sessionId: string | undefined
  readonly timeoutMs: number
}): Promise<GenerateMessageResponse> {
  const { ctx, config, repoRoot, files, sessionId, timeoutMs } = options
  if (files.length === 0) throw new ApiHttpError(400, { code: 'NO_SELECTION', message: 'select at least one change first' })

  const llm = optionalService<LlmLike>(ctx, 'llm')
  if (llm === undefined) throw new ApiHttpError(503, { code: 'NO_LLM', message: 'no model service is mounted; cannot generate a commit message' })

  const route = await resolveRoute(ctx, config, sessionId)
  const diff = await collectDiff(repoRoot, files, timeoutMs)
  if (diff.text.trim() === '') throw new ApiHttpError(400, { code: 'EMPTY_DIFF', message: 'the selected changes produce no diff' })

  const stream = llm.stream({
    provider: route.provider,
    model: route.model,
    system: SYSTEM_PROMPT,
    messages: [{
      role: 'user',
      content: [{ type: 'text', text: `Write the commit message for this change.\n\n${diff.text}` }],
    }],
    temperature: 0,
  })

  let message = ''
  for await (const chunk of stream) {
    if (chunk.type !== 'text-delta') continue
    message += chunk.text ?? chunk.delta ?? ''
  }

  const cleaned = message.split('\n').map(line => line.trim()).filter(line => line !== '')
    .map(line => line.replace(/^```[a-z]*$/i, '').replace(/^["'`]|["'`]$/g, ''))
    .filter(line => line !== '')
    .slice(0, 1)
    .join('')
  if (cleaned === '') throw new ApiHttpError(502, { code: 'EMPTY_COMPLETION', message: 'the model returned no message; try again' })
  return { message: cleaned, route, truncated: diff.truncated }
}
