/**
 * Client for svc-ai-gateway.
 *
 * The API never calls Anthropic directly. Everything goes through the gateway so the
 * guardrail layer cannot be bypassed by adding a route here.
 */

import { HttpError } from '@justicedesk/service-kit'
import type { ApiConfig } from './config.js'

export interface GuardrailEnvelope {
  outcome: 'passed' | 'repaired' | 'blocked'
  requiresReview: boolean
  reasons?: string[]
}

export interface FlagRow {
  code: string
  severity: 'block' | 'review' | 'note'
  reason: string
  excerpt: string | null
  blocked: boolean
}

export interface AssistantResponse {
  reply: string
  guardrail: GuardrailEnvelope
  flags: FlagRow[]
}

export interface IntakeResponse {
  classification: {
    caseType: 'debt_defense' | 'small_claims' | 'eviction_tenant' | 'unsupported' | 'need_more_info'
    role: 'plaintiff' | 'defendant' | 'unknown'
    jurisdictionHint: string
    keyDeadlineMentioned: string | null
    confidence: number
    nextQuestion: string
    summary: string
  }
  guardrail: GuardrailEnvelope
  flags: FlagRow[]
}

export interface DraftResponse {
  draft: string | null
  blockedMessage: string | null
  guardrail: GuardrailEnvelope
  flags: FlagRow[]
}

export interface SummonsResponse {
  extraction: Record<string, unknown> & { requiresConfirmation: true }
}

export class AiGatewayClient {
  constructor(private readonly config: ApiConfig) {}

  private async post<T>(path: string, body: unknown): Promise<T> {
    let response: Response
    try {
      response = await fetch(`${this.config.aiGatewayBaseUrl}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-service-token': this.config.aiGatewayServiceToken,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(180_000),
      })
    } catch {
      throw HttpError.unavailable('The assistant is unavailable right now. Please try again.')
    }

    if (!response.ok) {
      // Surface the gateway's user-safe message when it has one; never its internals.
      const detail = (await response.json().catch(() => null)) as
        | { error?: { message?: string } }
        | null
      const message = detail?.error?.message
      if (response.status === 429) throw HttpError.tooManyRequests(message)
      throw HttpError.unavailable(message ?? 'The assistant could not answer right now.')
    }

    return (await response.json()) as T
  }

  classifyIntake(transcript: Array<{ role: string; content: string }>): Promise<IntakeResponse> {
    return this.post('/v1/intake/classify', { transcript })
  }

  askAssistant(params: {
    question: string
    grounding: unknown
    history?: Array<{ role: string; content: string }>
  }): Promise<AssistantResponse> {
    return this.post('/v1/assistant/message', params)
  }

  draftSection(params: {
    sectionPrompt: string
    answers: Record<string, unknown>
    grounding?: unknown
  }): Promise<DraftResponse> {
    return this.post('/v1/interview/draft', params)
  }

  readSummons(params: { imageBase64: string; mediaType: string }): Promise<SummonsResponse> {
    return this.post('/v1/ocr/summons', params)
  }
}
