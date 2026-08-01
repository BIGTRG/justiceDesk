/**
 * Authentication and authorisation.
 *
 * Clerk verifies the session JWT; this module maps it onto a JusticeDesk user row and
 * enforces ownership. Authorisation is deliberately not left to individual handlers:
 * `loadCase` is the only way a route obtains a case, and it will not return one the
 * caller does not own.
 */

import { verifyToken } from '@clerk/backend'
import { HttpError } from '@justicedesk/service-kit'
import type { CaseRecord, UserRole } from '@justicedesk/shared'
import type { NextFunction, Request, RequestHandler, Response } from 'express'
import type pg from 'pg'

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: { userId: string; clerkUserId: string; role: UserRole }
    }
  }
}

export interface AuthDeps {
  db: pg.Pool
  clerkSecretKey: string
}

/**
 * Verify the bearer token and resolve it to a local user row, creating one on first
 * sign-in. Clerk owns identity; we own the case data hanging off it.
 */
export function requireAuth(deps: AuthDeps): RequestHandler {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      const header = req.header('authorization')
      if (!header?.startsWith('Bearer ')) {
        throw HttpError.unauthorized()
      }

      const payload = await verifyToken(header.slice(7), { secretKey: deps.clerkSecretKey }).catch(
        () => {
          throw HttpError.unauthorized('Your session has expired. Please sign in again.')
        }
      )

      const clerkUserId = payload.sub
      if (!clerkUserId) throw HttpError.unauthorized()

      const { rows } = await deps.db.query<{ id: string; role: UserRole }>(
        `INSERT INTO users (clerk_user_id, phone, email)
         VALUES ($1, $2, $3)
         ON CONFLICT (clerk_user_id) DO UPDATE SET clerk_user_id = EXCLUDED.clerk_user_id
         RETURNING id, role`,
        [
          clerkUserId,
          typeof payload.phone_number === 'string' ? payload.phone_number : null,
          typeof payload.email === 'string' ? payload.email : null,
        ]
      )

      const user = rows[0]
      if (!user) throw HttpError.internal()

      req.auth = { userId: user.id, clerkUserId, role: user.role }
      next()
    } catch (err) {
      next(err)
    }
  }
}

/** Gate admin-only routes. */
export function requireRole(...roles: UserRole[]): RequestHandler {
  return (req, _res, next) => {
    if (!req.auth) return next(HttpError.unauthorized())
    if (!roles.includes(req.auth.role)) {
      return next(HttpError.forbidden('You do not have access to this area.'))
    }
    next()
  }
}

export interface CaseRow extends CaseRecord {
  definition: unknown
  jurisdictionKey: string
  timeZone: string
  caseTypeKey: string
}

/**
 * Load a case the caller is allowed to see.
 *
 * Returns 404, not 403, for a case belonging to someone else — a 403 confirms the case
 * exists, which leaks that a given person is being sued.
 */
export async function loadCase(db: pg.Pool, req: Request, caseId: string): Promise<CaseRow> {
  if (!req.auth) throw HttpError.unauthorized()

  const { rows } = await db.query(
    `SELECT c.id, c.user_id AS "userId", c.case_type_id AS "caseTypeId",
            c.jurisdiction_id AS "jurisdictionId", c.workflow_definition_id AS "workflowDefinitionId",
            c.court_case_number AS "courtCaseNumber", c.role, c.status,
            c.current_stage_key AS "currentStageKey", c.opened_at AS "openedAt",
            c.closed_at AS "closedAt", c.outcome, c.metadata,
            wd.definition,
            j.key AS "jurisdictionKey", j.time_zone AS "timeZone",
            ct.key AS "caseTypeKey"
       FROM cases c
       JOIN workflow_definitions wd ON wd.id = c.workflow_definition_id
       JOIN jurisdictions j ON j.id = c.jurisdiction_id
       JOIN case_types ct ON ct.id = c.case_type_id
      WHERE c.id = $1`,
    [caseId]
  )

  const row = rows[0] as CaseRow | undefined
  if (!row) throw HttpError.notFound('We could not find that case.')

  const isOwner = row.userId === req.auth.userId
  const isAdmin = req.auth.role === 'admin'
  if (!isOwner && !isAdmin) throw HttpError.notFound('We could not find that case.')

  return row
}
