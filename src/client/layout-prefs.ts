/**
 * Per-viewer layout conveniences kept in `localStorage`: split ratio, dock
 * height and state, diff mode, wrap and the background-activity toggle.
 *
 * Every access is wrapped in try/catch and guarded for a missing `localStorage`
 * (private window, blocked site data, a Node probe); a failure falls back to the
 * default, so the page renders identically with storage unavailable.
 */

/** Key prefix, so the plugin never collides with another page's keys. */
const PREFIX = 'dsh-intellij-git:'

/** A value `localStorage` round-trips through JSON. */
type Pref = string | number | boolean

/**
 * Read one preference.
 * @param key - preference name.
 * @param fallback - value used when nothing valid is stored.
 * @param valid - optional check on the parsed value.
 * @returns the stored value, or the fallback.
 */
export function readPref<T extends Pref>(key: string, fallback: T, valid?: (value: unknown) => boolean): T {
  try {
    if (typeof localStorage === 'undefined') return fallback
    const raw = localStorage.getItem(PREFIX + key)
    if (raw === null) return fallback
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== typeof fallback) return fallback
    if (valid !== undefined && !valid(parsed)) return fallback
    return parsed as T
  } catch {
    return fallback
  }
}

/**
 * Persist one preference; a storage failure is ignored.
 * @param key - preference name.
 * @param value - value to store.
 */
export function writePref(key: string, value: Pref): void {
  try {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(PREFIX + key, JSON.stringify(value))
  } catch {
    // Storage is a convenience: losing it only resets the layout on reload.
  }
}
