/**
 * The tool window's layout stylesheet.
 *
 * Only layout lives here. Buttons, checkboxes and dialogs come from the shell's
 * primitives, so their geometry, focus ring, hover state and reduced motion are
 * the platform's; re-styling them here would be the drift this iteration exists to
 * remove. Every colour below is a `--dsw-*` token except the two diff hues, which
 * stay fixed because a removed line must read as red under every palette skin.
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
[data-dsh-git] .git-mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
[data-dsh-git] .git-grow { flex: 1; }
[data-dsh-git] .git-dim { color: var(--dsw-alias-label-secondary); }
[data-dsh-git] .git-warn { color: var(--dsw-alias-state-warning-primary, #f59e0b); }
[data-dsh-git] .git-visuallyHidden {
  position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden;
  clip: rect(0 0 0 0); white-space: nowrap; border: 0;
}
[data-dsh-git] .git-tipAnchor { display: inline-flex; align-items: center; min-width: 0; }


/* Toolbar */
[data-dsh-git] .git-toolbar { display: flex; align-items: center; gap: 4px; padding: 8px 10px 6px; flex: none; }

/* Tree */
[data-dsh-git] .git-tree { flex: 1; min-height: 0; overflow: auto; padding: 2px 6px 8px; }
[data-dsh-git] .git-children { padding-left: 10px; border-left: 1px solid var(--dsw-alias-border-subtle); margin-left: 8px; }
[data-dsh-git] .git-sectionLabel {
  color: var(--dsw-alias-label-secondary); text-transform: uppercase; font-size: 10px;
  letter-spacing: 0.06em; padding: 8px 4px 3px;
}
[data-dsh-git] .git-row {
  display: flex; align-items: center; gap: 5px; min-height: 22px; padding: 1px 4px;
  border-radius: 5px;
}
[data-dsh-git] .git-row:hover { background: var(--dsw-alias-bg-hover); }
[data-dsh-git] .git-row[data-selected='true'] { background: var(--dsw-alias-bg-selected); }
[data-dsh-git] .git-rowGroup { margin-top: 2px; }
[data-dsh-git] .git-rowRepo { min-height: 24px; }
[data-dsh-git] .git-twisty {
  display: inline-flex; align-items: center; justify-content: center; width: 16px; height: 16px;
  padding: 0; border: 0; border-radius: 4px; background: none; color: var(--dsw-alias-label-secondary);
  cursor: pointer;
}
[data-dsh-git] .git-twisty:hover { background: var(--dsw-alias-bg-active, var(--dsw-alias-bg-hover)); }
[data-dsh-git] .git-twistyGlyph { font-size: 9px; line-height: 1; }
[data-dsh-git] .git-check { margin: 0; flex: none; accent-color: var(--dsw-alias-brand-primary, var(--dsw-alias-accent-primary, #3b82f6)); }
[data-dsh-git] .git-fileBtn {
  display: inline-flex; align-items: center; gap: 5px; min-width: 0; flex: 1;
  padding: 0; border: 0; background: none; color: inherit; font: inherit; text-align: left; cursor: pointer;
}
[data-dsh-git] .git-fileName { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
[data-dsh-git] .git-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
[data-dsh-git] .git-groupLabel { font-weight: 600; }
[data-dsh-git] .git-repo { font-weight: 600; }
[data-dsh-git] .git-count { margin-left: auto; flex: none; padding-left: 8px; color: var(--dsw-alias-label-secondary); font-size: 11px; }
[data-dsh-git] .git-badge {
  flex: none; font-size: 10px; font-weight: 600; padding: 0 4px; border-radius: 4px;
  border: 1px solid var(--dsw-alias-border-subtle);
}
[data-dsh-git] .git-badge[data-kind='M'] { color: #3b82f6; }
[data-dsh-git] .git-badge[data-kind='A'] { color: #22c55e; }
[data-dsh-git] .git-badge[data-kind='D'] { color: #ef4444; }
[data-dsh-git] .git-badge[data-kind='R'] { color: #f59e0b; }
[data-dsh-git] .git-badge[data-kind='U'] { color: #a855f7; }
[data-dsh-git] .git-branch {
  margin-left: auto; flex: none; display: inline-flex; gap: 6px; align-items: center;
  padding: 0 6px; height: 18px; border-radius: 9px;
  background: var(--dsw-alias-bg-subtle, rgba(127,127,127,0.12));
  color: var(--dsw-alias-label-secondary); font-size: 11px;
}
[data-dsh-git] .git-ahead { color: #22c55e; }
[data-dsh-git] .git-behind { color: #ef4444; }

/* Commit box */
[data-dsh-git] .git-commitbox {
  flex: none; display: flex; flex-direction: column; gap: 6px; padding: 8px 10px 10px;
  border-top: 1px solid var(--dsw-alias-border-subtle);
  background: var(--dsw-alias-bg-subtle, transparent);
}
[data-dsh-git] .git-amendRow { display: flex; align-items: center; gap: 8px; }
[data-dsh-git] .git-message {
  width: 100%; min-height: 54px; max-height: 180px; resize: vertical;
  padding: 6px 8px; border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-subtle);
  background: var(--dsw-alias-bg-input, var(--dsw-alias-bg-base));
  color: inherit; font: inherit;
}
[data-dsh-git] .git-message:focus-visible { outline: 2px solid var(--dsw-alias-border-focus, #3b82f6); outline-offset: 1px; }
[data-dsh-git] .git-actions { display: flex; align-items: center; gap: 6px; }
[data-dsh-git] .git-route { margin-left: auto; color: var(--dsw-alias-label-secondary); font-size: 11px; }

/* Banner */
[data-dsh-git] .git-banner {
  display: flex; align-items: flex-start; gap: 6px; margin: 0 10px 6px; padding: 6px 8px;
  border-radius: 8px; font-size: 11px;
}
[data-dsh-git] .git-banner[data-kind='error'] {
  background: color-mix(in srgb, #ef4444 12%, transparent); border: 1px solid color-mix(in srgb, #ef4444 40%, transparent);
}
[data-dsh-git] .git-banner[data-kind='notice'] {
  background: color-mix(in srgb, #22c55e 12%, transparent); border: 1px solid color-mix(in srgb, #22c55e 35%, transparent);
}
[data-dsh-git] .git-bannerClose {
  margin-left: auto; border: 0; background: none; color: inherit; cursor: pointer; font-size: 13px; line-height: 1;
}
[data-dsh-git] .git-empty { padding: 18px 12px; color: var(--dsw-alias-label-secondary); text-align: center; }

/* Diff */
[data-dsh-git] .git-diff { display: flex; flex-direction: column; height: 100%; min-height: 0; }
[data-dsh-git] .git-diffHead {
  flex: none; display: flex; align-items: center; gap: 4px; padding: 6px 10px;
  border-bottom: 1px solid var(--dsw-alias-border-subtle);
}
[data-dsh-git] .git-diffSub {
  flex: none; display: flex; align-items: center; gap: 8px; padding: 4px 10px;
  border-bottom: 1px solid var(--dsw-alias-border-subtle);
  color: var(--dsw-alias-label-secondary);
}
[data-dsh-git] .git-lock { flex: none; }
[data-dsh-git] .git-path { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
[data-dsh-git] .git-diffBody { flex: 1; min-height: 0; overflow: auto; }
[data-dsh-git] .git-table { width: 100%; border-collapse: collapse; table-layout: fixed; }
[data-dsh-git] .git-table td { padding: 0 8px; vertical-align: top; white-space: pre; overflow: hidden; }
[data-dsh-git] .git-num {
  width: 46px; text-align: right; user-select: none;
  color: var(--dsw-alias-label-secondary);
  border-right: 1px solid var(--dsw-alias-border-subtle);
}
[data-dsh-git] .git-half { width: calc(50% - 92px); }
[data-dsh-git] .git-lineAdd { background: color-mix(in srgb, #22c55e 15%, transparent); }
[data-dsh-git] .git-lineDel { background: color-mix(in srgb, #ef4444 15%, transparent); }
[data-dsh-git] .git-hunkRow {
  background: var(--dsw-alias-bg-subtle, rgba(127,127,127,0.10));
  color: var(--dsw-alias-label-secondary);
  padding: 3px 8px;
  position: sticky; top: 0;
}
[data-dsh-git] .git-gutter { display: flex; align-items: center; gap: 8px; }
[data-dsh-git] .git-hunkHeader { overflow: hidden; text-overflow: ellipsis; }
[data-dsh-git] .git-included { color: #22c55e; }
[data-dsh-git] .git-excluded { color: var(--dsw-alias-label-secondary); }

/* Confirmation dialog */
[data-dsh-git] .git-confirmBody { display: flex; flex-direction: column; gap: 8px; font-size: 13px; }
[data-dsh-git] .git-confirmBody p { margin: 0; }
[data-dsh-git] .git-confirmFooter { display: flex; justify-content: flex-end; gap: 8px; }
[data-dsh-git] .git-danger { --dsw-alias-button-primary-fill: var(--dsw-alias-state-error-primary, #ef4444); }

/* Activity dock */
[data-dsh-git] .git-activity {
  flex: none; display: flex; flex-direction: column; height: 168px; min-height: 0;
  border-top: 1px solid var(--dsw-alias-border-subtle);
  background: var(--dsw-alias-bg-base);
}
[data-dsh-git] .git-activity[data-open='false'] { height: auto; }
[data-dsh-git] .git-activityHead {
  flex: none; display: flex; align-items: center; gap: 6px; padding: 4px 10px;
  border-bottom: 1px solid var(--dsw-alias-border-subtle);
}
[data-dsh-git] .git-activityHead .git-count { margin-left: 0; }
[data-dsh-git] .git-activityBody { flex: 1; min-height: 0; overflow: auto; padding: 2px 6px 6px; }
[data-dsh-git] .git-activityEmpty { padding: 10px 6px; color: var(--dsw-alias-label-secondary); text-align: center; }
[data-dsh-git] .git-activityRow { display: flex; flex-direction: column; }
[data-dsh-git] .git-activityBtn {
  display: flex; align-items: center; gap: 6px; width: 100%; min-width: 0;
  padding: 2px 4px; border: 0; border-radius: 4px; background: none; color: inherit;
  font: inherit; text-align: left; cursor: pointer;
}
[data-dsh-git] .git-activityBtn:hover { background: var(--dsw-alias-bg-hover); }
[data-dsh-git] .git-activityRow[data-ok='false'] .git-activityState { color: var(--dsw-alias-state-error-primary, #ef4444); }
[data-dsh-git] .git-activityRow[data-ok='true'] .git-activityState { color: var(--dsw-alias-state-success-primary, #22c55e); }
[data-dsh-git] .git-activityTime { flex: none; color: var(--dsw-alias-label-secondary); font-size: 10px; }
[data-dsh-git] .git-activityBadge {
  flex: none; font-size: 9px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em;
  padding: 0 4px; border-radius: 4px; border: 1px solid var(--dsw-alias-border-subtle);
  color: var(--dsw-alias-label-secondary);
}
[data-dsh-git] .git-activityBadge[data-kind='git'] { color: var(--dsw-alias-brand-primary, var(--dsw-alias-accent-primary, #3b82f6)); }
[data-dsh-git] .git-activityLabel { flex: none; font-size: 11px; }
[data-dsh-git] .git-activityDetail {
  flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  color: var(--dsw-alias-label-secondary); font-size: 11px;
}
[data-dsh-git] .git-activityMs { flex: none; color: var(--dsw-alias-label-secondary); font-size: 10px; }
[data-dsh-git] .git-activityState { flex: none; font-size: 10px; font-weight: 600; }
[data-dsh-git] .git-activityOutput {
  margin: 2px 0 4px 18px; padding: 4px 6px; max-height: 180px; overflow: auto;
  white-space: pre-wrap; word-break: break-word;
  border-radius: 6px; border: 1px solid var(--dsw-alias-border-subtle);
  background: var(--dsw-alias-bg-subtle, rgba(127,127,127,0.08));
  color: var(--dsw-alias-label-secondary); font-size: 10px; line-height: 1.4;
}
`.trim()

/**
 * Install the layout stylesheet, owned by the plugin context.
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
