/**
 * Host-only configuration schema.
 *
 * Kept apart from `./config.ts` so the browser bundle never pulls schemastery.
 */
import z from '@deepseek-ai/schemastery'

import { DEFAULT_GIT_TIMEOUT_MS } from './config.ts'

/** Host configuration, as the Loader resolves it. */
export interface Config {
  /** Absolute Aweave root, or empty to derive it from the platform marker. */
  aweaveRoot: string
  /** Deadline of one `git` invocation, in milliseconds. */
  gitTimeoutMs: number
  /** Explicit provider for commit-message generation; empty means reuse the Session route. */
  llmProvider: string
  /** Explicit model for commit-message generation; empty means reuse the Session route. */
  llmModel: string
}

/** Plugin configuration. */
export const Config: z<Config> = z.object({
  aweaveRoot: z.string().default(''),
  gitTimeoutMs: z.number().step(1).min(1000).max(120_000).default(DEFAULT_GIT_TIMEOUT_MS),
  llmProvider: z.string().default(''),
  llmModel: z.string().default(''),
})
