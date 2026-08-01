/**
 * Transport tests.
 *
 * These pin the confirmed gateway contract so a future refactor cannot quietly drift back
 * to the assumed one, and pin the selection rules so nobody can bypass the operator's
 * egress path by forgetting an env var.
 */

import { createLogger } from '@justicedesk/service-kit'
import {
  DirectAnthropicTransport,
  selectTransport,
  SharedLegalGatewayTransport,
  type TransportRequest,
} from './transport.js'

const logger = createLogger('test')

const request: TransportRequest = {
  model: 'claude-sonnet-4-6',
  maxTokens: 1024,
  system: [{ type: 'text', text: 'boundary' }],
  messages: [{ role: 'user', content: 'When is my answer due?' }],
  profile: 'justice_desk',
}

function stubFetch(handler: (url: string, init: RequestInit) => Response) {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const original = globalThis.fetch
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} })
    return handler(String(url), init ?? {})
  }) as typeof fetch
  return { calls, restore: () => { globalThis.fetch = original } }
}

function ok(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
}

const gateway = (keys = { justice_desk: 'key-web', justice_desk_voice: 'key-voice' }) =>
  new SharedLegalGatewayTransport(
    { baseUrl: 'http://10.2.0.2:3500', keys, timeoutMs: 5000 },
    logger
  )

describe('the confirmed gateway wire contract', () => {
  it('posts to the OpenAI-style route, not /v1/messages', async () => {
    const stub = stubFetch(() => ok({ content: [{ type: 'text', text: 'hi' }] }))
    try {
      await gateway().send(request)
      // The route is OpenAI-style even though the body is Anthropic-shaped. This
      // mismatch is the gateway's and is deliberate.
      expect(stub.calls[0]!.url).toBe('http://10.2.0.2:3500/v1/chat/completions')
      expect(stub.calls[0]!.url).not.toContain('/v1/messages')
    } finally {
      stub.restore()
    }
  })

  it('carries identity by bearer key alone', async () => {
    const stub = stubFetch(() => ok({ content: [] }))
    try {
      await gateway().send(request)
      const headers = stub.calls[0]!.init.headers as Record<string, string>
      expect(headers.authorization).toBe('Bearer key-web')
      // Neither header exists on this gateway; sending them would be noise at best.
      expect(headers['x-app-id']).toBeUndefined()
      expect(headers['x-policy-profile']).toBeUndefined()
    } finally {
      stub.restore()
    }
  })

  it('sends no policy-profile field in the body — there are no profiles', async () => {
    const stub = stubFetch(() => ok({ content: [] }))
    try {
      await gateway().send(request)
      const body = JSON.parse(String(stub.calls[0]!.init.body))
      expect(body.policy_profile).toBeUndefined()
      expect(body.app_id).toBeUndefined()
      // Anthropic-shaped body.
      expect(body).toMatchObject({ model: 'claude-sonnet-4-6', max_tokens: 1024 })
      expect(body.messages).toHaveLength(1)
    } finally {
      stub.restore()
    }
  })

  it('selects the voice key when running as the voice app', async () => {
    const stub = stubFetch(() => ok({ content: [] }))
    try {
      await gateway().send({ ...request, profile: 'justice_desk_voice' })
      const headers = stub.calls[0]!.init.headers as Record<string, string>
      expect(headers.authorization).toBe('Bearer key-voice')
    } finally {
      stub.restore()
    }
  })

  it('refuses rather than borrowing another app’s key', async () => {
    // Borrowing would bill and rate-limit the wrong surface, defeating the only
    // isolation the gateway provides.
    const stub = stubFetch(() => ok({ content: [] }))
    try {
      await expect(
        gateway({ justice_desk: 'key-web' } as never).send({ ...request, profile: 'justice_desk_voice' })
      ).rejects.toThrow(/not configured for this surface/)
      expect(stub.calls).toHaveLength(0)
    } finally {
      stub.restore()
    }
  })

  it('parses the Anthropic-compatible response', async () => {
    const stub = stubFetch(() =>
      ok({
        content: [
          { type: 'text', text: 'Your answer is due April 1.' },
          { type: 'tool_use', name: 'record_classification', input: { case_type: 'debt_defense' } },
        ],
        usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2 },
        stop_reason: 'end_turn',
      })
    )
    try {
      const result = await gateway().send(request)
      expect(result.text).toBe('Your answer is due April 1.')
      expect(result.toolUses).toEqual([
        { name: 'record_classification', input: { case_type: 'debt_defense' } },
      ])
      expect(result.usage).toMatchObject({ inputTokens: 10, outputTokens: 5, cacheReadTokens: 2 })
      expect(result.stopReason).toBe('end_turn')
    } finally {
      stub.restore()
    }
  })
})

