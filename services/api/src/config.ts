import { readSecret, readSecretOptional } from '@justicedesk/shared'

export interface ApiConfig {
  port: number
  clerkSecretKey: string
  aiGatewayBaseUrl: string
  aiGatewayServiceToken: string
  /** Shared token for service-to-service calls into svc-api (svc-voice, svc-referral). */
  internalServiceToken: string
  webBaseUrl: string
  minio: {
    endPoint: string
    port: number
    useSSL: boolean
    accessKey: string
    secretKey: string
    bucket: string
    signedUrlTtlSeconds: number
  }
  stripe: { secretKey: string | null; webhookSecret: string | null }
  redis: { host: string; port: number; password: string | null }
}

export function loadConfig(): ApiConfig {
  const envFallback = { allowEnvFallback: true }

  return {
    port: Number(process.env.API_PORT ?? 4101),
    clerkSecretKey: readSecret(process.env.CLERK_SECRET_KEY_VAULT_KEY ?? 'clerk_secret_key', envFallback),
    aiGatewayBaseUrl: process.env.AI_GATEWAY_BASE_URL ?? 'http://localhost:4102',
    aiGatewayServiceToken: readSecret(
      process.env.AI_GATEWAY_SERVICE_TOKEN_VAULT_KEY ?? 'ai_gateway_service_token',
      envFallback
    ),
    internalServiceToken: readSecret(
      process.env.INTERNAL_SERVICE_TOKEN_VAULT_KEY ?? 'internal_service_token',
      envFallback
    ),
    webBaseUrl: process.env.WEB_BASE_URL ?? 'http://localhost:3000',
    minio: {
      endPoint: process.env.MINIO_ENDPOINT ?? 'localhost',
      port: Number(process.env.MINIO_PORT ?? 9000),
      useSSL: process.env.MINIO_USE_SSL === 'true',
      accessKey: readSecret(process.env.MINIO_ACCESS_KEY_VAULT_KEY ?? 'minio_access_key', envFallback),
      secretKey: readSecret(process.env.MINIO_SECRET_KEY_VAULT_KEY ?? 'minio_secret_key', envFallback),
      bucket: process.env.MINIO_BUCKET ?? 'justicedesk-documents',
      // Short by design. Every issue is audit-logged, and a long-lived URL is a document
      // that has effectively left the vault.
      signedUrlTtlSeconds: Number(process.env.MINIO_SIGNED_URL_TTL_SECONDS ?? 300),
    },
    stripe: {
      secretKey: readSecretOptional(process.env.STRIPE_SECRET_KEY_VAULT_KEY ?? 'stripe_secret_key', envFallback),
      webhookSecret: readSecretOptional(
        process.env.STRIPE_WEBHOOK_SECRET_VAULT_KEY ?? 'stripe_webhook_secret',
        envFallback
      ),
    },
    redis: {
      host: process.env.REDIS_HOST ?? 'localhost',
      port: Number(process.env.REDIS_PORT ?? 6379),
      password: readSecretOptional(process.env.REDIS_PASSWORD_VAULT_KEY ?? 'redis_password', envFallback),
    },
  }
}
