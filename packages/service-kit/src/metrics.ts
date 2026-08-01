/**
 * Prometheus metrics. Every service exposes /metrics.
 *
 * Label discipline: labels are bounded, low-cardinality values only. No case IDs, user
 * IDs, or raw paths — an unbounded label set both blows up Prometheus and turns the
 * metrics endpoint into a leak of who is being sued.
 */

import type { NextFunction, Request, Response } from 'express'
import { collectDefaultMetrics, Counter, Histogram, Registry } from 'prom-client'

export const registry = new Registry()

collectDefaultMetrics({ register: registry })

export const httpRequests = new Counter({
  name: 'justicedesk_http_requests_total',
  help: 'HTTP requests by route, method and status class.',
  labelNames: ['service', 'method', 'route', 'status_class'] as const,
  registers: [registry],
})

export const httpDuration = new Histogram({
  name: 'justicedesk_http_request_duration_seconds',
  help: 'HTTP request duration in seconds.',
  labelNames: ['service', 'method', 'route'] as const,
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
  registers: [registry],
})

/** AI guardrail outcomes — the operational view of the compliance layer. */
export const guardrailOutcomes = new Counter({
  name: 'justicedesk_ai_guardrail_outcomes_total',
  help: 'AI responses by guardrail outcome.',
  labelNames: ['surface', 'outcome'] as const,
  registers: [registry],
})

export const uplFlags = new Counter({
  name: 'justicedesk_upl_flags_total',
  help: 'UPL guardrail findings by code and severity.',
  labelNames: ['code', 'severity'] as const,
  registers: [registry],
})

export const citationViolations = new Counter({
  name: 'justicedesk_citation_violations_total',
  help: 'Citations emitted by the model that are not in the curated library.',
  labelNames: ['kind', 'surface'] as const,
  registers: [registry],
})

export const documentAccess = new Counter({
  name: 'justicedesk_document_access_total',
  help: 'Document vault accesses by action.',
  labelNames: ['action'] as const,
  registers: [registry],
})

export const remindersSent = new Counter({
  name: 'justicedesk_reminders_sent_total',
  help: 'Deadline reminders dispatched.',
  labelNames: ['channel', 'offset_days'] as const,
  registers: [registry],
})

/**
 * Express middleware recording request count and duration.
 *
 * Uses the matched route pattern (`/v1/cases/:id`), never `req.path`, so a case ID can
 * never become a metric label.
 */
export function metricsMiddleware(service: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const stop = httpDuration.startTimer()
    res.on('finish', () => {
      const route = req.route?.path ? `${req.baseUrl}${req.route.path}` : 'unmatched'
      const labels = { service, method: req.method, route }
      stop(labels)
      httpRequests.inc({ ...labels, status_class: `${Math.floor(res.statusCode / 100)}xx` })
    })
    next()
  }
}

export async function metricsHandler(_req: Request, res: Response): Promise<void> {
  res.setHeader('Content-Type', registry.contentType)
  res.end(await registry.metrics())
}