describe('gateway failure handling', () => {
  it('maps a rejected key to unavailable, never to a caller-facing auth error', async () => {
    const stub = stubFetch(() => new Response('{}', { status: 403 }))
    try {
      await expect(gateway().send(request)).rejects.toThrow(/unavailable/i)
    } finally {
      stub.restore()
    }
  })

  it('maps the per-app rate limit to a retry message', async () => {
    const stub = stubFetch(() => new Response('{}', { status: 429 }))
    try {
      await expect(gateway().send(request)).rejects.toThrow(/busy/i)
    } finally {
      stub.restore()
    }
  })

  it('maps an unreachable gateway to unavailable', async () => {
    const stub = stubFetch(() => {
      throw new Error('ECONNREFUSED')
    })
    try {
      await expect(gateway().send(request)).rejects.toThrow(/unavailable/i)
    } finally {
      stub.restore()
    }
  })
})

describe('transport selection', () => {
  const secrets = { anthropicApiKey: 'sk-ant-test', gatewayToken: 'key-web' }

  it('uses the gateway when configured', () => {
    const selection = selectTransport(
      { LEGAL_GATEWAY_URL: 'http://10.2.0.2:3500' },
      secrets,
      logger
    )
    expect(selection.transport).toBeInstanceOf(SharedLegalGatewayTransport)
    expect(selection.isDeviation).toBe(false)
  })

  it('says plainly in the banner that the gateway enforces no policy', () => {
    // Operators reading boot logs must not assume upstream guardrails exist.
    const selection = selectTransport({ LEGAL_GATEWAY_URL: 'http://10.2.0.2:3500' }, secrets, logger)
    expect(selection.banner).toMatch(/proxy only/i)
    expect(selection.banner).toMatch(/local guardrails are the only layer/i)
  })

  it('registers the voice app only once its key exists', () => {
    const withoutVoice = selectTransport({ LEGAL_GATEWAY_URL: 'http://x' }, secrets, logger)
    expect(withoutVoice.banner).not.toContain('justice_desk_voice')

    const withVoice = selectTransport(
      { LEGAL_GATEWAY_URL: 'http://x' },
      { ...secrets, gatewayVoiceToken: 'key-voice' },
      logger
    )
    expect(withVoice.banner).toContain('justice_desk_voice')
  })

  it('refuses to start when the gateway URL is set but the key is missing', () => {
    expect(() =>
      selectTransport({ LEGAL_GATEWAY_URL: 'http://x' }, { ...secrets, gatewayToken: null }, logger)
    ).toThrow(/no gateway key was found/i)
  })

  it('refuses to start with no transport configured at all', () => {
    // The important one: a missing/misspelled gateway URL must not silently fall back to
    // direct Anthropic and bypass the operator's egress path.
    expect(() => selectTransport({}, secrets, logger)).toThrow(/No model transport configured/)
  })

  it('allows the direct path only on explicit opt-in, and flags it', () => {
    const selection = selectTransport({ ALLOW_DIRECT_ANTHROPIC: 'true' }, secrets, logger)
    expect(selection.transport).toBeInstanceOf(DirectAnthropicTransport)
    expect(selection.isDeviation).toBe(true)
    expect(selection.banner).toMatch(/DIRECT ANTHROPIC/)
  })

  it('treats any value other than exactly "true" as not opted in', () => {
    for (const value of ['TRUE', '1', 'yes', '']) {
      expect(() => selectTransport({ ALLOW_DIRECT_ANTHROPIC: value }, secrets, logger)).toThrow()
    }
  })
})
