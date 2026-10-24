/**
 * Branch listing and the one branch write: switch, create, or track.
 *
 * Two properties shape this module.
 *
 * **Ref identity is the fully-qualified ref.** Display names come only from
 * `%(refname:lstrip=2)` (or a stripped `git symbolic-ref -q HEAD`), because a
 * short name is ambiguity-dependent: a branch and a tag sharing a name shorten
 * to `heads/<name>`, and a local branch literally named `<remote>/<branch>` makes
 * the remote short name ambiguous, which breaks both `rev-parse --verify` and a
 * `--track` start point. Every comparison, existence check, `--track` start point
 * and `git diff` revision here therefore stays fully qualified.
 *
 * **A failure is classified from repository state, never from prose.** git's
 * overwrite refusal is translated stderr, so the blocking paths are computed by
 * intersecting what the working tree changed with what differs between `HEAD` and
 * the target tree. The whole classification is contained: when it cannot explain
 * a failure it degrades to `SWITCH_FAILED` carrying the switch's own stderr, so a
 * refusal can never turn into a `500 INTERNAL`.
 *
 * Nothing here fetches, force-checks-out, autostashes or discards anything, and
 * exactly one mutating command ever runs per request.
 */
import { realpath } from 'node:fs/promises'

import type { BranchEntry, BranchesResponse, SwitchRequest, SwitchResponse } from '../config.ts'
import { markersPresent, currentHeadOid, readRepoBranch, requireRepoState } from './git-operations.ts'
import { GitCommandError, runGit } from './git-runner.ts'
import { parseLines } from './git-status.ts'
import { ApiHttpError } from './http-error.ts'

/** Field separator inside one `for-each-ref` record. */
const SEP = '\0'

/**
 * `for-each-ref` format of one local ref.
 *
 * `%(HEAD)` is `*` on the current branch and a space otherwise; `%(worktreepath)`
 * is the real path of the worktree that has the branch checked out, empty for
 * every branch that nobody holds.
 */
const LOCAL_FORMAT = '%(HEAD)%00%(refname:lstrip=2)%00%(objectname:short)%00%(upstream)%00%(committerdate:unix)%00%(subject)%00%(worktreepath)'

/**
 * `for-each-ref` format of one remote-tracking ref.
 *
 * `%(symref)` is non-empty exactly for `<remote>/HEAD`, which is an alias and not
 * a branch, so those records are skipped.
 */
const REMOTE_FORMAT = '%(refname:lstrip=2)%00%(objectname:short)%00%(committerdate:unix)%00%(subject)%00%(symref)'

/** Longest stderr tail an error answer keeps, in characters. */
const STDERR_LIMIT = 4096

/** How many blocking paths an answer lists before it truncates. */
const BLOCKING_PATH_LIMIT = 50

/** One local ref as `for-each-ref` reported it. */
interface LocalRef {
  /** Display name, `%(refname:lstrip=2)`. */
  readonly name: string
  readonly oidShort: string
  /** Full upstream ref, used only for equality comparisons. */
  readonly upstream: string | null
  readonly committedAt: number
  readonly subject: string
  readonly worktreePath: string | null
  readonly current: boolean
}

/** One remote-tracking ref as `for-each-ref` reported it. */
interface RemoteRef {
  /** Display name, `%(refname:lstrip=2)` of `refs/remotes/<...>`. */
  readonly name: string
  /** Full ref, `refs/remotes/<...>`. */
  readonly ref: string
  readonly oidShort: string
  readonly committedAt: number
  readonly subject: string
}

/**
 * Render a full ref as the display name the dialog shows.
 * @param ref - a fully-qualified ref.
 * @returns the ref without its `refs/heads/` or `refs/remotes/` prefix.
 */
function displayOf(ref: string): string {
  if (ref.startsWith('refs/remotes/')) return ref.slice('refs/remotes/'.length)
  if (ref.startsWith('refs/heads/')) return ref.slice('refs/heads/'.length)
  return ref
}

/**
 * Parse one number field, defaulting to zero.
 * @param raw - the field text.
 * @returns the number.
 */
function numberOf(raw: string): number {
  const value = Number.parseInt(raw, 10)
  return Number.isFinite(value) ? value : 0
}

