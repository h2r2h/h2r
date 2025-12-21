import pino from 'pino';

const isProduction = process.env.NODE_ENV === 'production';
const isTTY = process.stdout.isTTY;

const EXCLUDED_PATHS = new Set(['/health', '/healthz', '/livez', '/readyz', '/metrics']);

export interface LoggerOptions {
  level?: string;
  name?: string;
}

export function createLogger(options: LoggerOptions = {}): pino.Logger {
  const level = options.level || process.env.LOG_LEVEL || 'info';

  if (!isProduction && isTTY) {
    return pino({
      level,
      name: options.name,
      transport: {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:standard',
          ignore: 'pid,hostname',
        },
      },
    });
  }

  return pino({
    level,
    name: options.name,
    formatters: {
      level: (label) => ({ level: label }),
    },
    timestamp: () => `,"timestamp":"${new Date().toISOString()}"`,
    messageKey: 'message',
  });
}

export function shouldLogRequest(path: string, statusCode: number): boolean {
  if (EXCLUDED_PATHS.has(path)) {
    return statusCode !== 200 && statusCode !== 404;
  }
  return true;
}

export const logger = createLogger({ name: 'h2r' });
