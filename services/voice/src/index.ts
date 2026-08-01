/**
 * svc-voice (:4103) — the CALL front door.
 *
 * Twilio Programmable Voice webhooks drive a `CallSession`, which drives the pure call
 * state machine in @justicedesk/shared.
 *
 * Two boot interlocks beyond the platform-wide compliance gate:
 *   * spoken scripts must be counsel-approved once the compliance gate opens
 *   * Twilio request signatures are verified on every webhook
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
  readComplianceState,
  requestContext,
} from '@justicedesk/service-kit'
import { DEFAULT_PAYWALL_POLICY, readSecret, readSecretOptional } from '@justicedesk/shared'
import express from 'express'
import pg from 'pg'
import twilio from 'twilio'
import { assertScriptsUsable, SCRIPT_STATUS, scriptFor, type Language } from './scripts.js'
import { CallSession, type CallRecord, type SessionDeps } from './session.js'

const logger = createLogger('svc-voice')

/** Live calls, keyed by Twilio call SID. */
const sessions = new Map<string, CallSession>()

/**
 * Verify Twilio's request signature.
 *
 * Without this the webhook is an open endpoint that will start, bill and end calls for
 * anyone who can guess the URL.
 */
export function twilioSignature(authToken: string, publicBaseUrl: string): express.RequestHandler {
  return (req, _res, next) => {
    const signature = req.header('x-twilio-signature')
    const url = `${publicBaseUrl}${req.originalUrl}`
    const valid =
      signature !== undefined &&
      twilio.validateRequest(authToken, signature, url, req.body as Record<string, string>)
    if (!valid) {
      logger.warn('rejected an unsigned or mis-signed Twilio webhook', { path: req.path })
      next(HttpError.unauthorized('Invalid signature.'))
      return
    }
    next()
  }
}

/**
 * Pull a required parameter off a Twilio webhook.
 *
 * Twilio always sends these, but "always" is doing load-bearing work in a handler that
 * starts and bills a call. A malformed post should be rejected at the edge rather than
 * reaching the state machine with an undefined call SID.
 */
function required(body: Record<string, string | undefined>, field: string): string {
  const value = body[field]
  if (!value) throw HttpError.badRequest(`Twilio webhook is missing "${field}".`)
  return value
}

export interface VoiceDeps {
  db: pg.Pool
  sessionDeps: Omit<SessionDeps, 'db' | 'logger' | 'policy'>
  authToken: string
  publicBaseUrl: string
}