/**
 * Parse a `for-each-ref` run of `LOCAL_FORMAT` records.
 * @param raw - stdout, one record per line.
 * @returns the local refs.
 */
function parseLocalRefs(raw: string): LocalRef[] {
  const refs: LocalRef[] = []
  for (const record of raw.split('\n')) {
    if (record === '') continue
    const fields = record.split(SEP)
    const head = fields[0] ?? ''
    const name = fields[1] ?? ''
    if (name === '') continue
    const upstream = fields[3] ?? ''
    const worktreePath = fields[6] ?? ''
    refs.push({
      name,
      oidShort: fields[2] ?? '',
      upstream: upstream === '' ? null : upstream,
      committedAt: numberOf(fields[4] ?? ''),
      subject: fields[5] ?? '',
      worktreePath: worktreePath === '' ? null : worktreePath,
      current: head === '*',
    })
  }
  return refs
}

/**
 * Parse a `for-each-ref` run of `REMOTE_FORMAT` records.
 *
 * A symbolic record (`<remote>/HEAD`) is skipped rather than listed: it is an
 * alias for another ref, and offering it would create a branch called `HEAD`.
 * @param raw - stdout, one record per line.
 * @returns the remote-tracking refs.
 */
function parseRemoteRefs(raw: string): RemoteRef[] {
  const refs: RemoteRef[] = []
  for (const record of raw.split('\n')) {
    if (record === '') continue
    const fields = record.split(SEP)
    const name = fields[0] ?? ''
    const symref = fields[4] ?? ''
    if (name === '' || symref !== '') continue
    refs.push({
      name,
      ref: `refs/remotes/${name}`,
      oidShort: fields[1] ?? '',
      committedAt: numberOf(fields[2] ?? ''),
      subject: fields[3] ?? '',
    })
  }
  return refs
}

/** The configured remote a display name belongs to, and the rest of the name. */
interface RemoteSplit {
  readonly remote: string
  readonly suffix: string
}

/**
 * Split a remote display name on the **longest** configured remote prefix.
 *
 * Longest, because a remote name may itself contain a slash: `team/origin/foo`
 * belongs to the remote `team/origin`, not to `team`.
 * @param name - the display name, for example `origin/feature-x`.
 * @param remotes - the configured remote names.
 * @returns the split, or null when no configured remote matches.
 */
function splitRemote(name: string, remotes: readonly string[]): RemoteSplit | null {
  let best: RemoteSplit | null = null
  for (const remote of remotes) {
    if (!name.startsWith(`${remote}/`)) continue
    if (best !== null && remote.length <= best.remote.length) continue
    best = { remote, suffix: name.slice(remote.length + 1) }
  }
  return best
}

/**
 * Real path of a directory, falling back to the value when it cannot resolve.
 * @param path - candidate path.
 * @returns the comparison form.
 */
async function realpathOr(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch {
    return path
  }
}

/**
 * The branches another worktree currently holds, keyed by display name.
 *
 * `%(worktreepath)` prints a real path, and so does the repository root this
 * module is given, but a symlinked checkout can still differ, so both sides are
 * realpath'd before the comparison. Only a **different** worktree counts: the
 * calling worktree holding the current branch is not a conflict.
 * @param repoRoot - absolute repository root.
 * @param locals - the local refs just read.
 * @returns display name to worktree path.
 */
async function worktreeHolders(repoRoot: string, locals: readonly LocalRef[]): Promise<Map<string, string>> {
  const self = await realpathOr(repoRoot)
  const holders = new Map<string, string>()
  for (const ref of locals) {
    if (ref.worktreePath === null) continue
    const other = await realpathOr(ref.worktreePath)
    if (other === self) continue
    holders.set(ref.name, other)
  }
  return holders
}

/**
 * The abbreviated `HEAD`, or null on an unborn branch.
 * @param repoRoot - absolute repository root.
 * @param headOid - the full `HEAD` OID, or null when unborn.
 * @param timeoutMs - deadline of the call.
 * @returns the seven-character SHA, or null.
 */
