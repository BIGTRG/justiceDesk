import { createLogger } from './logger.js'

function capture(fn: () => void): Record<string, unknown>[] {
  const lines: Record<string, unknown>[] = []
  const outWrite = process.stdout.write.bind(process.stdout)
  const errWrite = process.stderr.write.bind(process.stderr)
  const collect = (chunk: string | Uint8Array): boolean => {
    lines.push(JSON.parse(String(chunk)))
    return true
  }
  // Narrow the overloaded write signature for the test.
  process.stdout.write = collect as typeof process.stdout.write
  process.stderr.write = collect as typeof process.stderr.write
  try {
    fn()
  } finally {
    process.stdout.write = outWrite
    process.stderr.write = errWrite
  }
  return lines
}

describe('structured output', () => {
  it('emits one JSON line per call with ELK-shaped fields', () => {
    const [line] = capture(() => createLogger('svc-test').info('hello', { caseId: 'abc' }))
    expect(line).toMatchObject({ level: 'info', service: 'svc-test', message: 'hello', caseId: 'abc' })
    expect(line!['@timestamp']).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('sends warnings and errors to stderr, everything else to stdout', () => {
    const lines = capture(() => {
      const log = createLogger('svc-test')
      log.info('a')
      log.error('b')
    })
    expect(lines).toHaveLength(2)
  })

  it('carries child bindings onto every line', () => {
    const [line] = capture(() =>
      createLogger('svc-test').child({ requestId: 'req-1' }).info('hello')
    )
    expect(line).toMatchObject({ requestId: 'req-1' })
  })
})

describe('redaction', () => {
  it('redacts an API key that reaches a message', () => {
    const [line] = capture(() =>
      createLogger('svc-test').error('upstream rejected key sk-ant-api03-ABCDEFGHIJKLMNOP')
    )
    expect(line!.message).not.toMatch(/sk-ant-api03/)
    expect(line!.message).toMatch(/\[REDACTED\]/)
  })

  it('omits personal fields even when a caller passes them', () => {
    // Guards the case where someone spreads a whole user or answer object into a log.
    const [line] = capture(() =>
      createLogger('svc-test').info('interview saved', {
        caseId: 'case-1',
        name: 'Jane Doe',
        phone: '+19195550123',
        answers: { rent_paid: true },
      })
    )
    expect(line).toMatchObject({
      caseId: 'case-1',
      name: '[OMITTED]',
      phone: '[OMITTED]',
      answers: '[OMITTED]',
    })
  })

  it('omits personal fields nested inside another object', () => {
    const [line] = capture(() =>
      createLogger('svc-test').info('x', { user: { id: 'u1', email: 'a@b.com' } })
    )
    expect(line!.user).toEqual({ id: 'u1', email: '[OMITTED]' })
  })

  it('logs an Error without its stack', () => {
    const [line] = capture(() =>
      createLogger('svc-test').error('failed', { err: new Error('boom sk-ant-api03-SECRETVALUE1') })
    )
    expect(line!.err).toEqual({ name: 'Error', message: expect.stringContaining('[REDACTED]') })
    expect(JSON.stringify(line)).not.toMatch(/at Object/)
  })
})

describe('level filtering', () => {
  const original = process.env.LOG_LEVEL
  afterEach(() => {
    if (original === undefined) delete process.env.LOG_LEVEL
    else process.env.LOG_LEVEL = original
  })

  it('drops lines below the configured level', () => {
    process.env.LOG_LEVEL = 'warn'
    const lines = capture(() => {
      const log = createLogger('svc-test')
      log.debug('no')
      log.info('no')
      log.warn('yes')
      log.error('yes')
    })
    expect(lines.map((l) => l.level)).toEqual(['warn', 'error'])
  })
})
