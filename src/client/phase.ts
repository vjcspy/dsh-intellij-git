/**
 * Phase copy of the running write, derived from `busy`.
 *
 * Every control that shows progress reads the same descriptor through this one
 * helper, so the bar, the running button, the dialog and the "wait for ..."
 * tooltips can never name different phases.
 */
import { useEffect, useState } from 'react'

import type { DshIntellijGitKey, Translate } from './locale.ts'
import type { BusyKind, BusyState } from './store.ts'

/** Seconds a write runs before its elapsed time is shown. */
const ELAPSED_AFTER_SECONDS = 3

const PHASE_KEYS: Record<BusyKind, DshIntellijGitKey> = {
  commit: 'phase.commit',
  commitPush: 'phase.commitPush',
  push: 'phase.push',
  rebase: 'phase.rebase',
  merge: 'phase.merge',
  rollback: 'phase.rollback',
  revertHunk: 'phase.revertHunk',
  switchBranch: 'phase.switchBranch',
}

/** The phase text of a running write, and the same text with elapsed seconds once it is slow. */
export interface PhaseText {
  readonly text: string
  readonly label: string
}

/**
 * Describe the running write.
 * @param t - the locale seat.
 * @param busy - the busy descriptor, or null.
 * @returns the phase text, or null when nothing runs.
 */
export function usePhase(t: Translate, busy: BusyState | null): PhaseText | null {
  const [now, setNow] = useState(() => Date.now())
  const startedAt = busy?.startedAt ?? null
  useEffect(() => {
    if (startedAt === null) return undefined
    setNow(Date.now())
    const timer = setInterval(() => { setNow(Date.now()) }, 1000)
    return () => { clearInterval(timer) }
  }, [startedAt])
  if (busy === null) return null
  const text = t(PHASE_KEYS[busy.kind], busy.params ?? {})
  const seconds = Math.floor((now - busy.startedAt) / 1000)
  return { text, label: seconds >= ELAPSED_AFTER_SECONDS ? t('phase.elapsed', { phase: text, seconds }) : text }
}
