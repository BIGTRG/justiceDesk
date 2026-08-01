/**
 * svc-api (:4101) — the only public service.
 */

import {
  assertComplianceGate,
  complianceBanner,
  createLogger,
  errorHandler,
  metricsHandler,
  metricsMiddleware,
  notFoundHandler,
  requestContext,
} from '@justicedesk/service-kit'
import { Queue } from 'bullmq'
import express from 'express'
import pg from 'pg'
import { AiGatewayClient } from './aiClient.js'
import { requireAuth, requireRole } from './auth.js'
import { loadConfig, type ApiConfig } from './config.js'
import { createAdminRoutes } from './routes/admin.js'
import { createAnalyticsRoutes } from './routes/analytics.js'
import { createBillingRoutes, createStripeWebhookRoute } from './routes/billing.js'
import { createCaseRoutes } from './routes/cases.js'
import { createPostCallRoutes } from './routes/postCall.js'
import { createVault, type Vault } from './storage.js'

const logger = createLogger('svc-api')

export interface AppDeps {
  db: pg.Pool
  config: ApiConfig
  vault: Vault
  ai: AiGatewayClient
  enqueueRender: (payload: { interviewId: string; caseId: string }) => Promise<void>
}

export function createApp(deps: AppDeps): express.Express {
  const app = express()
  app.disable('x-powered-by')
  // Behind a load balancer. Without this every audit row records the balancer's IP.
  app.set('trust proxy', true)

  app.use(requestContext(logger))
  app.use(metricsMiddleware('svc-api'))

  app.get('/healthz', (_req, res) => res.json({ ok: true, service: 'svc-api' }))
  app.get('/readyz', async (_req, res) => {
    try {
      await deps.db.query('SELECT 1')
      res.json({ ok: true })
    } catch {
      res.status(503).json({ ok: false })
    }
  })
  app.get('/metrics', metricsHandler)

  // Stripe's signature is over the raw bytes, so this must be mounted before the JSON
  // parser and given the raw body.
  app.use(express.raw({ type: 'application/json', limit: '1mb' }), createStripeWebhookRoute(deps))

  // Photographs of court papers arrive base64-encoded.
  app.use(express.json({ limit: '12mb' }))

  // Post-call routes carry their own auth: a shared service token for svc-voice, and a
  // capability token for the SMS landing page. Neither has a Clerk session, so they are
  // mounted BEFORE the authenticated router rather than inside it.
  app.use(
    createPostCallRoutes({
      db: deps.db,
      config: deps.config,
      internalToken: deps.config.internalServiceToken,
      webBaseUrl: deps.config.webBaseUrl,
    })
  )

  const authenticated = express.Router()
  authenticated.use(requireAuth({ db: deps.db, clerkSecretKey: deps.config.clerkSecretKey }))
  authenticated.use(createCaseRoutes(deps))
  authenticated.use(createBillingRoutes({ db: deps.db, config: deps.config }))
  authenticated.use('/v1/admin', requireRole('admin'), createAdminRoutes(deps.db))
  authenticated.use('/v1/admin/analytics', requireRole('admin'), createAnalyticsRoutes(deps.db))
  app.use(authenticated)

  app.use(notFoundHandler())
  app.use(errorHandler())
  return app
}

async function main(): Promise<void> {
  assertComplianceGate()

  const config = loadConfig()
  const { readSecret } = await import('@justicedesk/shared')

  const db = new pg.Pool({
    host: process.env.PGHOST ?? 'localhost',
    port: Number(process.env.PGPORT ?? 5432),
    database: process.env.PGDATABASE ?? 'justicedesk',
    user: process.env.PGUSER ?? 'justicedesk',
    password: readSecret(process.env.PGPASSWORD_VAULT_KEY ?? 'postgres_password', {
      allowEnvFallback: true,
    }),
    max: Number(process.env.PGPOOL_MAX ?? 10),
  })

  const vault = createVault(config)
  await vault.ensureBucket()

  const renderQueue = new Queue('document-render', {
    connection: {
      host: config.redis.host,
      port: config.redis.port,
      password: config.redis.password ?? undefined,
    },
  })

  const app = createApp({
    db,
    config,
    vault,
    ai: new AiGatewayClient(config),
    enqueueRender: async (payload) => {
      await renderQueue.add('render', payload, {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: 500,
        removeOnFail: 1000,
      })
    },
  })

  app.listen(config.port, () => {
    logger.info('svc-api listening', { port: config.port, compliance: complianceBanner() })
  })
}

if (process.env.NODE_ENV !== 'test') {
  main().catch((err) => {
    logger.error('failed to start', { err })
    process.exit(1)
  })
}
