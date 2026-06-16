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