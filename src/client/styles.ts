/**
 * The tool window's scoped stylesheet.
 *
 * One `<style>` element is created inside a `ctx.effect()`, marked with
 * `data-plugin`, and removed by that effect's disposer, so hot re-activation
 * never accumulates nodes. Every rule is scoped to `[data-dsh-git]`.
 *
 * Colours come from the platform's `--dsw-alias-*` theme aliases, so every
 * palette skin applies. Only diff semantics use fixed hues, because a removed
 * line must stay red under every skin.
 */
import type { Context } from '@deepseek-ai/cordis'

import { PLUGIN_ID } from '../config.ts'

/** Stable style element id. */
const STYLE_ID = `${PLUGIN_ID}/toolwindow`

const CSS = `
[data-dsh-git] {
  display: flex; flex-direction: column; height: 100%; min-height: 0; position: relative;
  background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary);
  font-size: 12px; line-height: 1.45;
}
[data-dsh-git] *, [data-dsh-git] *::before, [data-dsh-git] *::after { box-sizing: border-box; }
[data-dsh-git] button { font: inherit; color: inherit; cursor: pointer; }
[data-dsh-git] button:disabled { cursor: default; opacity: 0.45; }
[data-dsh-git] .git-mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }

[data-dsh-git] .git-toolbar { display: flex; align-items: center; gap: 4px; padding: 8px 8px 6px; flex: none; }
[data-dsh-git] .git-toolbar button, [data-dsh-git] .git-seg button {
  background: transparent; border: 1px solid transparent; border-radius: 4px; padding: 2px 6px;
}
[data-dsh-git] .git-toolbar button:hover, [data-dsh-git] .git-seg button:hover { background: var(--dsw-alias-bg-hover); }
[data-dsh-git] .git-toolbar .git-grow { flex: 1; }
[data-dsh-git] .git-seg { display: inline-flex; border: 1px solid var(--dsw-alias-border-subtle); border-radius: 4px; overflow: hidden; }
[data-dsh-git] .git-seg button[data-on='true'] { background: var(--dsw-alias-bg-selected); color: var(--dsw-alias-label-primary); }

[data-dsh-git] .git-tree { flex: 1; min-height: 0; overflow: auto; padding: 0 4px 6px; }
[data-dsh-git] .git-row { display: flex; align-items: center; gap: 4px; padding: 1px 4px; border-radius: 3px; }
[data-dsh-git] .git-row:hover { background: var(--dsw-alias-bg-hover); }
[data-dsh-git] .git-row[data-selected='true'] { background: var(--dsw-alias-bg-selected); }
[data-dsh-git] .git-twisty { width: 14px; flex: none; text-align: center; color: var(--dsw-alias-label-secondary); background: none; border: 0; padding: 0; }
[data-dsh-git] .git-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
[data-dsh-git] .git-label.git-dim { color: var(--dsw-alias-label-secondary); }
[data-dsh-git] .git-count { margin-left: auto; flex: none; color: var(--dsw-alias-label-secondary); font-size: 11px; padding-left: 8px; }
[data-dsh-git] .git-badge { flex: none; font-size: 10px; padding: 0 3px; border-radius: 3px; border: 1px solid var(--dsw-alias-border-subtle); }
[data-dsh-git] .git-badge[data-kind='M'] { color: #3b82f6; }
[data-dsh-git] .git-badge[data-kind='A'] { color: #22c55e; }
[data-dsh-git] .git-badge[data-kind='D'] { color: #ef4444; }
[data-dsh-git] .git-badge[data-kind='R'] { color: #f59e0b; }
[data-dsh-git] .git-badge[data-kind='U'] { color: #a855f7; }
[data-dsh-git] .git-branch { margin-left: auto; flex: none; display: inline-flex; gap: 5px; color: var(--dsw-alias-label-secondary); font-size: 11px; }
[data-dsh-git] .git-repo { font-weight: 600; }
[data-dsh-git] .git-section-label { color: var(--dsw-alias-label-secondary); text-transform: uppercase; font-size: 10px; letter-spacing: 0.04em; padding: 4px 4px 2px; }

[data-dsh-git] .git-commitbox { flex: none; border-top: 1px solid var(--dsw-alias-border-subtle); padding: 6px 8px 8px; display: flex; flex-direction: column; gap: 5px; }
[data-dsh-git] .git-amend { display: flex; align-items: center; gap: 5px; color: var(--dsw-alias-label-secondary); }
[data-dsh-git] .git-amend input { margin: 0; }
[data-dsh-git] .git-amend .git-warn { color: #f59e0b; }
[data-dsh-git] .git-message { width: 100%; min-height: 48px; max-height: 160px; resize: vertical; padding: 5px 6px; border-radius: 4px;
  border: 1px solid var(--dsw-alias-border-subtle); background: var(--dsw-alias-bg-input, var(--dsw-alias-bg-base)); color: inherit; font: inherit; }
[data-dsh-git] .git-actions { display: flex; gap: 6px; align-items: center; }
[data-dsh-git] .git-primary { background: var(--dsw-alias-accent-primary, #3b82f6); color: #fff; border: 0; border-radius: 4px; padding: 4px 10px; }
[data-dsh-git] .git-secondary { background: transparent; border: 1px solid var(--dsw-alias-border-subtle); border-radius: 4px; padding: 4px 10px; }
[data-dsh-git] .git-route { margin-left: auto; color: var(--dsw-alias-label-secondary); font-size: 11px; }
[data-dsh-git] .git-banner { margin: 0 8px 6px; padding: 5px 7px; border-radius: 4px; font-size: 11px; }
[data-dsh-git] .git-banner[data-kind='error'] { background: rgba(239,68,68,0.12); border: 1px solid rgba(239,68,68,0.4); }
[data-dsh-git] .git-banner[data-kind='notice'] { background: rgba(34,197,94,0.12); border: 1px solid rgba(34,197,94,0.35); }
[data-dsh-git] .git-empty { padding: 16px 12px; color: var(--dsw-alias-label-secondary); text-align: center; }

[data-dsh-git] .git-diff { display: flex; flex-direction: column; height: 100%; min-height: 0; }
[data-dsh-git] .git-diff-head { flex: none; display: flex; align-items: center; gap: 6px; padding: 5px 8px; border-bottom: 1px solid var(--dsw-alias-border-subtle); }
[data-dsh-git] .git-diff-sub { flex: none; display: flex; align-items: center; gap: 6px; padding: 3px 8px; border-bottom: 1px solid var(--dsw-alias-border-subtle); color: var(--dsw-alias-label-secondary); }
[data-dsh-git] .git-diff-body { flex: 1; min-height: 0; overflow: auto; }
[data-dsh-git] .git-table { width: 100%; border-collapse: collapse; table-layout: fixed; }
[data-dsh-git] .git-table td { padding: 0 6px; vertical-align: top; white-space: pre; overflow: hidden; }
[data-dsh-git] .git-table td.git-num { width: 44px; text-align: right; color: var(--dsw-alias-label-secondary); user-select: none; }
[data-dsh-git] .git-table td.git-half { width: calc(50% - 88px); }
[data-dsh-git] .git-line-add { background: rgba(34,197,94,0.14); }
[data-dsh-git] .git-line-del { background: rgba(239,68,68,0.14); }
[data-dsh-git] .git-hunk-row td { background: var(--dsw-alias-bg-subtle, rgba(127,127,127,0.10)); color: var(--dsw-alias-label-secondary); padding: 2px 6px; }
[data-dsh-git] .git-hunk-row .git-gutter { display: inline-flex; align-items: center; gap: 6px; }
[data-dsh-git] .git-hunk-row .git-gutter button { border: 1px solid var(--dsw-alias-border-subtle); border-radius: 3px; background: transparent; padding: 0 4px; }
[data-dsh-git] .git-included { color: #22c55e; }
[data-dsh-git] .git-excluded { color: var(--dsw-alias-label-secondary); }
`.trim()

/**
 * Install the scoped stylesheet, owned by the plugin context.
 * @param ctx - browser-side plugin context.
 */
export function installStyles(ctx: Context): void {
  ctx.effect(() => {
    const element = document.createElement('style')
    element.id = STYLE_ID
    element.dataset['plugin'] = PLUGIN_ID
    element.dataset['pluginCss'] = STYLE_ID
    element.textContent = CSS
    document.head.appendChild(element)
    return () => { element.remove() }
  }, `${PLUGIN_ID}: stylesheet`)
}
