# dsh-intellij-git

An external [Cordis](https://deepseek-harness.github.io/deepseek-harness/) plugin for the DeepSeek Harness Web UI
that brings the IntelliJ IDEA commit workflow to the right sidebar.

## What it does

Aweave keeps **one platform root repository** (`aweave`) plus **a repository per workspace folder** at
`workspaces/<workspace>/<domain>/<repo>`, which is about a hundred git roots on this deployment.

The plugin adds two tabs to the core right sidebar:

* **Git Commit** - a repository accordion with `Root repo` and `Workspaces` sections, an IntelliJ-style change tree
  with tri-state checkboxes over sections, compact directories and files, and a commit box carrying `Amend`,
  message generation, `Commit` and `Commit and Push...`.
* **Commit: file** - a Side-by-Side or Unified diff with a per-hunk gutter: `>>` reverts one hunk in the working
  tree, and its checkbox includes or excludes that hunk from the next commit.

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
* **`HEAD` compare-and-swap.** Both commit and rollback send the `HEAD` the view was built from; the host answers
  `409` when it moved, and verifies `HEAD^1` again after committing.
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

All six sit under `/api/dsh-intellij-git/` and are registered through `ctx.connection.fetch.register`, so the shared
`/api` channel admits them before any handler runs.

| Route | Method | Purpose |
| --- | --- | --- |
| `repos/tree` | GET | Root plus workspace repositories, from a directory scan |
| `repo/status` | POST | Branch, ahead/behind, changed and untracked paths for one repository |
| `repo/diff` | POST | One file's hunks with their content keys |
| `repo/rollback` | POST | Revert selected files, or single hunks |
| `repo/commit` | POST | Atomic partial commit, optionally followed by a push |
| `repo/generate-message` | POST | Commit message from the current selection |

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
* The diff tab chip shows the static label, not the open file name; the file path is shown in the diff sub-header.
* Binary and deleted files support whole-file inclusion only, not per-hunk inclusion.
