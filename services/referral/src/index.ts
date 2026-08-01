/**
 * svc-referral (:4104) — the feeder engine.
 *
 * Qualified callers become leads, leads route to a covering recipient, delivery is
 * measured against the 60-second speed-to-lead target, and a delivered lead bills a flat
 * fee. Disputes credit it back.
 *
 * Two surfaces:
 *   /v1/internal/*   svc-voice creating and qualifying leads. Shared service token.
 *   /v1/console/*    the attorney lead console: accept, log contact, report outcome, dispute.
 *
 * The decisions live in @justicedesk/shared (qualification, fee resolution, billing
 * eligibility); this service moves data and talks to Stripe.
 */

import {
  assertComplianceGate,
  asyncHandler,
  complianceBanner,
  createLogger,
  errorHandler,
  HttpError,
  metricsHandler,
  metricsMiddleware,
  notFoundHandler,
  requestContext,
} from '@justicedesk/service-kit'
import {
  billingEligibility,
  fallbackFeeKeyFor,
  feeKeyFor,
  metSpeedTarget,
  qualifyLead,
  type PracticeArea,
  type UniversalLead,
} from '@justicedesk/shared'
import { readSecret, readSecretOptional } from '@justicedesk/shared'
import express, { Router, type RequestHandler } from 'express'
import pg from 'pg'
import { selectLeadTarget, type LeadTarget } from './exchange.js'

const logger = createLogger('svc-referral')

function internalAuth(expected: string): RequestHandler {
  return (req, _res, next) => {
    const presented = req.header('x-service-token') ?? ''
    let diff = presented.length === expected.length ? 0 : 1
    for (let i = 0; i < Math.max(presented.length, expected.length); i++) {
      diff |= (presented.charCodeAt(i) || 0) ^ (expected.charCodeAt(i) || 0)
    }
    if (diff !== 0) return next(HttpError.unauthorized('This endpoint is internal.'))
    next()
  }
}

export interface ReferralDeps {
  db: pg.Pool
  target: LeadTarget
  internalToken: string
}

