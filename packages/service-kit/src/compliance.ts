/**
 * The compliance interlock.
 *
 * The build spec gates this product:
 *
 *   "DO NOT deploy publicly or enable payments in production until ethics counsel
 *    has reviewed the UPL guardrails, disclosure language, and attorney marketplace
 *    fee structure. Ship to staging only."
 *
 * A gate that lives only in a document gets missed. This turns it into something a
 * process cannot start through by accident: services refuse to boot in a configuration
 * that would serve the public or take real money before sign-off.
 *
 * It is deliberately awkward to bypass — flipping it means editing an env var whose name
 * says what it asserts, in a commit someone has to review.
 */

export interface ComplianceState {
  reviewComplete: boolean
  deployTarget: string
  paymentsMode: string
  nodeEnv: string
}

export function readComplianceState(env: NodeJS.ProcessEnv = process.env): ComplianceState {
  return {
    reviewComplete: env.COMPLIANCE_REVIEW_COMPLETE === 'true',
    deployTarget: env.DEPLOY_TARGET ?? 'development',
    paymentsMode: env.PAYMENTS_MODE ?? 'test',
    nodeEnv: env.NODE_ENV ?? 'development',
  }
}

export class ComplianceGateError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ComplianceGateError'
  }
}

/**
 * Throws when the process is configured in a way the gate forbids. Called at boot by
 * every service, before a port is bound.
 */
export function assertComplianceGate(state: ComplianceState = readComplianceState()): void {
  const problems: string[] = []

  if (!state.reviewComplete) {
    if (state.nodeEnv === 'production') {
      problems.push(
        'NODE_ENV=production, but COMPLIANCE_REVIEW_COMPLETE is not "true". Phase 1 ships to staging only.'
      )
    }
    if (state.deployTarget === 'production') {
      problems.push(
        'DEPLOY_TARGET=production, but COMPLIANCE_REVIEW_COMPLETE is not "true". Phase 1 ships to staging only.'
      )
    }
    if (state.paymentsMode === 'live') {
      problems.push(
        'PAYMENTS_MODE=live, but COMPLIANCE_REVIEW_COMPLETE is not "true". Payments stay in Stripe test mode until sign-off.'
      )
    }
  }

  if (problems.length) {
    throw new ComplianceGateError(
      'Refusing to start — the compliance gate is closed.\n\n' +
        problems.map((p) => `  * ${p}`).join('\n') +
        '\n\nSee COMPLIANCE.md for what ethics counsel must review before this gate opens.'
    )
  }
}

/** True when real money may be taken. Read by the billing routes. */
export function livePaymentsPermitted(state: ComplianceState = readComplianceState()): boolean {
  return state.reviewComplete && state.paymentsMode === 'live'
}

/** Banner logged at boot so the gate's state is visible in every deployment's logs. */
export function complianceBanner(state: ComplianceState = readComplianceState()): string {
  return state.reviewComplete
    ? `compliance gate OPEN (payments=${state.paymentsMode}, target=${state.deployTarget})`
    : `compliance gate CLOSED — staging only, payments forced to test mode (target=${state.deployTarget})`
}
