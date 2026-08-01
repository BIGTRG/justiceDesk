/**
 * Post-call landing tokens.
 *
 * The link is texted to a phone. Whoever holds that phone — or is forwarded the message —
 * holds the capability. So this treats the token the way a password is treated, not the
 * way an ID is:
 *
 *   * 256 bits of entropy, so it cannot be guessed or enumerated;
 *   * stored as a SHA-256 hash, so a database leak yields no working links;
 *   * compared in constant time, so timing cannot be used to recover one;
 *   * expiring, so a forwarded text stops being live.
 *
 * SHA-256 rather than a slow KDF is deliberate and worth stating: bcrypt/argon2 exist to
 * make *low-entropy* human passwords expensive to brute force. A 256-bit random token has
 * nothing to brute force, and a slow hash on every page load would only add latency.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

/** How long a landing link stays live. */
export const DEFAULT_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000

export interface IssuedToken {
  /** Goes in the SMS. Never stored. */
  token: string
  /** Goes in the database. */
  tokenHash: string
  expiresAt: Date
}

export function issueLandingToken(now: Date = new Date(), ttlMs = DEFAULT_TOKEN_TTL_MS): IssuedToken {
  // base64url: URL-safe with no percent-encoding, so it survives an SMS intact.
  const token = randomBytes(32).toString('base64url')
  return {
    token,
    tokenHash: hashLandingToken(token),
    expiresAt: new Date(now.getTime() + ttlMs),
  }
}

export function hashLandingToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

/** Constant-time comparison of two hex digests. */
export function tokenHashesMatch(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  try {
    return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'))
  } catch {
    return false
  }
}

export type TokenRejection = 'not_found' | 'expired' | 'revoked'

export interface StoredToken {
  tokenHash: string
  expiresAt: Date
  revokedAt: Date | null
}

export type TokenCheck = { ok: true } | { ok: false; reason: TokenRejection }

/**
 * Validate a presented token against its stored record.
 *
 * Order matters: revocation is checked before expiry so a deliberately killed link
 * reports as revoked rather than aging into a misleading "expired".
 */
export function checkLandingToken(
  presented: string,
  stored: StoredToken | null,
  now: Date = new Date()
): TokenCheck {
  if (!stored) return { ok: false, reason: 'not_found' }
  if (!tokenHashesMatch(hashLandingToken(presented), stored.tokenHash)) {
    // Same rejection as a missing row: a caller must not be able to tell a wrong token
    // from a nonexistent one.
    return { ok: false, reason: 'not_found' }
  }
  if (stored.revokedAt !== null) return { ok: false, reason: 'revoked' }
  if (stored.expiresAt.getTime() <= now.getTime()) return { ok: false, reason: 'expired' }
  return { ok: true }
}

/**
 * What a landing page may reveal.
 *
 * The link is a capability held by a phone, not a signed-in identity, so this is
 * deliberately narrow. It shows the caller what they already know — what they said, and
 * what can be prepared — and nothing they would have to authenticate to learn.
 *
 * Explicitly NOT here: the transcript, the recording, the opposing party, the amount
 * claimed, any deadline, any document contents, and any case the caller may already have.
 * Reaching those requires phone-OTP sign-in.
 */
export interface LandingView {
  callId: string
  summaryText: string
  detectedCaseType: string | null
  offers: LandingOffer[]
  /** Whether the caller already paid something on the call. */
  alreadyPaidCents: number
  expiresAt: string
}

export interface LandingOffer {
  kind: 'one_shot_document' | 'subscription' | 'call_credit'
  feeKey: string
  title: string
  description: string
  priceCents: number
}

/** Fields that must never appear in a landing payload. Asserted in tests. */
export const LANDING_FORBIDDEN_FIELDS = [
  'transcript',
  'recordingUrl',
  'recording_minio_key',
  'opposingParty',
  'amountClaimedCents',
  'phone',
  'fromE164',
  'caseId',
  'userId',
] as const
