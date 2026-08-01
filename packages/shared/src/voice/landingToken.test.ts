import {
  checkLandingToken,
  DEFAULT_TOKEN_TTL_MS,
  hashLandingToken,
  issueLandingToken,
  LANDING_FORBIDDEN_FIELDS,
  tokenHashesMatch,
  type StoredToken,
} from './landingToken.js'

const NOW = new Date('2026-08-01T12:00:00Z')

function stored(over: Partial<StoredToken> & { tokenHash: string }): StoredToken {
  return { expiresAt: new Date(NOW.getTime() + DEFAULT_TOKEN_TTL_MS), revokedAt: null, ...over }
}

describe('token issuance', () => {
  it('produces a URL-safe token that survives an SMS intact', () => {
    const { token } = issueLandingToken(NOW)
    // base64url only: no +, /, = or anything needing percent-encoding.
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(encodeURIComponent(token)).toBe(token)
  })

  it('carries 256 bits of entropy', () => {
    const { token } = issueLandingToken(NOW)
    // 32 random bytes → 43 base64url chars.
    expect(Buffer.from(token, 'base64url')).toHaveLength(32)
  })

  it('never repeats', () => {
    const tokens = new Set(Array.from({ length: 500 }, () => issueLandingToken(NOW).token))
    expect(tokens.size).toBe(500)
  })

  it('returns the hash for storage, and the hash is not the token', () => {
    const { token, tokenHash } = issueLandingToken(NOW)
    expect(tokenHash).toBe(hashLandingToken(token))
    expect(tokenHash).not.toBe(token)
    expect(tokenHash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('expires seven days out by default', () => {
    const { expiresAt } = issueLandingToken(NOW)
    expect(expiresAt.getTime() - NOW.getTime()).toBe(DEFAULT_TOKEN_TTL_MS)
  })

  it('accepts a shorter TTL', () => {
    const { expiresAt } = issueLandingToken(NOW, 60_000)
    expect(expiresAt.getTime() - NOW.getTime()).toBe(60_000)
  })
})

describe('a database leak does not yield working links', () => {
  it('stores only a hash, from which the token cannot be recovered', () => {
    const { token, tokenHash } = issueLandingToken(NOW)
    // The whole point: what is at rest is not what opens the door.
    expect(tokenHash).not.toContain(token)
    expect(token).not.toContain(tokenHash)
  })

  it('rejects a stored hash presented as if it were the token', () => {
    // Someone who reads the database and replays the hash gets nothing.
    const { tokenHash } = issueLandingToken(NOW)
    expect(checkLandingToken(tokenHash, stored({ tokenHash }), NOW)).toEqual({
      ok: false,
      reason: 'not_found',
    })
  })
})

describe('validation', () => {
  it('accepts the right token', () => {
    const { token, tokenHash } = issueLandingToken(NOW)
    expect(checkLandingToken(token, stored({ tokenHash }), NOW)).toEqual({ ok: true })
  })

  it('rejects a wrong token as not_found, not as a distinct error', () => {
    // A caller must not be able to tell a wrong token from a nonexistent one, or the
    // endpoint becomes an oracle for which links exist.
    const { tokenHash } = issueLandingToken(NOW)
    const other = issueLandingToken(NOW).token
    expect(checkLandingToken(other, stored({ tokenHash }), NOW)).toEqual({
      ok: false,
      reason: 'not_found',
    })
  })

  it('rejects a missing record', () => {
    expect(checkLandingToken('anything', null, NOW)).toEqual({ ok: false, reason: 'not_found' })
  })

  it('rejects an expired token', () => {
    const { token, tokenHash } = issueLandingToken(NOW, 60_000)
    const later = new Date(NOW.getTime() + 61_000)
    expect(checkLandingToken(token, stored({ tokenHash, expiresAt: new Date(NOW.getTime() + 60_000) }), later))
      .toEqual({ ok: false, reason: 'expired' })
  })

  it('treats the expiry instant itself as expired', () => {
    const { token, tokenHash } = issueLandingToken(NOW, 60_000)
    const at = new Date(NOW.getTime() + 60_000)
    expect(checkLandingToken(token, stored({ tokenHash, expiresAt: at }), at).ok).toBe(false)
  })

  it('reports a revoked token as revoked even if it is also expired', () => {
    // A deliberately killed link should not age into a misleading "expired".
    const { token, tokenHash } = issueLandingToken(NOW, 60_000)
    const check = checkLandingToken(
      token,
      stored({ tokenHash, expiresAt: new Date(NOW.getTime() - 1), revokedAt: NOW }),
      NOW
    )
    expect(check).toEqual({ ok: false, reason: 'revoked' })
  })

  it('does not throw on malformed input', () => {
    const { tokenHash } = issueLandingToken(NOW)
    for (const bad of ['', 'not-hex', '!!!', 'a'.repeat(1000)]) {
      expect(() => checkLandingToken(bad, stored({ tokenHash }), NOW)).not.toThrow()
      expect(checkLandingToken(bad, stored({ tokenHash }), NOW).ok).toBe(false)
    }
  })
})

describe('tokenHashesMatch', () => {
  it('matches identical digests', () => {
    const h = hashLandingToken('x')
    expect(tokenHashesMatch(h, h)).toBe(true)
  })

  it('rejects different digests', () => {
    expect(tokenHashesMatch(hashLandingToken('a'), hashLandingToken('b'))).toBe(false)
  })

  it('rejects different lengths without throwing', () => {
    expect(tokenHashesMatch('abcd', hashLandingToken('a'))).toBe(false)
  })

  it('rejects non-hex without throwing', () => {
    expect(tokenHashesMatch('z'.repeat(64), hashLandingToken('a'))).toBe(false)
  })
})

describe('what the landing page may reveal', () => {
  it('names the fields that must never appear in a landing payload', () => {
    // The link is a capability held by a phone, not a signed-in identity. Anything on
    // this list requires phone-OTP sign-in to see.
    expect(LANDING_FORBIDDEN_FIELDS).toEqual(
      expect.arrayContaining(['transcript', 'recordingUrl', 'opposingParty', 'caseId'])
    )
  })
})
