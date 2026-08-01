/**
 * Gateway routes.
 *
 * Every route that returns model output returns a `GuardrailResult`, never raw text.
 * svc-api persists the flag rows and decides what the litigant sees.
 *
 * This service is internal. It is not exposed publicly and authenticates callers with a
 * shared service token — it must never be reachable from a browser, because it is the
 * one place raw model output exists.
 */

import { asyncHandler, HttpError, guardrailOutcomes, uplFlags, citationViolations } from '@justicedesk/service-kit'
import {
  CitationLibrary,
  defaultDisclosureConfig,
  isValidDate,
  type CuratedCitation,
} from '@justicedesk/shared'
import { Router, type RequestHandler } from 'express'
import type { AnthropicGateway } from './anthropic.js'
import type { Classifier } from './guardrails/classifier.js'
import { applyGuardrails, flagRowsFor, type Surface } from './guardrails/pipeline.js'
import {
  buildAssistantSystem,
  INTAKE_SYSTEM_PROMPT,
  INTERVIEW_DRAFTING_SYSTEM_PROMPT,
  type GroundingContext,
} from './guardrails/systemPrompts.js'

export interface RouteDeps {
  gateway: AnthropicGateway
  classifier: Classifier
  serviceToken: string
}

/** Require the shared service token. Rejects browsers and anything else public. */
export function serviceAuth(expected: string): RequestHandler {
  return (req, _res, next) => {
    const presented = req.header('x-service-token')
    if (!presented || presented.length !== expected.length) {
      next(HttpError.unauthorized('This service is internal.'))
      return
    }
    // Constant-time-ish: compare every byte regardless of early mismatch.
    let diff = 0
    for (let i = 0; i < expected.length; i++) {
      diff |= presented.charCodeAt(i) ^ expected.charCodeAt(i)
    }
    if (diff !== 0) {
      next(HttpError.unauthorized('This service is internal.'))
      return
    }
    next()
  }
}

function recordMetrics(surface: Surface | 'ocr', result: ReturnType<typeof flagRowsFor> extends never ? never : Awaited<ReturnType<typeof applyGuardrails>>): void {
  guardrailOutcomes.inc({ surface, outcome: result.outcome })
  for (const f of result.findings) uplFlags.inc({ code: f.code, severity: f.severity })
  for (const v of result.citationViolations) citationViolations.inc({ kind: v.kind, surface })
}

function requireString(body: Record<string, unknown>, field: string, max = 8000): string {
  const value = body[field]
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw HttpError.badRequest(`"${field}" is required.`)
  }
  if (value.length > max) {
    throw HttpError.badRequest(`"${field}" is too long (limit ${max} characters).`)
  }
  return value
}

// ---------------------------------------------------------------- intake

const INTAKE_TOOL = {
  name: 'record_classification',
  description: 'Record which JusticeDesk case type this person’s situation matches.',
  input_schema: {
    type: 'object',
    properties: {
      case_type: {
        type: 'string',
        enum: ['debt_defense', 'small_claims', 'eviction_tenant', 'unsupported', 'need_more_info'],
      },
      role: { type: 'string', enum: ['plaintiff', 'defendant', 'unknown'] },
      jurisdiction_hint: {
        type: 'string',
        description: 'County or court named by the person, or "unknown".',
      },
      key_deadline_mentioned: {
        type: 'string',
        description: 'A date the person mentioned, as YYYY-MM-DD, or "none".',
      },
      confidence: { type: 'number' },
      next_question: {
        type: 'string',
        description:
          'If more information is needed, the single next question to ask, in plain language. Otherwise an empty string.',
      },
      summary: {
        type: 'string',
        description: 'One or two plain-language sentences restating the situation, with no legal conclusions.',
      },
    },
    required: ['case_type', 'role', 'jurisdiction_hint', 'key_deadline_mentioned', 'confidence', 'next_question', 'summary'],
  },
}

