/**
 * The write half: partial commit, remote push and rollback.
 *
 * The commit is the delicate part. IntelliJ's checkboxes are an INCLUSION SET,
 * not staging, so nothing may touch the real index before the commit runs. The
 * commit therefore builds a temporary index seeded from the expected `HEAD`,
 * stages the selected whole files and the selected hunks into it, commits from
 * it, and only afterwards reconciles the real index for exactly the paths it
 * committed.
 *
 * Why the reconciliation is path-scoped rather than `git read-tree HEAD`: this
 * tree is shared with running Agents that stage their own work, so a whole-tree
 * reset would silently unstage their files. `git reset -q HEAD -- <paths>`
 * leaves every other path alone.
 */
import { createHash, randomUUID } from 'node:crypto'
import { stat, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type {
  CommitRequest,
  CommitResponse,
  DiffHunk,
  FileChangeEntry,
  FileInclusionRequest,
  RollbackRequest,
  RollbackResponse,
} from '../config.ts'
import { buildPatch, readFileDiff } from './git-diff.ts'
import { runGit, runGitWithIndex } from './git-runner.ts'
import { readPushTarget } from './git-status.ts'
import { ApiHttpError } from './http-error.ts'
import { resolveRepoFile } from './workspace-tree.ts'

/** Attempts at reconciling the real index while another process holds its lock. */
const INDEX_SYNC_ATTEMPTS = 5

/** Delay between index-lock retries, in milliseconds. */
const INDEX_SYNC_DELAY_MS = 100

/**
 * Read the current `HEAD` OID.
 * @param repoRoot - absolute repository root.
 * @param timeoutMs - deadline of the call.
 * @returns the OID, or null on an unborn branch.
 */
export async function currentHeadOid(repoRoot: string, timeoutMs: number): Promise<string | null> {
  const result = await runGit({
    cwd: repoRoot,
    args: ['rev-parse', '--verify', 'HEAD'],
    timeoutMs,
    allowExitCodes: [0, 128],
  })
  return result.exitCode === 0 ? result.stdout.trim() : null
}

/**
 * Refuse when `HEAD` is not the commit the browser's view was built from.
 * @param repoRoot - absolute repository root.
 * @param expected - the OID the client sent.
 * @param timeoutMs - deadline of the call.
 */
async function requireHead(repoRoot: string, expected: string | null, timeoutMs: number): Promise<void> {
  const actual = await currentHeadOid(repoRoot, timeoutMs)
  if (actual !== expected) {
    throw new ApiHttpError(409, {
      code: 'HEAD_MOVED',
      message: 'the repository HEAD moved since this view was loaded; refresh and try again',
      details: { expectedHeadOid: expected, actualHeadOid: actual },
    })
  }
}

/**
 * Wait between index-lock retries.
 * @param ms - delay in milliseconds.
 */
function delay(ms: number): Promise<void> {
  return new Promise<void>(resolve => { setTimeout(resolve, ms) })
}

/**
 * Reconcile the real index for the committed paths only.
 *
 * Worktree-safe lock detection: in a linked worktree `.git` is a file, so the
 * lock is located through `git rev-parse --git-path index.lock` rather than a
 * hardcoded `repoRoot/.git/index.lock`.
 * @param repoRoot - absolute repository root.
 * @param paths - repository-relative paths that were committed.
 * @param timeoutMs - deadline of each call.
 * @returns whether the index was reconciled, and the failure reason when it was not.
 */
async function syncRealIndex(repoRoot: string, paths: readonly string[], timeoutMs: number): Promise<{ synced: boolean, error?: string }> {
  if (paths.length === 0) return { synced: true }
  let lastError = ''
  for (let attempt = 0; attempt < INDEX_SYNC_ATTEMPTS; attempt += 1) {
    try {
      await runGit({ cwd: repoRoot, args: ['reset', '-q', 'HEAD', '--', ...paths], timeoutMs })
      return { synced: true }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
      const locked = await indexLocked(repoRoot, timeoutMs) || lastError.includes('index.lock')
      if (!locked) return { synced: false, error: lastError }
      await delay(INDEX_SYNC_DELAY_MS)
    }
  }
  return { synced: false, error: lastError }
}

/**
 * Whether the repository's index lock exists.
 * @param repoRoot - absolute repository root.
 * @param timeoutMs - deadline of the call.
 * @returns true while a lock file is present.
 */
async function indexLocked(repoRoot: string, timeoutMs: number): Promise<boolean> {
  try {
    const result = await runGit({ cwd: repoRoot, args: ['rev-parse', '--git-path', 'index.lock'], timeoutMs })
    const path = result.stdout.trim()
    if (path === '') return false
    const absolute = path.startsWith('/') ? path : join(repoRoot, path)
    await stat(absolute)
    return true
  } catch {
    return false
  }
}

/**
 * Paths a set of inclusions will modify in the index.
 * @param files - the requested inclusions.
 * @returns destination paths plus rename sources.
 */
function touchedPaths(files: readonly FileInclusionRequest[]): string[] {
  const paths = new Set<string>()
  for (const file of files) {
    paths.add(file.path)
    if (file.origPath !== undefined && file.origPath !== '') paths.add(file.origPath)
  }
  return [...paths]
}

/**
 * Stage one inclusion into the temporary index.
 * @param repoRoot - absolute repository root.
 * @param indexFile - temporary index path.
 * @param file - the inclusion.
 * @param timeoutMs - deadline of each call.
 */
async function stageFile(repoRoot: string, indexFile: string, file: FileInclusionRequest, timeoutMs: number): Promise<void> {
  const status = file.status
  if (!file.partial) {
    if (status === 'D') {
      await runGitWithIndex({ cwd: repoRoot, args: ['update-index', '--force-remove', '--', file.path], timeoutMs }, indexFile)
      return
    }
    if (status === 'R' && file.origPath !== undefined && file.origPath !== '') {
      await runGitWithIndex({ cwd: repoRoot, args: ['update-index', '--force-remove', '--', file.origPath], timeoutMs }, indexFile)
    }
    await runGitWithIndex({ cwd: repoRoot, args: ['update-index', '--add', '--remove', '--', file.path], timeoutMs }, indexFile)
    return
  }

  const keys = file.hunkKeys ?? []
  if (keys.length === 0) return
  // A new file carries exactly one hunk, and `git apply --cached` cannot consume a
  // creation patch built from `/dev/null` (`error: dev/null: does not exist in
  // index`). Staging the whole file is the same commit and the only thing that works.
  if (status === 'U' || status === 'A') {
    await runGitWithIndex({ cwd: repoRoot, args: ['update-index', '--add', '--remove', '--', file.path], timeoutMs }, indexFile)
    return
  }
  const diff = await readFileDiff({
    repoRoot,
    path: file.path,
    origPath: file.origPath ?? null,
    status,
    timeoutMs,
  })
  const wanted = diff.hunks.filter(hunk => keys.includes(hunk.contentKey))
  if (wanted.length !== keys.length) {
    throw new ApiHttpError(409, {
      code: 'STALE_HUNKS',
      message: 'the file changed on disk since this diff was loaded; refresh and try again',
      details: { path: file.path, missing: keys.filter(key => !wanted.some(hunk => hunk.contentKey === key)) },
    })
  }
  const kind = status === 'D' ? 'delete' : 'edit'
  await runGitWithIndex({
    cwd: repoRoot,
    args: ['apply', '--cached', '--unidiff-zero', '-'],
    timeoutMs,
    input: buildPatch(file.path, wanted, kind),
  }, indexFile)
}

/**
 * Commit the selected files and hunks.
 * @param options - repository paths, request body and the config deadline.
 * @returns the commit outcome.
 */
export async function commitRepo(options: {
  readonly repoRoot: string
  readonly request: CommitRequest
  readonly timeoutMs: number
}): Promise<CommitResponse> {
  const { repoRoot, request, timeoutMs } = options
  await requireHead(repoRoot, request.expectedHeadOid, timeoutMs)

  const indexFile = join(tmpdir(), `dsh-intellij-git-${randomUUID()}.index`)
  let commitSha: string | null = null
  let headMovedDuringCommit = false

  try {
    if (request.expectedHeadOid !== null) {
      await runGitWithIndex({ cwd: repoRoot, args: ['read-tree', request.expectedHeadOid], timeoutMs }, indexFile)
    }
    for (const file of request.files) await stageFile(repoRoot, indexFile, file, timeoutMs)

    const message = request.message.trim()
    if (message === '' && !request.amend) {
      throw new ApiHttpError(400, { code: 'EMPTY_MESSAGE', message: 'commit message is required' })
    }
    await runGitWithIndex({
      cwd: repoRoot,
      args: request.amend ? ['commit', '--amend', '-m', message === '' ? 'amend' : message] : ['commit', '-m', message],
      timeoutMs,
    }, indexFile)

    commitSha = (await currentHeadOid(repoRoot, timeoutMs)) ?? null

    const parent = await runGit({
      cwd: repoRoot,
      args: ['rev-parse', '--verify', 'HEAD^1'],
      timeoutMs,
      allowExitCodes: [0, 128],
    })
    const parentOid = parent.exitCode === 0 ? parent.stdout.trim() : null
    const expectedParent = request.amend
      ? await expectedGrandparent(repoRoot, request.expectedHeadOid, timeoutMs)
      : request.expectedHeadOid
    headMovedDuringCommit = expectedParent !== null && parentOid !== expectedParent
  } finally {
    await unlink(indexFile).catch(() => undefined)
  }

  const sync = await syncRealIndex(repoRoot, touchedPaths(request.files), timeoutMs)

  if (!request.push) return { committed: true, commitSha, indexSynced: sync.synced, ...(sync.error === undefined ? {} : { indexSyncError: sync.error }), headMovedDuringCommit, pushed: false }

  const pushTarget = await readPushTarget(repoRoot, timeoutMs)
  if (pushTarget === null) {
    const remotes = (await runGit({ cwd: repoRoot, args: ['remote'], timeoutMs })).stdout.split('\n').map(line => line.trim()).filter(line => line !== '')
    const branch = (await runGit({ cwd: repoRoot, args: ['rev-parse', '--abbrev-ref', 'HEAD'], timeoutMs })).stdout.trim()
    const hint = remotes.length === 1 ? `git push -u ${remotes[0] ?? 'origin'} ${branch}` : `git push -u <remote> ${branch}`
    return {
      committed: true,
      commitSha,
      indexSynced: sync.synced,
      ...(sync.error === undefined ? {} : { indexSyncError: sync.error }),
      headMovedDuringCommit,
      pushed: false,
      pushErrorCode: 'NO_PUSH_TARGET',
      pushError: `no push target is configured for this branch; set one with: ${hint}`,
    }
  }

  try {
    await runGit({ cwd: repoRoot, args: ['push'], timeoutMs })
    return {
      committed: true,
      commitSha,
      indexSynced: sync.synced,
      ...(sync.error === undefined ? {} : { indexSyncError: sync.error }),
      headMovedDuringCommit,
      pushed: true,
      pushTarget,
    }
  } catch (error) {
    return {
      committed: true,
      commitSha,
      indexSynced: sync.synced,
      ...(sync.error === undefined ? {} : { indexSyncError: sync.error }),
      headMovedDuringCommit,
      pushed: false,
      pushTarget,
      pushErrorCode: 'PUSH_FAILED',
      pushError: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * Parent of the commit being amended, which is what the new commit's parent must be.
 * @param repoRoot - absolute repository root.
 * @param expectedHeadOid - the `HEAD` the client saw.
 * @param timeoutMs - deadline of the call.
 * @returns the expected parent OID, or null when the amended commit is a root commit.
 */
async function expectedGrandparent(repoRoot: string, expectedHeadOid: string | null, timeoutMs: number): Promise<string | null> {
  if (expectedHeadOid === null) return null
  const result = await runGit({
    cwd: repoRoot,
    args: ['rev-parse', '--verify', `${expectedHeadOid}^1`],
    timeoutMs,
    allowExitCodes: [0, 128],
  })
  return result.exitCode === 0 ? result.stdout.trim() : null
}

/**
 * Revert selected files or single hunks in the working tree.
 * @param options - repository paths, request body and the config deadline.
 * @returns the paths that were rolled back.
 */
export async function rollbackRepo(options: {
  readonly repoRoot: string
  readonly request: RollbackRequest
  readonly timeoutMs: number
}): Promise<RollbackResponse> {
  const { repoRoot, request, timeoutMs } = options
  await requireHead(repoRoot, request.expectedHeadOid, timeoutMs)
  const headOid = await currentHeadOid(repoRoot, timeoutMs)
  const prepared = await preflightRollback(repoRoot, request, timeoutMs)
  const done: string[] = []

  for (const file of request.files) {
    const absolute = resolveRepoFile(repoRoot, file.path)
    if (willDelete(file)) {
      // U and A carry no committed content, so removing them from disk IS the revert.
      await runGit({ cwd: repoRoot, args: ['rm', '--cached', '-q', '-f', '--', file.path], timeoutMs, allowExitCodes: [0, 1, 128] })
      await unlink(absolute).catch(() => undefined)
      done.push(file.path)
      continue
    }
    if (file.partial) {
      const hunks = prepared.get(file.path) ?? []
      await runGit({
        cwd: repoRoot,
        args: ['apply', '--reverse', '--unidiff-zero', '-'],
        timeoutMs,
        input: buildPatch(file.path, hunks, 'edit'),
      })
      done.push(file.path)
      continue
    }
    if (headOid === null) {
      await runGit({ cwd: repoRoot, args: ['rm', '--cached', '-q', '-f', '--', file.path], timeoutMs, allowExitCodes: [0, 1, 128] })
      done.push(file.path)
      continue
    }
    await runGit({ cwd: repoRoot, args: ['checkout', 'HEAD', '--', file.path], timeoutMs })
    done.push(file.path)
  }

  return { rolledBack: done, headOid }
}

/**
 * Whether reverting this entry removes the file from disk.
 *
 * One predicate, shared by the browser copy and this pre-pass, so the dialog can
 * never promise "nothing is deleted" while a file disappears. `U` and `A` have no
 * committed content, so any revert of them is a delete, partial or not. `R` is a
 * delete only as a whole-file change: a partial `R` is reverse-applied as an edit,
 * so its file survives.
 * @param file - the requested inclusion.
 * @returns true when the revert deletes the path.
 */
export function willDelete(file: FileInclusionRequest): boolean {
  return file.status === 'U' || file.status === 'A' || (file.status === 'R' && !file.partial)
}

/** What a rollback needs from its pre-pass, keyed by path. */
type PreparedRollback = ReadonlyMap<string, readonly DiffHunk[]>

/**
 * Validate the whole rollback before touching anything.
 *
 * Both refusals are all-or-nothing: a request that needs a deletion the caller did
 * not confirm, or whose selected hunks no longer match the file, must leave the
 * working tree and the index exactly as they were. Validating per entry inside the
 * mutation loop would half-apply the rollback.
 * @param repoRoot - absolute repository root.
 * @param request - the rollback body.
 * @param timeoutMs - deadline of each call.
 * @returns the hunks to reverse-apply, per path.
 */
async function preflightRollback(repoRoot: string, request: RollbackRequest, timeoutMs: number): Promise<PreparedRollback> {
  const deletions = request.files.filter(willDelete)
  if (deletions.length > 0 && !request.confirmDeletePaths) {
    throw new ApiHttpError(400, {
      code: 'DELETE_CONFIRMATION_REQUIRED',
      message: 'rolling back these paths deletes them from disk; confirm the deletion first',
      details: { paths: deletions.map(file => file.path) },
    })
  }

  const prepared = new Map<string, readonly DiffHunk[]>()
  for (const file of request.files) {
    if (!file.partial || willDelete(file)) continue
    const keys = file.hunkKeys ?? []
    if (keys.length === 0) continue
    const diff = await readFileDiff({ repoRoot, path: file.path, origPath: file.origPath ?? null, status: file.status, timeoutMs })
    const wanted = diff.hunks.filter(hunk => keys.includes(hunk.contentKey))
    if (wanted.length !== keys.length) {
      throw new ApiHttpError(409, { code: 'STALE_HUNKS', message: 'the file changed on disk since this diff was loaded; refresh and try again' })
    }
    prepared.set(file.path, wanted)
  }
  return prepared
}

/**
 * Refuse a destructive rollback the caller did not confirm.
 * @param confirmed - the request's confirmation flag.
 * @param path - the path that would be deleted.
 */
function requireDeleteConfirmation(confirmed: boolean, path: string): void {
  if (confirmed) return
  throw new ApiHttpError(400, {
    code: 'DELETE_CONFIRMATION_REQUIRED',
    message: `rolling back ${path} deletes it from disk; confirm the deletion first`,
    details: { path },
  })
}

/**
 * A stable digest of a patch, used only for logging and error detail.
 * @param text - patch text.
 * @returns a short hex digest.
 */
export function patchDigest(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 12)
}
