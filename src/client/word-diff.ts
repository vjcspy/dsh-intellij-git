/**
 * Word-level difference of two paired lines.
 *
 * Tokenizes into words, whitespace runs and single punctuation characters, runs
 * a longest-common-subsequence over the tokens and returns the character ranges
 * that differ on each side. Linear in practice because the caller caps line
 * length (`WORD_DIFF_MAX_CHARS`) and the number of pairs per file.
 */

/** Longest line, in characters, that is word-diffed. */
export const WORD_DIFF_MAX_CHARS = 400

/** Most paired lines word-diffed in one file. */
export const WORD_DIFF_MAX_PAIRS = 300

/** A half-open character range `[start, end)`. */
export type CharRange = readonly [start: number, end: number]

/** The changed ranges on each side of one pair. */
export interface WordDiff {
  readonly old: readonly CharRange[]
  readonly next: readonly CharRange[]
}

const TOKEN = /\s+|[A-Za-z0-9_]+|[^\sA-Za-z0-9_]/gu

/**
 * Split text into tokens with their start offsets.
 * @param text - one line.
 * @returns tokens in order.
 */
function tokenize(text: string): { text: string, start: number }[] {
  const tokens: { text: string, start: number }[] = []
  for (const match of text.matchAll(TOKEN)) tokens.push({ text: match[0], start: match.index })
  return tokens
}

/**
 * Merge touching ranges.
 * @param ranges - ranges in ascending order.
 * @returns the merged ranges.
 */
function merge(ranges: CharRange[]): CharRange[] {
  const merged: CharRange[] = []
  for (const range of ranges) {
    const last = merged[merged.length - 1]
    if (last !== undefined && last[1] >= range[0]) merged[merged.length - 1] = [last[0], Math.max(last[1], range[1])]
    else merged.push(range)
  }
  return merged
}

/**
 * Diff two lines by tokens.
 * @param before - the old line.
 * @param after - the new line.
 * @returns the changed ranges, or null when either line exceeds the cap.
 */
export function wordDiff(before: string, after: string): WordDiff | null {
  if (before.length > WORD_DIFF_MAX_CHARS || after.length > WORD_DIFF_MAX_CHARS) return null
  const a = tokenize(before)
  const b = tokenize(after)
  const rows = a.length + 1
  const cols = b.length + 1
  const table = new Uint16Array(rows * cols)
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i * cols + j] = a[i]?.text === b[j]?.text
        ? (table[(i + 1) * cols + j + 1] ?? 0) + 1
        : Math.max(table[(i + 1) * cols + j] ?? 0, table[i * cols + j + 1] ?? 0)
    }
  }
  const oldRanges: CharRange[] = []
  const newRanges: CharRange[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    const left = a[i]
    const right = b[j]
    if (left === undefined || right === undefined) break
    if (left.text === right.text) {
      i += 1
      j += 1
    } else if ((table[(i + 1) * cols + j] ?? 0) >= (table[i * cols + j + 1] ?? 0)) {
      oldRanges.push([left.start, left.start + left.text.length])
      i += 1
    } else {
      newRanges.push([right.start, right.start + right.text.length])
      j += 1
    }
  }
  for (; i < a.length; i += 1) {
    const token = a[i]
    if (token !== undefined) oldRanges.push([token.start, token.start + token.text.length])
  }
  for (; j < b.length; j += 1) {
    const token = b[j]
    if (token !== undefined) newRanges.push([token.start, token.start + token.text.length])
  }
  return { old: merge(oldRanges), next: merge(newRanges) }
}
