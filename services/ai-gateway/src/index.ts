/**
 * svc-ai-gateway (:4102)
 *
 * Internal only. Wraps the Anthropic API and enforces the UPL guardrail layer. Never
 * expose this port publicly: it is the one place raw model output exists before the
 * guardrails run.
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
import express from 'express'
import { AnthropicGateway } from './anthropic.js'
import { loadConfig } from './config.js'
import { createClassifier, failClosed } from './guardrails/classifier.js'
import { createRoutes } from './routes.js'

const logger = createLogger('svc-ai-gateway')

export function createApp(deps: Parameters<typeof createRoutes>[0]): express.Express {
  const app = express()
  app.disable('x-powered-by')
  // Court-paper photographs arrive base64-encoded, so the body limit is generous.
  app.use(express.json({ limit: '12mb' }))
  app.use(requestContext(logger))
  app.use(metricsMiddleware('svc-ai-gateway'))

  app.get('/healthz', (_req, res) => res.json({ ok: true, service: 'svc-ai-gateway' }))
  app.get('/readyz', (_req, res) => res.json({ ok: true }))
  app.get('/metrics', metricsHandler)

  app.use(createRoutes(deps))
  app.use(notFoundHandler())
  app.use(errorHandler())
  return app
}

function main(): void {
  assertComplianceGate()

  const config = loadConfig()
  const gateway = new AnthropicGateway(config)
  const classifier = failClosed(createClassifier(gateway))

  const app = createApp({ gateway, classifier, serviceToken: config.serviceToken })

  app.listen(config.port, () => {
    logger.info('svc-ai-gateway listening', {
      port: config.port,
      model: config.model,
      compliance: complianceBanner(),
    })
  })
}

// Only start a server when run directly; tests import `createApp`.
if (process.env.NODE_ENV !== 'test') {
  main()
}
