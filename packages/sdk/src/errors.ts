import type { PublicApiErrorCode } from './types';

/**
 * Error thrown when the Syra API returns a non-2xx response.
 */
export class SyraApiError extends Error {
  /** HTTP status code returned by the API. */
  readonly status: number;
  /** The machine-readable code, when the route answered with a structured public-API error. */
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

/**
 * Error thrown when a 2xx response from the Syra API does not have the shape
 * this SDK promises its caller — a required field missing, a field of the wrong
 * type. It is not an `SyraApiError`: the request succeeded, the payload did not.
 */
export class SyraResponseError extends Error {
  /** The SDK method whose response failed, e.g. `getPodcast`. */
  readonly method: string;
  /** Where in the response the check failed (`['coverArtSizes', 'small', 'url']`). */
  readonly path: (string | number)[];

  constructor(method: string, path: (string | number)[], message: string) {
    super(message);
    this.name = 'SyraResponseError';
    this.method = method;
    this.path = path;
    Object.setPrototypeOf(this, SyraResponseError.prototype);
  }
}
