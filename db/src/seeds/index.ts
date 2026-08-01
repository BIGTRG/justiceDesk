import type { WorkflowDefinition } from '@justicedesk/shared'
import { debtDefenseWakeDistrict } from './workflows/debtDefense.js'
import { evictionTenantWakeMagistrate } from './workflows/evictionTenant.js'
import { smallClaimsWakeMagistrate } from './workflows/smallClaims.js'

export * from './citations.js'
export * from './reference.js'
export * from './templates.js'
export { debtDefenseWakeDistrict, evictionTenantWakeMagistrate, smallClaimsWakeMagistrate }

export const WORKFLOW_DEFINITIONS: WorkflowDefinition[] = [
  debtDefenseWakeDistrict,
  smallClaimsWakeMagistrate,
  evictionTenantWakeMagistrate,
]