export function createApp(deps: ReferralDeps): express.Express {
  const app = express()
  app.disable('x-powered-by')
  app.set('trust proxy', true)
  app.use(express.json({ limit: '1mb' }))
  app.use(requestContext(logger))
  app.use(metricsMiddleware('svc-referral'))

  app.get('/healthz', (_req, res) =>
    res.json({ ok: true, service: 'svc-referral', target: deps.target.kind })
  )
  app.get('/readyz', async (_req, res) => {
    try {
      await deps.db.query('SELECT 1')
      res.json({ ok: true })
    } catch {
      res.status(503).json({ ok: false })
    }
  })
  app.get('/metrics', metricsHandler)

  const internal = Router()
  internal.use(internalAuth(deps.internalToken))

  /**
   * Create and qualify a lead from a call.
   *
   * An unqualified lead is STORED, not discarded — it stays in `draft` with its failure
   * reasons. A lead that failed only because a consent was never asked for is recoverable
   * on a callback; throwing it away loses that.
   */
  internal.post(
    '/v1/internal/leads',
    asyncHandler(async (req, res) => {
      const body = req.body as Record<string, unknown>
      const practiceArea = String(body.practiceArea ?? '') as PracticeArea
      const county = String(body.county ?? '')

      const qualification = qualifyLead({
        practiceArea,
        county,
        state: String(body.state ?? 'NC'),
        notAlreadyRepresented:
          body.notAlreadyRepresented === undefined ? null : Boolean(body.notAlreadyRepresented),
        consentTcpa: Boolean(body.consentTcpa),
        consentReferralDisclosure: Boolean(body.consentReferralDisclosure),
        damagesBand: body.damagesBand as never,
        summary: String(body.summary ?? ''),
        contactPhone: body.contactPhone ? String(body.contactPhone) : null,
      })

      const { rows } = await deps.db.query<{ id: string }>(
        `INSERT INTO leads
           (tenant_id, source_call_id, case_type, practice_area, county, state, summary,
            qualification_answers, damages_band, contact_name, contact_phone, contact_email,
            not_already_represented, represented_checked_at,
            consent_tcpa, consent_referral_disclosure, consent_captured_at,
            status, qualified_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12,
                 $13, $14, $15, $16, $17, $18::lead_status, $19)
         RETURNING id`,
        [
          body.tenantId,
          body.sourceCallId ?? null,
          String(body.caseType ?? practiceArea),
          practiceArea,
          county,
          String(body.state ?? 'NC'),
          String(body.summary ?? ''),
          JSON.stringify(body.qualificationAnswers ?? {}),
          body.damagesBand ?? null,
          body.contactName ?? null,
          body.contactPhone ?? null,
          body.contactEmail ?? null,
          body.notAlreadyRepresented === undefined ? null : Boolean(body.notAlreadyRepresented),
          body.notAlreadyRepresented === undefined ? null : new Date(),
          Boolean(body.consentTcpa),
          Boolean(body.consentReferralDisclosure),
          body.consentTcpa || body.consentReferralDisclosure ? new Date() : null,
          qualification.qualified ? 'qualified' : 'draft',
          qualification.qualified ? new Date() : null,
        ]
      )

      res.status(201).json({ leadId: rows[0]!.id, qualification })
    })
  )

  /**
   * Route a qualified lead to a covering recipient.
   *
   * Capacity is respected: a firm past its daily limit is skipped rather than flooded,
   * because a lead sitting in an overloaded queue is a lead nobody works.
   */
  internal.post(
    '/v1/internal/leads/:leadId/route',
    asyncHandler(async (req, res) => {
      const { rows: leads } = await deps.db.query(
        `SELECT * FROM leads WHERE id = $1`,
        [req.params.leadId]
      )
      const lead = leads[0]
      if (!lead) throw HttpError.notFound('No such lead.')
      if (lead.status !== 'qualified') {
        throw HttpError.conflict(`Lead is "${lead.status}", not qualified. Nothing to route.`)
      }

      const { rows: recipients } = await deps.db.query(
        `SELECT r.id, r.name, r.webhook_url, r.contact_email, r.daily_capacity,
                (SELECT count(*) FROM lead_deliveries d
                  WHERE d.recipient_id = r.id AND d.routed_at::date = CURRENT_DATE) AS today
           FROM lead_recipients r
           JOIN lead_recipient_coverage c ON c.recipient_id = r.id
          WHERE r.tenant_id = $1 AND r.active
            AND c.practice_area = $2 AND c.county = $3 AND c.state = $4
          ORDER BY today ASC`,
        [lead.tenant_id, lead.practice_area, lead.county, lead.state]
      )

      const recipient = recipients.find((r) => Number(r.today) < r.daily_capacity)
      if (!recipient) {
        // Not an error: no panel covers this, or everyone is full. The lead stays
        // qualified and can be routed later rather than being burned.
        res.status(202).json({ routed: false, reason: 'no_recipient_with_capacity' })
        return
      }

      const universal: UniversalLead = {
        caseType: lead.case_type,
        practiceArea: lead.practice_area,
        county: lead.county,
        state: lead.state,
        summary: lead.summary,
        qualificationAnswers: lead.qualification_answers,
        consentRecords: [
          { kind: 'tcpa_sms', granted: lead.consent_tcpa, capturedAt: String(lead.consent_captured_at) },
          {
            kind: 'referral_disclosure',
            granted: lead.consent_referral_disclosure,
            capturedAt: String(lead.consent_captured_at),
          },
        ],
        sourceCallId: lead.source_call_id,
        damagesBand: lead.damages_band ?? undefined,
      }

      const delivery = await deps.target.deliver(universal, lead.id)

      await deps.db.query(
        `INSERT INTO lead_deliveries (lead_id, recipient_id, channel, delivered_at, attempts)
         VALUES ($1, $2, $3, $4, 1)
         ON CONFLICT (lead_id, recipient_id) DO UPDATE
           SET attempts = lead_deliveries.attempts + 1, delivered_at = EXCLUDED.delivered_at`,
        [lead.id, recipient.id, recipient.webhook_url ? 'webhook' : 'email', delivery.deliveredAt]
      )
      await deps.db.query(`UPDATE leads SET status = 'delivered' WHERE id = $1`, [lead.id])

      const onTime = metSpeedTarget(new Date(lead.qualified_at), delivery.deliveredAt)
      logger.info('lead routed', {
        leadId: lead.id,
        recipientId: recipient.id,
        target: delivery.target,
        metSpeedTarget: onTime,
      })

      res.json({ routed: true, recipientId: recipient.id, metSpeedTarget: onTime })
    })
  )

  /**
   * Bill a delivered lead.
   *
   * The amount comes from the fee schedule by practice area and county. Nothing about the
   * matter's value can reach it — see `feeKeyFor`, which takes exactly two arguments, and
   * the database trigger that refuses a charge differing from the published fee.
   */
  internal.post(
    '/v1/internal/leads/:leadId/bill',
    asyncHandler(async (req, res) => {
      const { rows: leads } = await deps.db.query(`SELECT * FROM leads WHERE id = $1`, [
        req.params.leadId,
      ])
      const lead = leads[0]
      if (!lead) throw HttpError.notFound('No such lead.')

      const { rows: deliveries } = await deps.db.query(
        `SELECT id, recipient_id FROM lead_deliveries WHERE lead_id = $1 ORDER BY routed_at LIMIT 1`,
        [lead.id]
      )
      const { rows: existing } = await deps.db.query(
        `SELECT id FROM lead_charges WHERE lead_id = $1`,
        [lead.id]
      )
      const { rows: disputes } = await deps.db.query(
        `SELECT id FROM lead_disputes WHERE lead_id = $1 AND status = 'open'`,
        [lead.id]
      )

      const { rows: fees } = await deps.db.query(
        `SELECT id, amount_cents FROM fee_schedule
          WHERE tenant_id = $1 AND status = 'live' AND key = ANY($2::text[])
          ORDER BY array_position($2::text[], key) LIMIT 1`,
        [
          lead.tenant_id,
          [feeKeyFor(lead.practice_area, lead.county), fallbackFeeKeyFor(lead.practice_area)],
        ]
      )
      const fee = fees[0] ?? null

      const eligibility = billingEligibility({
        qualification: { qualified: lead.status !== 'draft', failures: [], reasons: [] },
        delivered: deliveries.length > 0,
        publishedFeeCents: fee ? fee.amount_cents : null,
        alreadyCharged: existing.length > 0,
        disputeOpen: disputes.length > 0,
      })

      if (!eligibility.billable) {
        // `no_published_fee` is the expected state while COMPLIANCE.md §3 is open —
        // no referral fee amounts are seeded until the structure is signed off.
        res.status(202).json({ billed: false, blocks: eligibility.blocks })
        return
      }

      await deps.db.query(
        `INSERT INTO lead_charges
           (lead_id, delivery_id, recipient_id, tenant_id, fee_schedule_id, amount_cents)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [lead.id, deliveries[0]!.id, deliveries[0]!.recipient_id, lead.tenant_id, fee!.id, fee!.amount_cents]
      )

      res.status(201).json({ billed: true, amountCents: fee!.amount_cents })
    })
  )

  app.use(internal)

  // ================================================================ attorney console

  const console_ = Router()
  console_.use(internalAuth(deps.internalToken))

  console_.post(
    '/v1/console/deliveries/:deliveryId/accept',
    asyncHandler(async (req, res) => {
      const { rows } = await deps.db.query(
        `UPDATE lead_deliveries SET accepted_at = now() WHERE id = $1 AND accepted_at IS NULL
         RETURNING lead_id`,
        [req.params.deliveryId]
      )
      if (!rows[0]) throw HttpError.notFound('No such delivery, or it was already accepted.')
      await deps.db.query(`UPDATE leads SET status = 'accepted' WHERE id = $1`, [rows[0].lead_id])

      // Contact details are released here, on acceptance — not with the offer.
      const { rows: contact } = await deps.db.query(
        `SELECT contact_name, contact_phone, contact_email FROM leads WHERE id = $1`,
        [rows[0].lead_id]
      )
      res.json({ accepted: true, contact: contact[0] })
    })
  )

  console_.post(
    '/v1/console/deliveries/:deliveryId/decline',
    asyncHandler(async (req, res) => {
      const { rows } = await deps.db.query(
        `UPDATE lead_deliveries SET declined_at = now() WHERE id = $1 RETURNING lead_id`,
        [req.params.deliveryId]
      )
      if (!rows[0]) throw HttpError.notFound('No such delivery.')
      // Back to qualified so it can be re-routed to someone else.
      await deps.db.query(`UPDATE leads SET status = 'qualified' WHERE id = $1`, [rows[0].lead_id])
      res.json({ declined: true })
    })
  )

  console_.post(
    '/v1/console/deliveries/:deliveryId/contact-logged',
    asyncHandler(async (req, res) => {
      await deps.db.query(
        `UPDATE lead_deliveries SET first_contact_logged_at = COALESCE(first_contact_logged_at, now())
          WHERE id = $1`,
        [req.params.deliveryId]
      )
      res.json({ logged: true })
    })
  )

  console_.post(
    '/v1/console/deliveries/:deliveryId/outcome',
    asyncHandler(async (req, res) => {
      const outcome = String((req.body as Record<string, unknown>).outcome ?? '').slice(0, 200)
      await deps.db.query(`UPDATE lead_deliveries SET outcome = $2 WHERE id = $1`, [
        req.params.deliveryId,
        outcome,
      ])
      res.json({ recorded: true })
    })
  )

  /** Dispute an unqualified lead. Opening one blocks billing until it is resolved. */
  console_.post(
    '/v1/console/leads/:leadId/dispute',
    asyncHandler(async (req, res) => {
      const body = req.body as Record<string, unknown>
      const { rows } = await deps.db.query<{ id: string }>(
        `INSERT INTO lead_disputes (lead_id, charge_id, recipient_id, reason, detail)
         SELECT $1, (SELECT id FROM lead_charges WHERE lead_id = $1), $2, $3, $4
         RETURNING id`,
        [req.params.leadId, body.recipientId, String(body.reason ?? ''), String(body.detail ?? '')]
      )
      await deps.db.query(`UPDATE leads SET status = 'disputed' WHERE id = $1`, [req.params.leadId])
      res.status(201).json({ disputeId: rows[0]!.id })
    })
  )

  app.use(console_)
  app.use(notFoundHandler())
  app.use(errorHandler())
  return app
}

async function main(): Promise<void> {
  assertComplianceGate()

  const db = new pg.Pool({
    host: process.env.PGHOST ?? 'localhost',
    port: Number(process.env.PGPORT ?? 5432),
    database: process.env.PGDATABASE ?? 'justicedesk',
    user: process.env.PGUSER ?? 'justicedesk',
    password: readSecret(process.env.PGPASSWORD_VAULT_KEY ?? 'postgres_password', {
      allowEnvFallback: true,
    }),
  })

  const target = selectLeadTarget(
    process.env,
    db,
    readSecretOptional(process.env.LEAD_EXCHANGE_TOKEN_VAULT_KEY ?? 'lead_exchange_token', {
      allowEnvFallback: true,
    }),
    logger
  )

  const app = createApp({
    db,
    target,
    internalToken: readSecret(
      process.env.INTERNAL_SERVICE_TOKEN_VAULT_KEY ?? 'internal_service_token',
      { allowEnvFallback: true }
    ),
  })

  const port = Number(process.env.REFERRAL_PORT ?? 4104)
  app.listen(port, () => {
    logger.info('svc-referral listening', {
      port,
      leadTarget: target.kind,
      compliance: complianceBanner(),
    })
  })
}

if (process.env.NODE_ENV !== 'test') {
  main().catch((err) => {
    logger.error('failed to start', { err })
    process.exit(1)
  })
}
