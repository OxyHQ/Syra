/**
 * Environment-aware logging utility.
 * Provides controlled logging based on environment and log levels.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LoggerFunction {
  (message: string, ...args: unknown[]): void;
}

export interface Logger {
  info: LoggerFunction;
  warn: LoggerFunction;
  error: LoggerFunction;
  debug: LoggerFunction;
}

const PREFIX = '[Studio]';

const LOG_LEVEL: LogLevel = (process.env.LOG_LEVEL as LogLevel) || 'info';
const isProduction = process.env.NODE_ENV === 'production';

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

function shouldLog(level: LogLevel): boolean {
  // In production, only log warnings and errors unless LOG_LEVEL is explicitly set.
  if (isProduction && !process.env.LOG_LEVEL) {
    return level === 'warn' || level === 'error';
  }
  return LOG_LEVELS[level] >= LOG_LEVELS[LOG_LEVEL];
}

/**
 * Create a scoped logger with a custom prefix.
 */
export function createScopedLogger(scope: string): Logger {
  const scopePrefix = `[${scope}]`;
  return {
    info: (message: string, ...args: unknown[]) => {
      if (shouldLog('info')) {
        console.log(`${PREFIX} ${scopePrefix} [INFO] ${message}`, ...args);
      }
    },
    warn: (message: string, ...args: unknown[]) => {
      if (shouldLog('warn')) {
        console.warn(`${PREFIX} ${scopePrefix} [WARN] ${message}`, ...args);
      }
    },
    error: (message: string, ...args: unknown[]) => {
      console.error(`${PREFIX} ${scopePrefix} [ERROR] ${message}`, ...args);
    },
    debug: (message: string, ...args: unknown[]) => {
      if (shouldLog('debug')) {
        console.debug(`${PREFIX} ${scopePrefix} [DEBUG] ${message}`, ...args);
      }
    },
  };
}

export const logger = createScopedLogger('app');
