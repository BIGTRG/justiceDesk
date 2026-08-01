/**
 * Secret loading.
 *
 * Secrets live in /opt/credential-vault as one file per secret. Nothing is ever read from
 * a committed file, and no secret is ever logged. `NEVER hardcode keys` from the spec is
 * enforced three ways: this loader, an ESLint rule on `sk-ant-` literals, and the
 * `.gitignore` on `.env`.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export class MissingSecretError extends Error {
  readonly key: string
  constructor(key: string, dir: string, cause?: unknown) {
    super(`Secret "${key}" not found in credential vault at ${dir}. See README.md "Secrets".`)
    this.name = 'MissingSecretError'
    this.key = key
    this.cause = cause
  }
}

export interface VaultOptions {
  dir?: string
  /**
   * When true, fall back to `process.env[KEY.toUpperCase()]` if the vault file is absent.
   * Development convenience only — refused when NODE_ENV is production or staging.
   */
  allowEnvFallback?: boolean
}

const cache = new Map<string, string>()

function vaultDir(opts: VaultOptions = {}): string {
  return opts.dir ?? process.env.CREDENTIAL_VAULT_DIR ?? '/opt/credential-vault'
}

function envFallbackPermitted(opts: VaultOptions): boolean {
  if (!opts.allowEnvFallback) return false
  const env = process.env.NODE_ENV
  return env !== 'production' && env !== 'staging'
}

/** Read a secret. Cached for process lifetime — rotation requires a restart, by design. */
export function readSecret(key: string, opts: VaultOptions = {}): string {
  const cached = cache.get(key)
  if (cached !== undefined) return cached

  const dir = vaultDir(opts)
  try {
    const value = readFileSync(join(dir, key), 'utf8').trim()
    if (!value) throw new Error('empty secret file')
    cache.set(key, value)
    return value
  } catch (err) {
    if (envFallbackPermitted(opts)) {
      const fromEnv = process.env[key.toUpperCase()]
      if (fromEnv) {
        cache.set(key, fromEnv)
        return fromEnv
      }
    }
    throw new MissingSecretError(key, dir, err)
  }
}

export function readSecretOptional(key: string, opts: VaultOptions = {}): string | null {
  try {
    return readSecret(key, opts)
  } catch (err) {
    if (err instanceof MissingSecretError) return null
    throw err
  }
}

/** Test-only. Clears the process-lifetime secret cache. */
export function __clearSecretCache(): void {
  cache.clear()
}

/**
 * Redact anything secret-shaped before it reaches a log line or an error report.
 * Applied by the structured logger in every service.
 */
const SECRET_SHAPES: RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{8,}/g,
  /sk_(?:live|test)_[A-Za-z0-9]{8,}/g,
  /whsec_[A-Za-z0-9]{8,}/g,
  /\bAC[a-f0-9]{32}\b/g, // Twilio account SID
  /\bSK[a-f0-9]{32}\b/g, // Twilio API key SID
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, // JWT
  /\b[A-Za-z0-9+/]{40}\b(?=\s*$|["',])/g, // long opaque tokens (MinIO secret keys)
]

export function redactSecrets(input: string): string {
  let out = input
  for (const shape of SECRET_SHAPES) out = out.replace(shape, '[REDACTED]')
  return out
}