async function shortHead(repoRoot: string, headOid: string | null, timeoutMs: number): Promise<string | null> {
  if (headOid === null) return null
  const result = await runGit({ cwd: repoRoot, args: ['rev-parse', '--short', 'HEAD'], timeoutMs })
  const short = result.stdout.trim()
  return short === '' ? headOid.slice(0, 7) : short
}

/**
 * List every local and remote-tracking branch of one repository, with the facts
 * the dialog needs.
 *
 * A remote row is hidden only when a same-named local branch already tracks that
 * exact ref: that local row represents it, and a direct route call reuses the
 * same branch. A same-named local that tracks something else (or nothing) keeps
 * the remote row visible but marked, so the dialog can explain the refusal
 * instead of hiding a reachable branch.
 * @param repoRoot - absolute repository root.
 * @param repoId - the id the tree knows this repository by.
 * @param timeoutMs - deadline of each call.
 * @returns the listing.
 */
export async function listBranches(repoRoot: string, repoId: string, timeoutMs: number): Promise<BranchesResponse> {
  const remotes = parseLines((await runGit({ cwd: repoRoot, args: ['remote'], timeoutMs })).stdout)
  const localRaw = await runGit({ cwd: repoRoot, args: ['for-each-ref', `--format=${LOCAL_FORMAT}`, 'refs/heads'], timeoutMs })
  const remoteRaw = await runGit({ cwd: repoRoot, args: ['for-each-ref', `--format=${REMOTE_FORMAT}`, 'refs/remotes'], timeoutMs })
  const locals = parseLocalRefs(localRaw.stdout)
  const remoterefs = parseRemoteRefs(remoteRaw.stdout)
  const holders = await worktreeHolders(repoRoot, locals)
  const current = await readRepoBranch(repoRoot, timeoutMs)
  const headOid = await currentHeadOid(repoRoot, timeoutMs)
  const headShortSha = await shortHead(repoRoot, headOid, timeoutMs)

  const localByName = new Map<string, LocalRef>(locals.map(ref => [ref.name, ref]))

  const localEntries: BranchEntry[] = locals.map((ref) => {
    const holder = holders.get(ref.name) ?? null
    return {
      kind: 'local',
      name: ref.name,
      localName: null,
      upstream: ref.upstream === null ? null : displayOf(ref.upstream),
      headShortSha: ref.oidShort === '' ? null : ref.oidShort,
      subject: ref.subject,
      committedAt: ref.committedAt,
      checkedOutAt: holder,
      // `%(HEAD)` and the symbolic ref agree by construction; the symbolic ref is
      // the identity this module reasons about, so it wins where they could differ.
      current: ref.current && current === ref.name,
      localConflict: null,
    }
  })
  localEntries.sort((left, right) => {
    if (left.current !== right.current) return left.current ? -1 : 1
    return left.name.localeCompare(right.name)
  })

  const remoteEntries: BranchEntry[] = []
  const seen = new Set<string>()
  for (const ref of [...remoterefs].sort((left, right) => left.name.localeCompare(right.name))) {
    const split = splitRemote(ref.name, remotes)
    // A ref under a remote that is no longer configured is a leftover; it is
    // skipped, never an error, so an orphan can never fail the listing.
    if (split === null || split.suffix === '') continue
    if (seen.has(ref.name)) continue
    seen.add(ref.name)
    const local = localByName.get(split.suffix) ?? null
    if (local !== null && local.upstream === ref.ref) continue
    remoteEntries.push({
      kind: 'remote',
      name: ref.name,
      localName: split.suffix,
      upstream: null,
      headShortSha: ref.oidShort === '' ? null : ref.oidShort,
      subject: ref.subject,
      committedAt: ref.committedAt,
      checkedOutAt: null,
      current: false,
      localConflict: local === null ? null : { name: local.name, upstream: local.upstream === null ? null : displayOf(local.upstream) },
    })
  }

  return {
    repoId,
    current,
    detached: current === null,
    headShortSha,
    remotes,
    local: localEntries,
    remote: remoteEntries,
  }
}

/**
 * Read a NUL-separated path list from one `git` call.
 * @param repoRoot - absolute repository root.
 * @param args - the git arguments.
 * @param timeoutMs - deadline of the call.
 * @returns the paths.
 */
