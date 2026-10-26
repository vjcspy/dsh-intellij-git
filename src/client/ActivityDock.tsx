/**
 * The activity dock: one row per request, newest first.
 *
 * Grouping is the pure `groupActivity` helper; this renders its result. A
 * request that has recorded git calls but no api row yet is still running and
 * renders with the platform spinner, so the Human sees a commit while it
 * happens, not after. Newest-first removes every scroll rule: the latest action
 * is at the top whatever the ring does at capacity.
 */
import { useSyncExternalStore, type ReactNode } from 'react'
import {
  Checkbox,
  IconChevronDownOutlineRegular,
  IconChevronRightOutlineRegular,
  IconCopyOutlineRegular,
  IconRefreshOutlineRegular,
  IconTrashOutlineRegular,
  StateDot,
  Tag,
  Tooltip,
  writeClipboard,
} from '@deepseek-ai/dsh-client-ui-primitives'

import type { ActivityEntry } from '../config.ts'
import { ActionButton } from './ActionButton.tsx'
import { groupActivity, type ActivityGroup } from './activity-groups.ts'
import type { Translate } from './locale.ts'
import { dockOpenOf, type IntellijGitStore } from './store.ts'

/** Props: the shared store and the locale seat. */
export interface ActivityDockProps {
  readonly store: IntellijGitStore
  readonly t: Translate
}

/**
 * A `HH:mm:ss.SSS` clock label.
 * @param at - epoch milliseconds.
 * @returns the formatted time.
 */
