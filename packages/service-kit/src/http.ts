/**
 * Express plumbing shared by every service: request IDs, async error capture, a typed
 * error class, and a terminal error handler that never leaks internals to a caller.
 */

import { randomUUID } from 'node:crypto'
import type { NextFunction, Request, RequestHandler, Response } from 'express'
import type { Logger } from './logger.js'

// Augment the Express namespace rather than express-serve-static-core directly — the
// latter's module name differs between @types/express v4 and v5.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      id: string
      log: Logger
    }
  }
}

export class HttpError extends Error {
  readonly status: number
  readonly code: string
  readonly details?: unknown

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message)
    this.name = 'HttpError'
    this.status = status
    this.code = code
    this.details = details
  }

  static badRequest(message: string, details?: unknown) {
    return new HttpError(400, 'bad_request', message, details)
  }
  static unauthorized(message = 'Sign in to continue.') {
    return new HttpError(401, 'unauthorized', message)
  }
  static forbidden(message = 'You do not have access to this.') {
    return new HttpError(403, 'forbidden', message)
  }
  static notFound(message = 'Not found.') {
    return new HttpError(404, 'not_found', message)
  }
  static conflict(message: string, details?: unknown) {
    return new HttpError(409, 'conflict', message, details)
  }
  static tooManyRequests(message = 'Too many requests. Please wait and try again.') {
    return new HttpError(429, 'rate_limited', message)
  }
  static internal(message = 'Something went wrong on our end.') {
    return new HttpError(500, 'internal_error', message)
  }
  static unavailable(message = 'This service is temporarily unavailable.') {
    return new HttpError(503, 'unavailable', message)
  }
}

/** Attach a request ID and a request-scoped logger. */
export function requestContext(logger: Logger): RequestHandler {
  return (req, res, next) => {
    const incoming = req.header('x-request-id')
    req.id = incoming && /^[\w-]{1,64}$/.test(incoming) ? incoming : randomUUID()
    req.log = logger.child({ requestId: req.id })
    res.setHeader('x-request-id', req.id)
    next()
  }
}

/** Wrap an async handler so a rejected promise reaches the error middleware. */
export function asyncHandler<T extends RequestHandler>(handler: T): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next)
  }
}

/**
 * Terminal error handler.
 *
 * A 5xx returns a generic message and the request ID — never a stack trace, a SQL error,
 * or an upstream provider message, any of which can carry data about other users.
 */
export function errorHandler() {
  return (err: unknown, req: Request, res: Response, _next: NextFunction): void => {
    if (err instanceof HttpError) {
      if (err.status >= 500) {
        req.log?.error('request failed', { code: err.code, status: err.status, err })
      } else {
        req.log?.warn('request rejected', { code: err.code, status: err.status })
      }
      res.status(err.status).json({
        error: { code: err.code, message: err.message, details: err.details, requestId: req.id },
      })
      return
    }

    req.log?.error('unhandled error', { err: err instanceof Error ? err : new Error(String(err)) })
    res.status(500).json({
      error: {
        code: 'internal_error',
        message: 'Something went wrong on our end. Please try again.',
        requestId: req.id,
      },
    })
  }
}

export function notFoundHandler() {
  return (req: Request, res: Response): void => {
    res.status(404).json({
      error: { code: 'not_found', message: `No route for ${req.method} ${req.path}.`, requestId: req.id },
    })
  }
}
