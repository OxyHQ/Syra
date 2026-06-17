import pino from 'pino';

const level = process.env.LOG_LEVEL ?? (process.env.NODE_ENV === 'production' ? 'info' : 'debug');
const isProduction = process.env.NODE_ENV === 'production';

const pinoLogger = pino({
  level,
  ...(isProduction
    ? {}
    : {
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'SYS:HH:MM:ss.l',
            ignore: 'pid,hostname',
          },
        },
      }),
});

function formatArgs(args: unknown[]): Record<string, unknown> | undefined {
  if (args.length === 0) return undefined;
  if (args.length === 1 && typeof args[0] === 'object' && args[0] !== null) {
    return args[0] as Record<string, unknown>;
  }
  return { data: args };
}

export const logger = {
  info: (message: string, ...args: unknown[]) => {
    const obj = formatArgs(args);
    if (obj) {
      pinoLogger.info(obj, message);
    } else {
      pinoLogger.info(message);
    }
  },
  warn: (message: string, ...args: unknown[]) => {
    const obj = formatArgs(args);
    if (obj) {
      pinoLogger.warn(obj, message);
    } else {
      pinoLogger.warn(message);
    }
  },
  error: (message: string, ...args: unknown[]) => {
    const obj = formatArgs(args);
    if (obj) {
      pinoLogger.error(obj, message);
    } else {
      pinoLogger.error(message);
    }
  },
  debug: (message: string, ...args: unknown[]) => {
    const obj = formatArgs(args);
    if (obj) {
      pinoLogger.debug(obj, message);
    } else {
      pinoLogger.debug(message);
    }
  },
};
