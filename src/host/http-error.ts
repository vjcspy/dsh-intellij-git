/**
 * One error type the handlers throw and the route wrapper turns into a JSON
 * envelope with the intended status code.
 */
import type { ApiErrorBody } from '../config.ts'

/** A failure that already carries the HTTP status and body the client should see. */
export class ApiHttpError extends Error {
  /** HTTP status to answer with. */
  readonly status: number
  /** Error envelope body. */
  readonly body: ApiErrorBody

  /**
   * @param status - HTTP status.
   * @param body - error envelope.
   */
  constructor(status: number, body: ApiErrorBody) {
    super(body.message)
    this.name = 'ApiHttpError'
    this.status = status
    this.body = body
  }
}
