import { readSecret, readSecretOptional } from '@justicedesk/shared'

/**
 * Model selection.
 *
 * The build spec names `claude-sonnet-4-6`, so that is the default. It is configurable
 * because model choice is an operational decision, not a code one.
 *
 * Note for whoever revisits this: `claude-sonnet-4-6` is the previous-generation Sonnet;
 * `claude-sonnet-5` is current and materially stronger on instruction-following, which is
 * what the UPL guardrails depend on. Worth benchmarking against the guardrail test set
 * before Phase 2. Changing the model invalidates the prompt cache on first use.
 */
export const DEFAULT_MODEL = 'claude-sonnet-4-6'

export interface GatewayConfig {
  port: number
  model: string
  maxTokens: number
  apiKey: string
  serviceToken: string
  /**
   * RBAC credential for the operator's shared legal gateway. Optional only so the
   * service can still boot in the explicit direct-Anthropic development mode.
   */
  legalGatewayToken: string | null
  /** Separate key for svc-voice so its call volume cannot exhaust the web app's budget. */
  legalGatewayVoiceToken: string | null
  /** Hard ceiling on a single assistant turn, independent of model behaviour. */
  requestTimeoutMs: number
}

export function loadConfig(): GatewayConfig {
  return {
    port: Number(process.env.AI_GATEWAY_PORT ?? 4102),
    model: process.env.ANTHROPIC_MODEL ?? DEFAULT_MODEL,
    maxTokens: Number(process.env.ANTHROPIC_MAX_TOKENS ?? 16000),
    apiKey: readSecret(process.env.ANTHROPIC_API_KEY_VAULT_KEY ?? 'anthropic_api_key', {
      allowEnvFallback: true,
    }),
    serviceToken: readSecret(
      process.env.AI_GATEWAY_SERVICE_TOKEN_VAULT_KEY ?? 'ai_gateway_service_token',
      { allowEnvFallback: true }
    ),
    legalGatewayToken: readSecretOptional(
      process.env.LEGAL_GATEWAY_TOKEN_VAULT_KEY ?? 'legal_gateway_key',
      { allowEnvFallback: true }
    ),
    legalGatewayVoiceToken: readSecretOptional(
      process.env.LEGAL_GATEWAY_VOICE_TOKEN_VAULT_KEY ?? 'legal_gateway_voice_key',
      { allowEnvFallback: true }
    ),
    requestTimeoutMs: Number(process.env.AI_GATEWAY_TIMEOUT_MS ?? 120_000),
  }
}