export interface IntakeClassification {
  caseType: 'debt_defense' | 'small_claims' | 'eviction_tenant' | 'unsupported' | 'need_more_info'
  role: 'plaintiff' | 'defendant' | 'unknown'
  jurisdictionHint: string
  keyDeadlineMentioned: string | null
  confidence: number
  nextQuestion: string
  summary: string
}

const CASE_TYPES = new Set(['debt_defense', 'small_claims', 'eviction_tenant', 'unsupported', 'need_more_info'])
const ROLES = new Set(['plaintiff', 'defendant', 'unknown'])

export function parseIntake(input: unknown): IntakeClassification {
  const raw = (input ?? {}) as Record<string, unknown>
  const caseType = String(raw.case_type ?? 'need_more_info')
  const role = String(raw.role ?? 'unknown')
  const deadline = String(raw.key_deadline_mentioned ?? 'none')
  const confidence = Number(raw.confidence)

  return {
    caseType: (CASE_TYPES.has(caseType) ? caseType : 'need_more_info') as IntakeClassification['caseType'],
    role: (ROLES.has(role) ? role : 'unknown') as IntakeClassification['role'],
    jurisdictionHint: String(raw.jurisdiction_hint ?? 'unknown').slice(0, 120),
    // Only accept a real calendar date. A malformed one becomes null rather than
    // propagating into the deadline engine as an anchor.
    keyDeadlineMentioned: isValidDate(deadline) ? deadline : null,
    confidence: Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : 0,
    nextQuestion: String(raw.next_question ?? '').slice(0, 500),
    summary: String(raw.summary ?? '').slice(0, 1000),
  }
}

// ---------------------------------------------------------------- OCR

const SUMMONS_TOOL = {
  name: 'record_summons_fields',
  description: 'Record the fields readable from a photograph of court papers.',
  input_schema: {
    type: 'object',
    properties: {
      court_case_number: { type: 'string', description: 'Case number, or empty string if not legible.' },
      court_name: { type: 'string' },
      county: { type: 'string' },
      plaintiff_name: { type: 'string' },
      defendant_name: { type: 'string' },
      hearing_date: { type: 'string', description: 'YYYY-MM-DD, or empty string.' },
      summons_issued_date: { type: 'string', description: 'YYYY-MM-DD, or empty string.' },
      served_date: { type: 'string', description: 'YYYY-MM-DD, or empty string.' },
      amount_claimed: { type: 'string', description: 'Digits only, or empty string.' },
      document_type: { type: 'string' },
      legibility_notes: {
        type: 'string',
        description: 'Anything unreadable, cut off, or ambiguous. Say so rather than guessing.',
      },
    },
    required: [
      'court_case_number',
      'court_name',
      'county',
      'plaintiff_name',
      'defendant_name',
      'hearing_date',
      'summons_issued_date',
      'served_date',
      'amount_claimed',
      'document_type',
      'legibility_notes',
    ],
  },
}

export interface SummonsExtraction {
  courtCaseNumber: string | null
  courtName: string | null
  county: string | null
  plaintiffName: string | null
  defendantName: string | null
  hearingDate: string | null
  summonsIssuedDate: string | null
  servedDate: string | null
  amountClaimedCents: number | null
  documentType: string | null
  legibilityNotes: string
  /** Always true. Every OCR field is confirmed by the litigant on S4 before it is used. */
  requiresConfirmation: true
}

const str = (v: unknown): string | null => {
  const s = typeof v === 'string' ? v.trim() : ''
  return s.length ? s.slice(0, 200) : null
}
const date = (v: unknown): string | null => {
  const s = typeof v === 'string' ? v.trim() : ''
  return isValidDate(s) ? s : null
}

