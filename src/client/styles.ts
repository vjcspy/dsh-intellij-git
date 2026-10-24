/**
 * The Git page's stylesheet.
 *
 * Layout and the page's own surfaces live here. Buttons, checkboxes, tags,
 * segmented controls and dialogs come from the shell's primitives, so their
 * geometry, focus ring and hover are the platform's. Every colour is a
 * `--dsw-alias-*` token that `design-platform.css` defines, so the 37 palette
 * skins and light/dark all apply; there are no colour literals and no
 * `var(--undefined, #fallback)` pairs. Motion has a `prefers-reduced-motion`
 * fallback.
 *
 * Dialog rules are scoped under `.dsh-git-dialog`, the class passed to `Modal`:
 * the primitive portals to `document.body`, outside `[data-dsh-git]`, and renders
 * its content and footer as siblings, so only the dialog root covers both.
 */
import type { Context } from '@deepseek-ai/cordis'

import { PLUGIN_ID } from '../config.ts'

/** Stable style element id. */
const STYLE_ID = `${PLUGIN_ID}/page`

const CSS = `
[data-dsh-git] {
  display: flex; flex-direction: column; height: 100%; min-height: 0; position: relative;
  background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary);
  font-size: 12px; line-height: 1.45;
}
[data-dsh-git] *, [data-dsh-git] *::before, [data-dsh-git] *::after { box-sizing: border-box; }
.git-mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.git-grow { flex: 1; }
.git-dim { color: var(--dsw-alias-label-secondary); }
.git-warn { color: var(--dsw-alias-state-warn-primary); }
.git-visuallyHidden {
  position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden;
  clip: rect(0 0 0 0); white-space: nowrap; border: 0;
}
.git-tipAnchor { display: inline-flex; align-items: center; min-width: 0; }
.git-running { display: inline-flex; align-items: center; gap: 6px; color: var(--dsw-alias-label-secondary); }
.git-danger { --dsw-alias-button-primary-fill: var(--dsw-alias-state-error-primary); }

/* Page */
[data-dsh-git='page'] { container-type: inline-size; container-name: dsh-git-page; }
[data-dsh-git] .git-head {
  position: relative; flex: none; padding: 8px 12px 10px;
  background: var(--dsw-alias-bg-layer-1); border-bottom: 1px solid var(--dsw-alias-border-l1);
}
[data-dsh-git] .git-headMain { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; min-height: 28px; }
[data-dsh-git] .git-title { font-size: 14px; font-weight: 600; }
[data-dsh-git] .git-repoName { color: var(--dsw-alias-label-secondary); }
[data-dsh-git] .git-branchTag { display: inline-flex; align-items: center; gap: 4px; }
[data-dsh-git] .git-branchBtn {
  display: inline-flex; align-items: center; gap: 4px; max-width: 32ch; padding: 1px 6px;
  border: 1px solid var(--dsw-alias-border-l2); border-radius: 6px; background: none;
  color: inherit; font: inherit; cursor: pointer; transition: background 120ms ease;
}
[data-dsh-git] .git-branchBtn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
[data-dsh-git] .git-branchBtn:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
[data-dsh-git] .git-branchBtn:disabled { opacity: 0.55; cursor: default; }
[data-dsh-git] .git-branchBtnName { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
[data-dsh-git] .git-bar {
  position: absolute; left: 0; right: 0; bottom: -1px; height: 2px; overflow: hidden;
  opacity: 0; transition: opacity 120ms ease;
}
[data-dsh-git] .git-bar[data-active='true'] { opacity: 1; }
[data-dsh-git] .git-barFill {
  display: block; height: 100%; width: 35%; background: var(--dsw-alias-brand-primary);
  animation: git-sweep 1.2s ease-in-out infinite;
}
@keyframes git-sweep { from { transform: translateX(-100%); } to { transform: translateX(300%); } }

[data-dsh-git] .git-banner {
  flex: none; display: flex; align-items: center; justify-content: space-between; gap: 8px;
  margin: 8px 12px 0; padding: 6px 10px; border-radius: 8px;
  border: 1px solid var(--dsw-alias-state-error-primary); background: var(--dsw-alias-state-error-secondary);
}
[data-dsh-git] .git-banner[data-kind='notice'] {
  border-color: var(--dsw-alias-state-success-primary); background: var(--dsw-alias-state-success-secondary);
}
[data-dsh-git] .git-bannerClose {
  display: inline-flex; align-items: center; justify-content: center; width: 20px; height: 20px; padding: 0;
  border: 0; border-radius: 4px; background: none; color: inherit; cursor: pointer;
}
[data-dsh-git] .git-bannerClose:hover { background: var(--dsw-alias-interactive-bg-hover); }

[data-dsh-git] .git-body { flex: 1; min-height: 0; display: flex; flex-direction: column; }
[data-dsh-git] .git-main {
  flex: 1; min-height: 0; display: grid; grid-template-columns: var(--git-split, 38%) 6px minmax(0, 1fr);
}
[data-dsh-git] .git-col { min-width: 0; min-height: 0; overflow: hidden; display: flex; flex-direction: column; }
[data-dsh-git] .git-panel { flex: 1; min-height: 0; }

[data-dsh-git] .git-splitter { position: relative; flex: none; background: transparent; outline: none; touch-action: none; }
[data-dsh-git] .git-splitter::after {
  content: ''; position: absolute; background: var(--dsw-alias-border-l1); transition: background 120ms ease;
}
[data-dsh-git] .git-splitter[data-orientation='vertical'] { width: 6px; cursor: col-resize; }
[data-dsh-git] .git-splitter[data-orientation='vertical']::after { left: 2px; top: 0; bottom: 0; width: 1px; }
[data-dsh-git] .git-splitter[data-orientation='horizontal'] { height: 6px; cursor: row-resize; }
[data-dsh-git] .git-splitter[data-orientation='horizontal']::after { top: 2px; left: 0; right: 0; height: 1px; }
[data-dsh-git] .git-splitter:hover::after, [data-dsh-git] .git-splitter:focus-visible::after {
  background: var(--dsw-alias-brand-primary);
}
[data-dsh-git] .git-splitter[data-orientation='vertical']:hover::after,
[data-dsh-git] .git-splitter[data-orientation='vertical']:focus-visible::after { width: 2px; left: 2px; }
[data-dsh-git] .git-splitter[data-orientation='horizontal']:hover::after,
[data-dsh-git] .git-splitter[data-orientation='horizontal']:focus-visible::after { height: 2px; }

@container dsh-git-page (max-width: 760px) {
  [data-dsh-git] .git-main { grid-template-columns: minmax(0, 1fr); grid-template-rows: minmax(0, 1fr) minmax(0, 1fr); }
  [data-dsh-git] .git-splitCol { display: none; }
  [data-dsh-git] .git-colDiff { border-top: 1px solid var(--dsw-alias-border-l1); }
}

/* Toolbar and tree */
[data-dsh-git] .git-toolbar { display: flex; align-items: center; flex-wrap: wrap; gap: 4px; padding: 8px 10px 6px; flex: none; }
[data-dsh-git] .git-tree { flex: 1; min-height: 0; overflow: auto; padding: 2px 8px 8px; }
[data-dsh-git] .git-card {
  margin-top: 8px; padding: 4px 4px 6px; border-radius: 8px; background: var(--dsw-alias-bg-layer-1);
  border: 1px solid var(--dsw-alias-border-l1);
}
[data-dsh-git] .git-children { padding-left: 10px; border-left: 1px solid var(--dsw-alias-border-l2); margin-left: 8px; }
[data-dsh-git] .git-sectionLabel {
  color: var(--dsw-alias-label-tertiary); text-transform: uppercase; font-size: 10px;
  letter-spacing: 0.06em; padding: 4px 6px 3px;
}
[data-dsh-git] .git-row {
  display: flex; align-items: center; gap: 5px; min-height: 24px; padding: 1px 4px;
  border-radius: 6px; transition: background 120ms ease;
}
[data-dsh-git] .git-row:hover { background: var(--dsw-alias-interactive-bg-hover); }
[data-dsh-git] .git-row[data-selected='true'] { background: var(--dsw-alias-interactive-bg-active); }
[data-dsh-git] .git-rowGroup { margin-top: 2px; }
[data-dsh-git] .git-rowRepo { min-height: 26px; box-shadow: inset 2px 0 0 transparent; }
[data-dsh-git] .git-rowRepo[data-active='true'] { box-shadow: inset 2px 0 0 var(--dsw-alias-brand-primary); background: var(--dsw-alias-interactive-bg-hover); }
[data-dsh-git] .git-twisty {
  display: inline-flex; align-items: center; justify-content: center; width: 18px; height: 18px;
  padding: 0; border: 0; border-radius: 4px; background: none; color: var(--dsw-alias-label-secondary); cursor: pointer;
}
[data-dsh-git] .git-twisty:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-active); }
[data-dsh-git] .git-twisty:disabled { opacity: 0.45; cursor: default; }
[data-dsh-git] .git-twistyGlyph { display: inline-flex; transition: transform 120ms ease; }
[data-dsh-git] .git-check { margin: 0; flex: none; accent-color: var(--dsw-alias-brand-primary); }
[data-dsh-git] .git-check:disabled { opacity: 0.5; }
[data-dsh-git] .git-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
[data-dsh-git] .git-repo { font-weight: 600; }
[data-dsh-git] .git-groupLabel { font-weight: 600; }
[data-dsh-git] .git-count { color: var(--dsw-alias-label-tertiary); font-size: 11px; white-space: nowrap; }
[data-dsh-git] .git-fileBtn {
  flex: 1; min-width: 0; display: inline-flex; align-items: center; gap: 6px; padding: 0; border: 0;
  background: none; color: inherit; font: inherit; text-align: left; cursor: pointer;
}
[data-dsh-git] .git-fileName { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
[data-dsh-git] .git-statusTag { flex: none; min-width: 18px; justify-content: center; }
[data-dsh-git] .git-branch { display: inline-flex; align-items: center; gap: 6px; color: var(--dsw-alias-label-secondary); }
[data-dsh-git] .git-ahead { color: var(--dsw-alias-state-success-primary); }
[data-dsh-git] .git-behind { color: var(--dsw-alias-state-warn-primary); }
[data-dsh-git] .git-empty { padding: 14px 10px; color: var(--dsw-alias-label-secondary); }
[data-dsh-git] .git-emptyDiff { display: flex; align-items: center; justify-content: center; flex: 1; }
[data-dsh-git] .git-inlineError {
  display: flex; align-items: center; justify-content: space-between; gap: 8px; margin: 4px 0; padding: 4px 8px;
  border-radius: 6px; background: var(--dsw-alias-state-error-secondary); color: var(--dsw-alias-state-error-primary);
}
[data-dsh-git] .git-fieldError { color: var(--dsw-alias-state-error-primary); }

/* Skeleton */
[data-dsh-git] .git-skelRow { display: flex; align-items: center; min-height: 22px; padding: 0 4px; }
[data-dsh-git] .git-skel {
  display: block; height: 10px; border-radius: 5px; background: var(--dsw-alias-bg-skeleton);
  animation: git-pulse 1.4s ease-in-out infinite;
}
@keyframes git-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.45; } }
[data-dsh-git] .git-diffSkeleton { padding: 8px 10px; }

/* Commit box */
[data-dsh-git] .git-commitbox {
  flex: none; display: flex; flex-direction: column; gap: 6px; padding: 8px 10px 10px;
  border-top: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1);
}
[data-dsh-git] .git-amendRow { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
[data-dsh-git] .git-message {
  width: 100%; min-height: 72px; resize: vertical; padding: 6px 8px; border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-primary); font: inherit;
}
[data-dsh-git] .git-message:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: -1px; }
[data-dsh-git] .git-message[readonly] { opacity: 0.7; }
[data-dsh-git] .git-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; }
[data-dsh-git] .git-route { color: var(--dsw-alias-label-tertiary); font-size: 11px; }

/* Diff */
[data-dsh-git] .git-diffHead {
  flex: none; display: flex; align-items: center; flex-wrap: wrap; gap: 4px; padding: 6px 10px;
  border-bottom: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1);
}
[data-dsh-git] .git-diffSub {
  flex: none; display: flex; align-items: center; gap: 8px; padding: 4px 10px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
}
[data-dsh-git] .git-path { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
[data-dsh-git] .git-diffBody { flex: 1; min-height: 0; overflow: auto; position: relative; }
[data-dsh-git] .git-table { border-collapse: separate; border-spacing: 0; width: max-content; min-width: 100%; }
[data-dsh-git] .git-diffBody[data-wrap='true'] .git-table { width: 100%; }
[data-dsh-git] .git-table td, [data-dsh-git] .git-table th { padding: 0; vertical-align: top; }
[data-dsh-git] .git-num {
  position: sticky; left: 0; z-index: 1; width: 48px; min-width: 48px; padding: 0 6px; text-align: right;
  color: var(--dsw-alias-label-tertiary); background: var(--dsw-alias-bg-layer-1); user-select: none;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
[data-dsh-git] .git-numSecond { left: 48px; }
[data-dsh-git] .git-numRight { position: static; border-left: 1px solid var(--dsw-alias-border-l1); }
[data-dsh-git] .git-numAdd { background: var(--dsw-alias-file-diff-added-gutter); box-shadow: inset 2px 0 0 var(--dsw-alias-file-diff-added-marker); }
[data-dsh-git] .git-numDel { background: var(--dsw-alias-file-diff-deleted-gutter); box-shadow: inset 2px 0 0 var(--dsw-alias-file-diff-deleted-marker); }
[data-dsh-git] .git-code {
  padding: 0 8px; white-space: pre; tab-size: 4;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
[data-dsh-git] .git-diffBody[data-wrap='true'] .git-code { white-space: pre-wrap; overflow-wrap: anywhere; }
[data-dsh-git] .git-table[data-mode='split'] .git-code { width: 50%; }
[data-dsh-git] .git-lineAdd { background: var(--dsw-alias-file-diff-added-bg); }
[data-dsh-git] .git-lineDel { background: var(--dsw-alias-file-diff-deleted-bg); }
[data-dsh-git] .git-mark { color: inherit; border-radius: 2px; }
[data-dsh-git] .git-mark[data-side='add'] { background: color-mix(in srgb, var(--dsw-alias-file-diff-added-marker) 35%, transparent); }
[data-dsh-git] .git-mark[data-side='del'] { background: color-mix(in srgb, var(--dsw-alias-file-diff-deleted-marker) 35%, transparent); }
[data-dsh-git] .git-hunkHead th {
  position: sticky; top: 0; z-index: 3; text-align: left; font-weight: 400; padding: 3px 8px;
  background: var(--dsw-alias-bg-layer-2); border-top: 1px solid var(--dsw-alias-border-l1); border-bottom: 1px solid var(--dsw-alias-border-l1);
}
[data-dsh-git] .git-hunkBar { position: sticky; left: 0; display: inline-flex; align-items: center; gap: 8px; }
[data-dsh-git] .git-hunkHeader { color: var(--dsw-alias-label-secondary); }
[data-dsh-git] .git-included { color: var(--dsw-alias-state-success-primary); }
[data-dsh-git] .git-excluded { color: var(--dsw-alias-label-tertiary); }
[data-dsh-git] .git-gapRow td, [data-dsh-git] .git-foldRow td {
  padding: 2px 8px; text-align: center; color: var(--dsw-alias-label-tertiary); background: var(--dsw-alias-bg-layer-2);
}
[data-dsh-git] .git-foldBtn {
  width: 100%; padding: 0; border: 0; background: none; color: var(--dsw-alias-label-secondary);
  font: inherit; cursor: pointer;
}
[data-dsh-git] .git-foldBtn:hover { color: var(--dsw-alias-brand-primary); }

/* Activity dock */
[data-dsh-git] .git-dock {
  flex: none; display: flex; flex-direction: column; min-height: 0;
  background: var(--dsw-alias-bg-layer-1); border-top: 1px solid var(--dsw-alias-border-l1);
}
[data-dsh-git] .git-dock[data-open='true'] { height: var(--git-dock, 200px); }
[data-dsh-git] .git-dockHead { flex: none; display: flex; align-items: center; flex-wrap: wrap; gap: 8px; padding: 4px 10px; }
[data-dsh-git] .git-dockBody { flex: 1; min-height: 0; overflow: auto; padding: 2px 8px 8px; }
[data-dsh-git] .git-unread { width: 8px; height: 8px; border-radius: 50%; background: var(--dsw-alias-brand-primary); }
[data-dsh-git] .git-group { border-radius: 6px; }
[data-dsh-git] .git-group[data-background='true'] { opacity: 0.65; }
[data-dsh-git] .git-groupBtn, [data-dsh-git] .git-callBtn {
  width: 100%; display: flex; align-items: center; gap: 8px; padding: 3px 6px; border: 0; border-radius: 6px;
  background: none; color: inherit; font: inherit; text-align: left; cursor: pointer; transition: background 120ms ease;
}
[data-dsh-git] .git-groupBtn:hover, [data-dsh-git] .git-callBtn:hover { background: var(--dsw-alias-interactive-bg-hover); }
[data-dsh-git] .git-groupTwisty { display: inline-flex; color: var(--dsw-alias-label-secondary); }
[data-dsh-git] .git-groupNote { padding: 0 6px 2px 28px; font-size: 11px; }
[data-dsh-git] .git-groupBody { margin-left: 14px; padding-left: 8px; border-left: 1px solid var(--dsw-alias-border-l2); }
[data-dsh-git] .git-callBtn { padding-left: 4px; }
[data-dsh-git] .git-activityTime { color: var(--dsw-alias-label-tertiary); flex: none; }
[data-dsh-git] .git-activityLabel { flex: none; font-weight: 600; }
[data-dsh-git] .git-activityDetail { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dsw-alias-label-secondary); }
[data-dsh-git] .git-activityMs { flex: none; color: var(--dsw-alias-label-tertiary); }
[data-dsh-git] .git-activityEmpty { padding: 10px; color: var(--dsw-alias-label-secondary); }
[data-dsh-git] .git-outputWrap { position: relative; margin: 2px 0 6px 18px; }
[data-dsh-git] .git-activityOutput {
  margin: 0; padding: 6px 28px 6px 8px; max-height: 160px; overflow: auto; border-radius: 6px;
  background: var(--dsw-alias-bg-base); border: 1px solid var(--dsw-alias-border-l1); white-space: pre-wrap; overflow-wrap: anywhere;
}
[data-dsh-git] .git-copyBtn {
  position: absolute; top: 4px; right: 4px; display: inline-flex; align-items: center; justify-content: center;
  width: 20px; height: 20px; padding: 0; border: 0; border-radius: 4px; background: none;
  color: var(--dsw-alias-label-secondary); cursor: pointer;
}
[data-dsh-git] .git-copyBtn:hover { background: var(--dsw-alias-interactive-bg-hover); }

/* Dialogs: portaled by Modal, so scoped by the class passed to it */
.dsh-git-dialog .git-confirmBody { display: flex; flex-direction: column; gap: 8px; font-size: 13px; line-height: 1.5; }
.dsh-git-dialog .git-confirmBody p { margin: 0; }
.dsh-git-dialog .git-confirmFooter { display: flex; justify-content: flex-end; flex-wrap: wrap; gap: 8px; }
.dsh-git-dialog .git-warn { color: var(--dsw-alias-state-warn-primary); }
.dsh-git-dialog .git-dim { color: var(--dsw-alias-label-secondary); }
.dsh-git-dialog .git-tipAnchor { display: inline-flex; }
.dsh-git-dialog .git-running { display: inline-flex; align-items: center; gap: 6px; color: var(--dsw-alias-label-secondary); }
.dsh-git-dialog .git-danger { --dsw-alias-button-primary-fill: var(--dsw-alias-state-error-primary); }
.dsh-git-dialog .git-branchBody { display: flex; flex-direction: column; gap: 8px; min-height: 0; font-size: 13px; }
.dsh-git-dialog .git-branchFilter {
  width: 100%; padding: 5px 8px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); font: inherit;
}
.dsh-git-dialog .git-branchFilter:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: -1px; }
.dsh-git-dialog .git-branchFilter:disabled { opacity: 0.6; }
.dsh-git-dialog .git-branchScroll { max-height: 42vh; overflow: auto; }
.dsh-git-dialog .git-branchGroup { display: flex; flex-direction: column; gap: 1px; }
.dsh-git-dialog .git-branchGroupLabel {
  text-transform: uppercase; letter-spacing: 0.06em; font-size: 10px;
  color: var(--dsw-alias-label-tertiary); padding: 4px 2px 2px;
}
.dsh-git-dialog .git-branchHint { margin: 0; color: var(--dsw-alias-label-tertiary); font-size: 11px; }
.dsh-git-dialog .git-branchRow {
  display: flex; align-items: center; gap: 8px; width: 100%; padding: 4px 6px; border: 0;
  border-radius: 6px; background: none; color: inherit; font: inherit; text-align: left;
  cursor: pointer; transition: background 120ms ease;
}
.dsh-git-dialog .git-branchRow:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.dsh-git-dialog .git-branchRow[data-selected='true'] { background: var(--dsw-alias-interactive-bg-active); }
.dsh-git-dialog .git-branchRow:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: -1px; }
.dsh-git-dialog .git-branchRow:disabled { opacity: 0.55; cursor: default; }
.dsh-git-dialog .git-branchRow[aria-current='true'] .git-branchName { font-weight: 600; }
.dsh-git-dialog .git-branchName { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-git-dialog .git-branchUnit { flex: none; color: var(--dsw-alias-label-tertiary); font-size: 11px; white-space: nowrap; }
.dsh-git-dialog .git-branchCurrent { flex: none; color: var(--dsw-alias-brand-primary); font-size: 11px; }
.dsh-git-dialog .git-branchEmpty { padding: 6px 4px; }
.dsh-git-dialog .git-branchError {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  padding: 4px 8px; border-radius: 6px;
  background: var(--dsw-alias-state-error-secondary); color: var(--dsw-alias-state-error-primary);
}
.dsh-git-dialog .git-branchNew { display: flex; flex-direction: column; gap: 4px; }
.dsh-git-dialog .git-branchEffect { color: var(--dsw-alias-label-secondary); font-size: 12px; }
.dsh-git-dialog .git-branchFooter { display: flex; flex-direction: column; gap: 8px; width: 100%; }
.dsh-git-dialog .git-branchFooterRow { display: flex; justify-content: flex-end; flex-wrap: wrap; gap: 8px; }

@media (prefers-reduced-motion: reduce) {
  [data-dsh-git] .git-barFill { animation: none; width: 40%; }
  [data-dsh-git] .git-branchBtn, .dsh-git-dialog .git-branchRow { transition: none; }
  [data-dsh-git] .git-skel { animation: none; }
  [data-dsh-git] .git-bar, [data-dsh-git] .git-row, [data-dsh-git] .git-twistyGlyph,
  [data-dsh-git] .git-groupBtn, [data-dsh-git] .git-callBtn, [data-dsh-git] .git-splitter::after { transition: none; }
}
`

/**
 * Install the page stylesheet, owned by the plugin context.
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
