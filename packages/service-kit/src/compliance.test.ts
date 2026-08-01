import {
  assertComplianceGate,
  ComplianceGateError,
  complianceBanner,
  livePaymentsPermitted,
  readComplianceState,
} from './compliance.js'

const closed = { reviewComplete: false, deployTarget: 'staging', paymentsMode: 'test', nodeEnv: 'staging' }

describe('the gate blocks a premature launch', () => {
  it('refuses to start in production before sign-off', () => {
    expect(() => assertComplianceGate({ ...closed, nodeEnv: 'production' })).toThrow(ComplianceGateError)
  })

  it('refuses a production deploy target before sign-off', () => {
    expect(() => assertComplianceGate({ ...closed, deployTarget: 'production' })).toThrow(
      /Phase 1 ships to staging only/
    )
  })

  it('refuses live payments before sign-off', () => {
    expect(() => assertComplianceGate({ ...closed, paymentsMode: 'live' })).toThrow(
      /Stripe test mode until sign-off/
    )
  })

  it('reports every problem at once rather than one per restart', () => {
    try {
      assertComplianceGate({
        reviewComplete: false,
        deployTarget: 'production',
        paymentsMode: 'live',
        nodeEnv: 'production',
      })
      throw new Error('expected the gate to throw')
    } catch (err) {
      const message = (err as Error).message
      expect(message.match(/^\s+\*/gm)).toHaveLength(3)
      expect(message).toMatch(/COMPLIANCE\.md/)
    }
  })
})

describe('the gate allows normal development and staging', () => {
  it('permits staging with test payments', () => {
    expect(() => assertComplianceGate(closed)).not.toThrow()
  })

  it('permits local development', () => {
    expect(() =>
      assertComplianceGate({ ...closed, nodeEnv: 'development', deployTarget: 'development' })
    ).not.toThrow()
  })

  it('permits everything once review is complete', () => {
    expect(() =>
      assertComplianceGate({
        reviewComplete: true,
        deployTarget: 'production',
        paymentsMode: 'live',
        nodeEnv: 'production',
      })
    ).not.toThrow()
  })
})

describe('livePaymentsPermitted', () => {
  it('is false while review is outstanding, even if payments mode says live', () => {
    expect(livePaymentsPermitted({ ...closed, paymentsMode: 'live' })).toBe(false)
  })

  it('is false after review while payments remain in test mode', () => {
    expect(livePaymentsPermitted({ ...closed, reviewComplete: true })).toBe(false)
  })

  it('is true only when both conditions hold', () => {
    expect(livePaymentsPermitted({ ...closed, reviewComplete: true, paymentsMode: 'live' })).toBe(true)
  })
})

describe('readComplianceState', () => {
  it('defaults to the safe configuration when nothing is set', () => {
    const state = readComplianceState({})
    expect(state).toEqual({
      reviewComplete: false,
      deployTarget: 'development',
      paymentsMode: 'test',
      nodeEnv: 'development',
    })
  })

  it('treats any value other than the exact string "true" as not reviewed', () => {
    for (const value of ['TRUE', 'True', '1', 'yes', '', 'true ']) {
      expect(readComplianceState({ COMPLIANCE_REVIEW_COMPLETE: value }).reviewComplete).toBe(false)
    }
    expect(readComplianceState({ COMPLIANCE_REVIEW_COMPLETE: 'true' }).reviewComplete).toBe(true)
  })
})

describe('complianceBanner', () => {
  it('says the gate is closed while review is outstanding', () => {
    expect(complianceBanner(closed)).toMatch(/CLOSED — staging only/)
  })

  it('says the gate is open afterwards', () => {
    expect(complianceBanner({ ...closed, reviewComplete: true })).toMatch(/OPEN/)
  })
})