async function nameList(repoRoot: string, args: readonly string[], timeoutMs: number): Promise<string[]> {
  const result = await runGit({ cwd: repoRoot, args, timeoutMs })
  return result.stdout.split('\0').filter(path => path !== '')
}

/**
 * Intersect two path lists.
 *
 * Case is folded only when the repository's volume is case-insensitive: measured
 * true for `core.ignorecase` on macOS and false in the Linux container, so folding
 * unconditionally would invent a collision on a case-sensitive checkout while
 * never folding would miss the macOS one.
 * @param left - first list.
 * @param right - second list.
 * @param fold - compare lowercased when true.
 * @returns the entries of `left` that also appear in `right`.
 */
function overlap(left: readonly string[], right: readonly string[], fold: boolean): string[] {
  const index = new Set<string>(fold ? right.map(path => path.toLowerCase()) : right)
  return left.filter((path) => {
    const key = fold ? path.toLowerCase() : path
    return index.has(key)
  })
}

/**
 * Validate a name with git's own ref-format check.
 *
 * The exit code alone is not enough: `check-ref-format --branch @{-1}` expands to
 * another name and exits 0, so the printed name must equal the input. Exit 128 is
 * git's own refusal and is allowed here so it maps to a `400`, not a `500`.
 * @param repoRoot - absolute repository root.
 * @param name - the requested branch name.
 * @param timeoutMs - deadline of the call.
 */
async function requireValidBranchName(repoRoot: string, name: string, timeoutMs: number): Promise<void> {
  const result = await runGit({
    cwd: repoRoot,
    args: ['check-ref-format', '--branch', name],
    timeoutMs,
    allowExitCodes: [0, 128],
  })
  const printed = result.stdout.trim()
  if (result.exitCode !== 0 || printed !== name) {
    throw new ApiHttpError(400, {
      code: 'INVALID_BRANCH_NAME',
      message: `git refused this branch name: ${name}`,
      details: { name, expanded: printed },
    })
  }
}

/**
 * Whether a local ref exists.
 * @param repoRoot - absolute repository root.
 * @param name - the bare branch name.
 * @param timeoutMs - deadline of the call.
 * @returns true when `refs/heads/<name>` resolves.
 */
async function localRefExists(repoRoot: string, name: string, timeoutMs: number): Promise<boolean> {
  const result = await runGit({
    cwd: repoRoot,
    args: ['rev-parse', '--verify', `refs/heads/${name}`],
    timeoutMs,
    allowExitCodes: [0, 128],
  })
  return result.exitCode === 0
}

/**
 * The `409 SWITCH_FAILED` answer: the switch's own exit code and stderr tail.
 * @param error - what the switch threw.
 * @returns the error to throw.
 */
function switchFailed(error: unknown): ApiHttpError {
  const exitCode = error instanceof GitCommandError ? error.exitCode : -1
  const stderr = error instanceof GitCommandError
    ? error.stderr
    : error instanceof Error ? error.message : String(error)
  return new ApiHttpError(409, {
    code: 'SWITCH_FAILED',
    message: `git refused the switch: ${stderr.trim().slice(0, 800)}`,
    details: { exitCode, stderr: stderr.slice(-STDERR_LIMIT) },
  })
}

/**
 * Classify a failed switch from repository state.
 *
 * Every read below is contained: an unborn, ambiguous or otherwise unreadable
 * repository degrades to `SWITCH_FAILED` rather than escaping as an internal
 * error, because `runGit` throws on any exit code the caller did not allow and the
 * route layer turns that into a `500`.
 * @param options - repository root, the target's tree ref, and what the switch threw.
 * @returns the classified refusal.
 */
