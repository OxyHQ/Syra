import type { PublicApiErrorCode } from '@syra.fm/contracts';
/**
 * Error thrown when the Syra API returns a non-2xx response.
 */
export class SyraApiError extends Error {
  /** HTTP status code returned by the API. */
  readonly status: number;
  readonly code?: PublicApiErrorCode;

  constructor(status: number, message: string, code?: PublicApiErrorCode) {
    super(message);
    this.name = 'SyraApiError';
    this.status = status;
    this.code = code;
    // Restore the prototype chain when targeting ES5-ish runtimes.
    Object.setPrototypeOf(this, SyraApiError.prototype);
  }
}
