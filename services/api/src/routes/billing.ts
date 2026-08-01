/**
 * Billing.
 *
 * Stripe stays in test mode until the compliance gate opens. That is enforced here, not
 * just configured: `livePaymentsPermitted()` is checked on every checkout, and a
 * live-mode key while the gate is closed is refused rather than used.
 *
 * Non-negotiable #4 (price changes affect new signups only) is enforced in the database
 * — see db/migrations/0003_pricing_immutability.sql. This layer just pins the plan row.
 */

import { asyncHandler, HttpError, livePaymentsPermitted } from '@justicedesk/service-kit'
import { Router } from 'express'
import type pg from 'pg'
import Stripe from 'stripe'
import { auditFromRequest } from '../audit.js'
import { loadCase } from '../auth.js'
import type { ApiConfig } from '../config.js'

export interface BillingDeps {
  db: pg.Pool
  config: ApiConfig
}

export function createBillingRoutes(deps: BillingDeps): Router {
  const router = Router()
  const { db, config } = deps

  const stripe = config.stripe.secretKey
    ? new Stripe(config.stripe.secretKey, { apiVersion: '2025-02-24.acacia' })
    : null

  /**
   * A live secret key while the gate is closed is a misconfiguration, not a preference.
   * Fail loudly at first use rather than quietly charging someone real money.
   */
  function assertPaymentsAllowed(): Stripe {
    if (!stripe) {
      throw HttpError.unavailable('Payments are not configured in this environment.')
    }
    const keyIsLive = config.stripe.secretKey?.startsWith('sk_live_') ?? false
    if (keyIsLive && !livePaymentsPermitted()) {
      throw new HttpError(
        503,
        'compliance_gate_closed',
        'Payments are disabled until the compliance review is complete.'
      )
    }
    return stripe
  }

  /** Plans available for sale. Draft plans are invisible to litigants. */
  router.get(
    '/v1/plans',
    asyncHandler(async (req, res) => {
      const caseTypeKey = String(req.query.caseTypeKey ?? '')
      const { rows } = await db.query(
        `SELECT p.id, p.kind, p.name, p.price_cents AS "priceCents", ct.key AS "caseTypeKey"
           FROM plans p JOIN case_types ct ON ct.id = p.case_type_id
          WHERE p.status = 'live' AND ($1 = '' OR ct.key = $1)
          ORDER BY p.kind, p.price_cents`,
        [caseTypeKey]
      )
      res.json({ plans: rows, paymentsLive: livePaymentsPermitted() })
    })
  )

  router.post(
    '/v1/billing/checkout',
    asyncHandler(async (req, res) => {
      const client = assertPaymentsAllowed()
      const body = req.body as Record<string, unknown>
      const planId = String(body.planId ?? '')
      const caseId = String(body.caseId ?? '')

      const row = await loadCase(db, req, caseId)

      const { rows: plans } = await db.query(
        `SELECT id, kind, price_cents AS "priceCents", name, stripe_price_id AS "stripePriceId"
           FROM plans WHERE id = $1 AND status = 'live'`,
        [planId]
      )
      const plan = plans[0]
      if (!plan) throw HttpError.notFound('That plan is not available.')
      if (!plan.stripePriceId) {
        throw HttpError.conflict('This plan has not been connected to Stripe yet.')
      }

      const session = await client.checkout.sessions.create({
        mode: plan.kind === 'monthly' ? 'subscription' : 'payment',
        line_items: [{ price: plan.stripePriceId, quantity: 1 }],
        success_url: `${process.env.WEB_BASE_URL ?? 'http://localhost:3000'}/cases/${row.id}?checkout=success`,
        cancel_url: `${process.env.WEB_BASE_URL ?? 'http://localhost:3000'}/cases/${row.id}?checkout=cancelled`,
        client_reference_id: row.id,
        // The plan row is pinned into metadata so the webhook records the exact price the
        // litigant agreed to, even if a new plan version is published in between.
        metadata: { caseId: row.id, planId: plan.id, userId: req.auth!.userId },
      })

      await auditFromRequest(db, req, {
        action: 'billing.checkout_started',
        entity: 'cases',
        entityId: row.id,
        metadata: { planId: plan.id, kind: plan.kind, priceCents: plan.priceCents },
      })

      res.json({ checkoutUrl: session.url })
    })
  )

  router.get(
    '/v1/cases/:caseId/subscription',
    asyncHandler(async (req, res) => {
      const row = await loadCase(db, req, req.params.caseId!)
      const { rows } = await db.query(
        `SELECT s.id, s.status, s.started_at AS "startedAt", s.canceled_at AS "canceledAt",
                p.name AS "planName", p.price_cents AS "priceCents", p.kind
           FROM subscriptions s JOIN plans p ON p.id = s.plan_id
          WHERE s.case_id = $1 ORDER BY s.started_at DESC LIMIT 1`,
        [row.id]
      )
      res.json({ subscription: rows[0] ?? null })
    })
  )

  router.post(
    '/v1/cases/:caseId/subscription/cancel',
    asyncHandler(async (req, res) => {
      const client = assertPaymentsAllowed()
      const row = await loadCase(db, req, req.params.caseId!)

      const { rows } = await db.query(
        `SELECT id, stripe_subscription_id AS "stripeSubscriptionId"
           FROM subscriptions WHERE case_id = $1 AND status = 'active' LIMIT 1`,
        [row.id]
      )
      const subscription = rows[0]
      if (!subscription) throw HttpError.notFound('There is no active subscription on this case.')

      if (subscription.stripeSubscriptionId) {
        await client.subscriptions.cancel(subscription.stripeSubscriptionId)
      }
      await db.query(
        `UPDATE subscriptions SET status = 'canceled', canceled_at = now() WHERE id = $1`,
        [subscription.id]
      )
      await auditFromRequest(db, req, {
        action: 'billing.subscription_canceled',
        entity: 'subscriptions',
        entityId: subscription.id,
        metadata: { caseId: row.id },
      })

      res.json({ canceled: true })
    })
  )

  return router
}

