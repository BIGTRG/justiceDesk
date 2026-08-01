/**
 * Branch coverage for the validator's rejection paths.
 *
 * Separated from validate.test.ts, which reads as documentation of the rules. This file
 * exists to make sure every guard actually fires — an unexercised guard is a guard that
 * silently stopped working.
 */

import { makeDefinition, testDeadlineRule } from './fixtures.js'
import { validateWorkflowDefinition } from './validate.js'
import type { DeadlineRule } from '../deadlines/types.js'
import type { WorkflowDefinition, WorkflowStage } from './types.js'

function codesFor(def: WorkflowDefinition): string[] {
  const r = validateWorkflowDefinition(def)
  return [...r.errors, ...r.warnings].map((i) => i.code)
}

function withRule(rule: Partial<DeadlineRule>): string[] {
  const def = makeDefinition()
  def.stages[0]!.deadlineRule = { ...testDeadlineRule, ...rule } as DeadlineRule
  return codesFor(def)
}

function withStage(patch: Partial<WorkflowStage>): string[] {
  const def = makeDefinition()
  def.stages[1] = { ...def.stages[1]!, ...patch }
  return codesFor(def)
}

describe('definition-level guards', () => {
  it.each([
    [{ caseTypeKey: '' }, 'definition.case_type_missing'],
    [{ jurisdictionKey: '  ' }, 'definition.jurisdiction_missing'],
    [{ overview: '' }, 'definition.overview_missing'],
    [{ version: 0 }, 'definition.version_invalid'],
    [{ version: 1.5 }, 'definition.version_invalid'],
  ])('rejects %o', (patch, code) => {
    expect(codesFor(makeDefinition(patch as Partial<WorkflowDefinition>))).toContain(code)
  })
})

describe('stage-level guards', () => {
  it.each([
    [{ title: '' }, 'stage.title_missing'],
    [{ plainLanguageExplainer: '' }, 'stage.explainer_missing'],
    [{ next: 'case_closed' as unknown as string[] }, 'stage.next_not_array'],
    [{ next: ['case_closed', 'case_closed'] }, 'stage.next_duplicate'],
    [{ requiredDocuments: null as unknown as [] }, 'stage.documents_not_array'],
    [{ courtFeeCents: 12.5 }, 'stage.court_fee_invalid'],
  ])('rejects %o', (patch, code) => {
    expect(withStage(patch as Partial<WorkflowStage>)).toContain(code)
  })

  it('rejects a required document with no templateKey', () => {
    expect(
      withStage({
        requiredDocuments: [{ templateKey: '', title: 'X', required: true, purpose: 'why' }],
      })
    ).toContain('stage.document_template_missing')
  })

  it('accepts an explicit zero court fee as meaningfully different from null', () => {
    expect(withStage({ courtFeeCents: 0 })).not.toContain('stage.court_fee_invalid')
  })
})

describe('deadline-rule guards', () => {
  it.each([
    [{ key: '' }, 'deadline.key_missing'],
    [{ title: '' }, 'deadline.title_missing'],
    [{ anchor: '' }, 'deadline.anchor_missing'],
    [{ offset: { count: 1.5, unit: 'calendar_days' } }, 'deadline.offset_not_integer'],
    [{ offset: { count: 30, unit: 'fortnights' } }, 'deadline.offset_unit_invalid'],
    [{ direction: 'sideways' }, 'deadline.direction_invalid'],
    [{ rollover: 'maybe' }, 'deadline.rollover_invalid'],
    [{ verification: { status: 'probably_fine' } }, 'deadline.verification_missing'],
    [{ verification: undefined }, 'deadline.verification_missing'],
    [{ reminderOffsetsDays: [14, -1] }, 'deadline.reminder_offset_invalid'],
    [{ reminderOffsetsDays: [2.5] }, 'deadline.reminder_offset_invalid'],
  ])('rejects %o', (patch, code) => {
    expect(withRule(patch as Partial<DeadlineRule>)).toContain(code)
  })

  it('rejects a service extension with negative days', () => {
    expect(
      withRule({
        serviceExtension: {
          appliesToMethods: ['first_class_mail'],
          days: -3,
          source: { citation: 'N.C. Gen. Stat. § 1A-1, Rule 6(e)', summary: 'mail adds days' },
        },
      })
    ).toContain('deadline.service_extension_days_invalid')
  })

  it('rejects a service extension that applies to no method', () => {
    expect(
      withRule({
        serviceExtension: {
          appliesToMethods: [],
          days: 3,
          source: { citation: 'N.C. Gen. Stat. § 1A-1, Rule 6(e)', summary: 'mail adds days' },
        },
      })
    ).toContain('deadline.service_extension_methods_empty')
  })

  it('accepts a fully verified rule with no warnings', () => {
    const codes = withRule({
      verification: {
        status: 'attorney_verified',
        verifiedBy: 'Reviewing Counsel',
        verifiedAt: '2026-07-15T00:00:00Z',
      },
    })
    expect(codes).not.toContain('deadline.unverified')
    expect(codes).not.toContain('deadline.verified_by_missing')
    expect(codes).not.toContain('deadline.verified_at_invalid')
  })

  it('rejects a verified-at that is not a real date', () => {
    expect(
      withRule({
        verification: {
          status: 'attorney_verified',
          verifiedBy: 'Reviewing Counsel',
          verifiedAt: 'last Tuesday',
        },
      })
    ).toContain('deadline.verified_at_invalid')
  })
})
