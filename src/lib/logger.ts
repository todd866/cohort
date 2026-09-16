/**
 * Structured Logger
 *
 * Environment-aware logging that outputs JSON in production (for log aggregators)
 * and human-readable format in development.
 *
 * Usage:
 *   import { logger } from '@/lib/logger';
 *   logger.info('Processing queue', { userId, rotation });
 *   logger.warn('Fallback triggered', { error: error.message });
 *   logger.error('Operation failed', { error, context: { userId, cardId } });
 */

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogContext {
  [key: string]: unknown;
}

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const MIN_LEVEL = process.env.LOG_LEVEL
  ? (process.env.LOG_LEVEL as LogLevel)
  : process.env.NODE_ENV === 'production'
    ? 'info'
    : 'debug';

const IS_PRODUCTION = process.env.NODE_ENV === 'production';

function shouldLog(level: LogLevel): boolean {
  return LOG_LEVELS[level] >= LOG_LEVELS[MIN_LEVEL];
}

function formatMessage(level: LogLevel, message: string, context?: LogContext): string {
  const timestamp = new Date().toISOString();

  if (IS_PRODUCTION) {
    // JSON format for log aggregators (Vercel, Datadog, etc.)
    return JSON.stringify({
      timestamp,
      level,
      message,
      ...context,
    });
  }

  // Human-readable format for development
  const contextStr = context ? ` ${JSON.stringify(context)}` : '';
  return `[${timestamp}] ${level.toUpperCase()}: ${message}${contextStr}`;
}

function log(level: LogLevel, message: string, context?: LogContext): void {
  if (!shouldLog(level)) return;

  const formatted = formatMessage(level, message, context);

  switch (level) {
    case 'debug':
    case 'info':
      console.log(formatted);
      break;
    case 'warn':
      console.warn(formatted);
      break;
    case 'error':
      console.error(formatted);
      break;
  }
}

export const logger = {
  debug: (message: string, context?: LogContext) => log('debug', message, context),
  info: (message: string, context?: LogContext) => log('info', message, context),
  warn: (message: string, context?: LogContext) => log('warn', message, context),
  error: (message: string, context?: LogContext) => log('error', message, context),
};

export default logger;
