/**
 * svc-jobs — BullMQ workers.
 *
 * Queues:
 *   document-render   fill an AOC form or render a freeform document, store it in MinIO
 *   deadline-reminder repeating scan that sends SMS at 14/7/2/1 days out
 *   summons-ocr       retry surface for OCR that failed inline in svc-api
 *   docket-status     Phase 2 placeholder — registered so the queue exists, no-ops today
 */

import {
  assertComplianceGate,
  complianceBanner,
  createLogger,
  metricsHandler,
  registry,
} from '@justicedesk/service-kit'
import { readSecret, readSecretOptional } from '@justicedesk/shared'
import { Queue, Worker, type ConnectionOptions } from 'bullmq'
import express from 'express'
import { Client as MinioClient } from 'minio'
import pg from 'pg'
import { closeBrowser } from './render/htmlPdf.js'
import { runReminderPass, type DueDeadline } from './reminders.js'
import { createSmsSender } from './sms.js'
import { renderDocument } from './workers/renderDocument.js'

const logger = createLogger('svc-jobs')

function connection(): ConnectionOptions {
  return {
    host: process.env.REDIS_HOST ?? 'localhost',
    port: Number(process.env.REDIS_PORT ?? 6379),
    password: readSecretOptional(process.env.REDIS_PASSWORD_VAULT_KEY ?? 'redis_password', {
      allowEnvFallback: true,
    }) ?? undefined,
  }
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

  const minio = new MinioClient({
    endPoint: process.env.MINIO_ENDPOINT ?? 'localhost',
    port: Number(process.env.MINIO_PORT ?? 9000),
    useSSL: process.env.MINIO_USE_SSL === 'true',
    accessKey: readSecret(process.env.MINIO_ACCESS_KEY_VAULT_KEY ?? 'minio_access_key', {
      allowEnvFallback: true,
    }),
    secretKey: readSecret(process.env.MINIO_SECRET_KEY_VAULT_KEY ?? 'minio_secret_key', {
      allowEnvFallback: true,
    }),
  })
  const bucket = process.env.MINIO_BUCKET ?? 'justicedesk-documents'

  const sms = createSmsSender()
  const smsEnabled = process.env.SMS_SENDING_ENABLED === 'true'

  // ---------------------------------------------------------------- document render
  const renderWorker = new Worker(
    'document-render',
    async (job) => {
      const { interviewId, caseId } = job.data as { interviewId: string; caseId: string }
      return renderDocument({ db, minio, bucket, interviewId, caseId, logger })
    },
    { connection: connection(), concurrency: 2 }
  )

  // ---------------------------------------------------------------- reminders
  const reminderWorker = new Worker(
    'deadline-reminder',
    async () => {
      const { rows } = await db.query<DueDeadline>(
        `SELECT d.id, d.case_id AS "caseId", d.title, d.due_date::text AS "dueDate",
                d.jurisdictional, d.reminder_schedule AS "reminderSchedule",
                u.phone, j.time_zone AS "timeZone"
           FROM deadlines d
           JOIN cases c ON c.id = d.case_id
           JOIN users u ON u.id = c.user_id
           JOIN jurisdictions j ON j.id = c.jurisdiction_id
          WHERE d.status = 'pending'
            AND c.status = 'active'
            AND d.due_date >= CURRENT_DATE
            AND d.due_date <= CURRENT_DATE + INTERVAL '15 days'`
      )

      const result = await runReminderPass({
        deadlines: rows,
        sms,
        smsEnabled,
        markSent: async (deadlineId, offsets) => {
          await db.query(
            `UPDATE deadlines
                SET reminder_schedule = jsonb_set(reminder_schedule, '{sentOffsets}', $2::jsonb)
              WHERE id = $1`,
            [deadlineId, JSON.stringify(offsets)]
          )
        },
        onError: (deadlineId, err) => logger.error('reminder failed', { deadlineId, err }),
      })

      logger.info('reminder pass complete', { ...result, smsEnabled })
      return result
    },
    { connection: connection(), concurrency: 1 }
  )

  // Repeating trigger. Hourly rather than daily so a missed run costs an hour, not a day,
  // and so the catch-up logic in reminders.ts rarely has to do real work.
  const reminderQueue = new Queue('deadline-reminder', { connection: connection() })
  await reminderQueue.add(
    'scan',
    {},
    { repeat: { pattern: '0 * * * *' }, jobId: 'deadline-reminder-hourly', removeOnComplete: 100 }
  )

  // ---------------------------------------------------------------- Phase 2 placeholder
  const docketWorker = new Worker(
    'docket-status',
    async (job) => {
      // Phase 2: poll the court docket for status changes. Registered now so the queue
      // and its retry policy exist and nothing has to be wired up later under pressure.
      logger.info('docket-status is a Phase 2 placeholder; nothing to do', { jobId: job.id })
      return { skipped: true }
    },
    { connection: connection(), concurrency: 1 }
  )

  for (const [name, worker] of [
    ['document-render', renderWorker],
    ['deadline-reminder', reminderWorker],
    ['docket-status', docketWorker],
  ] as const) {
    worker.on('failed', (job, err) => logger.error('job failed', { queue: name, jobId: job?.id, err }))
    worker.on('completed', (job) => logger.debug('job completed', { queue: name, jobId: job.id }))
  }

  // Prometheus needs a scrape target even though this process serves no API.
  const metricsApp = express()
  metricsApp.get('/metrics', metricsHandler)
  metricsApp.get('/healthz', (_req, res) => res.json({ ok: true, service: 'svc-jobs' }))
  const metricsPort = Number(process.env.JOBS_METRICS_PORT ?? 4103)
  metricsApp.listen(metricsPort)

  logger.info('svc-jobs started', {
    metricsPort,
    smsEnabled,
    compliance: complianceBanner(),
    metricsRegistered: registry.getMetricsAsArray().length,
  })

  const shutdown = async (): Promise<void> => {
    logger.info('shutting down')
    await Promise.allSettled([
      renderWorker.close(),
      reminderWorker.close(),
      docketWorker.close(),
      closeBrowser(),
      db.end(),
    ])
    process.exit(0)
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}

if (process.env.NODE_ENV !== 'test') {
  main().catch((err) => {
    logger.error('failed to start', { err })
    process.exit(1)
  })
}