async function classifySwitchFailure(options: {
  readonly repoRoot: string
  readonly headOid: string | null
  readonly targetTreeRef: string | null
  readonly holderPath: string | null
  readonly error: unknown
  readonly timeoutMs: number
}): Promise<ApiHttpError> {
  const { repoRoot, headOid, targetTreeRef, holderPath, error, timeoutMs } = options
  try {
    if (holderPath !== null) {
      throw new ApiHttpError(409, {
        code: 'BRANCH_CHECKED_OUT_ELSEWHERE',
        message: `this branch is checked out in another worktree: ${holderPath}`,
        details: { path: holderPath },
      })
    }
    // An unborn repository has no tree to compare against, and `switch -c` there
    // is measured to succeed, so there is nothing to classify.
    if (headOid === null || targetTreeRef === null) throw switchFailed(error)

    const ignorecase = await runGit({
      cwd: repoRoot,
      args: ['config', '--bool', 'core.ignorecase'],
      timeoutMs,
      allowExitCodes: [0, 1],
    })
    const fold = ignorecase.stdout.trim() === 'true'

    const modified = await nameList(repoRoot, ['diff', '--name-only', '-z', headOid], timeoutMs)
    const untracked = await nameList(repoRoot, ['ls-files', '--others', '--exclude-standard', '-z'], timeoutMs)
    // Fully qualified with `--`: a branch and a file of the same name make the
    // bare form exit 128 with `ambiguous argument`.
    const differing = await nameList(repoRoot, ['diff', '--name-only', '-z', headOid, targetTreeRef, '--'], timeoutMs)
    const addedInTarget = await nameList(repoRoot, ['diff', '--name-only', '--diff-filter=A', '-z', headOid, targetTreeRef, '--'], timeoutMs)

    const blocked = [...overlap(modified, differing, fold), ...overlap(untracked, addedInTarget, fold)]
    const unique = [...new Set(blocked)].sort()
    if (unique.length > 0) {
      const shown = unique.slice(0, BLOCKING_PATH_LIMIT)
      throw new ApiHttpError(409, {
        code: 'LOCAL_CHANGES_BLOCK_SWITCH',
        message: `the switch would overwrite local changes in ${unique.length === 1 ? 'one path' : `${unique.length} paths`}; commit or discard them first`,
        details: { paths: shown, total: unique.length, truncated: shown.length < unique.length },
      })
    }
    throw switchFailed(error)
  } catch (classificationError) {
    // A refusal this function decided on passes through; anything the
    // classification itself hit becomes the plain switch failure.
    if (classificationError instanceof ApiHttpError) throw classificationError
    throw switchFailed(error)
  }
}

/**
 * Switch, create or track a branch, exactly once.
 *
 * The order is fixed: compare-and-swap on (branch, OID), an operation-in-progress
 * guard, validation of the target against freshly read refs (never against the
 * client's list), then at most one mutating command, then classification from
 * state if it failed. Nothing here fetches, forces or stashes.
 * @param repoRoot - absolute repository root.
 * @param request - the switch body.
 * @param timeoutMs - deadline of each call.
 * @returns the outcome.
 */
