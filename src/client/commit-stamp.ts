/**
 * The default commit message: the browser's local time as `YYMMDD-HHMM`.
 *
 * The Human's clock is the browser's, so the stamp is read from local `Date`
 * fields here and never from the host (whose time zone, a container's UTC for
 * one, would decide the subject). The formatter is pure so the store can freeze
 * a value into the pending commit; the hook only feeds the placeholder and is
 * never read by the store.
 */
import { useEffect, useState } from 'react'

/**
 * Format a date as `YYMMDD-HHMM` from its local fields.
 * @param date - the instant to format.
 * @returns the zero-padded stamp, e.g. `261026-2330`.
 */
export function formatCommitStamp(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(date.getFullYear() % 100)}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`
}

/**
 * The current stamp, refreshed at every local minute boundary.
 *
 * One timeout to the next boundary, rescheduled after it fires and cleared on
 * unmount, so nothing runs while the component is not mounted.
 * @returns the current stamp.
 */
export function useCommitStamp(): string {
  const [stamp, setStamp] = useState<string>(() => formatCommitStamp(new Date()))
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const schedule = (): void => {
      const now = new Date()
      const untilNext = 60_000 - (now.getSeconds() * 1000 + now.getMilliseconds())
      timer = setTimeout(() => {
        setStamp(formatCommitStamp(new Date()))
        schedule()
      }, untilNext + 5)
    }
    setStamp(formatCommitStamp(new Date()))
    schedule()
    return () => { if (timer !== undefined) clearTimeout(timer) }
  }, [])
  return stamp
}
