/**
 * Model transport.
 *
 * v2 pre-flight rule 3: all model calls route through the operator's shared legal
 * gateway. Phase 1 called Anthropic directly; this module is the seam.
 *
 * ┌─ WHAT THE GATEWAY ACTUALLY IS (confirmed by the operator; supersedes the spec) ──┐
 * │ It is an AUTHENTICATED PROXY, not a policy engine.                               │
 * │                                                                                   │
 * │   * No policy profiles. `prose_platform` does not exist.                         │
 * │   * No RBAC, no scopes, no roles — every registered app gets identical access.   │
 * │   * No guardrails of any kind.                                                   │
 * │   * The only control is a per-app rate limit (60–150 req/min).                   │
 * │   * App identity is carried by WHICH bearer key is sent. There is no x-app-id    │
 * │     header; the gateway maps key → app name internally.                          │
 * │                                                                                   │
 * │ THE CONSEQUENCE, AND IT IS LOAD-BEARING:                                         │
 * │ the guardrails in this service are not a second layer behind the gateway's.      │
 * │ They are the ONLY layer. Nothing upstream will catch unauthorized-practice        │
 * │ output, an uncurated citation, or a missing disclosure.                          │
 * │                                                                                   │
 * │ v2 non-negotiable #6 (voice shares the app's guardrail profile, no drift)        │
 * │ therefore CANNOT be satisfied at the gateway. It is satisfied by svc-voice       │
 * │ calling THIS service rather than the gateway directly. A voice agent wired       │
 * │ straight to 10.2.0.2 would have no guardrails at all.                            │
 * └───────────────────────────────────────────────────────────────────────────────────┘
 *
 * The wire contract below is confirmed, not assumed.
 */

import Anthropic from '@anthropic-ai/sdk'
import { HttpError, type Logger } from '@justicedesk/service-kit'
import type { ModelMessage, SystemBlock, ModelUsage } from './anthropic.js'

/**
 * Which registered app this call runs as.
 *
 * The v2 spec called this a policy profile, but the gateway has no profiles — identity is
 * simply which bearer key is sent, and the only behavioural difference is the rate limit
 * attached to that app name. Kept as a distinct type because the two surfaces still need
 * separate keys and separate rate-limit budgets: a busy call queue must not exhaust the
 * web app's allowance.
 */
export type AppIdentity = 'justice_desk' | 'justice_desk_voice'

/** @deprecated The gateway has no policy profiles. Use {@link AppIdentity}. */
export type PolicyProfile = AppIdentity

export interface TransportRequest {
  model: string
  maxTokens: number
  system: SystemBlock[]
  messages: ModelMessage[]
  tools?: Array<Record<string, unknown>>
  toolChoice?: { type: 'tool'; name: string }
  thinking?: { type: 'adaptive' }
  /** Which registered app this call runs as — selects the bearer key. */
  profile: AppIdentity
}

export interface TransportResponse {
  text: string
  toolUses: Array<{ name: string; input: unknown }>
  usage: ModelUsage
  stopReason: string | null
}

export interface ModelTransport {
  readonly kind: 'shared_legal_gateway' | 'direct_anthropic'
  send(request: TransportRequest): Promise<TransportResponse>
}

// ---------------------------------------------------------------- shared legal gateway

export interface SharedGatewayConfig {
  /** http://10.2.0.2:3500 — private network, never public. */
  baseUrl: string
  /**
   * One bearer key per registered app. The key IS the identity: the gateway maps it to an
   * app name and its rate limit. A missing key for a surface means that surface cannot
   * call the gateway at all, which is the intended failure.
   */
  keys: Partial<Record<AppIdentity, string>>
  timeoutMs: number
}

/**
 * Client for the operator's shared legal gateway.
 *
 * Routing through it buys centralised credential custody, per-app rate limiting, and a
 * single egress path to audit — worth having. It buys no policy enforcement, so it does
 * not reduce what `applyGuardrails` has to catch. See the file header.
 */