export function parseSummons(input: unknown): SummonsExtraction {
  const raw = (input ?? {}) as Record<string, unknown>
  const amountDigits = String(raw.amount_claimed ?? '').replace(/[^\d]/g, '')

  return {
    courtCaseNumber: str(raw.court_case_number),
    courtName: str(raw.court_name),
    county: str(raw.county),
    plaintiffName: str(raw.plaintiff_name),
    defendantName: str(raw.defendant_name),
    hearingDate: date(raw.hearing_date),
    summonsIssuedDate: date(raw.summons_issued_date),
    servedDate: date(raw.served_date),
    amountClaimedCents: amountDigits ? Number(amountDigits) * 100 : null,
    documentType: str(raw.document_type),
    legibilityNotes: String(raw.legibility_notes ?? '').slice(0, 1000),
    requiresConfirmation: true,
  }
}

const OCR_SYSTEM = `You read photographs of North Carolina court papers and transcribe the fields on them.

You transcribe. You do not interpret, advise, or explain what the document means.

If a field is blurry, cut off, covered, or you are not certain, leave it empty and say so in legibility_notes. A wrong case number or a wrong date is far worse than a blank one — the person will be shown these fields to confirm, and a plausible-looking wrong date could cause them to miss a hearing.

Dates must be YYYY-MM-DD. If a date is ambiguous (for example you cannot tell day from month), leave it empty and note the ambiguity.`

// ---------------------------------------------------------------- router

