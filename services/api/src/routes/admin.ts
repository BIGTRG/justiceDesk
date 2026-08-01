/**
 * Admin surface: pricing board, workflow editor, template manager, UPL review queue.
 *
 * Every route here is admin-only and audited. The two that can affect a live litigant —
 * publishing a workflow and publishing a plan — validate before they write, because the
 * blast radius of a broken publish is every case opened afterwards.
 */

import { asyncHandler, HttpError } from '@justicedesk/service-kit'
import { validateWorkflowDefinition, type WorkflowDefinition } from '@justicedesk/shared'
import { Router } from 'express'
import type pg from 'pg'
import { auditFromRequest } from '../audit.js'

export function createAdminRoutes(db: pg.Pool): Router {
  const router = Router()

  // ---------------------------------------------------------------- pricing board

  router.get(
    '/plans',
    asyncHandler(async (_req, res) => {
      const { rows } = await db.query(
        `SELECT p.id, p.kind, p.name, p.price_cents AS "priceCents", p.status,
                p.stripe_price_id AS "stripePriceId", p.created_at AS "createdAt",
                ct.key AS "caseTypeKey",
                (SELECT count(*) FROM subscriptions s WHERE s.plan_id = p.id) AS "subscriberCount"
           FROM plans p JOIN case_types ct ON ct.id = p.case_type_id
          ORDER BY ct.key, p.kind, p.created_at DESC`
      )
      res.json({ plans: rows })
    })
  )

  /**
   * Change a price.
   *
   * A live plan's price is frozen in the database, so this always publishes a NEW plan
   * row and supersedes the old one rather than editing in place. Existing subscribers
   * stay pinned to the row they signed up on.
   */
  router.post(
    '/plans',
    asyncHandler(async (req, res) => {
      const body = req.body as Record<string, unknown>
      const caseTypeKey = String(body.caseTypeKey ?? '')
      const kind = String(body.kind ?? '')
      const priceCents = Number(body.priceCents)
      const name = String(body.name ?? '').slice(0, 200)
      const publish = body.publish === true

      if (!['monthly', 'one_shot'].includes(kind)) {
        throw HttpError.badRequest('"kind" must be "monthly" or "one_shot".')
      }
      if (!Number.isInteger(priceCents) || priceCents < 0) {
        throw HttpError.badRequest('"priceCents" must be a whole number of cents, zero or more.')
      }
      if (!name) throw HttpError.badRequest('"name" is required.')

      const client = await db.connect()
      try {
        await client.query('BEGIN')

        const { rows: caseTypes } = await client.query(`SELECT id FROM case_types WHERE key = $1`, [
          caseTypeKey,
        ])
        const caseType = caseTypes[0]
        if (!caseType) throw HttpError.badRequest(`Unknown case type "${caseTypeKey}".`)

        // Retire the incumbent first — the partial unique index allows only one live plan
        // per (case type, kind), so publishing without this would violate it.
        let supersededId: string | null = null
        if (publish) {
          const { rows: current } = await client.query<{ id: string }>(
            `UPDATE plans SET status = 'draft'
              WHERE case_type_id = $1 AND kind = $2::plan_kind AND status = 'live'
              RETURNING id`,
            [caseType.id, kind]
          )
          supersededId = current[0]?.id ?? null
        }

        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO plans (case_type_id, kind, price_cents, name, status)
           VALUES ($1, $2::plan_kind, $3, $4, $5::plan_status)
           RETURNING id`,
          [caseType.id, kind, priceCents, name, publish ? 'live' : 'draft']
        )
        const newId = rows[0]!.id

        if (supersededId) {
          await client.query(`UPDATE plans SET superseded_by = $2 WHERE id = $1`, [supersededId, newId])
        }

        await auditFromRequest(client, req, {
          action: 'plan.change',
          entity: 'plans',
          entityId: newId,
          metadata: { caseTypeKey, kind, priceCents, published: publish, supersededId },
        })
        await client.query('COMMIT')

        res.status(201).json({
          planId: newId,
          published: publish,
          supersededId,
          note: 'Existing subscribers keep the price they signed up on.',
        })
      } catch (err) {
        await client.query('ROLLBACK')
        throw err
      } finally {
        client.release()
      }
    })
  )

  // ---------------------------------------------------------------- workflow editor

  router.get(
    '/workflows',
    asyncHandler(async (_req, res) => {
      const { rows } = await db.query(
        `SELECT wd.id, wd.version, wd.status, wd.verification, wd.published_at AS "publishedAt",
                ct.key AS "caseTypeKey", j.key AS "jurisdictionKey",
                (SELECT count(*) FROM cases c WHERE c.workflow_definition_id = wd.id) AS "caseCount"
           FROM workflow_definitions wd
           JOIN case_types ct ON ct.id = wd.case_type_id
           JOIN jurisdictions j ON j.id = wd.jurisdiction_id
          ORDER BY ct.key, j.key, wd.version DESC`
      )
      res.json({ workflows: rows })
    })
  )

  router.get(
    '/workflows/:id',
    asyncHandler(async (req, res) => {
      const { rows } = await db.query(
        `SELECT id, version, status, definition, verification FROM workflow_definitions WHERE id = $1`,
        [req.params.id]
      )
      if (!rows[0]) throw HttpError.notFound('No such workflow definition.')

      const validation = validateWorkflowDefinition(rows[0].definition as WorkflowDefinition)
      res.json({ workflow: rows[0], validation })
    })
  )

  /** Validate a definition without saving — powers the JSON editor's live check. */
  router.post(
    '/workflows/validate',
    asyncHandler(async (req, res) => {
      const definition = (req.body as Record<string, unknown>).definition as WorkflowDefinition
      if (!definition || typeof definition !== 'object') {
        throw HttpError.badRequest('"definition" must be a workflow definition object.')
      }
      res.json({ validation: validateWorkflowDefinition(definition) })
    })
  )

  /**
   * Publish a new version.
   *
   * Refuses on any validation error. Warnings (including every unverified citation) do
   * not block, but they are returned so the publisher sees exactly what is still pending
   * counsel before they make it live.
   */
  router.post(
    '/workflows/publish',
    asyncHandler(async (req, res) => {
      const body = req.body as Record<string, unknown>
      const definition = body.definition as WorkflowDefinition
      if (!definition) throw HttpError.badRequest('"definition" is required.')

      const validation = validateWorkflowDefinition(definition)
      if (!validation.valid) {
        throw HttpError.badRequest('This workflow has errors and cannot be published.', validation.errors)
      }

      const client = await db.connect()
      try {
        await client.query('BEGIN')

        const { rows: ids } = await client.query(
          `SELECT ct.id AS case_type_id, j.id AS jurisdiction_id
             FROM case_types ct, jurisdictions j
            WHERE ct.key = $1 AND j.key = $2`,
          [definition.caseTypeKey, definition.jurisdictionKey]
        )
        const target = ids[0]
        if (!target) throw HttpError.badRequest('Unknown case type or jurisdiction.')

        const { rows: versions } = await client.query<{ next: number }>(
          `SELECT COALESCE(MAX(version), 0) + 1 AS next
             FROM workflow_definitions WHERE case_type_id = $1 AND jurisdiction_id = $2`,
          [target.case_type_id, target.jurisdiction_id]
        )
        const version = versions[0]!.next

        // Retire the incumbent: one live version per case type and jurisdiction.
        await client.query(
          `UPDATE workflow_definitions SET status = 'draft'
            WHERE case_type_id = $1 AND jurisdiction_id = $2 AND status = 'live'`,
          [target.case_type_id, target.jurisdiction_id]
        )

        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO workflow_definitions
             (case_type_id, jurisdiction_id, version, status, definition, verification,
              published_at, published_by)
           VALUES ($1, $2, $3, 'live', $4::jsonb, $5::jsonb, now(), $6)
           RETURNING id`,
          [
            target.case_type_id,
            target.jurisdiction_id,
            version,
            JSON.stringify({ ...definition, version, status: 'live' }),
            JSON.stringify(definition.verification ?? { status: 'unverified' }),
            req.auth!.userId,
          ]
        )

        await auditFromRequest(client, req, {
          action: 'admin.workflow_publish',
          entity: 'workflow_definitions',
          entityId: rows[0]!.id,
          metadata: {
            caseTypeKey: definition.caseTypeKey,
            jurisdictionKey: definition.jurisdictionKey,
            version,
            warningCount: validation.warnings.length,
          },
        })
        await client.query('COMMIT')

        res.status(201).json({
          workflowDefinitionId: rows[0]!.id,
          version,
          warnings: validation.warnings,
          note: 'Cases already open stay on the version they started with.',
        })
      } catch (err) {
        await client.query('ROLLBACK')
        throw err
      } finally {
        client.release()
      }
    })
  )

  // ---------------------------------------------------------------- templates

  router.get(
    '/templates',
    asyncHandler(async (_req, res) => {
      const { rows } = await db.query(
        `SELECT dt.id, dt.key, dt.name, dt.source, dt.form_pdf_minio_key AS "formPdfMinioKey",
                dt.field_map AS "fieldMap", dt.verification, dt.active,
                ct.key AS "caseTypeKey", j.key AS "jurisdictionKey"
           FROM document_templates dt
           JOIN case_types ct ON ct.id = dt.case_type_id
           JOIN jurisdictions j ON j.id = dt.jurisdiction_id
          ORDER BY ct.key, dt.key`
      )
      res.json({ templates: rows })
    })
  )

  /** Update a template's field map — the AOC form field mapping step. */
  router.patch(
    '/templates/:id',
    asyncHandler(async (req, res) => {
      const body = req.body as Record<string, unknown>
      const fieldMap = body.fieldMap as Record<string, string> | undefined
      const verification = body.verification as Record<string, unknown> | undefined

      if (fieldMap) {
        const placeholders = Object.entries(fieldMap).filter(([, v]) => String(v).startsWith('PLACEHOLDER_'))
        const markingVerified = (verification?.status as string) === 'attorney_verified'
        if (placeholders.length && markingVerified) {
          // The trap: a template flipped to verified while its field map is still guesses
          // would produce an official-looking, wrongly-filled court form.
          throw HttpError.badRequest(
            'This template still has placeholder PDF field names and cannot be marked verified.',
            { placeholderFields: placeholders.map(([k]) => k) }
          )
        }
      }

      const { rows } = await db.query(
        `UPDATE document_templates
            SET field_map = COALESCE($2::jsonb, field_map),
                verification = COALESCE($3::jsonb, verification),
                active = COALESCE($4, active)
          WHERE id = $1
          RETURNING id, key, verification`,
        [
          req.params.id,
          fieldMap ? JSON.stringify(fieldMap) : null,
          verification ? JSON.stringify(verification) : null,
          typeof body.active === 'boolean' ? body.active : null,
        ]
      )
      if (!rows[0]) throw HttpError.notFound('No such template.')

      await auditFromRequest(db, req, {
        action: 'admin.template_upload',
        entity: 'document_templates',
        entityId: req.params.id!,
        metadata: { fieldsUpdated: fieldMap ? Object.keys(fieldMap).length : 0 },
      })

      res.json({ template: rows[0] })
    })
  )

  // ---------------------------------------------------------------- UPL review queue

  router.get(
    '/upl-flags',
    asyncHandler(async (req, res) => {
      const onlyUnreviewed = req.query.reviewed !== 'true'
      const { rows } = await db.query(
        `SELECT f.id, f.code, f.severity, f.reason, f.excerpt, f.blocked, f.reviewed,
                f.created_at AS "createdAt", f.message_index AS "messageIndex",
                f.conversation_id AS "conversationId",
                c.case_id AS "caseId"
           FROM upl_flags f
           JOIN ai_conversations c ON c.id = f.conversation_id
          WHERE ($1 = FALSE OR f.reviewed = FALSE)
          ORDER BY f.blocked DESC, f.created_at DESC
          LIMIT 200`,
        [onlyUnreviewed]
      )
      res.json({ flags: rows })
    })
  )

  router.post(
    '/upl-flags/:id/review',
    asyncHandler(async (req, res) => {
      const notes = String((req.body as Record<string, unknown>).notes ?? '').slice(0, 2000)

      const { rows } = await db.query(
        `UPDATE upl_flags
            SET reviewed = TRUE, reviewer_id = $2, reviewed_at = now(), review_notes = $3
          WHERE id = $1
          RETURNING id, code`,
        [req.params.id, req.auth!.userId, notes]
      )
      if (!rows[0]) throw HttpError.notFound('No such flag.')

      await auditFromRequest(db, req, {
        action: 'admin.upl_review',
        entity: 'upl_flags',
        entityId: req.params.id!,
        metadata: { code: rows[0].code },
      })

      res.json({ reviewed: true })
    })
  )

  return router
}
