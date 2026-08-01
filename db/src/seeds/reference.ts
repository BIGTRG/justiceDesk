/**
 * Reference data: jurisdictions, case types, and pricing plans.
 *
 * Phase 1 covers North Carolina, Wake County only. Adding a county is a row here plus a
 * workflow definition — no code change.
 */

import type { CourtLevel } from '@justicedesk/shared'

export interface JurisdictionSeed {
  key: string
  state: string
  county: string
  courtLevel: CourtLevel
  efileSupported: boolean
  timeZone: string
  filingAddresses: Record<string, unknown>
}

/**
 * ⚠️ UNVERIFIED. The courthouse address, phone and hours below are placeholders and must
 * be confirmed against the current NC Judicial Branch listing before a litigant is told
 * where to go. A wrong address means a missed hearing.
 */
export const JURISDICTIONS: JurisdictionSeed[] = [
  {
    key: 'NC-WAKE-MAGISTRATE',
    state: 'NC',
    county: 'Wake',
    courtLevel: 'magistrate',
    efileSupported: false,
    timeZone: 'America/New_York',
    filingAddresses: {
      _verification: 'UNVERIFIED — confirm against the NC Judicial Branch county listing.',
      clerkOfCourt: {
        name: 'Wake County Clerk of Superior Court — Small Claims',
        street: 'VERIFY BEFORE USE',
        city: 'Raleigh',
        state: 'NC',
        zip: 'VERIFY',
      },
      phone: 'VERIFY BEFORE USE',
      hours: 'VERIFY BEFORE USE',
    },
  },
  {
    key: 'NC-WAKE-DISTRICT',
    state: 'NC',
    county: 'Wake',
    courtLevel: 'district',
    efileSupported: false,
    timeZone: 'America/New_York',
    filingAddresses: {
      _verification: 'UNVERIFIED — confirm against the NC Judicial Branch county listing.',
      clerkOfCourt: {
        name: 'Wake County Clerk of Superior Court — Civil',
        street: 'VERIFY BEFORE USE',
        city: 'Raleigh',
        state: 'NC',
        zip: 'VERIFY',
      },
      phone: 'VERIFY BEFORE USE',
      hours: 'VERIFY BEFORE USE',
    },
  },
]

export interface CaseTypeSeed {
  key: string
  name: string
  description: string
  active: boolean
}

export const CASE_TYPES: CaseTypeSeed[] = [
  {
    key: 'debt_defense',
    name: 'Someone is suing me over a debt',
    description:
      'A company says you owe money and has filed a lawsuit. Get help writing your response and keeping your dates straight.',
    active: true,
  },
  {
    key: 'small_claims',
    name: 'Small claims (up to $10,000)',
    description:
      'A dispute over money or property worth $10,000 or less, decided by a magistrate in a short hearing.',
    active: true,
  },
  {
    key: 'eviction_tenant',
    name: 'My landlord is trying to evict me',
    description:
      'Your landlord has filed to have you removed. These cases move fast — get your hearing date and what to bring.',
    active: true,
  },
]

export interface PlanSeed {
  caseTypeKey: string
  kind: 'monthly' | 'one_shot'
  name: string
  priceCents: number
  status: 'live' | 'draft'
}

/**
 * Prices from the build spec. All seeded as `draft`, not `live`: publishing a plan makes
 * it purchasable, and payments stay in Stripe test mode until the compliance gate clears.
 * The admin pricing board promotes these to live after sign-off.
 */
export const PLANS: PlanSeed[] = [
  { caseTypeKey: 'debt_defense', kind: 'monthly', name: 'Debt defense — monthly', priceCents: 4900, status: 'draft' },
  { caseTypeKey: 'debt_defense', kind: 'one_shot', name: 'Debt defense — one document', priceCents: 3900, status: 'draft' },
  { caseTypeKey: 'small_claims', kind: 'monthly', name: 'Small claims — monthly', priceCents: 3900, status: 'draft' },
  { caseTypeKey: 'small_claims', kind: 'one_shot', name: 'Small claims — one document', priceCents: 2900, status: 'draft' },
  { caseTypeKey: 'eviction_tenant', kind: 'monthly', name: 'Eviction defense — monthly', priceCents: 2900, status: 'draft' },
  { caseTypeKey: 'eviction_tenant', kind: 'one_shot', name: 'Eviction defense — one document', priceCents: 2500, status: 'draft' },
]
