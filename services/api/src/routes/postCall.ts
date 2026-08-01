/**
 * Post-call: landing links, payment links, and the one-shot document flow.
 *
 * Two audiences, two auth models, deliberately separated:
 *
 *   /v1/internal/*  called by svc-voice. Shared service token. Never public.
 *   /v1/landing/*   called by a phone that received an SMS. Capability token.
 *
 * The landing routes are the only place in the platform where something is served
 * without a signed-in identity, so they are narrow on purpose: a summary, a price, and a
 * checkout. Anything about the actual case requires phone-OTP sign-in.
 */

import { asyncHandler, HttpError } from '@justicedesk/service-kit'
import {
  checkLandingToken,
  describeCoverage,
  hashLandingToken,
  issueLandingToken,
  prefillCaseFromCall,
  type CallFacts,
  type LandingOffer,
  type LandingView,
} from '@justicedesk/shared'
import { Router, type RequestHandler } from 'express'
import type pg from 'pg'
import Stripe from 'stripe'
import { recordAudit } from '../audit.js'
import type { ApiConfig } from '../config.js'

export interface PostCallDeps {
  db: pg.Pool
  config: ApiConfig
  internalToken: string
  webBaseUrl: string
}

/** Constant-time shared-token check for service-to-service calls. */
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

interface ResolvedToken {
  callId: string
  tenantId: string
  tokenId: string
  expiresAt: Date
}

