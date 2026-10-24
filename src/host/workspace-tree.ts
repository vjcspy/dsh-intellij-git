/**
 * Aweave root resolution, repository discovery and path containment.
 *
 * Discovery is deliberately done with `readdir` + `stat` and NEVER with `git`:
 * the tree is 101 repositories on this deployment, and asking git about all of
 * them on every panel open is exactly the cost the Single-Active-Repo Accordion
 * exists to avoid. Opening the tree spawns zero processes; only the one active
 * repository is ever handed to git.
 *
 * Every path that arrives from the browser is re-derived here from a validated
 * id and re-checked with `realpath`, so a crafted `repoId` or `filePath` can
 * never reach a directory outside the Aweave root.
 */
import { readdir, realpath, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'

import {
  AWEAVE_MARKER_REL_PATH,
  ROOT_REPO_ID,
  ROOT_REPO_LABEL,
  type DomainNode,
  type RepoNode,
  type WorkspaceNode,
  type WorkspaceTreeResponse,
} from '../config.ts'

/** One path segment of a workspace, domain or repository name. */
const SEGMENT = /^[A-Za-z0-9._@+-]{1,120}$/

/**
 * Whether a directory entry named `.git` exists.
 *
 * A git worktree stores `.git` as a FILE pointing at the real git dir, so an
 * `isDirectory()` check alone silently drops every worktree.
 * @param path - candidate repository root.
 * @returns true when `.git` exists in any form.
 */
async function hasGitDir(path: string): Promise<boolean> {
  try {
    const info = await stat(join(path, '.git'))
    return info.isDirectory() || info.isFile()
  } catch {
    return false
  }
}

/**
 * Resolve the Aweave platform root.
 *
 * Configured value first, then a walk up from the Host process working
 * directory looking for the platform marker. The marker rule is the one
 * `aweave-dsh-devkit` documents, so both plugins resolve the same tree.
 * @param configured - the `aweaveRoot` config value; empty means derive.
 * @param startDir - directory to start the walk from; defaults to the process cwd.
 * @returns an absolute real path, or null when nothing resolved.
 */
export async function resolveAweaveRoot(configured: string, startDir: string = process.cwd()): Promise<string | null> {
  if (configured.trim() !== '') {
    const candidate = resolve(configured.trim())
    if (!isAbsolute(candidate)) return null
    return realpathOrNull(candidate)
  }
  let current = resolve(startDir)
  for (;;) {
    const marker = join(current, AWEAVE_MARKER_REL_PATH)
    try {
      await stat(marker)
      return realpathOrNull(current)
    } catch {
      const parent = dirname(current)
      if (parent === current) return null
      current = parent
    }
  }
}

/**
 * Real path of an existing directory.
 * @param path - candidate path.
 * @returns the real path, or null when it does not exist.
 */
async function realpathOrNull(path: string): Promise<string | null> {
  try {
    return await realpath(path)
  } catch {
    return null
  }
}

/**
 * List subdirectories of a directory, sorted by name.
 * @param path - the directory.
 * @returns entry names, never throwing for a missing directory.
 */
async function subdirectories(path: string): Promise<string[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true })
    return entries.filter(entry => entry.isDirectory() && !entry.name.startsWith('.')).map(entry => entry.name).sort()
  } catch {
    return []
  }
}

/**
 * Discover every repository under the Aweave root.
 *
 * The platform root repository plus `workspaces/<workspace>/<domain>/<repo>`
 * on exactly three levels. Domains with no repository are omitted so the tree
 * does not offer empty branches.
 * @param aweaveRoot - resolved platform root.
 * @returns the tree, grouped for display.
 */
export async function discoverTree(aweaveRoot: string | null): Promise<WorkspaceTreeResponse> {
  if (aweaveRoot === null) return { configured: false, aweaveRoot: null, rootRepo: null, workspaces: [] }
  const rootRepo: RepoNode | null = (await hasGitDir(aweaveRoot))
    ? { id: ROOT_REPO_ID, label: ROOT_REPO_LABEL, path: aweaveRoot }
    : null

  const workspaces: WorkspaceNode[] = []
  for (const workspace of await subdirectories(join(aweaveRoot, 'workspaces'))) {
    if (!SEGMENT.test(workspace)) continue
    const domains: DomainNode[] = []
    for (const domain of await subdirectories(join(aweaveRoot, 'workspaces', workspace))) {
      if (!SEGMENT.test(domain)) continue
      const repos: RepoNode[] = []
      for (const repo of await subdirectories(join(aweaveRoot, 'workspaces', workspace, domain))) {
        if (!SEGMENT.test(repo)) continue
        const path = join(aweaveRoot, 'workspaces', workspace, domain, repo)
        if (!(await hasGitDir(path))) continue
        repos.push({ id: `${workspace}/${domain}/${repo}`, label: repo, path })
      }
      if (repos.length > 0) domains.push({ name: domain, repos })
    }
    if (domains.length > 0) workspaces.push({ name: workspace, domains })
  }
  return { configured: true, aweaveRoot, rootRepo, workspaces }
}

/**
 * Re-derive one repository's absolute path from its id.
 *
 * The id is the only thing the browser sends; the path is never trusted from
 * the client.
 * @param aweaveRoot - resolved platform root.
 * @param repoId - `root`, or `<workspace>/<domain>/<repo>`.
 * @returns the absolute path, or null when the id is malformed or escapes.
 */
export function resolveRepoPath(aweaveRoot: string, repoId: string): string | null {
  if (repoId === ROOT_REPO_ID) return aweaveRoot
  const parts = repoId.split('/')
  if (parts.length !== 3) return null
  for (const part of parts) {
    if (!SEGMENT.test(part) || part === '.' || part === '..') return null
  }
  const [workspace, domain, repo] = parts as [string, string, string]
  const candidate = resolve(aweaveRoot, 'workspaces', workspace, domain, repo)
  if (!isInside(aweaveRoot, candidate)) return null
  return candidate
}

/**
 * Whether a candidate path stays inside a parent directory.
 * @param parent - already-resolved parent.
 * @param candidate - candidate path.
 * @returns true when the candidate is strictly below the parent.
 */
export function isInside(parent: string, candidate: string): boolean {
  const normalizedParent = parent.endsWith(sep) ? parent : `${parent}${sep}`
  return candidate === parent || candidate.startsWith(normalizedParent)
}

/**
 * Resolve one repository-relative path to an absolute path inside its repo.
 *
 * Rejects absolute paths, `..` segments and any result that escapes the
 * repository after normalization, so a diff or rollback request cannot reach a
 * file outside the repository it names.
 * @param repoRoot - absolute repository root.
 * @param filePath - repository-relative path from git output.
 * @returns the absolute path.
 * @throws Error when the path escapes the repository.
 */
export function resolveRepoFile(repoRoot: string, filePath: string): string {
  if (filePath === '' || isAbsolute(filePath)) throw new Error(`invalid repository path: ${filePath}`)
  if (filePath.split('/').some(part => part === '..')) throw new Error(`invalid repository path: ${filePath}`)
  const candidate = resolve(repoRoot, filePath)
  if (!isInside(repoRoot, candidate) || candidate === repoRoot) throw new Error(`path escapes repository: ${filePath}`)
  return candidate
}
