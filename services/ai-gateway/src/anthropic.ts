/**
 * Anthropic client wrapper.
 *
 * Everything the gateway sends to the model goes through here, so timeouts, retries and
 * usage accounting live in one place. Nothing in this file decides what is safe to return
 * to a litigant — that is the guardrail pipeline's job, and no route calls this directly
 * without passing the result through it.
 */

import Anthropic from '@anthropic-ai/sdk'
import { HttpError } from '@justicedesk/service-kit'
import type { GatewayConfig } from './config.js'
import type { ModelTransport, PolicyProfile } from './transport.js'

export interface SystemBlock {
  type: 'text'
  text: string
  cache_control?: { type: 'ephemeral' }
}

export interface ModelMessage {
  role: 'user' | 'assistant'
  content: string | Array<Record<string, unknown>>
}

export interface ModelUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
}

export interface TextResult {
  text: string
  usage: ModelUsage
  stopReason: string | null
}

export interface ToolResult<T> {
  value: T
  usage: ModelUsage
}

export class AnthropicGateway {
  private readonly transport: ModelTransport
  private readonly config: GatewayConfig
  private readonly profile: PolicyProfile

  /**
   * Takes a `ModelTransport` rather than an Anthropic client so the shared legal gateway
   * and the direct path are interchangeable — see transport.ts. Nothing above this class
   * knows or cares which one is in use.
   */
  constructor(config: GatewayConfig, transport: ModelTransport, profile: PolicyProfile = 'prose_platform') {
    this.config = config
    this.transport = transport
    this.profile = profile
  }

  /** A new instance bound to a different policy profile (svc-voice uses its own). */
  withProfile(profile: PolicyProfile): AnthropicGateway {
    return new AnthropicGateway(this.config, this.transport, profile)
  }

  /** A plain text completion. */
  async complete(params: {
    system: SystemBlock[]
    messages: ModelMessage[]
    maxTokens?: number
  }): Promise<TextResult> {
    try {
      const response = await this.transport.send({
        model: this.config.model,
        maxTokens: params.maxTokens ?? this.config.maxTokens,
        // Adaptive thinking: the model decides how much reasoning a turn needs. Fixed
        // token budgets are deprecated on this model family.
        thinking: { type: 'adaptive' },
        system: params.system,
        messages: params.messages,
        profile: this.profile,
      })

      return { text: response.text, usage: response.usage, stopReason: response.stopReason }
    } catch (err) {
      throw translateAnthropicError(err)
    }
  }

  /**
   * Force a single tool call and return its validated input.
   *
   * Used wherever the gateway needs structured data (intake classification, the UPL
   * classifier, OCR extraction). Tool use rather than a JSON output format because the
   * configured model predates the structured-outputs feature; `validate` therefore does
   * the schema enforcement on our side rather than trusting the shape.
   */
  async callTool<T>(params: {
    system: SystemBlock[]
    messages: ModelMessage[]
    tool: { name: string; description: string; input_schema: Record<string, unknown> }
    validate: (input: unknown) => T
    maxTokens?: number
  }): Promise<ToolResult<T>> {
    try {
      const response = await this.transport.send({
        model: this.config.model,
        maxTokens: params.maxTokens ?? 4096,
        thinking: { type: 'adaptive' },
        system: params.system,
        messages: params.messages,
        tools: [params.tool as unknown as Record<string, unknown>],
        toolChoice: { type: 'tool', name: params.tool.name },
        profile: this.profile,
      })

      const call = response.toolUses.find((t) => t.name === params.tool.name)
      if (!call) {
        throw HttpError.unavailable('The assistant did not return a usable answer. Please try again.')
      }

      return { value: params.validate(call.input), usage: response.usage }
    } catch (err) {
      throw translateAnthropicError(err)
    }
  }
}

/**
 * Map provider failures onto our own error surface.
 *
 * Upstream messages are never forwarded verbatim: they can carry request detail, and a
 * litigant reading "rate_limit_error on org …" learns nothing useful and something they
 * should not see.
 */
export function translateAnthropicError(err: unknown): HttpError {
  if (err instanceof HttpError) return err

  if (err instanceof Anthropic.APIError) {
    if (err.status === 429) {
      return HttpError.tooManyRequests(
        'The assistant is busy right now. Please wait a moment and try again.'
      )
    }
    if (err.status === 401 || err.status === 403) {
      // A credential problem is ours, not the caller's — do not imply they did anything wrong.
      return HttpError.unavailable('The assistant is unavailable right now. Please try again shortly.')
    }
    if (err.status && err.status >= 500) {
      return HttpError.unavailable('The assistant is temporarily unavailable. Please try again.')
    }
    return HttpError.unavailable('The assistant could not answer that right now. Please try again.')
  }

  if (err instanceof Anthropic.APIConnectionError || err instanceof Anthropic.APIConnectionTimeoutError) {
    return HttpError.unavailable('The assistant took too long to respond. Please try again.')
  }

  return HttpError.internal()
}
