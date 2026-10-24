/**
 * Reading one file's diff and rebuilding patches from selected hunks.
 *
 * Two jobs, both about identity. The browser keeps a per-hunk inclusion set,
 * and reverting one hunk shifts every later hunk's line numbers, so a hunk's
 * identity cannot be its position: `contentKey` is a fingerprint of the hunk's
 * own body plus an occurrence ordinal, which survives renumbering.
 *
 * Every `git diff` here is hardened against the operator's configuration.
 * `color.ui=always`, `diff.noprefix`, a `textconv` driver or `diff.external`
 * would all change the bytes this parser reads and the patch `git apply`
 * consumes, so the flags below pin the format regardless of the user's config.
 */
import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'

import {
  MAX_DIFF_FILE_BYTES,
  type DiffHunk,
  type DiffLine,
  type FileDiffResponse,
} from '../config.ts'
import { runGit } from './git-runner.ts'
import { resolveRepoFile } from './workspace-tree.ts'

/** Format-pinning flags shared by every diff invocation. */
const DIFF_FLAGS = [
  '--no-ext-diff',
  '--no-color',
  '--no-textconv',
  '--src-prefix=a/',
  '--dst-prefix=b/',
  '--unified=3',
] as const

/** Matches a hunk header and captures its four span numbers. */
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

/** Marker git writes instead of a patch when a side is binary. */
const BINARY_MARKERS = ['Binary files ', 'GIT binary patch', 'Binary file '] as const

/**
 * Read one file's diff against `HEAD`.
 * @param repoRoot - absolute repository root.
 * @param path - repository-relative path.
 * @param origPath - source path of a rename, when the change is one.
 * @param status - the change status the tree reported.
 * @param timeoutMs - deadline of each `git` call.
 * @returns the parsed diff.
 */
export async function readFileDiff(options: {
  readonly repoRoot: string
  readonly path: string
  readonly origPath: string | null
  readonly status: FileDiffResponse['status']
  readonly timeoutMs: number
}): Promise<FileDiffResponse> {
  const { repoRoot, path, origPath, status, timeoutMs } = options
  const head = await runGit({
    cwd: repoRoot,
    args: ['rev-parse', '--verify', 'HEAD'],
    timeoutMs,
    allowExitCodes: [0, 128],
  })
  const headOid = head.exitCode === 0 ? head.stdout.trim() : null
  const headShortSha = headOid === null ? 'initial' : headOid.slice(0, 7)

  const withoutHead = headOid === null || status === 'U'
  const argv = withoutHead
    ? ['diff', '--no-index', ...DIFF_FLAGS, '--', '/dev/null', resolveRepoFile(repoRoot, path)]
    : ['diff', ...DIFF_FLAGS, 'HEAD', '--', ...(status === 'R' && origPath !== null ? [origPath, path] : [path])]

  const result = await runGit({ cwd: repoRoot, args: argv, timeoutMs, allowExitCodes: [0, 1] })
  const binary = BINARY_MARKERS.some(marker => result.stdout.includes(marker)) || (await looksBinary(repoRoot, path))
  const hunks = binary ? [] : parseUnifiedHunks(result.stdout)

  return {
    repoId: '',
    path,
    origPath: origPath ?? null,
    status,
    headOid,
    headShortSha,
    binary,
    changedLines: hunks.reduce((total, hunk) => total + hunk.lines.filter(line => line.kind !== 'context').length, 0),
    hunks,
  }
}

/**
 * Whether a working-tree file looks binary.
 * @param repoRoot - absolute repository root.
 * @param path - repository-relative path.
 * @returns true when the first bytes carry a NUL.
 */
async function looksBinary(repoRoot: string, path: string): Promise<boolean> {
  try {
    const absolute = resolveRepoFile(repoRoot, path)
    const info = await stat(absolute)
    if (info.size > MAX_DIFF_FILE_BYTES) return true
    const buffer = await readFile(absolute)
    return buffer.subarray(0, 8000).includes(0)
  } catch {
    return false
  }
}

/**
 * Parse unified-diff hunks.
 * @param raw - the full diff text.
 * @returns hunks with their stable content keys.
 */
export function parseUnifiedHunks(raw: string): DiffHunk[] {
  const hunks: DiffHunk[] = []
  const seen = new Map<string, number>()
  const lines = raw.split('\n')
  let current: { header: string, oldStart: number, oldLines: number, newStart: number, newLines: number, body: DiffLine[] } | null = null

  const flush = (): void => {
    if (current === null) return
    const bodyKeys = current.body.map(line => `${line.kind}${line.text}`).join('\n')
    const base = createHash('sha256').update(`${current.oldLines}:${current.newLines}\n${bodyKeys}`).digest('hex')
    const ordinal = seen.get(base) ?? 0
    seen.set(base, ordinal + 1)
    hunks.push({
      contentKey: `${base}#${ordinal}`,
      header: current.header,
      oldStart: current.oldStart,
      oldLines: current.oldLines,
      newStart: current.newStart,
      newLines: current.newLines,
      lines: current.body,
    })
    current = null
  }

  let oldLine = 0
  let newLine = 0
  for (const line of lines) {
    const header = HUNK_HEADER.exec(line)
    if (header !== null) {
      flush()
      const oldStart = Number.parseInt(header[1] ?? '0', 10)
      const oldCount = header[2] === undefined ? 1 : Number.parseInt(header[2], 10)
      const newStart = Number.parseInt(header[3] ?? '0', 10)
      const newCount = header[4] === undefined ? 1 : Number.parseInt(header[4], 10)
      current = { header: line, oldStart, oldLines: oldCount, newStart, newLines: newCount, body: [] }
      oldLine = oldStart
      newLine = newStart
      continue
    }
    if (current === null) continue
    if (line.startsWith('\\')) continue
    if (line === '' && current.body.length > 0) break
    const marker = line.charAt(0)
    if (marker === ' ') {
      current.body.push({ kind: 'context', text: line.slice(1), oldLine, newLine })
      oldLine += 1
      newLine += 1
    } else if (marker === '-') {
      current.body.push({ kind: 'del', text: line.slice(1), oldLine, newLine: null })
      oldLine += 1
    } else if (marker === '+') {
      current.body.push({ kind: 'add', text: line.slice(1), oldLine: null, newLine })
      newLine += 1
    }
  }
  flush()
  return hunks
}

/**
 * Build a unified patch containing only the named hunks.
 *
 * The patch is what `git apply --cached --unidiff-zero` consumes for a partial
 * commit and what `git apply --reverse --unidiff-zero` consumes for a hunk
 * revert, so the header must name the repository-relative paths and the hunk
 * spans must be the original ones.
 * @param path - repository-relative destination path.
 * @param hunks - the hunks to include.
 * @param kind - whether the patch creates a file (`new`), removes one (`delete`) or edits one.
 * @returns the patch text.
 */
export function buildPatch(path: string, hunks: readonly DiffHunk[], kind: 'edit' | 'new' | 'delete'): string {
  const oldPath = kind === 'new' ? '/dev/null' : `a/${path}`
  const newPath = kind === 'delete' ? '/dev/null' : `b/${path}`
  const out: string[] = [`diff --git a/${path} b/${path}`, `--- ${oldPath}`, `+++ ${newPath}`]
  for (const hunk of hunks) {
    out.push(hunk.header)
    for (const line of hunk.lines) {
      const prefix = line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' '
      out.push(`${prefix}${line.text}`)
    }
  }
  return `${out.join('\n')}\n`
}
