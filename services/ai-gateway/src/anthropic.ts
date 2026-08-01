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

function usageOf(usage: Anthropic.Usage | undefined): ModelUsage {
  return {
    inputTokens: usage?.input_tokens ?? 0,
    outputTokens: usage?.output_tokens ?? 0,
    cacheReadTokens: usage?.cache_read_input_tokens ?? 0,
    cacheCreationTokens: usage?.cache_creation_input_tokens ?? 0,
  }
}

export class AnthropicGateway {
  private readonly client: Anthropic
  private readonly config: GatewayConfig

  constructor(config: GatewayConfig, client?: Anthropic) {
    this.config = config
    this.client =
      client ??
      new Anthropic({
        apiKey: config.apiKey,
        timeout: config.requestTimeoutMs,
        maxRetries: 2,
      })
  }

  /** A plain text completion. */
  async complete(params: {
    system: SystemBlock[]
    messages: ModelMessage[]
    maxTokens?: number
  }): Promise<TextResult> {
    try {
      const response = await this.client.messages.create({
        model: this.config.model,
        max_tokens: params.maxTokens ?? this.config.maxTokens,
        // Adaptive thinking: the model decides how much reasoning a turn needs. Fixed
        // token budgets are deprecated on this model family.
        thinking: { type: 'adaptive' },
        system: params.system as Anthropic.TextBlockParam[],
        messages: params.messages as Anthropic.MessageParam[],
      })

      const text = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('')

      return { text, usage: usageOf(response.usage), stopReason: response.stop_reason ?? null }
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
      const response = await this.client.messages.create({
        model: this.config.model,
        max_tokens: params.maxTokens ?? 4096,
        thinking: { type: 'adaptive' },
        system: params.system as Anthropic.TextBlockParam[],
        messages: params.messages as Anthropic.MessageParam[],
        tools: [params.tool as Anthropic.Tool],
        tool_choice: { type: 'tool', name: params.tool.name },
      })

      const call = response.content.find(
        (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && b.name === params.tool.name
      )
      if (!call) {
        throw HttpError.unavailable('The assistant did not return a usable answer. Please try again.')
      }

      return { value: params.validate(call.input), usage: usageOf(response.usage) }
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