export async function switchBranch(repoRoot: string, request: SwitchRequest, timeoutMs: number): Promise<SwitchResponse> {
  const expected = { headOid: request.expectedHeadOid, ...(request.expectedBranch === undefined ? {} : { branch: request.expectedBranch }) }
  const state = await requireRepoState(repoRoot, expected, timeoutMs)
  const previousBranch = state.branch

  const markers = await markersPresent(repoRoot, timeoutMs)
  if (markers.length > 0) {
    throw new ApiHttpError(409, {
      code: 'INTEGRATION_IN_PROGRESS',
      message: `this repository already has an operation in progress (${markers.join(', ')}); finish or abort it first`,
      details: { marker: markers[0], markers },
    })
  }

  const target = request.target
  if (target.name.startsWith('-')) {
    throw new ApiHttpError(400, { code: 'INVALID_REQUEST', message: 'a branch name cannot start with "-"' })
  }

  const remotes = parseLines((await runGit({ cwd: repoRoot, args: ['remote'], timeoutMs })).stdout)
  const locals = parseLocalRefs((await runGit({
    cwd: repoRoot,
    args: ['for-each-ref', `--format=${LOCAL_FORMAT}`, 'refs/heads'],
    timeoutMs,
  })).stdout)
  const holders = await worktreeHolders(repoRoot, locals)

  /** Local names as the dialog shows them, for membership tests. */
  const localNames = new Set(locals.map(ref => ref.name))
  /** The branch this switch would leave checked out, when it is a local one. */
  let localTarget: string | null = null
  /** The tree the target resolves to, for the state comparison; null for a new branch. */
  let targetTreeRef: string | null = null
  /** The command to run, or null when the target is already current. */
  let command: string[] | null = null
  let created = false
  let changed = false

  if (target.kind === 'local') {
    if (!localNames.has(target.name)) {
      throw new ApiHttpError(404, {
        code: 'BRANCH_NOT_FOUND',
        message: `no local branch named ${target.name} exists any more; reload the list`,
        details: { name: target.name },
      })
    }
    localTarget = target.name
    targetTreeRef = `refs/heads/${target.name}`
    changed = previousBranch !== target.name
    if (changed) command = [target.name]
  } else if (target.kind === 'remote') {
    const split = splitRemote(target.name, remotes)
    if (split === null || split.suffix === '') {
      throw new ApiHttpError(404, {
        code: 'BRANCH_NOT_FOUND',
        message: `no remote branch named ${target.name} exists any more; reload the list`,
        details: { name: target.name },
      })
    }
    const fullRef = `refs/remotes/${split.remote}/${split.suffix}`
    const exists = await runGit({
      cwd: repoRoot,
      args: ['rev-parse', '--verify', fullRef],
      timeoutMs,
      allowExitCodes: [0, 128],
    })
    if (exists.exitCode !== 0) {
      throw new ApiHttpError(404, {
        code: 'BRANCH_NOT_FOUND',
        message: `no remote branch named ${target.name} exists any more; reload the list`,
        details: { name: target.name },
      })
    }
    targetTreeRef = fullRef
    const local = locals.find(ref => ref.name === split.suffix) ?? null
    if (local !== null) {
      if (local.upstream !== fullRef) {
        throw new ApiHttpError(409, {
          code: 'BRANCH_EXISTS',
          message: `the local branch ${local.name} already exists and tracks ${local.upstream === null ? 'nothing' : displayOf(local.upstream)}`,
          details: { local: local.name, upstream: local.upstream === null ? null : displayOf(local.upstream), target: fullRef },
        })
      }
      // Reuse: the same-named local already tracks exactly this ref.
      localTarget = local.name
      targetTreeRef = `refs/heads/${local.name}`
      changed = previousBranch !== local.name
      if (changed) command = [local.name]
    } else {
      await requireValidBranchName(repoRoot, split.suffix, timeoutMs)
      localTarget = split.suffix
      // The fully-qualified start point: the bare form is measured to fail with
      // `ambiguous object name` when a local branch is named `<remote>/<branch>`.
      command = ['-c', split.suffix, '--track', fullRef]
      created = true
      changed = true
    }
  } else {
    await requireValidBranchName(repoRoot, target.name, timeoutMs)
    if (await localRefExists(repoRoot, target.name, timeoutMs)) {
      throw new ApiHttpError(409, {
        code: 'BRANCH_EXISTS',
        message: `a branch named ${target.name} already exists`,
        details: { name: target.name },
      })
    }
    command = ['-c', target.name]
    created = true
    changed = true
  }

  if (command === null) {
    // Already current: no mutating command runs, and the answer still carries a
    // freshly read OID in case the caller's copy was stale.
    const headOid = await currentHeadOid(repoRoot, timeoutMs)
    return {
      repoId: request.repoId,
      previousBranch,
      branch: previousBranch,
      headOid,
      headShortSha: await shortHead(repoRoot, headOid, timeoutMs),
      created: false,
      changed: false,
    }
  }

  try {
    await runGit({ cwd: repoRoot, args: ['switch', '--no-guess', ...command], timeoutMs })
  } catch (error) {
    if (!(error instanceof GitCommandError)) throw error
    throw await classifySwitchFailure({
      repoRoot,
      headOid: state.headOid,
      targetTreeRef,
      holderPath: localTarget === null ? null : (holders.get(localTarget) ?? null),
      error,
      timeoutMs,
    })
  }

  const headOid = await currentHeadOid(repoRoot, timeoutMs)
  return {
    repoId: request.repoId,
    previousBranch,
    branch: await readRepoBranch(repoRoot, timeoutMs),
    headOid,
    headShortSha: await shortHead(repoRoot, headOid, timeoutMs),
    created,
    changed,
  }
}
