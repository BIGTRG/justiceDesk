/**
 * Model transport.
 *
 * v2 pre-flight rule 3: "Confirm ALL model calls route through the shared legal gateway
 * at 10.2.0.2 using the `prose_platform` policy profile. No direct Anthropic API calls
 * anywhere."
 *
 * Phase 1 called Anthropic directly. This module introduces the seam so the shared legal
 * gateway is the default and the direct path becomes an explicit, logged deviation.
 *
 * ┌─ WHAT IS VERIFIED ────────────────────────────────────────────────────────────┐
 * │ Nothing about the gateway's wire format. 10.2.0.2 is unreachable from the      │
 * │ build machine (no route; ping and ports 80/443/8080/4100 all fail), so the     │
 * │ request/response shape below is an ASSUMED contract, not a confirmed one.      │
 * │                                                                                │
 * │ Everything that needs correcting once the real contract is known is marked     │
 * │ `CONTRACT:` and is confined to this file. See HUMAN_REVIEW.md item G-1.        │
 * └────────────────────────────────────────────────────────────────────────────────┘
 *
 * The point of the seam is that `AnthropicGateway` and every route above it are already
 * written against `ModelTransport`. Correcting the contract is edits here, not a rewrite.
 */

import Anthropic from '@anthropic-ai/sdk'
import { HttpError, type Logger } from '@justicedesk/service-kit'
import type { ModelMessage, SystemBlock, ModelUsage } from './anthropic.js'

/** Policy profile registered on the shared gateway. */
export type PolicyProfile = 'prose_platform' | 'justice_desk_voice'

export interface TransportRequest {
  model: string
  maxTokens: number
  system: SystemBlock[]
  messages: ModelMessage[]
  tools?: Array<Record<string, unknown>>
  toolChoice?: { type: 'tool'; name: string }
  thinking?: { type: 'adaptive' }
  /** Which registered profile this call runs under. */
  profile: PolicyProfile
}

export interface TransportResponse {
  /** Concatenated text blocks. */
  text: string
  /** Tool-use blocks, if any. */
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
  /** e.g. http://10.2.0.2 — private network, never public. */
  baseUrl: string
  /** RBAC credential. Loaded from the credential vault, never a literal. */
  token: string
  /** Application identity registered on the gateway. */
  appId: string
  timeoutMs: number
}

/**
 * Client for the operator's shared legal gateway.
 *
 * The gateway owns policy enforcement centrally (RBAC + the policy profile), which is why
 * v2 requires every call to go through it — a second, separately-prompted brain for voice
 * is exactly the prompt drift non-negotiable #6 forbids.
 *
 * Note this does NOT replace the local guardrail pipeline. The gateway is an upstream
 * policy layer; `applyGuardrails` still runs on everything that comes back. Two
 * independent layers is the intent, not redundancy to be optimised away.
 */
export class SharedLegalGatewayTransport implements ModelTransport {
  readonly kind = 'shared_legal_gateway' as const

  constructor(
    private readonly config: SharedGatewayConfig,
    private readonly logger: Logger
  ) {}

  async send(request: TransportRequest): Promise<TransportResponse> {
    // CONTRACT: path. Assumed `/v1/messages`. Adjust to the real route.
    const url = `${this.config.baseUrl.replace(/\/$/, '')}/v1/messages`

    let response: Response
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          // CONTRACT: auth scheme. Assumed bearer. If the gateway uses an
          // `x-api-key` header or mTLS instead, change it here.
          authorization: `Bearer ${this.config.token}`,
          // CONTRACT: how app identity and profile are conveyed. Assumed headers.
          'x-app-id': this.config.appId,
          'x-policy-profile': request.profile,
        },
        // CONTRACT: body shape. Assumed Anthropic Messages-compatible with the profile
        // echoed in-body. If the gateway takes its own envelope, map it here.
        body: JSON.stringify({
          app_id: this.config.appId,
          policy_profile: request.profile,
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
      // 403 from an RBAC gateway means this app or profile is not permitted — an
      // operator problem, not a caller problem. Surface it as unavailable to the
      // litigant and loudly in the logs, so it is not mistaken for a model refusal.
      if (response.status === 401 || response.status === 403) {
        this.logger.error('legal gateway rejected our credentials or profile', {
          status: response.status,
          appId: this.config.appId,
          profile: request.profile,
        })
        throw HttpError.unavailable('The assistant is unavailable right now. Please try again.')
      }
      if (response.status === 429) {
        throw HttpError.tooManyRequests('The assistant is busy. Please wait a moment and try again.')
      }
      throw HttpError.unavailable('The assistant could not answer that right now. Please try again.')
    }

    // CONTRACT: response shape. Assumed Anthropic-compatible `content[]` + `usage`.
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
 * Retained ONLY so the platform still runs on a machine with no route to the private
 * network. It violates v2 pre-flight rule 3 and must not be the configuration that ships.
 * Selecting it requires an explicit opt-in and is logged as a deviation at every boot.
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
 * gateway URL fails to boot rather than silently bypassing the operator's policy layer,
 * because a silent bypass is precisely the failure v2 rule 3 exists to prevent.
 */
export function selectTransport(
  env: NodeJS.ProcessEnv,
  secrets: { anthropicApiKey: string; gatewayToken: string | null },
  logger: Logger
): TransportSelection {
  const baseUrl = env.LEGAL_GATEWAY_URL
  const timeoutMs = Number(env.LEGAL_GATEWAY_TIMEOUT_MS ?? 120_000)

  if (baseUrl) {
    if (!secrets.gatewayToken) {
      throw new Error(
        'LEGAL_GATEWAY_URL is set but no gateway credential was found. ' +
          'Add `legal_gateway_token` to the credential vault (RBAC credential for this app).'
      )
    }
    return {
      transport: new SharedLegalGatewayTransport(
        {
          baseUrl,
          token: secrets.gatewayToken,
          appId: env.LEGAL_GATEWAY_APP_ID ?? 'justice_desk',
          timeoutMs,
        },
        logger
      ),
      isDeviation: false,
      banner: `model transport: shared legal gateway (${baseUrl}, app=${env.LEGAL_GATEWAY_APP_ID ?? 'justice_desk'})`,
    }
  }

  if (env.ALLOW_DIRECT_ANTHROPIC === 'true') {
    return {
      transport: new DirectAnthropicTransport(secrets.anthropicApiKey, timeoutMs),
      isDeviation: true,
      banner:
        'model transport: DIRECT ANTHROPIC — deviates from v2 rule 3 ' +
        '(all model calls must route through the shared legal gateway). Development only.',
    }
  }

  throw new Error(
    'No model transport configured.\n' +
      '  Set LEGAL_GATEWAY_URL (plus a `legal_gateway_token` vault secret) to use the shared legal gateway.\n' +
      '  Or set ALLOW_DIRECT_ANTHROPIC=true to fall back to direct Anthropic calls — development only,\n' +
      '  and a deviation from v2 pre-flight rule 3.'
  )
}
