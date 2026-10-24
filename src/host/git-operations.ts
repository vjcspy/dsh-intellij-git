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
import { isAbsolute, join } from 'node:path'

import type {
  CommitRequest,
  CommitResponse,
  DiffHunk,
  FileChangeEntry,
  FileInclusionRequest,
  PushErrorCode,
  RollbackRequest,
  RollbackResponse,
  SyncMode,
  SyncRequest,
  SyncResponse,
} from '../config.ts'
import { buildPatch, readFileDiff } from './git-diff.ts'
import { GitCommandError, runGit, runGitWithIndex } from './git-runner.ts'
import { parseLines, readPushTarget } from './git-status.ts'
import { ApiHttpError } from './http-error.ts'
import { resolveRepoFile } from './workspace-tree.ts'

/** Attempts at reconciling the real index while another process holds its lock. */
const INDEX_SYNC_ATTEMPTS = 5

/** Delay between index-lock retries, in milliseconds. */
const INDEX_SYNC_DELAY_MS = 100

/** git's own non-fast-forward refusal, which is the one push failure the UI can act on. */
const PUSH_REJECTION_PATTERN = /non-fast-forward|fetch first|\[rejected\]/i

/** Phrases git uses when it refuses an integration because local contents are in the way. */
const WORKTREE_REFUSAL_PATTERN = /would be overwritten|unstaged changes|uncommitted changes|cannot merge|cannot rebase|Please commit or stash/i

/**
 * Markers git leaves behind while an operation is in progress.
 *
 * `rebase-merge`/`rebase-apply` are the rebase states, `MERGE_HEAD` the merge
 * state; a cherry-pick or revert in progress is the same class of state, so it
 * refuses the same way instead of failing obscurely underneath.
 */
