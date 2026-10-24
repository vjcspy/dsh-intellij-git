/**
 * Turning one repository's changed and untracked paths into the two IntelliJ
 * groups, with compact directory folding and derived tri-state checkboxes.
 *
 * The checkbox state is DERIVED, never stored per node: only files carry an
 * inclusion value, and every group and directory reports the aggregate of its
 * descendants. That is what keeps a folder checkbox, a section header and the
 * diff sub-header's `Current version` box in agreement without a
 * synchronisation step.
 */
import type { FileChangeEntry, FileInclusion } from '../config.ts'

/** Derived checkbox state. */
export type CheckState = 'checked' | 'indeterminate' | 'unchecked'

/** One file row. */
export interface FileNode {
  readonly type: 'file'
  readonly name: string
  readonly path: string
  readonly origPath: string | null
  readonly status: FileChangeEntry['status'] | 'U'
  readonly check: CheckState
  /** True when some but not all hunks of this file are included. */
  readonly partial: boolean
}

/** One directory row. */
export interface DirNode {
  readonly type: 'dir'
  readonly name: string
  readonly key: string
  readonly children: readonly TreeNode[]
  readonly check: CheckState
  readonly count: number
}

/** One section row (`Changes` or `Unversioned Files`). */
export interface GroupNode {
  readonly type: 'group'
  readonly key: 'changes' | 'unversioned'
  readonly children: readonly TreeNode[]
  readonly check: CheckState
  readonly count: number
}

/** Any row the tree renders. */
export type TreeNode = FileNode | DirNode

/** Per-file inclusion values, keyed by path. */
export type InclusionMap = Readonly<Record<string, FileInclusion>>

/**
 * Derive a checkbox state from a file's inclusion.
 * @param inclusion - the file's inclusion, or undefined when untouched.
 * @returns the checkbox state.
 */
export function fileCheckState(inclusion: FileInclusion | undefined): CheckState {
  if (inclusion === undefined || inclusion.mode === 'none') return 'unchecked'
  if (inclusion.mode === 'all') return 'checked'
  return inclusion.hunkKeys.length === 0 ? 'unchecked' : 'indeterminate'
}

/**
 * Aggregate child states into a parent state.
 * @param states - descendant states.
 * @returns checked when all are checked, unchecked when none is, indeterminate otherwise.
 */
export function aggregate(states: readonly CheckState[]): CheckState {
  if (states.length === 0) return 'unchecked'
  const checked = states.filter(state => state === 'checked').length
  if (checked === states.length) return 'checked'
  if (checked === 0 && states.every(state => state === 'unchecked')) return 'unchecked'
  return 'indeterminate'
}

/** A raw row before folding. */
interface RawEntry {
  readonly path: string
  readonly origPath: string | null
  readonly status: FileChangeEntry['status'] | 'U'
}

/**
 * Build a directory tree from flat paths, folding single-child directories.
 *
 * Folding is what produces IntelliJ's `commands/common` rows instead of one row
 * per path segment. It only folds a directory whose sole child is another
 * directory, so a directory holding files always renders as its own row.
 * @param entries - flat file rows.
 * @param inclusions - per-file inclusion values.
 * @param compact - whether to fold single-child directories.
 * @returns the child rows of the group.
 */
export function buildChildren(entries: readonly RawEntry[], inclusions: InclusionMap, compact: boolean): { children: TreeNode[], check: CheckState, count: number } {
  interface Build {
    dirs: Map<string, Build>
    files: FileNode[]
  }
  const root: Build = { dirs: new Map(), files: [] }

  for (const entry of entries) {
    const segments = entry.path.split('/')
    const fileName = segments[segments.length - 1] ?? entry.path
    const inclusion = inclusions[entry.path]
    const state = fileCheckState(inclusion)
    const file: FileNode = {
      type: 'file',
      name: fileName,
      path: entry.path,
      origPath: entry.origPath,
      status: entry.status,
      check: state,
      partial: state === 'indeterminate',
    }
    let cursor = root
    for (const segment of segments.slice(0, -1)) {
      const next = cursor.dirs.get(segment)
      if (next === undefined) {
        const created: Build = { dirs: new Map(), files: [] }
        cursor.dirs.set(segment, created)
        cursor = created
      } else {
        cursor = next
      }
    }
    cursor.files.push(file)
  }

  /**
   * Render one level.
   * @param build - the level.
   * @param prefix - accumulated path prefix for child keys.
   * @returns rendered rows with their aggregate state.
   */
  const render = (build: Build, prefix: string): { rows: TreeNode[], states: CheckState[], count: number } => {
    const rows: TreeNode[] = []
    const states: CheckState[] = []
    let count = 0
    for (const file of [...build.files].sort((a, b) => a.name.localeCompare(b.name))) {
      rows.push(file)
      states.push(file.check)
      count += 1
    }
    const names = [...build.dirs.keys()].sort()
    for (const name of names) {
      const child = build.dirs.get(name)
      if (child === undefined) continue
      const childPrefix = prefix === '' ? name : `${prefix}/${name}`
      const rendered = render(child, childPrefix)
      let label = name
      let rowsForNode = rendered.rows
      let statesForNode = rendered.states
      let countForNode = rendered.count
      if (compact) {
        let cursor = child
        let merged = name
        // Fold while the current directory holds no file and exactly one subdirectory.
        while (cursor.files.length === 0 && cursor.dirs.size === 1) {
          const onlyName = [...cursor.dirs.keys()][0]
          if (onlyName === undefined) break
          const only = cursor.dirs.get(onlyName)
          if (only === undefined) break
          merged = `${merged}/${onlyName}`
          cursor = only
        }
        if (merged !== name) {
          label = merged
          const folded = render(cursor, childPrefix)
          rowsForNode = folded.rows
          statesForNode = folded.states
          countForNode = folded.count
        }
      }
      rows.push({
        type: 'dir',
        name: label,
        key: childPrefix,
        children: rowsForNode,
        check: aggregate(statesForNode),
        count: countForNode,
      })
      states.push(aggregate(statesForNode))
      count += countForNode
    }
    return { rows, states, count }
  }

  const rendered = render(root, '')
  return { children: rendered.rows, check: aggregate(rendered.states), count: rendered.count }
}

/**
 * Build both groups for one repository.
 * @param changes - tracked changes.
 * @param unversioned - untracked paths.
 * @param inclusions - per-file inclusion values.
 * @param compact - whether to fold single-child directories.
 * @returns the two groups.
 */
export function buildGroups(
  changes: readonly FileChangeEntry[],
  unversioned: readonly string[],
  inclusions: InclusionMap,
  compact: boolean,
): { changes: GroupNode, unversioned: GroupNode } {
  const changeRows: RawEntry[] = changes.map(entry => ({ path: entry.path, origPath: entry.origPath ?? null, status: entry.status }))
  const untrackedRows: RawEntry[] = unversioned.map(path => ({ path, origPath: null, status: 'U' as const }))
  const changed = buildChildren(changeRows, inclusions, compact)
  const untracked = buildChildren(untrackedRows, inclusions, compact)
  return {
    changes: { type: 'group', key: 'changes', children: changed.children, check: changed.check, count: changed.count },
    unversioned: { type: 'group', key: 'unversioned', children: untracked.children, check: untracked.check, count: untracked.count },
  }
}

/**
 * Collect every file row under a node.
 * @param node - the node to walk.
 * @returns its file rows.
 */
export function filesOf(node: TreeNode | GroupNode): FileNode[] {
  if (node.type === 'file') return [node]
  return node.children.flatMap(child => filesOf(child))
}
