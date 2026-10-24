/**
 * One repository's status, measured as the net difference between `HEAD` and
 * the working tree.
 *
 * Why not porcelain's X/Y columns: this plugin commits `HEAD` against the
 * working tree, so "staged then reverted in the worktree" must NOT appear as a
 * change. `git diff HEAD --name-status` answers exactly that question, and
 * porcelain v2 is kept for the branch facts and the untracked list.
 */
import { createHash } from 'node:crypto'

import type { FileChangeEntry, RepoStatusResponse, WatchResponse } from '../config.ts'
import { runGit } from './git-runner.ts'

/** Depth of the log message read for the Amend prefill. */
const LOG_FORMAT = '%H%x00%h%x00%B'

/** The one command whose output both `readStatus` and `readWatch` digest. */
const PORCELAIN_ARGS = ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all'] as const

/** Bytes of the branch/untracked porcelain output parsed per call. */
const FIELD = (value: string | undefined): string => (value ?? '').trim()

/**
 * Hash the raw porcelain output.
 *
 * Both the status and the watch probe call this with the stdout of the same
 * command line, so the two routes cannot diverge: a digest built any other way
 * would make the browser observe a permanent mismatch and refresh every tick.
 * @param stdout - raw `git status --porcelain=v2 --branch -z` output.
 * @returns the SHA-1 hex digest.
 */
export function porcelainDigest(stdout: string): string {
  return createHash('sha1').update(stdout).digest('hex')
}

/**
 * Read the status of one repository.
 * @param repoRoot - absolute repository root.
 * @param repoId - the id the tree knows this repository by.
 * @param timeoutMs - deadline of each `git` call.
 * @returns branch facts, changed paths and untracked paths.
 */
export async function readStatus(repoRoot: string, repoId: string, timeoutMs: number): Promise<RepoStatusResponse> {
  const porcelain = await runGit({
    cwd: repoRoot,
    args: [...PORCELAIN_ARGS],
    timeoutMs,
  })
  const parsed = parsePorcelainV2(porcelain.stdout)
  const unborn = parsed.headOid === null

  const changes = unborn
    ? parseNameStatus((await runGit({
      cwd: repoRoot,
      args: ['diff', '--cached', '--name-status', '-M', '-z', '--no-ext-diff', '--no-textconv'],
      timeoutMs,
    })).stdout)
    : parseNameStatus((await runGit({
      cwd: repoRoot,
      args: ['diff', 'HEAD', '--name-status', '-M', '-z', '--no-ext-diff', '--no-textconv'],
      timeoutMs,
    })).stdout)

  let lastCommitMessage = ''
  if (!unborn) {
    const log = await runGit({ cwd: repoRoot, args: ['log', '-1', `--format=${LOG_FORMAT}`, 'HEAD'], timeoutMs })
    const first = log.stdout.indexOf('\0')
    const second = log.stdout.indexOf('\0', first + 1)
    lastCommitMessage = second === -1 ? '' : log.stdout.slice(second + 1).trim()
  }

  const remotes = parseLines((await runGit({ cwd: repoRoot, args: ['remote'], timeoutMs })).stdout)
  const pushTarget = await readPushTarget(repoRoot, timeoutMs)
  const headPublished = pushTarget === null ? false : await isAncestor(repoRoot, pushTarget, timeoutMs)

  return {
    repoId,
    branch: parsed.branch,
    headOid: parsed.headOid,
    headShortSha: parsed.headOid === null ? 'initial' : parsed.headOid.slice(0, 7),
    lastCommitMessage,
    upstream: parsed.upstream,
    ahead: parsed.ahead,
    behind: parsed.behind,
    pushTarget,
    headPublished,
    remotes,
    changes,
    unversioned: parsed.unversioned,
    statusDigest: porcelainDigest(porcelain.stdout),
  }
}

/**
 * Read only what the watcher needs: the digest plus the branch facts.
 *
 * One `git status` per tick, with `GIT_OPTIONAL_LOCKS=0` so the probe never takes
 * or rewrites the index while a commit or another agent's `git add` runs. The
 * command line and the digest helper are shared with `readStatus`, so the two
 * answers agree byte for byte; the probe deliberately returns no file lists,
 * because the browser only compares the digest.
 * @param repoRoot - absolute repository root.
 * @param timeoutMs - deadline of the call.
 * @returns the digest and the branch facts.
 */
export async function readWatch(repoRoot: string, timeoutMs: number): Promise<Omit<WatchResponse, 'repoId'>> {
  const porcelain = await runGit({
    cwd: repoRoot,
    args: [...PORCELAIN_ARGS],
    timeoutMs,
    env: { GIT_OPTIONAL_LOCKS: '0' },
  })
  const parsed = parsePorcelainV2(porcelain.stdout)
  return {
    digest: porcelainDigest(porcelain.stdout),
    headOid: parsed.headOid,
    branch: parsed.branch,
    ahead: parsed.ahead,
    behind: parsed.behind,
  }
}