const OPERATION_MARKERS = ['rebase-merge', 'rebase-apply', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD'] as const

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
 * Read the current branch as a fully-qualified-ref identity.
 *
 * `git symbolic-ref -q HEAD` rather than `rev-parse --abbrev-ref HEAD`: the latter
 * answers the literal `HEAD` on a detached checkout and can answer `<kind>/<name>`
 * when a short name is ambiguous, so neither can identify a branch. The prefix is
 * stripped here and the name is only ever a display string; every comparison
 * elsewhere stays on the full ref.
 * @param repoRoot - absolute repository root.
 * @param timeoutMs - deadline of the call.
 * @returns the branch name, or null on a detached `HEAD`.
 */
export async function readRepoBranch(repoRoot: string, timeoutMs: number): Promise<string | null> {
  const result = await runGit({
    cwd: repoRoot,
    args: ['symbolic-ref', '-q', 'HEAD'],
    timeoutMs,
    allowExitCodes: [0, 1],
  })
  if (result.exitCode !== 0) return null
  const ref = result.stdout.trim()
  const prefix = 'refs/heads/'
  return ref.startsWith(prefix) ? ref.slice(prefix.length) : ref
}

/**
 * Refuse when `HEAD` is not the state the browser's view was built from.
 *
 * Identity is (branch, OID), not OID: two branches on one commit are common, and
 * a terminal switch between loading the view and writing would otherwise commit
 * onto the wrong branch silently. The branch is compared only when the caller
 * sent it, so a raw OID-only caller keeps the previous contract.
 * @param repoRoot - absolute repository root.
 * @param expected - the OID, and optionally the branch, the client sent.
 * @param timeoutMs - deadline of the call.
 * @returns the OID and branch actually read, so a caller need not read them twice.
 */
export async function requireRepoState(
  repoRoot: string,
  expected: { readonly headOid: string | null, readonly branch?: string | null },
  timeoutMs: number,
): Promise<{ readonly headOid: string | null, readonly branch: string | null }> {
  const actualHeadOid = await currentHeadOid(repoRoot, timeoutMs)
  const checkBranch = expected.branch !== undefined
  const actualBranch = checkBranch ? await readRepoBranch(repoRoot, timeoutMs) : null
  const oidMoved = actualHeadOid !== expected.headOid
  const branchMoved = checkBranch && (expected.branch ?? null) !== actualBranch
  if (oidMoved || branchMoved) {
    throw new ApiHttpError(409, {
      code: 'HEAD_MOVED',
      message: 'the repository HEAD moved since this view was loaded; refresh and try again',
      details: {
        expectedHeadOid: expected.headOid,
        actualHeadOid,
        ...(checkBranch ? { expectedBranch: expected.branch ?? null, actualBranch } : {}),
      },
    })
  }
  return { headOid: actualHeadOid, branch: actualBranch }
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
  const expectedBranch = request.expectedBranch
  await requireRepoState(repoRoot, { headOid: request.expectedHeadOid, ...(expectedBranch === undefined ? {} : { branch: expectedBranch }) }, timeoutMs)

  const indexFile = join(tmpdir(), `dsh-intellij-git-${randomUUID()}.index`)
  let commitSha: string | null = null
  let headMovedDuringCommit = false
  let branchMovedDuringCommit = false

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
    // A switch can land between the compare-and-swap above and `git commit`
    // itself. Re-reading the branch narrows that window to a reported mismatch;
    // it cannot close it, because git has no atomic symref compare-and-swap.
    if (expectedBranch !== undefined) {
      const branchAfter = await readRepoBranch(repoRoot, timeoutMs)
      branchMovedDuringCommit = branchAfter !== (expectedBranch ?? null)
    }
  } finally {
    await unlink(indexFile).catch(() => undefined)
  }

  const sync = await syncRealIndex(repoRoot, touchedPaths(request.files), timeoutMs)

  if (!request.push) return { committed: true, commitSha, indexSynced: sync.synced, ...(sync.error === undefined ? {} : { indexSyncError: sync.error }), headMovedDuringCommit, branchMovedDuringCommit, pushed: false }

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
      branchMovedDuringCommit,
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
      branchMovedDuringCommit,
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
      branchMovedDuringCommit,
      pushed: false,
      pushTarget,
      pushErrorCode: classifyPushError(error),
      pushError: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * Classify a push failure from git's own stderr.
 *
 * Only a non-fast-forward rejection earns `PUSH_REJECTED`, because only that one
 * has a path forward the UI can offer. A hook rejection, a protected branch or a
 * transport error stays `PUSH_FAILED` with its raw message kept.
 * @param error - the thrown failure.
 * @returns the code the browser branches on.
 */
export function classifyPushError(error: unknown): PushErrorCode {
  const text = error instanceof GitCommandError
    ? error.stderr
    : error instanceof Error ? error.message : String(error)
  return PUSH_REJECTION_PATTERN.test(text) ? 'PUSH_REJECTED' : 'PUSH_FAILED'
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
  const expectedBranch = request.expectedBranch
  await requireRepoState(repoRoot, { headOid: request.expectedHeadOid, ...(expectedBranch === undefined ? {} : { branch: expectedBranch }) }, timeoutMs)
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
      throw new ApiHttpError(409, {
        code: 'STALE_HUNKS',
        message: 'the file changed on disk since this diff was loaded; refresh and try again',
        details: { path: file.path, missing: keys.filter(key => !wanted.some(hunk => hunk.contentKey === key)) },
      })
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
 * The current branch name, or `HEAD` when detached.
 * @param repoRoot - absolute repository root.
 * @param timeoutMs - deadline of the call.
 * @returns the branch name.
 */
async function currentBranch(repoRoot: string, timeoutMs: number): Promise<string> {
  const result = await runGit({ cwd: repoRoot, args: ['rev-parse', '--abbrev-ref', 'HEAD'], timeoutMs })
  const branch = result.stdout.trim()
  return branch === '' ? 'HEAD' : branch
}

/**
 * The remote this branch pushes to.
 *
 * git's own answer rather than the first segment of `@{push}`: a remote or ref
 * containing a slash would make that split fetch from the wrong place.
 * @param repoRoot - absolute repository root.
 * @param branch - the branch being pushed.
 * @param timeoutMs - deadline of the call.
 * @returns the remote name, or an empty string when the branch has no push remote.
 */
async function pushRemoteName(repoRoot: string, branch: string, timeoutMs: number): Promise<string> {
  const result = await runGit({
    cwd: repoRoot,
    args: ['for-each-ref', '--format=%(push:remotename)', `refs/heads/${branch}`],
    timeoutMs,
  })
  return result.stdout.trim()
}

/**
 * The `NO_PUSH_TARGET` refusal, naming the exact command that would configure one.
 * @param repoRoot - absolute repository root.
 * @param timeoutMs - deadline of each call.
 * @returns the error to throw.
 */
async function noPushTargetError(repoRoot: string, timeoutMs: number): Promise<ApiHttpError> {
  const remotes = parseLines((await runGit({ cwd: repoRoot, args: ['remote'], timeoutMs })).stdout)
  const branch = await currentBranch(repoRoot, timeoutMs)
  const hint = remotes.length === 1 ? `git push -u ${remotes[0] ?? 'origin'} ${branch}` : `git push -u <remote> ${branch}`
  return new ApiHttpError(400, {
    code: 'NO_PUSH_TARGET',
    message: `no push target is configured for this branch; set one with: ${hint}`,
    details: { branch, remotes },
  })
}

/**
 * Which operation markers exist in this repository.
 * @param repoRoot - absolute repository root.
 * @param timeoutMs - deadline of each call.
 * @returns the marker names that are present, rebase states first.
 */
export async function markersPresent(repoRoot: string, timeoutMs: number): Promise<string[]> {
  const present: string[] = []
  for (const marker of OPERATION_MARKERS) {
    const result = await runGit({ cwd: repoRoot, args: ['rev-parse', '--git-path', marker], timeoutMs })
    const raw = result.stdout.trim()
    if (raw === '') continue
    const absolute = isAbsolute(raw) ? raw : join(repoRoot, raw)
    const found = await stat(absolute).catch(() => null)
    if (found !== null) present.push(marker)
  }
  return present
}

/**
 * Paths the integration left unmerged.
 * @param repoRoot - absolute repository root.
 * @param timeoutMs - deadline of the call.
 * @returns the repository-relative paths, read before any abort clears them.
 */
async function unmergedPaths(repoRoot: string, timeoutMs: number): Promise<string[]> {
  const result = await runGit({
    cwd: repoRoot,
    args: ['diff', '--name-only', '--diff-filter=U', '-z'],
    timeoutMs,
  })
  return result.stdout.split('\0').filter(path => path !== '')
}

/**
 * The path a single `git status --porcelain` line names.
 *
 * The record is exactly `XY PATH`: two fixed status columns, one space, then the
 * path, and the first column is a space for an unstaged-only change. The line is
 * therefore sliced positionally and must never be trimmed first - trimming
 * ` M a.txt` yields `M a.txt`, whose first byte would then be lost.
 * @param line - one porcelain record, verbatim.
 * @returns the destination path.
 */
function pathOfPorcelainLine(line: string): string {
  const rest = line.length > 3 ? line.slice(3) : ''
  const arrow = rest.indexOf(' -> ')
  return arrow === -1 ? rest.trim() : rest.slice(arrow + 4).trim()
}

/**
 * Paths named in git's "would be overwritten" block.
 * @param stderr - git's own refusal text.
 * @returns the indented paths it listed.
 */
function blockedPaths(stderr: string): string[] {
  return stderr.split('\n')
    .filter(line => /^\s+\S/.test(line))
    .map(line => line.trim())
    .filter(line => line !== '' && !line.startsWith('Aborting'))
}

/**
 * Turn an integration failure into a classified refusal, never a 500.
 *
 * The abort runs only when a marker proves an operation is actually in
 * progress: measured on git 2.51, `git merge --abort` with no `MERGE_HEAD` and
 * `git rebase --abort` with no `rebase-merge` both exit 128, which `runGit`
 * would surface as an internal error hiding the real cause. Unmerged paths are
 * read before the abort, because the abort clears them.
 * @param repoRoot - absolute repository root.
 * @param mode - the order that was attempted.
 * @param error - what the integration threw.
 * @param timeoutMs - deadline of each call.
 * @returns the error to throw.
 */
async function integrationFailure(repoRoot: string, mode: SyncMode, error: unknown, timeoutMs: number): Promise<ApiHttpError> {
  const recovery = mode === 'rebase' ? 'git rebase --abort' : 'git merge --abort'
  const stderr = error instanceof GitCommandError ? error.stderr : error instanceof Error ? error.message : String(error)
  const killed = error instanceof GitCommandError && error.exitCode === -1
  const markers = await markersPresent(repoRoot, timeoutMs)

  const stuck = (detail: string, extra: Record<string, unknown>): ApiHttpError => new ApiHttpError(409, {
    code: 'INTEGRATION_STUCK',
    message: `${detail}; recover with ${recovery}. A stale index.lock must only be removed once no git process holds it`,
    details: { mode, recovery, marker: markers[0], markers, stderr, note: 'check git rev-parse --git-path index.lock', ...extra },
  })

  if (markers.length === 0) {
    if (killed) return stuck(`the ${mode} did not finish before the deadline`, {})
    if (WORKTREE_REFUSAL_PATTERN.test(stderr)) {
      return new ApiHttpError(409, {
        code: 'WORKTREE_DIRTY',
        message: `${mode} was refused because local contents are in the way; commit or stash them and try again`,
        details: { paths: blockedPaths(stderr) },
      })
    }
    return new ApiHttpError(409, {
      code: 'INTEGRATE_REFUSED',
      message: `${mode} was refused: ${stderr.trim().slice(0, 800)}`,
      details: { stderr },
    })
  }

  const unmerged = await unmergedPaths(repoRoot, timeoutMs)
  try {
    await runGit({
      cwd: repoRoot,
      args: mode === 'rebase' ? ['rebase', '--abort'] : ['merge', '--abort'],
      timeoutMs,
    })
  } catch (abortError) {
    return stuck(`the ${mode} failed and could not be aborted`, {
      abortError: abortError instanceof Error ? abortError.message : String(abortError),
    })
  }

  if (unmerged.length > 0) {
    return new ApiHttpError(409, {
      code: 'INTEGRATE_CONFLICT',
      message: `${mode} hit a conflict in ${unmerged.length === 1 ? 'one path' : `${unmerged.length} paths`}; the integration was aborted and the commit kept`,
      details: { paths: unmerged },
    })
  }
  return new ApiHttpError(409, {
    code: 'INTEGRATE_FAILED',
    message: `${mode} failed and was aborted: ${stderr.trim().slice(0, 800)}`,
    details: { stderr },
  })
}

/**
 * Push, or integrate the push target and then push.
 *
 * The order matters and is fixed here: cheap local refusals first (`HEAD`
 * compare-and-swap, push target, an operation already in progress), then the
 * network fetch, then the `HEAD` re-check the CAS needs across that round trip,
 * then the integration, then the push. Nothing here force-pushes, guesses a
 * remote, autostashes another agent's work, or retries automatically.
 * @param options - repository root, request body and the integration deadline.
 * @returns the push outcome, with a second failure classified like the first.
 */
export async function integrateRepo(options: {
  readonly repoRoot: string
  readonly request: SyncRequest
  readonly timeoutMs: number
}): Promise<SyncResponse> {
  const { repoRoot, request, timeoutMs } = options
  const mode = request.mode
  const expectedBranch = request.expectedBranch
  const expectedState = { headOid: request.expectedHeadOid, ...(expectedBranch === undefined ? {} : { branch: expectedBranch }) }
  await requireRepoState(repoRoot, expectedState, timeoutMs)

  const pushTarget = await readPushTarget(repoRoot, timeoutMs)
  if (pushTarget === null) throw await noPushTargetError(repoRoot, timeoutMs)
  const branch = await currentBranch(repoRoot, timeoutMs)
  const remote = await pushRemoteName(repoRoot, branch, timeoutMs)
  if (remote === '') throw await noPushTargetError(repoRoot, timeoutMs)

  if (mode !== 'push') {
    const markers = await markersPresent(repoRoot, timeoutMs)
    if (markers.length > 0) {
      throw new ApiHttpError(409, {
        code: 'INTEGRATION_IN_PROGRESS',
        message: `this repository already has an operation in progress (${markers.join(', ')}); finish or abort it first`,
        details: { marker: markers[0], markers },
      })
    }
    if (mode === 'rebase') {
      // Exactly the condition git itself refuses: tracked changes. Untracked
      // paths never block, and `--autostash` is never used because it would
      // temporarily revert other agents' files in this shared tree.
      const porcelain = await runGit({
        cwd: repoRoot,
        args: ['status', '--porcelain', '--untracked-files=no'],
        timeoutMs,
      })
      // Split verbatim: `parseLines` trims, which would eat the first column.
      const dirty = porcelain.stdout.split('\n').filter(line => line !== '')
      if (dirty.length > 0) {
        throw new ApiHttpError(409, {
          code: 'WORKTREE_DIRTY',
          message: 'rebase refuses to run with uncommitted changes to tracked files; commit or stash them, or choose merge, which may still succeed',
          details: { paths: dirty.map(pathOfPorcelainLine) },
        })
      }
    }
    await runGit({ cwd: repoRoot, args: ['fetch', remote], timeoutMs })
    // A fetch can move refs, so the same (branch, OID) check runs again.
    await requireRepoState(repoRoot, expectedState, timeoutMs)
    try {
      await runGit({
        cwd: repoRoot,
        args: mode === 'rebase' ? ['rebase', pushTarget] : ['merge', '--no-edit', pushTarget],
        timeoutMs,
      })
    } catch (error) {
      throw await integrationFailure(repoRoot, mode, error, timeoutMs)
    }
  }

  const headOid = await currentHeadOid(repoRoot, timeoutMs)
  const headShortSha = headOid === null ? 'initial' : headOid.slice(0, 7)
  try {
    await runGit({ cwd: repoRoot, args: ['push'], timeoutMs })
  } catch (error) {
    return {
      mode,
      headOid,
      headShortSha,
      pushed: false,
      pushTarget,
      pushErrorCode: classifyPushError(error),
      pushError: error instanceof Error ? error.message : String(error),
    }
  }
  return { mode, headOid, headShortSha, pushed: true, pushTarget }
}

/**
 * A stable digest of a patch, used only for logging and error detail.
 * @param text - patch text.
 * @returns a short hex digest.
 */
export function patchDigest(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 12)
}
