/**
 * The audit trail.
 *
 * Non-negotiable #1 from the spec: every document view and download is written here.
 * The table is append-only at the database level (db/migrations/0002_audit_worm.sql), so
 * a bug in this file cannot rewrite history — only fail to add to it.
 *
 * That failure mode is the one this file is careful about: `recordAudit` is awaited
 * BEFORE the side effect it describes (issuing a signed URL, finalising a document). If
 * the audit write fails, the action does not happen. An unlogged document access is
 * exactly what the WORM requirement exists to prevent, so availability loses here.
 */

import type { AuditedAction } from '@justicedesk/shared'
import { documentAccess } from '@justicedesk/service-kit'
import type pg from 'pg'
import type { Request } from 'express'

export interface AuditEntry {
  actorId: string | null
  action: AuditedAction | (string & {})
  entity: string
  entityId: string | null
  ip?: string | null
  userAgent?: string | null
  metadata?: Record<string, unknown>
}

/**
 * Client IP, honouring a trusted proxy header.
 *
 * Express `trust proxy` is set in index.ts; without it `req.ip` returns the load
 * balancer for every request and the audit trail records the same address for everyone.
 */
export function clientIp(req: Request): string | null {
  return req.ip ?? null
}

export async function recordAudit(
  db: pg.Pool | pg.PoolClient,
  entry: AuditEntry
): Promise<void> {
  await db.query(
    `INSERT INTO audit_log (actor_id, action, entity, entity_id, ip, user_agent, metadata)
     VALUES ($1, $2, $3, $4, $5::inet, $6, $7::jsonb)`,
    [
      entry.actorId,
      entry.action,
      entry.entity,
      entry.entityId,
      entry.ip ?? null,
      entry.userAgent?.slice(0, 500) ?? null,
      JSON.stringify(entry.metadata ?? {}),
    ]
  )

  if (entry.action.startsWith('document.')) {
    documentAccess.inc({ action: entry.action.slice('document.'.length) })
  }
}

/** Convenience for route handlers: pull actor and request metadata off the request. */
export async function auditFromRequest(
  db: pg.Pool | pg.PoolClient,
  req: Request,
  entry: Omit<AuditEntry, 'actorId' | 'ip' | 'userAgent'>
): Promise<void> {
  await recordAudit(db, {
    ...entry,
    actorId: req.auth?.userId ?? null,
    ip: clientIp(req),
    userAgent: req.header('user-agent') ?? null,
  })
}
