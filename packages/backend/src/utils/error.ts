import { describeDriverError } from '@oxyhq/db';
import { isDriverError } from '../db/postgres';

export class ApiError extends Error {
    statusCode: number;

    constructor(statusCode: number, message: string) {
        super(message);
        this.statusCode = statusCode;
        this.name = 'ApiError';
    }
}

export const createError = (statusCode: number, message: string) => {
    return new ApiError(statusCode, message);
};

/** Safely extract a string message from an unknown catch value. */
export function getErrorMessage(error: unknown): string {
    if (error instanceof Error) return error.message;
    return String(error);
}

/** Safely extract a stack trace from an unknown catch value. */
export function getErrorStack(error: unknown): string | undefined {
    if (error instanceof Error) return error.stack;
    return undefined;
}

/**
 * A catch value rendered safely for a log field or a response body.
 *
 * Route handlers overwhelmingly do two things with a caught error: put it in a
 * `logger.error` field, and put its `.message` in the JSON they return. Both
 * were harmless while the errors came from Mongoose. They stopped being harmless
 * when the handlers started issuing SQL: a postgres.js error carries `query`,
 * `params` and `detail`, so `logger.error(msg, { error })` writes the whole
 * statement and every bound parameter into the log, and `.message` can carry a
 * `detail` string built from the offending ROW.
 *
 * So a driver error is reduced to `describeDriverError`'s redacted form — code
 * and constraint, no payload — and everything else keeps its message, because
 * for a non-database failure the message is the only thing worth having. That
 * is the same test `db/postgres.ts` documents at length for {@link isDriverError}:
 * the PAYLOAD, never `sqlStateOf(err) !== undefined`, which is true of any error
 * carrying a five-character `code` and would report an `ENOSPC` as the database
 * refusing the write with its real reason discarded.
 */
export function describeErrorSafely(error: unknown): string {
    if (!isDriverError(error)) return getErrorMessage(error);

    // `describeDriverError` returns the redacted SHAPE — `{ kind, code?,
    // constraint? }` — which is right for a structured log field and wrong for
    // the `error: string` these handlers have always returned. Rendered rather
    // than spread, so the response contract does not change and no field can be
    // added to that object later and land in a response body unnoticed.
    const { kind, code, constraint } = describeDriverError(error);
    return [kind, code, constraint].filter(Boolean).join(' ');
}

/**
 * Safely extract an HTTP status code from an unknown catch value.
 * Checks ApiError.statusCode, generic .statusCode, .status in that order.
 */
export function getHttpStatus(error: unknown, fallback = 500): number {
    if (error instanceof ApiError) return error.statusCode;
    if (error !== null && typeof error === 'object') {
        const e = error as Record<string, unknown>;
        if (typeof e['statusCode'] === 'number') return e['statusCode'];
        if (typeof e['status'] === 'number') return e['status'];
    }
    return fallback;
} 