export function createApp(deps: VoiceDeps): express.Express {
  const app = express()
  app.disable('x-powered-by')
  app.set('trust proxy', true)
  app.use(requestContext(logger))
  app.use(metricsMiddleware('svc-voice'))

  app.get('/healthz', (_req, res) =>
    res.json({ ok: true, service: 'svc-voice', scriptStatus: SCRIPT_STATUS })
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

  // Twilio posts form-encoded, and the signature is computed over those exact params.
  const twiml = express.urlencoded({ extended: false })
  const verify = twilioSignature(deps.authToken, deps.publicBaseUrl)

  /** Inbound call. Answers 24/7 — that IS the product (v2 §2). */
  app.post(
    '/twilio/voice',
    twiml,
    verify,
    asyncHandler(async (req, res) => {
      const body = req.body as Record<string, string | undefined>
      const callSid = required(body, 'CallSid')
      const from = required(body, 'From')
      const to = required(body, 'To')

      // Route to a tenant by the number that was dialled — vertical brands each have
      // their own line (v2 §5C).
      const { rows } = await deps.db.query<{
        id: string
        tenant_id: string
        language: Language
      }>(
        `SELECT id, tenant_id, language FROM tenant_phone_numbers
          WHERE e164 = $1 AND status = 'active' LIMIT 1`,
        [to]
      )
      const number = rows[0]
      if (!number) {
        logger.error('call to an unregistered number', { to })
        throw HttpError.notFound('This number is not in service.')
      }

      const { rows: created } = await deps.db.query<{ id: string }>(
        `INSERT INTO calls (tenant_id, twilio_call_sid, phone_number_id, from_e164, to_e164, language)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id`,
        [number.tenant_id, callSid, number.id, from, to, number.language]
      )

      const record: CallRecord = {
        id: created[0]!.id,
        tenantId: number.tenant_id,
        callSid,
        fromE164: from,
        language: number.language,
        startedAt: Date.now(),
      }

      const session = new CallSession(record, {
        ...deps.sessionDeps,
        db: deps.db,
        logger: logger.child({ callId: record.id }),
        policy: DEFAULT_PAYWALL_POLICY,
      })
      sessions.set(callSid, session)

      await session.handle({ type: 'call_answered', atMs: 0 })

      // The recording announcement is the first thing the caller hears, before any
      // recording starts (#5).
      const response = new twilio.twiml.VoiceResponse()
      response.say(
        { language: number.language === 'es' ? 'es-US' : 'en-US' },
        scriptFor('recording_notice', number.language)
      )
      response.record({ playBeep: false, recordingStatusCallback: '/twilio/recording' })
      response.redirect('/twilio/stream')

      res.type('text/xml').send(response.toString())
    })
  )

  /** Call completion. Guarantees an outcome is written (#1). */
  app.post(
    '/twilio/status',
    twiml,
    verify,
    asyncHandler(async (req, res) => {
      const body = req.body as Record<string, string | undefined>
      const callSid = required(body, 'CallSid')
      const session = sessions.get(callSid)

      if (session) {
        if (session.state.state !== 'ended') {
          await session.handle({
            type: 'caller_hung_up',
            atMs: Number(body.CallDuration ?? 0) * 1000,
          })
        }
        sessions.delete(callSid)
      } else {
        // No in-memory session — a restart mid-call. The call row must still get an
        // outcome, or the north-star metric quietly loses a row.
        await deps.db.query(
          `UPDATE calls
              SET state = 'ended',
                  outcome = COALESCE(outcome, 'abandoned'::call_outcome),
                  ended_at = COALESCE(ended_at, now()),
                  duration_seconds = COALESCE(duration_seconds, $2)
            WHERE twilio_call_sid = $1 AND state <> 'ended'`,
          [callSid, Number(body.CallDuration ?? 0)]
        )
      }

      res.type('text/xml').send('<Response/>')
    })
  )

  app.use(notFoundHandler())
  app.use(errorHandler())
  return app
}

async function main(): Promise<void> {
  assertComplianceGate()
  // Draft scripts are fine in staging. Once the gate opens they are not.
  assertScriptsUsable(readComplianceState().reviewComplete)

  const db = new pg.Pool({
    host: process.env.PGHOST ?? 'localhost',
    port: Number(process.env.PGPORT ?? 5432),
    database: process.env.PGDATABASE ?? 'justicedesk',
    user: process.env.PGUSER ?? 'justicedesk',
    password: readSecret(process.env.PGPASSWORD_VAULT_KEY ?? 'postgres_password', {
      allowEnvFallback: true,
    }),
  })

  const authToken = readSecret(process.env.TWILIO_AUTH_TOKEN_VAULT_KEY ?? 'twilio_auth_token', {
    allowEnvFallback: true,
  })
  const aiGatewayToken = readSecret(
    process.env.AI_GATEWAY_SERVICE_TOKEN_VAULT_KEY ?? 'ai_gateway_service_token',
    { allowEnvFallback: true }
  )
  const aiGatewayUrl = process.env.AI_GATEWAY_BASE_URL ?? 'http://localhost:4102'
  const apiUrl = process.env.API_BASE_URL ?? 'http://localhost:4101'
  const internalToken = readSecret(
    process.env.INTERNAL_SERVICE_TOKEN_VAULT_KEY ?? 'internal_service_token',
    { allowEnvFallback: true }
  )
  const smsEnabled = process.env.SMS_SENDING_ENABLED === 'true'

  const app = createApp({
    db,
    authToken,
    publicBaseUrl: process.env.VOICE_PUBLIC_BASE_URL ?? 'http://localhost:4103',
    sessionDeps: {
      // Through svc-ai-gateway, never the legal gateway directly — see session.ts.
      ask: async ({ question }) => {
        const response = await fetch(`${aiGatewayUrl}/v1/assistant/message`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-service-token': aiGatewayToken,
            // Runs this call under the justice_desk_voice gateway identity, so voice
            // volume cannot exhaust the web app's rate-limit budget. Same guardrails.
            'x-app-surface': 'voice',
          },
          body: JSON.stringify({ question, grounding: {} }),
        })
        if (!response.ok) throw HttpError.unavailable('The assistant is unavailable.')
        return ((await response.json()) as { reply: string }).reply
      },
      say: async () => {
        /* Media Streams TTS — wired in step 2 with the realtime audio path. */
      },
      sendSms: async (to) => {
        if (!smsEnabled) {
          logger.info('sms suppressed (SMS_SENDING_ENABLED is not true)', { to: '[OMITTED]' })
          return
        }
        logger.info('sms send requested')
      },
      createPaymentLink: async ({ callId, kind, amountCents }) => {
        // The amount is NOT sent. svc-api reads the price from the fee schedule by key,
        // so a bug or a compromise here cannot invent a price for a caller.
        const feeKey =
          kind === 'metered'
            ? 'call.per_minute'
            : kind === 'flat_session'
              ? 'call.flat_session'
              : 'document.one_shot'

        const response = await fetch(`${apiUrl}/v1/internal/calls/${callId}/payment-link`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-service-token': internalToken },
          body: JSON.stringify({ feeKey }),
        })
        if (!response.ok) {
          // While the compliance gate is closed every fee is draft, so this is the
          // expected path in staging rather than a fault.
          logger.warn('payment link unavailable', { callId, feeKey, status: response.status })
          throw HttpError.unavailable('Payments are not available right now.')
        }
        const { url } = (await response.json()) as { url: string }
        logger.info('payment link created', { callId, feeKey, amountCents })
        return url
      },
    },
  })

  const port = Number(process.env.VOICE_PORT ?? 4103)
  app.listen(port, () => {
    logger.info('svc-voice listening', {
      port,
      scriptStatus: SCRIPT_STATUS,
      smsEnabled,
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
