/**
 * The activity record: a bounded, in-process ring buffer of what this plugin
 * did, served to the tool window over two fenced routes.
 *
 * Two capture points feed it, one per half of the work. `recordGit` is called
 * from `runGit`'s observer, so it sees every subprocess with its argv, working
 * directory, exit code, duration and output; `recordApi` is called from the
 * `registerRoutes` wrapper, so it sees every request with its status and body.
 * Neither call site can forget: both are on the choke point the module already
 * mandates.
 *
 * Silence is an async-local scope rather than a flag on each call, because the
 * housekeeping that must stay out of the buffer (`repo/watch`, `activity`,
 * `activity/clear`) still runs real `git` commands through the same observer.
 * `silenced()` wraps the whole handler, so the tick's own `git status` is
 * suppressed with it.
 *
 * The buffer never leaves this process: no file, no restore, no retention
 * policy. It answers "what ran just now and what did it say", which is what the
 * Human asked for, and a restart is allowed to forget it.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { isAbsolute, relative } from 'node:path'

import { ACTIVITY_CAPACITY, ACTIVITY_OUTPUT_LIMIT, type ActivityEntry, type ActivityMeta } from '../config.ts'
import type { GitRunEvent } from './git-runner.ts'

/** Marker appended to output that was cut to fit the buffer. */
const TRUNCATION_MARKER = '… [truncated]'

/** One settled `/api` request, as the route wrapper measures it. */
export interface ApiActivityInput {
  /** Route key, used as the entry's label. */
  readonly key: string
  readonly method: string
  /** Request path below `/api`. */
  readonly path: string
  /** HTTP status the handler answered with. */
  readonly status: number
  readonly durationMs: number
  /** Response body text, already the text of a clone. */
  readonly output: string
}

/** The buffer's public face. */
export interface ActivityLog {
  /** Record one request, unless the current async scope is silenced. */
  recordApi(input: ApiActivityInput): void
  /** Record one `git` invocation, unless the current async scope is silenced. */
  recordGit(event: GitRunEvent): void
  /**
   * The recorded entries, oldest first.
   * @param after - when given, only entries with `id > after`.
   */
  list(after?: number): readonly ActivityEntry[]
  /** Whole-ring facts, independent of any cursor. */
  meta(): ActivityMeta
  /** Drop every entry and report how many were dropped; ids are never reset. */
  clear(): number
  /**
   * Run `fn` inside a request scope: allocate one request id and stamp it, with
   * the origin, on every entry recorded inside `fn`'s async context.
   * @param origin - who caused the request.
   * @param fn - the handler plus its own recording.
   * @returns whatever `fn` resolves to.
   */
  withRequest<T>(origin: 'user' | 'auto', fn: () => Promise<T>): Promise<T>
  /**
   * Run `fn` with recording suppressed for its whole async context.
   * @param fn - the work whose requests and commands stay out of the buffer.
   * @returns whatever `fn` resolves to.
   */
  silenced<T>(fn: () => Promise<T>): Promise<T>
  /**
   * Tell the buffer which directory to print `cwd` relative to.
   *
   * The Aweave root is resolved per request and asynchronously, so the route
   * layer hands it over as it resolves; without it the host working directory is
   * used, which is the same directory on this deployment.
   * @param root - absolute Aweave root, or null to fall back to the process cwd.
   */
  setRoot(root: string | null): void
}

/**
 * Cut one output string to the buffer's per-entry budget.
 * @param raw - captured output.
 * @returns the text to store plus whether it was cut.
 */
function truncate(raw: string): { text: string, truncated: boolean } {
  if (raw.length <= ACTIVITY_OUTPUT_LIMIT) return { text: raw, truncated: false }
  return { text: `${raw.slice(0, ACTIVITY_OUTPUT_LIMIT)}${TRUNCATION_MARKER}`, truncated: true }
}

/**
 * Render a working directory relative to the Aweave root.
 * @param root - absolute Aweave root, or null.
 * @param cwd - absolute working directory of the invocation.
 * @returns a repository-relative path, or the absolute one when outside the root.
 */
function showCwd(root: string | null, cwd: string): string {
  if (root === null) return cwd
  const shown = relative(root, cwd)
  if (shown === '') return '.'
  return shown.startsWith('..') || isAbsolute(shown) ? cwd : shown
}

/**
 * Describe one `git` invocation in a single line.
 * @param event - what the observer saw.
 * @param root - absolute Aweave root, or null.
 * @returns the entry's `detail`.
 */
function gitDetail(event: GitRunEvent, root: string | null): string {
  const parts = [`git ${event.args.join(' ')}`, `cwd ${showCwd(root, event.cwd)}`, `exit ${event.exitCode}`]
  if (event.env !== undefined && event.env['GIT_INDEX_FILE'] !== undefined) parts.push('temporary index')
  return parts.join(' · ')
}

/**
 * Build the stderr section of a `git` entry's output.
 * @param event - what the observer saw.
 * @returns the stored output text.
 */
function gitOutput(event: GitRunEvent): string {
  const stderr = event.stderr.trim()
  return stderr === '' ? event.stdout : `${event.stdout}\n--- stderr ---\n${stderr}`
}

/**
 * Create the activity buffer.
 * @param capacity - entries to keep; defaults to `ACTIVITY_CAPACITY`.
 * @returns the buffer handle.
 */
export function createActivityLog(capacity: number = ACTIVITY_CAPACITY): ActivityLog {
  const entries: ActivityEntry[] = []
  const silence = new AsyncLocalStorage<true>()
  const requests = new AsyncLocalStorage<{ readonly requestId: number, readonly origin: 'user' | 'auto' }>()
  const bootId = randomUUID()
  let nextId = 1
  let nextRequestId = 1
  let root: string | null = null

  /**
   * Append one entry, trimming the oldest beyond capacity.
   * @param entry - the entry without its id and timestamp.
   */
  const push = (entry: Omit<ActivityEntry, 'id' | 'at'>): void => {
    const scope = requests.getStore()
    entries.push({
      ...entry,
      id: nextId,
      at: Date.now(),
      ...(scope === undefined ? {} : { requestId: scope.requestId, origin: scope.origin }),
    })
    nextId += 1
    while (entries.length > capacity) entries.shift()
  }

  return {
    recordApi(input) {
      if (silence.getStore() === true) return
      const output = truncate(input.output)
      push({
        kind: 'api',
        label: input.key,
        detail: `${input.method} ${input.path} -> ${input.status}`,
        ok: input.status < 400,
        durationMs: input.durationMs,
        output: output.text,
        ...(output.truncated ? { truncated: true } : {}),
      })
    },

    recordGit(event) {
      if (silence.getStore() === true) return
      const output = truncate(gitOutput(event))
      push({
        kind: 'git',
        label: `git ${event.args[0] ?? ''}`.trim(),
        detail: gitDetail(event, root),
        ok: event.ok,
        durationMs: event.durationMs,
        output: output.text,
        ...(output.truncated ? { truncated: true } : {}),
      })
    },

    list(after) {
      return after === undefined ? [...entries] : entries.filter(entry => entry.id > after)
    },

    meta() {
      return { bootId, oldestId: entries[0]?.id ?? null, latestId: nextId - 1 }
    },

    withRequest(origin, fn) {
      const requestId = nextRequestId
      nextRequestId += 1
      return requests.run({ requestId, origin }, fn)
    },

    clear() {
      const cleared = entries.length
      entries.length = 0
      return cleared
    },

    silenced(fn) {
      return silence.run(true, fn)
    },

    setRoot(next) {
      root = next
    },
  }
}
