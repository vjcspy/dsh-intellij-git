/**
 * The one place this plugin spawns `git`.
 *
 * A wrapper rather than `execFile` calls scattered through the handlers,
 * because three behaviours are load-bearing and easy to forget: every call is
 * bounded by a deadline, an optional `GIT_INDEX_FILE` redirects the index away
 * from the real one, and only the exit codes the caller names count as
 * success. `git merge-base --is-ancestor` and `git diff --no-index` both use
 * exit `1` as an ANSWER, not as a failure, so a blanket zero-only rule would
 * throw on the common case.
 */
import { spawn } from 'node:child_process'

/** Git environment variable that redirects every index write. */
export const GIT_INDEX_FILE_ENV = 'GIT_INDEX_FILE'

/** A `git` invocation that did not exit with an allowed code. */
export class GitCommandError extends Error {
  /** Process exit code, or `-1` when the process never started or was killed. */
  readonly exitCode: number
  /** Everything git wrote to stderr. */
  readonly stderr: string

  /**
   * @param message - a human-readable summary.
   * @param exitCode - the process exit code.
   * @param stderr - captured stderr.
   */
  constructor(message: string, exitCode: number, stderr: string) {
    super(message)
    this.name = 'GitCommandError'
    this.exitCode = exitCode
    this.stderr = stderr
  }
}

/** One `git` invocation. */
export interface RunGitOptions {
  /** Repository working directory. */
  readonly cwd: string
  /** Arguments after the executable name. */
  readonly args: readonly string[]
  /** Deadline in milliseconds. */
  readonly timeoutMs: number
  /** Extra environment entries, for example `GIT_INDEX_FILE`. */
  readonly env?: Readonly<Record<string, string>>
  /** Exit codes that count as success; defaults to `[0]`. */
  readonly allowExitCodes?: readonly number[]
  /** Bytes written to stdin, for `git apply`. */
  readonly input?: string
}

/** Captured output of one successful invocation. */
export interface RunGitResult {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
}

/** One settled invocation, as an observer sees it. */
export interface GitRunEvent {
  /** Arguments after the executable name. */
  readonly args: readonly string[]
  /** Repository working directory. */
  readonly cwd: string
  /** Exit code, or `-1` when the process never started or was killed on the deadline. */
  readonly exitCode: number
  /** Wall-clock duration of the call. */
  readonly durationMs: number
  /** True when the exit code was one the caller allowed. */
  readonly ok: boolean
  readonly stdout: string
  readonly stderr: string
  /** Extra environment the call carried, when it carried any. */
  readonly env?: Readonly<Record<string, string>>
}

/** The single observer every invocation reports to, when one is installed. */
let observer: ((event: GitRunEvent) => void) | undefined

/**
 * Install the observer that sees every `git` invocation.
 *
 * One observer rather than a recorder threaded through every call site: the
 * module's stated property is that this is the one place the plugin spawns git,
 * so an assignment here covers every current and future call.
 * @param next - the observer, or undefined to detach.
 * @returns a disposer restoring the previous observer.
 */
export function setGitObserver(next?: (event: GitRunEvent) => void): () => void {
  const previous = observer
  observer = next
  return () => { observer = previous }
}

/**
 * Report one settled invocation to the observer, exactly once.
 *
 * A throwing observer must never fail the command it observes: recording is a
 * side effect, and the caller's exit-code contract is what the plugin runs on.
 * @param event - the settled invocation.
 */
function notify(event: GitRunEvent): void {
  if (observer === undefined) return
  try {
    observer(event)
  } catch {
    // A broken observer is not a broken command.
  }
}

/**
 * Run one `git` command.
 * @param options - the invocation.
 * @returns captured stdout and stderr.
 * @throws GitCommandError when the exit code is not allowed, the deadline fires, or the spawn fails.
 */
export function runGit(options: RunGitOptions): Promise<RunGitResult> {
  const allowed = options.allowExitCodes ?? [0]
  const startedAt = Date.now()
  let observed = false
  return new Promise<RunGitResult>((resolve, reject) => {
    const child = spawn('git', [...options.args], {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    const out: Buffer[] = []
    const err: Buffer[] = []
    let settled = false
    let killedByTimeout = false

    const timer = setTimeout(() => {
      killedByTimeout = true
      child.kill('SIGKILL')
    }, options.timeoutMs)

    /**
     * Report this invocation once, whatever settles it.
     * @param exitCode - the process exit code.
     * @param stdout - captured stdout.
     * @param stderr - captured stderr.
     * @param ok - whether the caller counts the code as success.
     */
    const report = (exitCode: number, stdout: string, stderr: string, ok: boolean): void => {
      if (observed) return
      observed = true
      notify({
        args: options.args,
        cwd: options.cwd,
        exitCode,
        durationMs: Date.now() - startedAt,
        ok,
        stdout,
        stderr,
        ...(options.env === undefined ? {} : { env: options.env }),
      })
    }

    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn()
    }

    child.stdout.on('data', (chunk: Buffer) => { out.push(chunk) })
    child.stderr.on('data', (chunk: Buffer) => { err.push(chunk) })
    child.on('error', (error: Error) => {
      finish(() => {
        report(-1, '', '', false)
        reject(new GitCommandError(`git ${options.args[0] ?? ''}: ${error.message}`, -1, ''))
      })
    })
    child.on('close', (code: number | null) => {
      const stdout = Buffer.concat(out).toString('utf8')
      const stderr = Buffer.concat(err).toString('utf8')
      const exitCode = code ?? -1
      finish(() => {
        if (killedByTimeout) {
          report(-1, stdout, stderr, false)
          reject(new GitCommandError(`git ${options.args[0] ?? ''} timed out after ${options.timeoutMs}ms`, -1, stderr))
          return
        }
        if (!allowed.includes(exitCode)) {
          report(exitCode, stdout, stderr, false)
          reject(new GitCommandError(`git ${options.args.join(' ')} exited ${exitCode}: ${stderr.trim().slice(0, 800)}`, exitCode, stderr))
          return
        }
        report(exitCode, stdout, stderr, true)
        resolve({ stdout, stderr, exitCode })
      })
    })

    if (options.input === undefined) child.stdin.end()
    else child.stdin.end(options.input, 'utf8')
  })
}

/**
 * Run `git` with a temporary index file, restoring the caller's environment.
 * @param options - the invocation, without `env`.
 * @param indexFile - absolute path of the temporary index.
 * @returns captured output.
 */
export function runGitWithIndex(options: Omit<RunGitOptions, 'env'>, indexFile: string): Promise<RunGitResult> {
  return runGit({ ...options, env: { [GIT_INDEX_FILE_ENV]: indexFile } })
}
