/**
 * The one place a branch name becomes display copy.
 *
 * The badge in the page header and the branch text on the active repository row
 * both render this, so the detached state cannot read one way in one place and
 * another way in the other. `RepoStatusResponse.branch` carries porcelain's
 * literal `(detached)` sentinel and is never rendered raw.
 */
import type { RepoStatusResponse } from '../config.ts'
import type { Translate } from './locale.ts'

/**
 * The label of the branch a status was read from.
 * @param status - the loaded status, or the slice the caller has.
 * @param t - the locale seat.
 * @returns the branch name, or the detached label carrying the short SHA.
 */
export function branchLabelOf(
  status: Pick<RepoStatusResponse, 'branch' | 'detached' | 'headShortSha'>,
  t: Translate,
): string {
  return status.detached ? t('branch.detachedLabel', { sha: status.headShortSha }) : status.branch
}