export class SharedLegalGatewayTransport implements ModelTransport {
  readonly kind = 'shared_legal_gateway' as const

  constructor(
    private readonly config: SharedGatewayConfig,
    private readonly logger: Logger
  ) {}

  async send(request: TransportRequest): Promise<TransportResponse> {
    // OpenAI-style route, Anthropic-shaped body. The mismatch is the gateway's and it is
    // deliberate on their side — do not "correct" this to /v1/messages.
    const url = `${this.config.baseUrl.replace(/\/$/, '')}/v1/chat/completions`

    const key = this.config.keys[request.profile]
    if (!key) {
      // Fail rather than silently borrowing another app's key: that would bill and
      // rate-limit the wrong surface and defeat the only isolation the gateway offers.
      this.logger.error('no gateway key registered for this app', { app: request.profile })
      throw HttpError.unavailable('The assistant is not configured for this surface.')
    }

    let response: Response
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          // The key alone carries identity. No x-app-id, no x-policy-profile —
          // neither exists on this gateway.
          authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({
          model: request.model,
          max_tokens: request.maxTokens,
          thinking: request.thinking,
          system: request.system,
          messages: request.messages,
          tools: request.tools,
          tool_choice: request.toolChoice,
        }),
        signal: AbortSignal.timeout(this.config.timeoutMs),
      })
    } catch (err) {
      this.logger.error('legal gateway unreachable', {
        baseUrl: this.config.baseUrl,
        err: err instanceof Error ? err : new Error(String(err)),
      })
      throw HttpError.unavailable('The assistant is unavailable right now. Please try again.')
    }

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        this.logger.error('legal gateway rejected our key', {
          status: response.status,
          app: request.profile,
          hint: 'Is this app registered in APP_KEYS on the gateway, and is the key current?',
        })
        throw HttpError.unavailable('The assistant is unavailable right now. Please try again.')
      }
      if (response.status === 429) {
        // Per-app rate limit (60–150 req/min). The surfaces have separate budgets, so
        // this is scoped to whichever one is hot.
        this.logger.warn('legal gateway rate limit hit', { app: request.profile })
        throw HttpError.tooManyRequests('The assistant is busy. Please wait a moment and try again.')
      }
      throw HttpError.unavailable('The assistant could not answer that right now. Please try again.')
    }

    // Anthropic-compatible response: id, content[], stop_reason, model.
    const payload = (await response.json()) as {
      content?: Array<{ type: string; text?: string; name?: string; input?: unknown }>
      usage?: Record<string, number>
      stop_reason?: string
    }

    const blocks = payload.content ?? []
    return {
      text: blocks
        .filter((b) => b.type === 'text')
        .map((b) => b.text ?? '')
        .join(''),
      toolUses: blocks
        .filter((b) => b.type === 'tool_use')
        .map((b) => ({ name: b.name ?? '', input: b.input })),
      usage: {
        inputTokens: payload.usage?.input_tokens ?? 0,
        outputTokens: payload.usage?.output_tokens ?? 0,
        cacheReadTokens: payload.usage?.cache_read_input_tokens ?? 0,
        cacheCreationTokens: payload.usage?.cache_creation_input_tokens ?? 0,
      },
      stopReason: payload.stop_reason ?? null,
    }
  }
}

// ---------------------------------------------------------------- direct (deviation)

/**
 * Direct Anthropic calls — the Phase 1 behaviour.
 *
 * Retained only so the platform runs on a machine with no route to the private network.
 * It bypasses the operator's egress path and per-app rate limiting, so it must not be the
 * configuration that ships. Selecting it requires an explicit opt-in and is logged as a
 * deviation at every boot.
 */
export class DirectAnthropicTransport implements ModelTransport {
  readonly kind = 'direct_anthropic' as const
  private readonly client: Anthropic