/**
 * Stripe webhook.
 *
 * Mounted separately in index.ts because it needs the raw request body for signature
 * verification — the JSON body parser would destroy it.
 */
export function createStripeWebhookRoute(deps: BillingDeps): Router {
  const router = Router()
  const { db, config } = deps

  const stripe = config.stripe.secretKey
    ? new Stripe(config.stripe.secretKey, { apiVersion: '2025-02-24.acacia' })
    : null

  router.post(
    '/v1/billing/webhook',
    asyncHandler(async (req, res) => {
      if (!stripe || !config.stripe.webhookSecret) {
        throw HttpError.unavailable('Payments are not configured in this environment.')
      }

      const signature = req.header('stripe-signature')
      if (!signature) throw HttpError.badRequest('Missing signature.')

      let event: Stripe.Event
      try {
        event = stripe.webhooks.constructEvent(
          req.body as Buffer,
          signature,
          config.stripe.webhookSecret
        )
      } catch {
        // An unverifiable webhook is either misconfiguration or forgery; neither is
        // something to act on.
        throw HttpError.badRequest('Signature verification failed.')
      }

      switch (event.type) {
        case 'checkout.session.completed': {
          const session = event.data.object
          const { caseId, planId, userId } = session.metadata ?? {}
          if (!caseId || !planId || !userId) break

          if (session.mode === 'subscription') {
            await db.query(
              `INSERT INTO subscriptions (user_id, case_id, plan_id, stripe_subscription_id, status)
               VALUES ($1, $2, $3, $4, 'active')
               ON CONFLICT (stripe_subscription_id) DO UPDATE SET status = 'active'`,
              [userId, caseId, planId, String(session.subscription ?? '')]
            )
          }

          await db.query(
            `INSERT INTO payments (user_id, case_id, plan_id, stripe_payment_intent_id,
                                   amount_cents, kind, status)
             VALUES ($1, $2, $3, $4, $5, $6::payment_kind, 'succeeded')
             ON CONFLICT (stripe_payment_intent_id) DO NOTHING`,
            [
              userId,
              caseId,
              planId,
              String(session.payment_intent ?? session.id),
              session.amount_total ?? 0,
              session.mode === 'subscription' ? 'subscription' : 'one_shot',
            ]
          )
          break
        }

        case 'customer.subscription.deleted': {
          const subscription = event.data.object
          await db.query(
            `UPDATE subscriptions SET status = 'canceled', canceled_at = now()
              WHERE stripe_subscription_id = $1`,
            [subscription.id]
          )
          break
        }

        case 'invoice.payment_failed': {
          const invoice = event.data.object as Stripe.Invoice & { subscription?: string }
          if (invoice.subscription) {
            await db.query(
              `UPDATE subscriptions SET status = 'past_due' WHERE stripe_subscription_id = $1`,
              [invoice.subscription]
            )
          }
          break
        }

        default:
          break
      }

      res.json({ received: true })
    })
  )

  return router
}
