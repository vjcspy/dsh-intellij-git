/**
 * Host half: discover Aweave's repositories, run `git` for exactly one active
 * repository at a time, and serve the result to the browser half over the
 * admission-fenced `/api` channel.
 *
 * Scope discipline: only `connection` is a required injection, so a composition
 * without `llm`, `sessions` or `agentDefaultModel` still serves every route and
 * merely loses commit-message generation.
 */
import type { Context } from '@deepseek-ai/cordis'
// Type-only: declares the `connection` member this module reads.
import type {} from '@deepseek-ai/dsh-client-connection'

import { PLUGIN_ID } from './config.ts'
import { registerRoutes } from './host/routes.ts'
import type { Config } from './schema.ts'

export { Config } from './schema.ts'

/** Cordis function-plugin name. */
export const name = PLUGIN_ID

/**
 * Services this plugin reads: a name listed here that never resolves leaves the
 * plugin silently PENDING, so only genuinely required services appear.
 */
export const inject = ['connection']

/**
 * Register the fenced routes.
 * @param ctx - Host context owning the `connection` service.
 * @param config - validated live configuration resolved by the Loader.
 */
export function apply(ctx: Context, config: Config): void {
  registerRoutes(ctx, {
    aweaveRoot: config.aweaveRoot,
    gitTimeoutMs: config.gitTimeoutMs,
    llmProvider: config.llmProvider,
    llmModel: config.llmModel,
  })
}