  constructor(apiKey: string, timeoutMs: number, client?: Anthropic) {
    this.client = client ?? new Anthropic({ apiKey, timeout: timeoutMs, maxRetries: 2 })
  }

  async send(request: TransportRequest): Promise<TransportResponse> {
    const response = await this.client.messages.create({
      model: request.model,
      max_tokens: request.maxTokens,
      thinking: request.thinking ?? { type: 'adaptive' },
      system: request.system as Anthropic.TextBlockParam[],
      messages: request.messages as Anthropic.MessageParam[],
      ...(request.tools ? { tools: request.tools as unknown as Anthropic.Tool[] } : {}),
      ...(request.toolChoice ? { tool_choice: request.toolChoice } : {}),
    })

    return {
      text: response.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join(''),
      toolUses: response.content
        .filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')
        .map((b) => ({ name: b.name, input: b.input })),
      usage: {
        inputTokens: response.usage?.input_tokens ?? 0,
        outputTokens: response.usage?.output_tokens ?? 0,
        cacheReadTokens: response.usage?.cache_read_input_tokens ?? 0,
        cacheCreationTokens: response.usage?.cache_creation_input_tokens ?? 0,
      },
      stopReason: response.stop_reason ?? null,
    }
  }
}

// ---------------------------------------------------------------- selection

export interface TransportSelection {
  transport: ModelTransport
  /** True when running in the non-compliant direct mode. */
  isDeviation: boolean
  banner: string
}

/**
 * Choose a transport from configuration.
 *
 * The shared gateway wins whenever it is configured. Falling back to direct Anthropic
 * requires setting `ALLOW_DIRECT_ANTHROPIC=true` deliberately — an unset or misspelled
 * gateway URL fails to boot rather than silently bypassing the operator's egress path.
 */
export function selectTransport(
  env: NodeJS.ProcessEnv,
  secrets: {
    anthropicApiKey: string
    gatewayToken: string | null
    gatewayVoiceToken?: string | null
  },
  logger: Logger
): TransportSelection {
  const baseUrl = env.LEGAL_GATEWAY_URL
  const timeoutMs = Number(env.LEGAL_GATEWAY_TIMEOUT_MS ?? 120_000)

  if (baseUrl) {
    if (!secrets.gatewayToken) {
      throw new Error(
        'LEGAL_GATEWAY_URL is set but no gateway key was found. Add `legal_gateway_key` ' +
          'to the credential vault — the value of APP_KEY_JUSTICE_DESK on the gateway.'
      )
    }

    const keys: Partial<Record<AppIdentity, string>> = { justice_desk: secrets.gatewayToken }
    // svc-voice runs as its own registered app so its call volume cannot exhaust the web
    // app's rate-limit budget. Absent until that key is issued on the gateway.
    if (secrets.gatewayVoiceToken) keys.justice_desk_voice = secrets.gatewayVoiceToken

    return {
      transport: new SharedLegalGatewayTransport({ baseUrl, keys, timeoutMs }, logger),
      isDeviation: false,
      banner:
        `model transport: shared legal gateway (${baseUrl}) — proxy only, no upstream ` +
        `policy enforcement; local guardrails are the only layer. ` +
        `apps: ${Object.keys(keys).join(', ')}`,
    }
  }

  if (env.ALLOW_DIRECT_ANTHROPIC === 'true') {
    return {
      transport: new DirectAnthropicTransport(secrets.anthropicApiKey, timeoutMs),
      isDeviation: true,
      banner:
        'model transport: DIRECT ANTHROPIC — bypasses the operator gateway and its ' +
        'per-app rate limiting. Development only.',
    }
  }

  throw new Error(
    'No model transport configured.\n' +
      '  Set LEGAL_GATEWAY_URL=http://10.2.0.2:3500 (plus a `legal_gateway_key` vault secret).\n' +
      '  Or set ALLOW_DIRECT_ANTHROPIC=true for direct Anthropic calls — development only.'
  )
}
