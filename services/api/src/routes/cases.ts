/**
 * Case, deadline, document and assistant routes — the litigant-facing API.
 */

import { asyncHandler, HttpError } from '@justicedesk/service-kit'
import {
  advance,
  assertValidWorkflowDefinition,
  getStage,
  isValidDate,
  type CaseMetadata,
  type ServiceMethod,
  type WorkflowDefinition,
} from '@justicedesk/shared'
import { Router } from 'express'
import type pg from 'pg'
import type { AiGatewayClient } from '../aiClient.js'
import { auditFromRequest } from '../audit.js'
import { loadCase } from '../auth.js'
import { buildCaseView, recordStageEvent, syncDeadlines } from '../caseService.js'
import type { Vault } from '../storage.js'

export interface CaseRouteDeps {
  db: pg.Pool
  vault: Vault
  ai: AiGatewayClient
  enqueueRender: (payload: { interviewId: string; caseId: string }) => Promise<void>
}

const SERVICE_METHODS: ServiceMethod[] = [
  'personal',
  'registered_mail',
  'certified_mail',
  'first_class_mail',
  'sheriff',
  'publication',
  'unknown',
]

export function createCaseRoutes(deps: CaseRouteDeps): Router {
  const router = Router()
  const { db } = deps

  // ------------------------------------------------------------------ intake

  router.post(
    '/v1/intake/classify',
    asyncHandler(async (req, res) => {
      const transcript = (req.body as Record<string, unknown>).transcript
      if (!Array.isArray(transcript)) throw HttpError.badRequest('"transcript" is required.')
      res.json(await deps.ai.classifyIntake(transcript as Array<{ role: string; content: string }>))
    })
  )

  /**
   * Summons OCR. The result is never written to the case here — the litigant confirms
   * every field on S4 first. An OCR misread that silently became a deadline anchor is the
   * highest-consequence bug this flow could have.
   */
  router.post(
    '/v1/intake/summons',
    asyncHandler(async (req, res) => {
      const body = req.body as Record<string, unknown>
      const imageBase64 = String(body.imageBase64 ?? '')
      if (!imageBase64) throw HttpError.badRequest('"imageBase64" is required.')

      const result = await deps.ai.readSummons({
        imageBase64,
        mediaType: String(body.mediaType ?? 'image/jpeg'),
      })
      res.json(result)
    })
  )

  // ------------------------------------------------------------------ cases

  router.get(
    '/v1/cases',
    asyncHandler(async (req, res) => {
      const { rows } = await db.query(
        `SELECT c.id, c.status, c.role, c.current_stage_key AS "currentStageKey",
                c.court_case_number AS "courtCaseNumber", c.opened_at AS "openedAt",
                ct.key AS "caseTypeKey", ct.name AS "caseTypeName"
           FROM cases c JOIN case_types ct ON ct.id = c.case_type_id
          WHERE c.user_id = $1
          ORDER BY c.opened_at DESC`,
        [req.auth!.userId]
      )
      res.json({ cases: rows })
    })
  )

  /**
   * Open a case. Pins the currently-live workflow definition (non-negotiable #3): the
   * version is captured here and the database refuses to move it afterwards.
   */
  router.post(
    '/v1/cases',
    asyncHandler(async (req, res) => {
      const body = req.body as Record<string, unknown>
      const caseTypeKey = String(body.caseTypeKey ?? '')
      const jurisdictionKey = String(body.jurisdictionKey ?? '')
      const role = body.role === 'plaintiff' ? 'plaintiff' : 'defendant'

      if (!caseTypeKey || !jurisdictionKey) {
        throw HttpError.badRequest('"caseTypeKey" and "jurisdictionKey" are required.')
      }

      const { rows: defs } = await db.query(
        `SELECT wd.id, wd.definition, ct.id AS case_type_id, j.id AS jurisdiction_id
           FROM workflow_definitions wd
           JOIN case_types ct ON ct.id = wd.case_type_id
           JOIN jurisdictions j ON j.id = wd.jurisdiction_id
          WHERE ct.key = $1 AND j.key = $2 AND wd.status = 'live'
          LIMIT 1`,
        [caseTypeKey, jurisdictionKey]
      )

      const def = defs[0]
      if (!def) {
        // Content exists but is unpublished while the compliance gate is closed.
        throw HttpError.conflict(
          'This case type is not available yet. The guidance for it is still being reviewed.'
        )
      }

      const definition = def.definition as WorkflowDefinition

      const client = await db.connect()
      try {
        await client.query('BEGIN')
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO cases (user_id, case_type_id, jurisdiction_id, workflow_definition_id,
                              role, status, current_stage_key, metadata)
           VALUES ($1, $2, $3, $4, $5::party_role, 'draft', $6, $7::jsonb)
           RETURNING id`,
          [
            req.auth!.userId,
            def.case_type_id,
            def.jurisdiction_id,
            def.id,
            role,
            definition.initialStageKey,
            JSON.stringify({ completedStageKeys: [] } satisfies CaseMetadata),
          ]
        )
        const caseId = rows[0]!.id

        await client.query(
          `INSERT INTO case_stage_events (case_id, stage_key, status) VALUES ($1, $2, 'current')`,
          [caseId, definition.initialStageKey]
        )
        await auditFromRequest(client, req, {
          action: 'case.create',
          entity: 'cases',
          entityId: caseId,
          metadata: { caseTypeKey, jurisdictionKey, role },
        })
        await client.query('COMMIT')

        res.status(201).json({ caseId })
      } catch (err) {
        await client.query('ROLLBACK')
        throw err
      } finally {
        client.release()
      }
    })
  )

  router.get(
    '/v1/cases/:caseId',
    asyncHandler(async (req, res) => {
      const row = await loadCase(db, req, req.params.caseId!)
      const view = buildCaseView(row)
      await syncDeadlines(db, row.id, view)

      res.json({
        case: {
          id: row.id,
          status: row.status,
          role: row.role,
          courtCaseNumber: row.courtCaseNumber,
          currentStageKey: row.currentStageKey,
          caseTypeKey: row.caseTypeKey,
          jurisdictionKey: row.jurisdictionKey,
          metadata: row.metadata,
        },
        overview: view.definition.overview,
        title: view.definition.title,
        today: view.today,
        timeline: view.timeline,
        nextAction: view.nextAction,
      })
    })
  )

  /**
   * Record confirmed case facts — the S4 confirm step and any later correction.
   *
   * Anchors are validated as real calendar dates here rather than trusted: a malformed
   * one reaching the deadline engine would either throw mid-render or, worse, parse into
   * a plausible wrong date.
   */
  router.post(
    '/v1/cases/:caseId/facts',
    asyncHandler(async (req, res) => {
      const row = await loadCase(db, req, req.params.caseId!)
      const body = req.body as Record<string, unknown>

      const metadata: CaseMetadata = { ...row.metadata }
      const anchors = { ...(metadata.anchors ?? {}) }

      if (body.anchors && typeof body.anchors === 'object') {
        for (const [key, value] of Object.entries(body.anchors as Record<string, unknown>)) {
          const date = String(value ?? '')
          if (!isValidDate(date)) {
            throw HttpError.badRequest(`"${key}" must be a date in YYYY-MM-DD form.`)
          }
          anchors[key] = date
        }
      }
      metadata.anchors = anchors

      if (body.serviceMethod !== undefined) {
        const method = String(body.serviceMethod) as ServiceMethod
        if (!SERVICE_METHODS.includes(method)) {
          throw HttpError.badRequest('Unrecognised service method.')
        }
        metadata.serviceMethod = method
      }
      if (typeof body.opposingParty === 'string') metadata.opposingParty = body.opposingParty.slice(0, 200)
      if (typeof body.courtName === 'string') metadata.courtName = body.courtName.slice(0, 200)

      const courtCaseNumber =
        typeof body.courtCaseNumber === 'string' ? body.courtCaseNumber.slice(0, 60) : row.courtCaseNumber

      await db.query(
        `UPDATE cases SET metadata = $2::jsonb, court_case_number = $3,
                          status = CASE WHEN status = 'draft' THEN 'active' ELSE status END
          WHERE id = $1`,
        [row.id, JSON.stringify(metadata), courtCaseNumber]
      )

      const updated = await loadCase(db, req, row.id)
      const view = buildCaseView(updated)
      const count = await syncDeadlines(db, row.id, view)

      await auditFromRequest(db, req, {
        action: 'case.facts_updated',
        entity: 'cases',
        entityId: row.id,
        metadata: { anchorKeys: Object.keys(anchors), deadlinesComputed: count },
      })

      res.json({ timeline: view.timeline, nextAction: view.nextAction, today: view.today })
    })
  )

  router.post(
    '/v1/cases/:caseId/advance',
    asyncHandler(async (req, res) => {
      const row = await loadCase(db, req, req.params.caseId!)
      const toStageKey = String((req.body as Record<string, unknown>).toStageKey ?? '')
      const definition = row.definition as WorkflowDefinition

      const completed = Array.isArray(row.metadata?.completedStageKeys)
        ? (row.metadata.completedStageKeys as string[])
        : []

      let result
      try {
        result = advance(
          definition,
          { currentStageKey: row.currentStageKey, completedStageKeys: completed, role: row.role },
          toStageKey,
          new Date().toISOString()
        )
      } catch (err) {
        // An illegal transition is a client bug, not a server error — say which moves are legal.
        throw HttpError.conflict((err as Error).message)
      }

      const metadata: CaseMetadata = {
        ...row.metadata,
        completedStageKeys: result.state.completedStageKeys,
      }

      const client = await db.connect()
      try {
        await client.query('BEGIN')
        await client.query(
          `UPDATE cases
              SET current_stage_key = $2,
                  metadata = $3::jsonb,
                  status = CASE WHEN $4 THEN 'closed' ELSE 'active' END,
                  closed_at = CASE WHEN $4 THEN now() ELSE closed_at END
            WHERE id = $1`,
          [row.id, result.state.currentStageKey, JSON.stringify(metadata), result.isTerminal]
        )
        await recordStageEvent(client, row.id, row.currentStageKey, result.state.currentStageKey)
        await auditFromRequest(client, req, {
          action: 'case.stage_advance',
          entity: 'cases',
          entityId: row.id,
          metadata: { from: row.currentStageKey, to: result.state.currentStageKey },
        })
        await client.query('COMMIT')
      } catch (err) {
        await client.query('ROLLBACK')
        throw err
      } finally {
        client.release()
      }

      const updated = await loadCase(db, req, row.id)
      const view = buildCaseView(updated)
      await syncDeadlines(db, row.id, view)

      res.json({
        currentStageKey: view.case.currentStageKey,
        isTerminal: result.isTerminal,
        timeline: view.timeline,
        nextAction: view.nextAction,
      })
    })
  )

  /** S15 close-out. */
  router.post(
    '/v1/cases/:caseId/close',
    asyncHandler(async (req, res) => {
      const row = await loadCase(db, req, req.params.caseId!)
      const outcome = String((req.body as Record<string, unknown>).outcome ?? '').slice(0, 200)

      await db.query(
        `UPDATE cases SET status = 'closed', closed_at = now(), outcome = $2 WHERE id = $1`,
        [row.id, outcome || null]
      )
      await db.query(`UPDATE deadlines SET status = 'waived' WHERE case_id = $1 AND status = 'pending'`, [
        row.id,
      ])
      await auditFromRequest(db, req, {
        action: 'case.close',
        entity: 'cases',
        entityId: row.id,
        metadata: { outcome },
      })

      const { rows: subs } = await db.query(
        `SELECT id, stripe_subscription_id AS "stripeSubscriptionId"
           FROM subscriptions WHERE case_id = $1 AND status = 'active'`,
        [row.id]
      )

      res.json({
        closed: true,
        // Drives the S15 prompt: an open subscription on a closed case should not keep billing.
        activeSubscriptions: subs,
      })
    })
  )

  // ------------------------------------------------------------------ deadlines

  router.get(
    '/v1/cases/:caseId/deadlines',
    asyncHandler(async (req, res) => {
      const row = await loadCase(db, req, req.params.caseId!)
      const view = buildCaseView(row)
      await syncDeadlines(db, row.id, view)

      const { rows } = await db.query(
        `SELECT id, rule_key AS "ruleKey", title, due_date AS "dueDate",
                rule_source AS "ruleSource", status, warnings, jurisdictional
           FROM deadlines WHERE case_id = $1 ORDER BY due_date`,
        [row.id]
      )
      res.json({ today: view.today, deadlines: rows })
    })
  )

  // ------------------------------------------------------------------ documents

  router.get(
    '/v1/cases/:caseId/documents',
    asyncHandler(async (req, res) => {
      const row = await loadCase(db, req, req.params.caseId!)
      const { rows } = await db.query(
        `SELECT id, kind, title, version, status, watermark, byte_size AS "byteSize",
                created_at AS "createdAt"
           FROM documents WHERE case_id = $1 ORDER BY created_at DESC`,
        [row.id]
      )
      res.json({ documents: rows })
    })
  )

  /**
   * Issue a download URL.
   *
   * POST, not GET: this has a side effect (an audit row) and must not be triggered by a
   * prefetch, a link crawler, or a browser preloading a page.
   */
  router.post(
    '/v1/cases/:caseId/documents/:documentId/download',
    asyncHandler(async (req, res) => {
      const row = await loadCase(db, req, req.params.caseId!)
      const intent = String((req.body as Record<string, unknown>).intent ?? 'download')
      const action = intent === 'print' ? 'document.print' : intent === 'view' ? 'document.view' : 'document.download'

      const { rows } = await db.query(
        `SELECT id, title, minio_key AS "minioKey", version, status
           FROM documents WHERE id = $1 AND case_id = $2`,
        [req.params.documentId, row.id]
      )
      const doc = rows[0]
      if (!doc) throw HttpError.notFound('We could not find that document.')

      const filename = `${doc.title.replace(/\s+/g, '-')}-v${doc.version}.pdf`

      // The audit write is awaited inside issueSignedUrl and gates the URL.
      const url = await deps.vault.issueSignedUrl(doc.minioKey, filename, async () => {
        await auditFromRequest(db, req, {
          action,
          entity: 'documents',
          entityId: doc.id,
          metadata: { caseId: row.id, version: doc.version, status: doc.status },
        })
      })

      res.json({ url, expiresInSeconds: 300, filename })
    })
  )

  // ------------------------------------------------------------------ interviews

  router.post(
    '/v1/cases/:caseId/interviews',
    asyncHandler(async (req, res) => {
      const row = await loadCase(db, req, req.params.caseId!)
      const templateKey = String((req.body as Record<string, unknown>).templateKey ?? '')

      const { rows: templates } = await db.query(
        `SELECT id, key, name, interview_schema AS "interviewSchema", disclosure_text AS "disclosureText",
                verification
           FROM document_templates
          WHERE key = $1 AND case_type_id = $2 AND active = TRUE`,
        [templateKey, row.caseTypeId]
      )
      const template = templates[0]
      if (!template) throw HttpError.notFound('We could not find that document type.')

      const { rows } = await db.query<{ id: string }>(
        `INSERT INTO interviews (case_id, template_id) VALUES ($1, $2) RETURNING id`,
        [row.id, template.id]
      )

      res.status(201).json({
        interviewId: rows[0]!.id,
        template: {
          key: template.key,
          name: template.name,
          schema: template.interviewSchema,
          disclosureText: template.disclosureText,
          verification: template.verification,
        },
      })
    })
  )

  router.patch(
    '/v1/cases/:caseId/interviews/:interviewId',
    asyncHandler(async (req, res) => {
      const row = await loadCase(db, req, req.params.caseId!)
      const answers = (req.body as Record<string, unknown>).answers
      if (!answers || typeof answers !== 'object') {
        throw HttpError.badRequest('"answers" must be an object.')
      }

      const { rowCount } = await db.query(
        `UPDATE interviews SET answers = $3::jsonb, updated_at = now()
          WHERE id = $1 AND case_id = $2 AND status = 'in_progress'`,
        [req.params.interviewId, row.id, JSON.stringify(answers)]
      )
      if (!rowCount) throw HttpError.notFound('We could not find that interview.')

      res.json({ saved: true })
    })
  )

  router.post(
    '/v1/cases/:caseId/interviews/:interviewId/complete',
    asyncHandler(async (req, res) => {
      const row = await loadCase(db, req, req.params.caseId!)
      const { rowCount } = await db.query(
        `UPDATE interviews SET status = 'complete', completed_at = now()
          WHERE id = $1 AND case_id = $2`,
        [req.params.interviewId, row.id]
      )
      if (!rowCount) throw HttpError.notFound('We could not find that interview.')

      // Rendering is a job: it fills a PDF or drives a headless browser, neither of which
      // belongs in a request cycle.
      await deps.enqueueRender({ interviewId: req.params.interviewId!, caseId: row.id })

      res.status(202).json({ queued: true })
    })
  )

  // ------------------------------------------------------------------ assistant

  router.post(
    '/v1/cases/:caseId/chat',
    asyncHandler(async (req, res) => {
      const row = await loadCase(db, req, req.params.caseId!)
      const question = String((req.body as Record<string, unknown>).question ?? '').trim()
      if (!question) throw HttpError.badRequest('Ask a question first.')

      const view = buildCaseView(row)
      const definition = view.definition
      const stage = getStage(definition, row.currentStageKey)

      // Grounding: this case's own content only. Sources come from the curated library
      // filtered to what this workflow actually cites, so the assistant cannot reach for
      // an authority the case has nothing to do with.
      const sources = definition.stages
        .filter((s) => s.deadlineRule)
        .map((s) => ({
          citation: s.deadlineRule!.source.citation,
          summary: s.deadlineRule!.source.summary,
        }))

      const { rows: templates } = await db.query(
        `SELECT key, name FROM document_templates WHERE case_type_id = $1 AND active = TRUE`,
        [row.caseTypeId]
      )

      const grounding = {
        caseTypeKey: row.caseTypeKey,
        jurisdictionLabel: row.jurisdictionKey,
        definition,
        currentStageKey: row.currentStageKey,
        sources,
        availableDocuments: stage.requiredDocuments.map((d) => ({
          key: d.templateKey,
          name: templates.find((t) => t.key === d.templateKey)?.name ?? d.title,
          purpose: d.purpose,
        })),
        knownDeadlines: view.timeline
          .filter((e) => e.deadline)
          .map((e) => ({
            title: e.deadline!.title,
            dueDate: e.deadline!.dueDate,
            source: e.deadline!.source.citation,
            warnings: e.deadline!.warnings,
          })),
      }

      const { rows: convos } = await db.query(
        `SELECT id, messages FROM ai_conversations WHERE case_id = $1 ORDER BY updated_at DESC LIMIT 1`,
        [row.id]
      )
      let conversationId = convos[0]?.id as string | undefined
      const history = (convos[0]?.messages ?? []) as Array<{ role: string; content: string }>

      const answer = await deps.ai.askAssistant({ question, grounding, history: history.slice(-10) })

      const messages = [
        ...history,
        { role: 'user', content: question, at: new Date().toISOString() },
        { role: 'assistant', content: answer.reply, at: new Date().toISOString() },
      ]

      const client = await db.connect()
      try {
        await client.query('BEGIN')
        if (conversationId) {
          await client.query(
            `UPDATE ai_conversations SET messages = $2::jsonb, updated_at = now() WHERE id = $1`,
            [conversationId, JSON.stringify(messages)]
          )
        } else {
          const { rows } = await client.query<{ id: string }>(
            `INSERT INTO ai_conversations (case_id, user_id, messages) VALUES ($1, $2, $3::jsonb) RETURNING id`,
            [row.id, req.auth!.userId, JSON.stringify(messages)]
          )
          conversationId = rows[0]!.id
        }

        // Persist guardrail findings for the admin review queue.
        for (const flag of answer.flags) {
          await client.query(
            `INSERT INTO upl_flags (conversation_id, message_index, code, severity, reason, excerpt, blocked)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [
              conversationId,
              messages.length - 1,
              flag.code,
              flag.severity,
              flag.reason,
              flag.excerpt,
              flag.blocked,
            ]
          )
        }

        if (answer.flags.length) {
          await auditFromRequest(client, req, {
            action: 'ai.upl_flag',
            entity: 'ai_conversations',
            entityId: conversationId,
            metadata: { codes: answer.flags.map((f) => f.code), outcome: answer.guardrail.outcome },
          })
        }
        await client.query('COMMIT')
      } catch (err) {
        await client.query('ROLLBACK')
        throw err
      } finally {
        client.release()
      }

      res.json({
        reply: answer.reply,
        blocked: answer.guardrail.outcome === 'blocked',
        conversationId,
      })
    })
  )

  return router
}

/** Exported for the admin workflow editor, which validates before publishing. */
export { assertValidWorkflowDefinition }