function clockOf(at: number): string {
  const date = new Date(at)
  const pad = (value: number, width = 2): string => String(value).padStart(width, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`
}

/**
 * One call inside an expanded group, with its output behind a click.
 * @param props - the entry, its expansion state, the locale seat and the toggles.
 * @returns the row.
 */
function CallRow(props: {
  readonly entry: ActivityEntry
  readonly open: boolean
  readonly t: Translate
  readonly onToggle: () => void
}): ReactNode {
  const { entry, open, t } = props
  const output = entry.output === undefined || entry.output === '' ? t('activity.noOutput') : entry.output
  return (
    <div className="git-call" data-ok={entry.ok}>
      <Tooltip label={t('activity.expand.tip')} delayMs={600} portal>
        <button type="button" className="git-callBtn" aria-expanded={open} onClick={props.onToggle}>
          <span className="git-activityTime git-mono">{clockOf(entry.at)}</span>
          <span className="git-activityLabel git-mono">{entry.label}</span>
          <span className="git-activityDetail git-mono">{entry.detail}</span>
          <span className="git-activityMs">{entry.durationMs} ms</span>
          <Tag tone={entry.ok ? 'success' : 'danger'}>{entry.ok ? t('activity.ok') : t('activity.error')}</Tag>
        </button>
      </Tooltip>
      {open ? (
        <div className="git-outputWrap">
          <pre className="git-activityOutput git-mono">
            {output}
            {entry.truncated === true ? `\n${t('activity.truncated')}` : ''}
          </pre>
          <Tooltip label={t('activity.copy.tip')} delayMs={500} portal>
            <button
              type="button"
              className="git-copyBtn"
              aria-label={t('activity.copy')}
              onClick={() => { void writeClipboard(entry.output ?? '') }}
            >
              <IconCopyOutlineRegular size={12} />
            </button>
          </Tooltip>
        </div>
      ) : null}
    </div>
  )
}

/**
 * One request row, expandable into the calls it caused.
 * @param props - the group, its expansion state, the locale seat and the store.
 * @returns the row.
 */
function GroupRow(props: {
  readonly group: ActivityGroup
  readonly open: boolean
  readonly detailOpen: readonly number[]
  readonly t: Translate
  readonly store: IntellijGitStore
}): ReactNode {
  const { group, open, t, store } = props
  const api = group.api
  return (
    <div className="git-group" data-status={group.status} data-background={group.background}>
      <button
        type="button"
        className="git-groupBtn"
        aria-expanded={open}
        onClick={() => { store.actions.toggleActivityGroup(group.key) }}
      >
        <span className="git-groupTwisty">{open ? <IconChevronDownOutlineRegular size={12} /> : <IconChevronRightOutlineRegular size={12} />}</span>
        {group.status === 'running' ? <StateDot state="ongoing" size={12} /> : null}
        <span className="git-activityTime git-mono">{clockOf(group.newestAt)}</span>
        <span className="git-activityLabel git-mono">{group.label}</span>
        {group.status === 'running'
          ? <Tag tone="info">{t('activity.running')}</Tag>
          : <Tag tone={group.status === 'ok' ? 'success' : 'danger'}>{group.status === 'ok' ? t('activity.ok') : t('activity.error')}</Tag>}
        {group.background ? <Tag tone="quiet">{t('activity.auto')}</Tag> : null}
        {api === null ? null : <span className="git-activityDetail git-mono">{api.detail}</span>}
        {api === null ? null : <span className="git-activityMs">{api.durationMs} ms</span>}
        {group.git.length === 0 ? null : <span className="git-count">{t('activity.calls', { count: group.git.length })}</span>}
      </button>
      {group.partial ? <div className="git-groupNote git-dim">{t('activity.partial')}</div> : null}
      {open ? (
        <div className="git-groupBody">
          {group.entries.map(entry => (
            <CallRow
              key={entry.id}
              entry={entry}
              open={props.detailOpen.includes(entry.id)}
              t={t}
              onToggle={() => { store.actions.toggleActivityDetail(entry.id) }}
            />
          ))}
        </div>
      ) : null}
    </div>
  )
}

/**
 * The dock.
 * @param props - the store and the locale seat.
 * @returns the dock region.
 */
export function ActivityDock(props: ActivityDockProps): ReactNode {
  const { store, t } = props
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const all = groupActivity(state.activity, { truncated: state.activityTruncated })
  const groups = state.showBackground ? all : all.filter(group => !group.background)
  const hidden = all.length - groups.length

  return (
    <div className="git-dock" data-open={dockOpenOf(state)}>
      <div className="git-dockHead">
        <Tooltip label={t('activity.toggle.tip')} delayMs={500} portal>
          <button type="button" className="git-twisty" aria-expanded={dockOpenOf(state)} aria-label={t('activity.title')} onClick={() => { store.actions.toggleActivity() }}>
            <span className="git-twistyGlyph" data-open={dockOpenOf(state)}>
              {dockOpenOf(state) ? <IconChevronDownOutlineRegular size={12} /> : <IconChevronRightOutlineRegular size={12} />}
            </span>
          </button>
        </Tooltip>
        <span className="git-label git-groupLabel">{t('activity.title')}</span>
        {state.activityUnread && !dockOpenOf(state) ? <span className="git-unread" role="status" aria-label={t('activity.unread')} /> : null}
        <span className="git-count">{t('activity.summary', { requests: groups.length, entries: state.activity.length })}</span>
        {state.activityStale ? <span className="git-warn">{t('activity.stale')}</span> : null}
        {state.activityError === null ? null : <span className="git-warn" role="alert">{t('activity.clearFailed', { reason: state.activityError })}</span>}
        <span className="git-grow" />
        <Tooltip label={t('activity.background.tip')} delayMs={500} portal>
          <span className="git-tipAnchor">
            <Checkbox
              checked={state.showBackground}
              label={hidden > 0 && !state.showBackground ? t('activity.background.count', { count: hidden }) : t('activity.background')}
              onChange={() => { store.actions.toggleShowBackground() }}
            />
          </span>
        </Tooltip>
        <ActionButton
          tip={t('activity.refresh.tip')}
          label={t('activity.refresh')}
          icon={<IconRefreshOutlineRegular size={14} />}
          onClick={() => { void store.actions.refreshActivity() }}
        />
        <ActionButton
          tip={t('activity.clear.tip')}
          disabledTip={state.activityClearing ? t('activity.clearing') : t('activity.empty')}
          disabled={state.activity.length === 0 || state.activityClearing}
          label={t('activity.clear')}
          icon={<IconTrashOutlineRegular size={14} />}
          onClick={() => { void store.actions.clearActivity() }}
        />
      </div>
      {dockOpenOf(state) ? (
        <div className="git-dockBody" role="log" aria-label={t('activity.title')}>
          {groups.length === 0
            ? <div className="git-activityEmpty">{t('activity.empty')}</div>
            : groups.map(group => (
              <GroupRow
                key={group.key}
                group={group}
                open={state.activityGroupsOpen.includes(group.key)}
                detailOpen={state.activityDetail}
                t={t}
                store={store}
              />
            ))}
        </div>
      ) : null}
    </div>
  )
}
