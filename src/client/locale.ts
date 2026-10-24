/**
 * Copy dictionary for the Git Commit tool window and the diff viewer.
 *
 * Every product-visible string, including every tooltip and every confirmation
 * sentence, lives here and reaches a component through the `t` seat.
 * Repository names, paths, branch names and commit messages are user data and
 * are rendered verbatim, never through this dictionary.
 */
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Git Commit tab title, guide entry, tree, commit box, diff viewer, tooltips and dialogs. */
    dshIntellijGit: DshIntellijGitKey
  }
}

/** English dictionary, and the namespace's key-set source of truth. */
export const en = {
  'tab.title': 'Git Commit',
  'guide.title': 'Git Commit',
  'guide.description': 'IntelliJ-style commit and diff for the platform root and every workspace repository',

  'diff.titleEmpty': 'Diff',

  'toolbar.refresh': 'Refresh',
  'toolbar.refresh.tip': 'Reload the change list of the open repository from disk',
  'toolbar.rollback': 'Rollback',
  'toolbar.rollback.tip': 'Discard the ticked changes and restore them from the last commit. Asks first',
  'toolbar.expandAll': 'Expand all',
  'toolbar.expandAll.tip': 'Open every directory in the change list',
  'toolbar.collapseAll': 'Collapse all',
  'toolbar.collapseAll.tip': 'Close every directory in the change list',
  'toolbar.compact': 'Group by directory',
  'toolbar.compact.tip': 'Fold single-child directories into one row, as IntelliJ does',
  'toolbar.busy.tip': 'Working. Wait for the current action to finish',

  'section.root': 'Root repo',
  'section.workspaces': 'Workspaces',
  'section.changes': 'Changes',
  'section.unversioned': 'Unversioned Files',
  'section.files': '{count} files',
  'section.file': '1 file',
  'section.twisty.tip': 'Expand or collapse this branch',
  'section.check.tip': 'Tick or untick every change under {name}',
  'section.disabled.tip': 'Nothing to load until a repository is open',

  'repo.open.tip': 'Open {name}. Only one repository is open at a time, so only one runs git',
  'repo.close.tip': 'Close {name} and unload its change list',
  'repo.branch.tip': 'Branch {branch}, {ahead} ahead and {behind} behind its upstream',

  'file.open.tip': 'Show the diff of {name} in the pane beside this tree',
  'file.check.tip': 'Include or exclude the whole of {name} in the next commit',

  'commit.amend': 'Amend',
  'commit.amend.tip': 'Rewrite the last commit instead of creating a new one',
  'commit.amendLast': 'last commit',
  'commit.amendPublished': 'already pushed; amending rewrites published history',
  'commit.message': 'Commit Message',
  'commit.message.tip': 'The message recorded with this commit',
  'commit.messagePlaceholder': 'Describe the change',
  'commit.generate': 'Generate message',
  'commit.generate.tip': 'Write a message from the ticked changes with the model that runs this Session',
  'commit.generate.disabled.tip': 'Tick at least one change first',
  'commit.generating': 'Generating',
  'commit.aiRoute': 'via {provider}/{model}',
  'commit.button': 'Commit',
  'commit.button.tip': 'Commit the ticked changes. Asks before writing',
  'commit.button.disabled.tip': 'Tick at least one change and type a message',
  'commit.pushButton': 'Commit and Push...',
  'commit.pushButton.tip': 'Commit the ticked changes, then push the branch to its configured upstream. Asks before writing',
  'commit.busy': 'Committing',

  'rollback.title': 'Rollback changes',
  'rollback.confirmButton': 'Roll back',
  'rollback.cancel': 'Cancel',

  'confirm.cancel': 'Cancel',
  'confirm.close': 'Close this dialog',
  'confirm.commit.title': 'Commit these changes?',
  'confirm.commit.body': '{files} will be committed on branch {branch}.',
  'confirm.commit.bodyHunks': '{files} will be committed on branch {branch}, {hunks} included.',
  'confirm.commit.amend': 'The last commit will be rewritten (amend).',
  'confirm.commit.push': 'Then the branch will be pushed to {target}.',
  'confirm.commit.pushNone': 'No push target is configured, so the push will be refused and the commit kept.',
  'confirm.commit.action': 'Commit',
  'confirm.push.action': 'Commit and push',
  'confirm.rollback.title': 'Roll back these changes?',
  'confirm.rollback.body': '{files} will be restored from the last commit. Uncommitted edits in them are lost.',
  'confirm.rollback.delete': 'DELETED from disk, because git holds no committed version: {paths}',
  'confirm.rollback.action': 'Roll back',
  'confirm.revertHunk.title': 'Revert this hunk?',
  'confirm.revertHunk.body': 'The hunk is removed from the working tree of {path} and is not part of any commit.',
  'confirm.revertHunk.delete': 'This deletes {path} from disk, because the whole file is this one hunk.',
  'confirm.revertHunk.action': 'Revert hunk',

  'state.loading': 'Loading',
  'state.noRoot': 'No Aweave root resolved. Set aweaveRoot in the profile patch.',
  'state.noRootHint': 'The plugin derives the root from the Host working directory; start the Host inside the checkout or configure the path.',
  'state.noChanges': 'No local changes',
  'state.error': 'Something went wrong',

  'commit.indexWarning': 'Committed, but the git index could not be updated: {reason}',
  'commit.headMoved': 'HEAD moved while committing; refresh the panel before committing again',
  'commit.pushNoTarget': 'Committed {sha}, but this branch has no push target: {hint}',
  'commit.pushFailed': 'Committed {sha}, but the push failed: {reason}',
  'commit.done': 'Committed {sha}',
  'commit.pushed': 'Committed {sha} and pushed',
  'rollback.done': 'Rolled back {count} paths',

  'diff.toolbar.previous': 'Previous difference',
  'diff.toolbar.previous.tip': 'Jump to the previous changed hunk in this file',
  'diff.toolbar.next': 'Next difference',
  'diff.toolbar.next.tip': 'Jump to the next changed hunk in this file',
  'diff.toolbar.refresh': 'Reload this diff from disk',
  'diff.toolbar.prevFile': 'Previous file',
  'diff.toolbar.prevFile.tip': 'Open the previous changed file of this repository',
  'diff.toolbar.nextFile': 'Next file',
  'diff.toolbar.nextFile.tip': 'Open the next changed file of this repository',
  'diff.toolbar.split': 'Side-by-Side',
  'diff.toolbar.split.tip': 'Compare old and new in two columns',
  'diff.toolbar.unified': 'Unified',
  'diff.toolbar.unified.tip': 'Compare old and new in one column',
  'diff.toolbar.collapse': 'Collapse unchanged fragments',
  'diff.toolbar.collapse.tip': 'Hide unchanged lines that are not next to a change',
  'diff.summary': '{total} differences, {included} included',
  'diff.currentVersion': 'Current version',
  'diff.currentVersion.tip': 'Include or exclude every hunk of this file in the next commit',
  'diff.binary': 'Binary content changed; the full file is included when ticked',
  'diff.deleteHunk': 'Revert this hunk',
  'diff.deleteHunk.tip': 'Remove this hunk from the working tree. Asks first',
  'diff.includeHunk': 'Include this hunk in the next commit',
  'diff.excludeHunk': 'Exclude this hunk from the next commit',
  'diff.locked': 'committed',
  'diff.empty': 'Select a file to see its diff',
  'diff.path.tip': 'The file this pane is showing',
} satisfies Record<string, string>

/** Every key the dictionary defines. */
export type DshIntellijGitKey = keyof typeof en

/** The namespace-bound translate seat a component receives. */
export type Translate = PropsLocale<'dshIntellijGit'>['t']