/** Branch facts and untracked paths from `--porcelain=v2 --branch -z`. */
interface PorcelainV2 {
  readonly branch: string
  readonly headOid: string | null
  readonly upstream: string | null
  readonly ahead: number
  readonly behind: number
  readonly unversioned: readonly string[]
}

/**
 * Parse `git status --porcelain=v2 --branch -z --untracked-files=all`.
 * @param raw - NUL-separated porcelain output.
 * @returns branch facts and the untracked list.
 */
export function parsePorcelainV2(raw: string): PorcelainV2 {
  let branch = 'HEAD'
  let headOid: string | null = null
  let upstream: string | null = null
  let ahead = 0
  let behind = 0
  const unversioned: string[] = []

  for (const record of raw.split('\0')) {
    if (record === '') continue
    if (record.startsWith('# ')) {
      const rest = record.slice(2)
      const space = rest.indexOf(' ')
      const key = space === -1 ? rest : rest.slice(0, space)
      const value = space === -1 ? '' : rest.slice(space + 1)
      if (key === 'branch.head') branch = value
      else if (key === 'branch.oid') headOid = value === '(initial)' ? null : FIELD(value)
      else if (key === 'branch.upstream') upstream = value === '' ? null : value
      else if (key === 'branch.ab') {
        for (const token of value.split(' ')) {
          if (token.startsWith('+')) ahead = Number.parseInt(token.slice(1), 10) || 0
          else if (token.startsWith('-')) behind = Number.parseInt(token.slice(1), 10) || 0
        }
      }
      continue
    }
    if (record.startsWith('? ')) unversioned.push(record.slice(2))
  }
  return { branch, headOid, upstream, ahead, behind, unversioned }
}

/**
 * Parse `git diff --name-status -M -z`.
 *
 * Rename records carry two paths: `<status>\0<old>\0<new>\0`. Copies are
 * reported as their own entry with the destination path, since the plugin
 * commits the new path only.
 * @param raw - NUL-separated name-status output.
 * @returns one entry per changed path.
 */
export function parseNameStatus(raw: string): FileChangeEntry[] {
  const tokens = raw.split('\0').filter(token => token !== '')
  const entries: FileChangeEntry[] = []
  let index = 0
  while (index < tokens.length) {
    const code = tokens[index] ?? ''
    index += 1
    const letter = code.charAt(0)
    if (letter === 'R' || letter === 'C') {
      const from = tokens[index] ?? ''
      const to = tokens[index + 1] ?? ''
      index += 2
      if (to !== '') entries.push({ path: to, origPath: from, status: letter === 'C' ? 'A' : 'R' })
      continue
    }
    const path = tokens[index] ?? ''
    index += 1
    if (path === '') continue
    const status = letter === 'M' || letter === 'A' || letter === 'D' || letter === 'T' ? letter : 'M'
    entries.push({ path, status })
  }
  return entries
}

/**
 * Resolve `@{push}` for the current branch.
 * @param repoRoot - absolute repository root.
 * @param timeoutMs - deadline of the call.
 * @returns the push target, or null when none is configured.
 */
export async function readPushTarget(repoRoot: string, timeoutMs: number): Promise<string | null> {
  const result = await runGit({
    cwd: repoRoot,
    args: ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{push}'],
    timeoutMs,
    allowExitCodes: [0, 128, 129],
  })
  const value = result.stdout.trim()
  return result.exitCode === 0 && value !== '' ? value : null
}

/**
 * Whether `HEAD` is reachable from a ref.
 *
 * `git merge-base --is-ancestor` answers with its exit code: `0` means
 * reachable, `1` means not, and `1` is the NORMAL state of any unpushed commit,
 * so it must not be treated as a failure.
 * @param repoRoot - absolute repository root.
 * @param ref - the ref to test against.
 * @param timeoutMs - deadline of the call.
 * @returns true when reachable.
 */
export async function isAncestor(repoRoot: string, ref: string, timeoutMs: number): Promise<boolean> {
  const result = await runGit({
    cwd: repoRoot,
    args: ['merge-base', '--is-ancestor', 'HEAD', ref],
    timeoutMs,
    allowExitCodes: [0, 1],
  })
  return result.exitCode === 0
}

/**
 * Split a newline-separated command output into trimmed non-empty lines.
 * @param raw - command output.
 * @returns the lines.
 */
export function parseLines(raw: string): string[] {
  return raw.split('\n').map(line => line.trim()).filter(line => line !== '')
}
