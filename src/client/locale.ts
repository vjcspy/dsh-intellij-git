/**
 * Copy dictionary for the Git Commit tool window and the diff viewer.
 *
 * Every product-visible string lives here and reaches a component through the
 * `t` seat. Repository names, paths, branch names and commit messages are user
 * data and are rendered verbatim, never through this dictionary.
 */
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Git Commit tab title, guide entry, tree, commit box and diff viewer copy. */
    dshIntellijGit: DshIntellijGitKey
  }
}

/** English dictionary, and the namespace's key-set source of truth. */
export const en = {
  'tab.title': 'Git Commit',
  'guide.title': 'Git Commit',
  'guide.description': 'IntelliJ-style commit and diff for the platform root and every workspace repository',

  'diff.title': 'Commit: {path}',
  'diff.titleEmpty': 'Diff',

  'toolbar.refresh': 'Refresh',
  'toolbar.rollback': 'Rollback',
  'toolbar.expandAll': 'Expand all',
  'toolbar.collapseAll': 'Collapse all',
  'toolbar.compact': 'Group by directory',

  'section.root': 'Root repo',
  'section.workspaces': 'Workspaces',
  'section.changes': 'Changes',
  'section.unversioned': 'Unversioned Files',
  'section.files': '{count} files',
  'section.file': '1 file',

  'commit.amend': 'Amend',
  'commit.amendLast': 'last commit',
  'commit.amendPublished': 'this commit is already pushed; amending rewrites published history',
  'commit.message': 'Commit Message',
  'commit.messagePlaceholder': 'Describe the change',
  'commit.generate': 'Generate message',
  'commit.generating': 'Generating',
  'commit.aiRoute': 'via {provider}/{model}',
  'commit.button': 'Commit',
  'commit.pushButton': 'Commit and Push...',
  'commit.busy': 'Committing',
  'commit.done': 'Committed {sha}',
  'commit.pushed': 'Committed {sha} and pushed',
  'commit.indexWarning': 'Committed, but the git index could not be updated: {reason}',
  'commit.headMoved': 'HEAD moved while committing; refresh the panel before committing again',
  'commit.pushNoTarget': 'Committed {sha}, but this branch has no push target: {hint}',
  'commit.pushFailed': 'Committed {sha}, but the push failed: {reason}',

  'rollback.title': 'Rollback changes',
  'rollback.confirm': 'Roll back the selected changes? Unversioned files are deleted from disk.',
  'rollback.confirmButton': 'Roll back',
  'rollback.cancel': 'Cancel',
  'rollback.done': 'Rolled back {count} paths',

  'state.loading': 'Loading',
  'state.noRoot': 'No Aweave root resolved. Set aweaveRoot in the profile patch.',
  'state.noRootHint': 'The plugin derives the root from the Host working directory; start the Host inside the checkout or configure the path.',
  'state.noRepo': 'Expand a repository to load its changes',
  'state.noChanges': 'No local changes',
  'state.error': 'Something went wrong',
  'state.retry': 'Retry',

  'diff.toolbar.previous': 'Previous difference',
  'diff.toolbar.next': 'Next difference',
  'diff.toolbar.refresh': 'Refresh',
  'diff.toolbar.prevFile': 'Previous file',
  'diff.toolbar.nextFile': 'Next file',
  'diff.toolbar.split': 'Side-by-Side',
  'diff.toolbar.unified': 'Unified',
  'diff.toolbar.collapse': 'Collapse unchanged fragments',
  'diff.summary': '{total} differences, {included} included',
  'diff.currentVersion': 'Current version',
  'diff.binary': 'Binary content changed; the full file is included when checked',
  'diff.deleteHunk': 'Revert this hunk',
  'diff.includeHunk': 'Include this hunk',
  'diff.excludeHunk': 'Exclude this hunk',
  'diff.locked': 'committed',
  'diff.empty': 'Select a file to see its diff',

  'badge.branch': 'branch',
  'badge.initial': 'initial',
  'badge.ahead': 'ahead',
  'badge.behind': 'behind',
  'badge.unresolved': 'unresolved',
} satisfies Record<string, string>

/** Every key the dictionary defines. */
export type DshIntellijGitKey = keyof typeof en

/** The namespace-bound translate seat a component receives. */
export type Translate = PropsLocale<'dshIntellijGit'>['t']
