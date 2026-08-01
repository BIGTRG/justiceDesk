/**
 * Structured logging for ELK.
 *
 * Two rules this enforces rather than documents:
 *   1. Every line is redacted through `redactSecrets` before it leaves the process.
 *   2. PHI-style personal detail is not logged. This product's users are people being
 *      sued; a log line naming them and their case type is sensitive on its own, so the
 *      logger takes IDs, not names, addresses, or document contents.
 */

import { redactSecrets } from '@justicedesk/shared'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

/** Field names that must never appear in a log line, whatever a caller passes. */
const FORBIDDEN_FIELDS = new Set([
  'name',
  'full_name',
  'fullName',
  'email',
  'phone',
  'address',
  'mailing_address',
  'mailingAddress',
  'answers',
  'messages',
  'content',
  'text',
  'body',
  'password',
  'token',
  'apiKey',
  'api_key',
  'secret',
])

export interface LogContext {
  [key: string]: unknown
}

function scrub(context: LogContext): LogContext {
  const out: LogContext = {}
  for (const [key, value] of Object.entries(context)) {
    if (FORBIDDEN_FIELDS.has(key)) {
      out[key] = '[OMITTED]'
      continue
    }
    if (value instanceof Error) {
      out[key] = { name: value.name, message: redactSecrets(value.message) }
      continue
    }
    if (typeof value === 'string') {
      out[key] = redactSecrets(value)
      continue
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      out[key] = scrub(value as LogContext)
      continue
    }
    out[key] = value
  }
  return out
}

export interface Logger {
  debug(message: string, context?: LogContext): void
  info(message: string, context?: LogContext): void
  warn(message: string, context?: LogContext): void
  error(message: string, context?: LogContext): void
  child(bindings: LogContext): Logger
}

export function createLogger(service: string, bindings: LogContext = {}): Logger {
  const threshold = LEVELS[(process.env.LOG_LEVEL as LogLevel) ?? 'info'] ?? LEVELS.info

  function emit(level: LogLevel, message: string, context: LogContext = {}): void {
    if (LEVELS[level] < threshold) return
    const line = {
      '@timestamp': new Date().toISOString(),
      level,
      service,
      env: process.env.NODE_ENV ?? 'development',
      message: redactSecrets(message),
      ...scrub({ ...bindings, ...context }),
    }
    const stream = level === 'error' || level === 'warn' ? process.stderr : process.stdout
    stream.write(`${JSON.stringify(line)}\n`)
  }

  return {
    debug: (m, c) => emit('debug', m, c),
    info: (m, c) => emit('info', m, c),
    warn: (m, c) => emit('warn', m, c),
    error: (m, c) => emit('error', m, c),
    child: (extra) => createLogger(service, { ...bindings, ...extra }),
  }
}