export function createPostCallRoutes(deps: PostCallDeps): Router {
  const router = Router()
  const { db } = deps

  const stripe = deps.config.stripe.secretKey
    ? new Stripe(deps.config.stripe.secretKey, { apiVersion: '2025-02-24.acacia' })
    : null

  /**
   * Resolve a landing token.
   *
   * Every rejection returns the same 404 and the same message. A distinct "expired" or
   * "revoked" response to an unauthenticated caller would confirm that a given link once
   * existed, which is a fact about someone's legal matter.
   */
  async function resolveToken(presented: string): Promise<ResolvedToken> {
    const { rows } = await db.query(
      `SELECT id, call_id, tenant_id, token_hash, expires_at, revoked_at
         FROM call_landing_tokens WHERE token_hash = $1`,
      [hashLandingToken(presented)]
    )
    const row = rows[0]

    const check = checkLandingToken(
      presented,
      row
        ? { tokenHash: row.token_hash, expiresAt: row.expires_at, revokedAt: row.revoked_at }
        : null
    )
    if (!check.ok) {
      throw HttpError.notFound('This link is no longer available. Call us back and we will text a new one.')
    }

    await db.query(
      `UPDATE call_landing_tokens SET last_used_at = now(), use_count = use_count + 1 WHERE id = $1`,
      [row.id]
    )

    return { callId: row.call_id, tenantId: row.tenant_id, tokenId: row.id, expiresAt: row.expires_at }
  }

  // ================================================================ internal

  const internal = Router()
  internal.use(internalAuth(deps.internalToken))

  /** Mint the SMS landing link for a call. */
  internal.post(
    '/v1/internal/calls/:callId/landing-link',
    asyncHandler(async (req, res) => {
      const { rows } = await db.query(`SELECT id, tenant_id FROM calls WHERE id = $1`, [
        req.params.callId,
      ])
      const call = rows[0]
      if (!call) throw HttpError.notFound('No such call.')

      const issued = issueLandingToken()
      await db.query(
        `INSERT INTO call_landing_tokens (call_id, tenant_id, token_hash, expires_at)
         VALUES ($1, $2, $3, $4)`,
        [call.id, call.tenant_id, issued.tokenHash, issued.expiresAt]
      )

      await recordAudit(db, {
        actorId: null,
        action: 'call.landing_link_issued',
        entity: 'calls',
        entityId: call.id,
        // The token itself is never logged — it is the capability.
        metadata: { expiresAt: issued.expiresAt.toISOString() },
      })

      res.status(201).json({
        url: `${deps.webBaseUrl}/c/${issued.token}`,
        expiresAt: issued.expiresAt.toISOString(),
      })
    })
  )

  /** Store the guardrailed call summary that the landing page will show. */
  internal.post(
    '/v1/internal/calls/:callId/summary',
    asyncHandler(async (req, res) => {
      const body = req.body as Record<string, unknown>
      const outcome = String(body.guardrailOutcome ?? 'blocked')

      // A blocked summary is not stored. The landing page falls back to neutral copy
      // rather than showing text the guardrails refused.
      if (outcome === 'blocked') {
        res.status(202).json({ stored: false, reason: 'guardrail_blocked' })
        return
      }

      const { rows } = await db.query(`SELECT tenant_id FROM calls WHERE id = $1`, [req.params.callId])
      if (!rows[0]) throw HttpError.notFound('No such call.')

      await db.query(
        `INSERT INTO call_summaries
           (call_id, tenant_id, summary_text, suggested_documents, detected_case_type, guardrail_outcome)
         VALUES ($1, $2, $3, $4::jsonb, $5, $6)
         ON CONFLICT (call_id) DO UPDATE
           SET summary_text = EXCLUDED.summary_text,
               suggested_documents = EXCLUDED.suggested_documents,
               detected_case_type = EXCLUDED.detected_case_type,
               guardrail_outcome = EXCLUDED.guardrail_outcome`,
        [
          req.params.callId,
          rows[0].tenant_id,
          String(body.summary ?? '').slice(0, 4000),
          JSON.stringify(body.suggestedDocuments ?? []),
          body.detectedCaseType ? String(body.detectedCaseType) : null,
          outcome,
        ]
      )

      res.status(201).json({ stored: true })
    })
  )

  /**
   * Create a mid-call payment link.
   *
   * The amount is never taken from the caller — it is read from the fee schedule by key,
   * so a compromised or buggy svc-voice cannot invent a price.
   */
  internal.post(
    '/v1/internal/calls/:callId/payment-link',
    asyncHandler(async (req, res) => {
      if (!stripe) throw HttpError.unavailable('Payments are not configured in this environment.')

      const feeKey = String((req.body as Record<string, unknown>).feeKey ?? '')
      const { rows: calls } = await db.query(`SELECT id, tenant_id FROM calls WHERE id = $1`, [
        req.params.callId,
      ])
      const call = calls[0]
      if (!call) throw HttpError.notFound('No such call.')

      const { rows: fees } = await db.query(
        `SELECT id, amount_cents, name, stripe_price_id
           FROM fee_schedule
          WHERE tenant_id = $1 AND key = $2 AND status = 'live'`,
        [call.tenant_id, feeKey]
      )
      const fee = fees[0]
      if (!fee) {
        // Draft fees are not purchasable. While the compliance gate is closed every fee
        // is draft, so this is the expected path in staging.
        throw HttpError.conflict(`No live fee is published for "${feeKey}".`)
      }
      if (!fee.stripe_price_id) {
        throw HttpError.conflict(`Fee "${feeKey}" has not been connected to Stripe.`)
      }

      const session = await stripe.checkout.sessions.create({
        mode: 'payment',
        line_items: [{ price: fee.stripe_price_id, quantity: 1 }],
        success_url: `${deps.webBaseUrl}/c/paid`,
        cancel_url: `${deps.webBaseUrl}/c/cancelled`,
        client_reference_id: call.id,
        metadata: { callId: call.id, feeScheduleId: fee.id, tenantId: call.tenant_id },
      })

      await db.query(
        `INSERT INTO call_charges (call_id, tenant_id, fee_schedule_id, amount_cents, payment_link_url, status)
         VALUES ($1, $2, $3, $4, $5, 'pending')`,
        [call.id, call.tenant_id, fee.id, fee.amount_cents, session.url]
      )

      res.status(201).json({ url: session.url, amountCents: fee.amount_cents, name: fee.name })
    })
  )

  /**
   * Convert a call into a case (v2 rung 4).
   *
   * Non-negotiable #7 — the caller never repeats themselves. Everything gathered on the
   * call is mapped onto the case and used to seed the guided interview, and the response
   * carries a coverage report naming anything that did NOT transfer.
   *
   * That report is the point. "Lossless" asserted in a spec is worth nothing; a caller
   * discovers a gap by being asked their hearing date twice. Here a gap is a field in the
   * response, countable in a metric, visible before they ever see the portal.
   */
  internal.post(
    '/v1/internal/calls/:callId/convert-to-case',
    asyncHandler(async (req, res) => {
      const { rows: calls } = await db.query(
        `SELECT c.id, c.tenant_id, c.from_e164, c.detected_case_type, c.detected_county,
                c.court_case_number, c.case_id,
                s.summary_text, s.detected_case_type AS summary_case_type
           FROM calls c
           LEFT JOIN call_summaries s ON s.call_id = c.id
          WHERE c.id = $1`,
        [req.params.callId]
      )
      const call = calls[0]
      if (!call) throw HttpError.notFound('No such call.')
      if (call.case_id) {
        // Already converted. Idempotent: a retried webhook must not create a second case.
        res.status(200).json({ caseId: call.case_id, alreadyConverted: true })
        return
      }

      const body = req.body as Record<string, unknown>
      const facts: CallFacts = {
        detectedCaseType: call.detected_case_type ?? call.summary_case_type,
        county: call.detected_county,
        courtCaseNumber: call.court_case_number,
        narrative: call.summary_text,
        callerPhone: call.from_e164,
        ...(body.facts as Partial<CallFacts> | undefined),
      }

      const caseTypeKey = String(facts.detectedCaseType ?? '')
      if (!caseTypeKey) {
        throw HttpError.conflict('This call has no detected case type, so no case can be opened.')
      }

      const { rows: defs } = await db.query(
        `SELECT wd.id, wd.definition, ct.id AS case_type_id, j.id AS jurisdiction_id
           FROM workflow_definitions wd
           JOIN case_types ct ON ct.id = wd.case_type_id
           JOIN jurisdictions j ON j.id = wd.jurisdiction_id
          WHERE ct.key = $1 AND wd.tenant_id = $2 AND wd.status = 'live'
          LIMIT 1`,
        [caseTypeKey, call.tenant_id]
      )
      const def = defs[0]
      if (!def) {
        // Expected while the compliance gate is closed: nothing is published.
        throw HttpError.conflict(
          `No published workflow for "${caseTypeKey}". The guidance for it is still under review.`
        )
      }

      const prefill = prefillCaseFromCall(facts)
      const definition = def.definition as { initialStageKey: string }

      const client = await db.connect()
      try {
        await client.query('BEGIN')

        // Lightweight account, keyed by the phone that called (v2 §4). Upgrades to a full
        // portal account when they sign in with OTP.
        const { rows: users } = await client.query<{ id: string }>(
          `INSERT INTO users (tenant_id, phone) VALUES ($1, $2)
           ON CONFLICT (tenant_id, phone) WHERE phone IS NOT NULL
             DO UPDATE SET phone = EXCLUDED.phone
           RETURNING id`,
          [call.tenant_id, call.from_e164]
        )
        const userId = users[0]!.id

        const { rows: created } = await client.query<{ id: string }>(
          `INSERT INTO cases (tenant_id, user_id, case_type_id, jurisdiction_id,
                              workflow_definition_id, role, status, current_stage_key,
                              court_case_number, metadata)
           VALUES ($1, $2, $3, $4, $5, $6::party_role, 'active', $7, $8, $9::jsonb)
           RETURNING id`,
          [
            call.tenant_id,
            userId,
            def.case_type_id,
            def.jurisdiction_id,
            def.id,
            prefill.role,
            definition.initialStageKey,
            facts.courtCaseNumber ?? null,
            JSON.stringify({ ...prefill.metadata, completedStageKeys: [] }),
          ]
        )
        const caseId = created[0]!.id

        await client.query(
          `INSERT INTO case_stage_events (case_id, stage_key, status) VALUES ($1, $2, 'current')`,
          [caseId, definition.initialStageKey]
        )

        await client.query(`UPDATE calls SET case_id = $2, user_id = $3 WHERE id = $1`, [
          call.id,
          caseId,
          userId,
        ])

        await client.query(
          `INSERT INTO call_case_prefills (call_id, case_id, fields)
           VALUES ($1, $2, $3::jsonb)
           ON CONFLICT (call_id, case_id) DO NOTHING`,
          [call.id, caseId, JSON.stringify(prefill.coverage)]
        )

        await recordAudit(client, {
          actorId: null,
          action: 'call.converted_to_case',
          entity: 'cases',
          entityId: caseId,
          metadata: {
            callId: call.id,
            caseTypeKey,
            transferred: prefill.coverage.transferred.length,
            lost: prefill.coverage.dropped.filter((d) => d.reason !== 'no_destination').length,
          },
        })

        await client.query('COMMIT')

        res.status(201).json({
          caseId,
          userId,
          role: prefill.role,
          interviewAnswers: prefill.interviewAnswers,
          coverage: prefill.coverage,
          summary: describeCoverage(prefill.coverage),
        })
      } catch (err) {
        await client.query('ROLLBACK')
        throw err
      } finally {
        client.release()
      }
    })
  )

  router.use(internal)

  // ================================================================ landing (capability token)

  /**
   * The post-call landing view.
   *
   * Returns only what the caller already knows plus what can be bought. No transcript,
   * no recording, no deadline, no case — those need a signed-in identity.
   */
  router.get(
    '/v1/landing/:token',
    asyncHandler(async (req, res) => {
      const resolved = await resolveToken(req.params.token!)

      const { rows } = await db.query(
        `SELECT c.id, c.detected_case_type AS "detectedCaseType", c.revenue_cents AS "revenueCents",
                s.summary_text AS "summaryText", s.suggested_documents AS "suggestedDocuments"
           FROM calls c
           LEFT JOIN call_summaries s ON s.call_id = c.id
          WHERE c.id = $1`,
        [resolved.callId]
      )
      const call = rows[0]
      if (!call) throw HttpError.notFound('This link is no longer available.')

      const { rows: fees } = await db.query(
        `SELECT key, name, amount_cents AS "amountCents", category
           FROM fee_schedule
          WHERE tenant_id = $1 AND status = 'live'
            AND category IN ('one_shot_document', 'subscription', 'call_credit_pack')`,
        [resolved.tenantId]
      )

      const offers: LandingOffer[] = fees.map((f) => ({
        kind:
          f.category === 'subscription'
            ? 'subscription'
            : f.category === 'call_credit_pack'
              ? 'call_credit'
              : 'one_shot_document',
        feeKey: f.key,
        title: f.name,
        description:
          f.category === 'subscription'
            ? 'Your own case timeline, every deadline, and every document.'
            : f.category === 'call_credit_pack'
              ? 'Credit for future calls.'
              : 'One document, prepared and ready to print.',
        priceCents: f.amountCents,
      }))

      const view: LandingView = {
        callId: call.id,
        // Falls back to neutral copy when the guardrails blocked the summary.
        summaryText:
          call.summaryText ??
          'Thanks for calling. We can prepare your paperwork or set this up as a full case.',
        detectedCaseType: call.detectedCaseType,
        offers,
        alreadyPaidCents: call.revenueCents ?? 0,
        expiresAt: resolved.expiresAt.toISOString(),
      } as unknown as LandingView

      await recordAudit(db, {
        actorId: null,
        action: 'call.landing_viewed',
        entity: 'calls',
        entityId: resolved.callId,
        ip: req.ip ?? null,
        userAgent: req.header('user-agent') ?? null,
      })

      res.json(view)
    })
  )

  /** One-tap checkout from the landing page. */
  router.post(
    '/v1/landing/:token/checkout',
    asyncHandler(async (req, res) => {
      if (!stripe) throw HttpError.unavailable('Payments are not configured in this environment.')

      const resolved = await resolveToken(req.params.token!)
      const feeKey = String((req.body as Record<string, unknown>).feeKey ?? '')

      const { rows: fees } = await db.query(
        `SELECT id, amount_cents, name, stripe_price_id, category
           FROM fee_schedule
          WHERE tenant_id = $1 AND key = $2 AND status = 'live'`,
        [resolved.tenantId, feeKey]
      )
      const fee = fees[0]
      if (!fee) throw HttpError.conflict('That option is not available right now.')
      if (!fee.stripe_price_id) throw HttpError.conflict('That option is not connected to payments yet.')

      const session = await stripe.checkout.sessions.create({
        mode: fee.category === 'subscription' ? 'subscription' : 'payment',
        line_items: [{ price: fee.stripe_price_id, quantity: 1 }],
        success_url: `${deps.webBaseUrl}/c/${req.params.token}?paid=1`,
        cancel_url: `${deps.webBaseUrl}/c/${req.params.token}`,
        client_reference_id: resolved.callId,
        metadata: { callId: resolved.callId, feeScheduleId: fee.id, tenantId: resolved.tenantId },
      })

      await recordAudit(db, {
        actorId: null,
        action: 'call.landing_checkout_started',
        entity: 'calls',
        entityId: resolved.callId,
        metadata: { feeKey, amountCents: fee.amount_cents },
      })

      res.json({ checkoutUrl: session.url })
    })
  )

  return router
}