export function createRoutes(deps: RouteDeps): Router {
  const router = Router()
  const disclosure = defaultDisclosureConfig()

  router.use(serviceAuth(deps.serviceToken))

  /**
   * Intake classification. No grounding block — no case exists yet — and no guardrail
   * pipeline, because the output is structured data rather than prose shown to the
   * litigant. The one free-text field it returns (`summary`) is scanned before use.
   */
  router.post(
    '/v1/intake/classify',
    asyncHandler(async (req, res) => {
      const body = req.body as Record<string, unknown>
      const transcript = body.transcript
      if (!Array.isArray(transcript) || transcript.length === 0) {
        throw HttpError.badRequest('"transcript" must be a non-empty array of messages.')
      }

      const messages = transcript.slice(-20).map((m) => {
        const entry = m as Record<string, unknown>
        return {
          role: entry.role === 'assistant' ? ('assistant' as const) : ('user' as const),
          content: String(entry.content ?? '').slice(0, 4000),
        }
      })

      const { value, usage } = await deps.gateway.callTool({
        system: [{ type: 'text', text: INTAKE_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
        messages,
        tool: INTAKE_TOOL,
        validate: parseIntake,
      })

      // The summary is prose the litigant will read back, so it goes through the pipeline.
      const guarded = await applyGuardrails(value.summary, {
        surface: 'intake',
        library: new CitationLibrary(),
        disclosure,
        citationPolicy: 'strip',
        classifier: deps.classifier,
        omitDisclosure: true,
      })
      recordMetrics('intake', guarded)

      res.json({
        classification: { ...value, summary: guarded.text ?? '' },
        guardrail: { outcome: guarded.outcome, requiresReview: guarded.requiresReview },
        flags: flagRowsFor(guarded),
        usage,
      })
    })
  )

  /**
   * The case-aware assistant (S11). Answers only from the grounding block: this case's
   * workflow definition, its already-computed deadlines, and its template library.
   */
  router.post(
    '/v1/assistant/message',
    asyncHandler(async (req, res) => {
      const body = req.body as Record<string, unknown>
      const question = requireString(body, 'question', 4000)
      const grounding = body.grounding as GroundingContext | undefined
      if (!grounding?.definition || !grounding.currentStageKey) {
        throw HttpError.badRequest('"grounding" must include the case workflow definition and current stage.')
      }

      const history = Array.isArray(body.history)
        ? (body.history as Array<Record<string, unknown>>).slice(-10).map((m) => ({
            role: m.role === 'assistant' ? ('assistant' as const) : ('user' as const),
            content: String(m.content ?? '').slice(0, 4000),
          }))
        : []

      const { text, usage } = await deps.gateway.complete({
        system: buildAssistantSystem(grounding),
        messages: [...history, { role: 'user', content: question }],
      })

      const library = new CitationLibrary(
        (grounding.sources ?? []).map(
          (s): CuratedCitation => ({ citation: s.citation, kind: 'statute', summary: s.summary })
        )
      )

      const guarded = await applyGuardrails(text, {
        surface: 'assistant',
        library,
        disclosure,
        citationPolicy: 'strip',
        classifier: deps.classifier,
        question,
      })
      recordMetrics('assistant', guarded)

      res.json({
        reply: guarded.text ?? guarded.blockedMessage,
        guardrail: {
          outcome: guarded.outcome,
          requiresReview: guarded.requiresReview,
          reasons: guarded.reviewReasons,
        },
        flags: flagRowsFor(guarded),
        usage,
      })
    })
  )

  /**
   * Interview drafting. Turns the litigant's own answers into document prose.
   *
   * Citation policy is `reject`, not `strip`: this text is destined for a court filing.
   */
  router.post(
    '/v1/interview/draft',
    asyncHandler(async (req, res) => {
      const body = req.body as Record<string, unknown>
      const sectionPrompt = requireString(body, 'sectionPrompt', 4000)
      const answers = body.answers
      if (!answers || typeof answers !== 'object') {
        throw HttpError.badRequest('"answers" must be an object of interview answers.')
      }
      const grounding = body.grounding as GroundingContext | undefined

      const sources = (grounding?.sources ?? [])
        .map((s) => `- ${s.citation} — ${s.summary}`)
        .join('\n')

      const { text, usage } = await deps.gateway.complete({
        system: [
          { type: 'text', text: INTERVIEW_DRAFTING_SYSTEM_PROMPT },
          {
            type: 'text',
            text: `SOURCES — the ONLY authorities you may cite\n${sources || '- None. Do not cite anything.'}`,
            cache_control: { type: 'ephemeral' },
          },
        ],
        messages: [
          {
            role: 'user',
            content: `Section to write:\n${sectionPrompt}\n\nThe person's answers:\n${JSON.stringify(answers, null, 2)}\n\nWrite only this section.`,
          },
        ],
      })

      const library = new CitationLibrary(
        (grounding?.sources ?? []).map(
          (s): CuratedCitation => ({ citation: s.citation, kind: 'statute', summary: s.summary })
        )
      )

      const guarded = await applyGuardrails(text, {
        surface: 'interview_draft',
        library,
        disclosure,
        citationPolicy: 'reject',
        classifier: deps.classifier,
        // The document carries the template's own disclosure; a chat footer inside a
        // court filing would be wrong.
        omitDisclosure: true,
      })
      recordMetrics('interview_draft', guarded)

      res.json({
        draft: guarded.text,
        blockedMessage: guarded.blockedMessage,
        guardrail: {
          outcome: guarded.outcome,
          requiresReview: guarded.requiresReview,
          reasons: guarded.reviewReasons,
        },
        flags: flagRowsFor(guarded),
        usage,
      })
    })
  )

  /** Summons OCR (S3 → S4). Transcription only; the litigant confirms every field. */
  router.post(
    '/v1/ocr/summons',
    asyncHandler(async (req, res) => {
      const body = req.body as Record<string, unknown>
      const imageBase64 = requireString(body, 'imageBase64', 8_000_000)
      const mediaType = String(body.mediaType ?? 'image/jpeg')
      if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(mediaType)) {
        throw HttpError.badRequest('Unsupported image type. Use a JPEG, PNG, WebP or GIF photo.')
      }

      const { value, usage } = await deps.gateway.callTool({
        system: [{ type: 'text', text: OCR_SYSTEM, cache_control: { type: 'ephemeral' } }],
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: mediaType, data: imageBase64 } },
              { type: 'text', text: 'Transcribe the fields you can read from these court papers.' },
            ],
          },
        ],
        tool: SUMMONS_TOOL,
        validate: parseSummons,
      })

      res.json({ extraction: value, usage })
    })
  )

  return router
}
