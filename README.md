# dsh-intellij-git

An external [Cordis](https://deepseek-harness.github.io/deepseek-harness/) plugin for the DeepSeek Harness Web UI
that brings the IntelliJ IDEA commit workflow to a full main-area page.

## What it does

Aweave keeps **one platform root repository** (`aweave`) plus **a repository per workspace folder** at
`workspaces/<workspace>/<domain>/<repo>`, which is about a hundred git roots on this deployment.

The plugin adds one row, **Git**, to the left sidebar panel list (directly under `Plugins`). Selecting it opens the
**Git page** in the main area, laid out as two columns plus a dock:

* **Left column, commit panel** - a repository accordion with `Root repo` and `Workspaces` sections, an IntelliJ-style
  change tree with tri-state checkboxes, compact directories, status letters and file-type icons, and a commit box
  carrying `Amend`, message generation, `Commit` and `Commit and Push...`.
* **Right column, diff panel** - Split or Unified view, syntax highlighting, word-level marks inside changed lines, a
  wrap toggle, expandable hidden context, hunk and file navigation, and a per-hunk gutter that reverts one hunk in the
  working tree or includes/excludes it from the next commit.
* **Bottom dock, activity** - every git call and API call the plugin made, grouped by request (one row per user action
  with its `git` rows nested), live while a long action runs, with a `Show background` switch for watcher-driven
  requests, per-call Copy, and Clear.
* **Page header** - repository, branch badge (the branch dialog's trigger), ahead/behind, last-checked time, Refresh,
  and `Push...` when the branch is ahead.
  The split between the columns and the dock height are draggable (keyboard: arrow keys) and remembered per browser.

Colours come only from the platform's `--dsw-alias-*` design tokens, so the page follows the active theme.

## Default commit message

An empty commit message box commits as the browser's local time, `YYMMDD-HHMM` (for example `261026-2330`). The
placeholder shows the live value and refreshes each minute; the value is resolved when the confirm dialog opens, shown
in it ("empty box, current time"), and sent exactly as shown, so a dialog left open across a minute boundary still
commits what it displays. Commit and Commit and Push are enabled whenever at least one change is ticked. Typing
replaces the default; ticking Amend on an empty box still prefills the last commit message. The host contract is
unchanged: a raw `repo/commit` with an empty message still answers `400 EMPTY_MESSAGE`.

## Narrow pages

Below 760px of page width (a phone, or a narrow main area) the page switches layout. The change list fills the body, the
activity dock starts collapsed (a memory-only state: the desktop `dockOpen` preference is never written), and tapping a
file opens its diff as an in-page full-screen sheet, always unified with wrapping on by default. `Changes` in the sheet's
toolbar closes it. While the sheet is open the covered page is `inert`, focus moves to `Changes` and returns to the
tapped file on exit. Desktop layout is unchanged.

## The branch dialog

Clicking the branch badge opens an IntelliJ-style **Branches** dialog: a filter box, a `Local` group with the current
branch pinned and marked, a `Remote` group, and a `New branch` mode that creates from the current `HEAD`. A detached
`HEAD` is shown as `(detached at <sha>)` and can be left by picking any branch.

* **One confirmation, informative.** The dialog *is* the confirmation for the write: a state-generated line beside
  the primary button names the exact effect (`Switch main → feature; 2 changed files carry over`, or
  `Create feature at 1a2b3c4`). There is no second dialog and no double-click submit.
* **Remote branches create or reuse a local tracking branch.** A remote row is hidden only when a same-named local
  branch already tracks that exact ref, and selecting it then reuses that branch. A same-named local that tracks
  something else keeps the remote row visible but disabled, and the call is refused with `BRANCH_EXISTS`.
* **No fetch.** The `Remote` group reflects the last fetch; the dialog never reaches the network.
* **Worktree-held branches are marked** and refused with the worktree path, because this plugin also discovers
  worktree checkouts (`.git` files).

### Dirty worktree: refused, precisely

A switch never stashes, never forces and never discards. When git refuses, the host classifies the failure from
repository state instead of git's (translated) stderr: it intersects the paths the working tree changed with the paths
that differ between `HEAD` and the target tree, and adds untracked paths that the target tree would create. A
non-empty intersection answers `409 LOCAL_CHANGES_BLOCK_SWITCH` listing those paths. Anything it cannot explain
degrades to `409 SWITCH_FAILED` carrying the switch's own exit code and stderr tail, so a refusal can never become a
`500`. Edits that do not overlap the target tree simply carry over, which is what `2 changed files carry over` counts.

### Ref identity

Every internal comparison, existence check, `--track` start point and `git diff` revision uses a fully-qualified ref
(`refs/heads/...`, `refs/remotes/...`). Display names come from `%(refname:lstrip=2)`, and the current branch from
`git symbolic-ref -q HEAD`. Short names are ambiguity-dependent: a branch and a tag sharing a name shorten to
`heads/<name>`, and a local branch literally named `<remote>/<branch>` makes the remote short name ambiguous, which
breaks both `rev-parse --verify` and a bare `--track` start point.

## Processing states

Every long action shows what it is doing instead of freezing: a progress bar under the header, a labelled running
button (`Committing`, `Pushing to <target>`, `Rebasing`, `Merging`, `Reverting`), and the phase text in the integrate
dialog. While a write runs the page is locked (repository switch, inclusion edits, dialogs cannot be dismissed
mid-write) and only the operation that started a write can release it. A rejected push offers `Rebase and push` or
`Merge and push` rather than a dead end; success shows a toast with a copyable short SHA.

## The two rules that shape the design

**Single-Active-Repo Accordion.** At most one repository is expanded, and therefore at most one repository ever runs
`git status`. Expanding another one collapses the previous one. Opening the tree itself spawns no process at all:
repository discovery is a plain directory scan.

**Inclusion is client state, not staging.** Ticking a box never touches `.git/index`. The whole selection is
materialised once, at commit time, by building a temporary index from the expected `HEAD`, staging the selected
whole files and selected hunks into it, committing from it, and only afterwards reconciling the real index for
exactly the committed paths with `git reset -q HEAD -- <paths>`. Two properties follow: untracked files never jump
between groups while you tick them, and a concurrent `git add` by another process is never silently unstaged.

## Safety

* **No remote guessing.** `Commit and Push...` resolves `@{push}` and runs a plain `git push`. When the branch has
  no push target the commit is kept and the push is refused with the exact `git push -u <remote> <branch>` command,
  because on this deployment `origin` is frequently an unrelated repository.
* **`HEAD` compare-and-swap on (branch, OID).** Commit, rollback, sync and switch send both the `HEAD` and the branch
  the view was built from; the host answers `409 HEAD_MOVED` naming both when either moved. OID alone is not identity:
  two branches on one commit are common, so an OID-only check would commit onto the wrong branch silently after a
  terminal switch. An `expectedBranch` that is omitted keeps the older OID-only behaviour, so a raw caller still works.
  `HEAD^1` is verified again after committing, the branch is re-read and reported as `branchMovedDuringCommit`, and
  sync re-checks across its `git fetch` because a fetch can move refs.
* **One mutating command per branch request.** `git switch --no-guess` without `-f`, `--force`, `--autostash` or
  `--discard-changes`, and no fetch. `switch` only resolves refs, so a branch name can never be read as a path, and
  `--no-guess` removes DWIM branch creation. An operation marker (`rebase-merge`, `rebase-apply`, `MERGE_HEAD`,
  `CHERRY_PICK_HEAD`, `REVERT_HEAD`) refuses the switch with `409 INTEGRATION_IN_PROGRESS`.
* **Path containment.** A `repoId` is re-derived into an absolute path from a validated id and re-checked with
  `realpath`; every repository-relative path is re-resolved inside that repository.

## Configuration

Set through the profile patch (an id-keyed row; `config` is assigned shallowly, so restate every key):

```yaml
- id: dsh-intellij-git
  name: dsh-intellij-git
  config:
    aweaveRoot: /absolute/path/to/aweave
    gitTimeoutMs: 30000
    llmProvider: ''
    llmModel: ''
```

| Field | Default | Meaning |
| --- | --- | --- |
| `aweaveRoot` | `""` | Absolute platform root; empty derives it from the `workspaces/devtools/common/server/package.json` marker |
| `gitTimeoutMs` | `30000` | Deadline of one `git` invocation |
| `llmProvider` | `""` | Provider for message generation; empty reuses the Session or deployment route |
| `llmModel` | `""` | Model for message generation; empty reuses the Session or deployment route |

## HTTP routes

All of them sit under `/api/dsh-intellij-git/` and are registered through `ctx.connection.fetch.register`, so the shared
`/api` channel admits them before any handler runs.

| Route | Method | Purpose |
| --- | --- | --- |
| `repos/tree` | GET | Root plus workspace repositories, from a directory scan |
| `repo/status` | POST | Branch, ahead/behind, changed and untracked paths for one repository |
| `repo/diff` | POST | One file's hunks with their content keys |
| `repo/rollback` | POST | Revert selected files, or single hunks |
| `repo/commit` | POST | Atomic partial commit, optionally followed by a push |
| `repo/generate-message` | POST | Commit message from the current selection |
| `repo/watch` | POST | Silent change probe (digest compare); recorded nowhere |
| `repo/sync` | POST | `push`, `rebase` or `merge` leg of an integrate |
| `repo/branches` | POST | Local and remote-tracking branches with current, upstream and worktree facts |
| `repo/switch` | POST | One switch, tracking-branch create or reuse; never fetches, forces or stashes |
| `activity` | GET | Retained call log; `?after=<id>` returns only newer entries; silent |
| `activity/clear` | POST | Empty the log; answers `{cleared, bootId, latestId}`; silent |

### Branch error codes

| Code | Status | Meaning |
| --- | --- | --- |
| `LOCAL_CHANGES_BLOCK_SWITCH` | 409 | The listed paths differ between the two trees and would be overwritten |
| `BRANCH_CHECKED_OUT_ELSEWHERE` | 409 | The branch is held by another worktree; `details.path` is its real path |
| `BRANCH_EXISTS` | 409 | The name already exists, or a same-named local tracks a different ref |
| `BRANCH_NOT_FOUND` | 404 | The ref vanished between listing and switch |
| `INVALID_BRANCH_NAME` | 400 | `git check-ref-format --branch` refused it, or expanded it to another name |
| `HEAD_MOVED` | 409 | The branch or `HEAD` is no longer the one the listing was built from |
| `INTEGRATION_IN_PROGRESS` | 409 | A rebase, merge, cherry-pick or revert marker is present |
| `SWITCH_FAILED` | 409 | git refused for a reason the state comparison could not explain |

## Requirements

Tested on git `2.51`; requires at least `2.31` (`git switch`, `--no-guess` and `%(worktreepath)`). Verified at the
`basic` level of this domain's container procedure: gates, boot, routes and probes, with the browser half left to the
Human.

## Build

```sh
pnpm install
pnpm run check    # tsc --noEmit on both faces
pnpm run build    # lib/index.js + lib/client.js
```

## Install

```sh
dsh plugin --profile web add file:/absolute/path/to/dsh-intellij-git
```

A `file:` install is a hardlink tree: rebuild before adding, and refresh with `remove` then `add` after a rebuild
replaces a file.

## Known limitations

* A hunk revert renumbers the hunks below it; selection is kept by content fingerprint, so a hunk whose own context
  changed is reported as stale (`409 STALE_HUNKS`) rather than silently dropped.
* Hidden-context folding applies to middle context runs of 6 or more lines only: `git diff --unified=3` never emits a
  longer run inside one hunk, so the lines between two hunks are the expandable gap rows instead.
* The activity log is an in-memory ring of 500 entries per host process; a host restart empties it and the page takes
  a full snapshot on the next call.
* Binary and deleted files support whole-file inclusion only, not per-hunk inclusion.
