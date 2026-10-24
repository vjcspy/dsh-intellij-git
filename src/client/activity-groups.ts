/**
 * Pure grouping of activity entries into one row per request.
 *
 * No React and no store access: the dock renders the result and the store
 * probes feed it captured entry lists directly.
 *
 * The host records a request's `api` entry only after its handler settles
 * (`recordApi` runs after the handler returns), while its `git` entries are
 * recorded as each subprocess finishes. A group that holds `git` entries for a
 * request id but no `api` entry is therefore a request that is still running.
 */
import type { ActivityEntry } from '../config.ts'

/** One request and the calls it caused. */
export interface ActivityGroup {
  /** Stable row key: `r:<requestId>` for a request, `e:<id>` for an entry outside any request. */
  readonly key: string
  readonly requestId: number | null
  /** The request's own entry, absent while it runs. */
  readonly api: ActivityEntry | null
  /** The `git` calls it caused, oldest first. */
  readonly git: readonly ActivityEntry[]
  /** Every entry of the group, oldest first. */
  readonly entries: readonly ActivityEntry[]
  /** `running`: git rows without an api row yet. */
  readonly status: 'running' | 'ok' | 'failed'
  /** True for watcher-driven requests (`origin: 'auto'`). */
  readonly background: boolean
  /** Short name: the route key, or the first git call's label while running. */
  readonly label: string
  /** Id of the group's newest entry; the sort key. */
  readonly newestId: number
  /** Epoch ms of the group's newest entry. */
  readonly newestAt: number
  /** True when older entries of this request were evicted or cleared. */
  readonly partial: boolean
}

/** Options of {@link groupActivity}. */
export interface GroupOptions {
  /** True when entries older than the first retained one were evicted or cleared. */
  readonly truncated: boolean
}

/**
 * Group entries by request, newest group first.
 * @param entries - the merged list, oldest first.
 * @param options - whether older entries were lost.
 * @returns one group per request, plus one per entry outside any request.
 */
export function groupActivity(entries: readonly ActivityEntry[], options: GroupOptions): ActivityGroup[] {
  const buckets = new Map<string, ActivityEntry[]>()
  for (const entry of entries) {
    const key = entry.requestId === undefined ? `e:${entry.id}` : `r:${entry.requestId}`
    const bucket = buckets.get(key)
    if (bucket === undefined) buckets.set(key, [entry])
    else bucket.push(entry)
  }
  let oldestRetained = Number.POSITIVE_INFINITY
  for (const entry of entries) oldestRetained = Math.min(oldestRetained, entry.id)

  const groups: ActivityGroup[] = []
  for (const [key, bucket] of buckets) {
    const sorted = [...bucket].sort((a, b) => a.id - b.id)
    const first = sorted[0]
    const last = sorted[sorted.length - 1]
    if (first === undefined || last === undefined) continue
    const api = sorted.find(entry => entry.kind === 'api') ?? null
    const git = sorted.filter(entry => entry.kind === 'git')
    const requestId = first.requestId ?? null
    const status: ActivityGroup['status'] = api === null
      ? (requestId === null ? (first.ok ? 'ok' : 'failed') : 'running')
      : (api.ok ? 'ok' : 'failed')
    groups.push({
      key,
      requestId,
      api,
      git,
      entries: sorted,
      status,
      background: sorted.some(entry => entry.origin === 'auto'),
      label: api?.label ?? git[0]?.label ?? first.label,
      newestId: last.id,
      newestAt: last.at,
      partial: options.truncated && requestId !== null && first.id === oldestRetained,
    })
  }
  return groups.sort((a, b) => b.newestId - a.newestId)
}
