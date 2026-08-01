import { makeDefinition, testDeadlineRule } from './fixtures.js'
import { assertValidWorkflowDefinition, reachableStages, validateWorkflowDefinition } from './validate.js'
import type { WorkflowDefinition } from './types.js'

function codes(result: ReturnType<typeof validateWorkflowDefinition>): string[] {
  return [...result.errors, ...result.warnings].map((i) => i.code)
}

describe('validateWorkflowDefinition — happy path', () => {
  it('accepts the fixture definition', () => {
    const result = validateWorkflowDefinition(makeDefinition())
    expect(result.errors).toEqual([])
    expect(result.valid).toBe(true)
  })

  it('warns about the unverified deadline rule without blocking publication', () => {
    const result = validateWorkflowDefinition(makeDefinition())
    expect(codes(result)).toContain('deadline.unverified')
    expect(result.valid).toBe(true)
  })
})

describe('validateWorkflowDefinition — structural errors', () => {
  it('rejects a next pointer to an unknown stage', () => {
    const def = makeDefinition()
    def.stages[0]!.next = ['nowhere']
    expect(codes(validateWorkflowDefinition(def))).toContain('stage.next_unknown')
  })

  it('rejects a non-terminal stage with no way out', () => {
    const def = makeDefinition()
    def.stages[1]!.next = []
    const result = validateWorkflowDefinition(def)
    expect(codes(result)).toContain('stage.dead_end')
    expect(result.valid).toBe(false)
  })

  it('rejects a terminal stage that still points onward', () => {
    const def = makeDefinition()
    def.stages[2]!.next = ['served']
    expect(codes(validateWorkflowDefinition(def))).toContain('stage.terminal_has_next')
  })

  it('rejects an unreachable stage', () => {
    const def = makeDefinition()
    def.stages.push({
      key: 'orphan',
      title: 'Orphan',
      plainLanguageExplainer: 'Nothing points here.',
      requiredDocuments: [],
      next: ['case_closed'],
    })
    expect(codes(validateWorkflowDefinition(def))).toContain('definition.stage_unreachable')
  })

  it('rejects a definition with no terminal stage', () => {
    const def: WorkflowDefinition = makeDefinition({
      initialStageKey: 'a',
      stages: [
        {
          key: 'a',
          title: 'A',
          plainLanguageExplainer: 'a',
          requiredDocuments: [],
          next: ['b'],
        },
        {
          key: 'b',
          title: 'B',
          plainLanguageExplainer: 'b',
          requiredDocuments: [],
          next: ['a'],
        },
      ],
    })
    const result = validateWorkflowDefinition(def)
    expect(codes(result)).toContain('definition.no_terminal_stage')
    // Every stage is also stranded — a litigant here could never reach an end.
    expect(codes(result)).toContain('definition.no_path_to_terminal')
  })

  it('rejects an initial stage that does not exist', () => {
    const def = makeDefinition({ initialStageKey: 'missing' })
    expect(codes(validateWorkflowDefinition(def))).toContain('definition.initial_stage_unknown')
  })

  it('rejects duplicate stage keys', () => {
    const def = makeDefinition()
    def.stages.push({ ...def.stages[2]! })
    expect(codes(validateWorkflowDefinition(def))).toContain('definition.duplicate_stage_key')
  })

  it('rejects malformed stage keys', () => {
    const def = makeDefinition()
    def.stages[1]!.key = 'Answer-Filed'
    const result = validateWorkflowDefinition(def)
    expect(codes(result)).toContain('stage.key_invalid')
  })

  it('warns on a self-loop rather than blocking it', () => {
    const def = makeDefinition()
    def.stages[1]!.next = ['answer_filed', 'case_closed']
    const result = validateWorkflowDefinition(def)
    expect(codes(result)).toContain('stage.self_loop')
    expect(result.valid).toBe(true)
  })

  it('rejects an empty stage list', () => {
    const def = makeDefinition({ stages: [] })
    expect(codes(validateWorkflowDefinition(def))).toContain('definition.stages_empty')
  })
})

describe('validateWorkflowDefinition — legal-content requirements', () => {
  it('refuses a deadline rule with no citation', () => {
    const def = makeDefinition()
    def.stages[0]!.deadlineRule = {
      ...testDeadlineRule,
      source: { citation: '   ', summary: 'no source' },
    }
    const result = validateWorkflowDefinition(def)
    expect(codes(result)).toContain('deadline.source_missing')
    expect(result.valid).toBe(false)
  })

  it('refuses a deadline rule with no plain-language summary of its source', () => {
    const def = makeDefinition()
    def.stages[0]!.deadlineRule = {
      ...testDeadlineRule,
      source: { citation: 'N.C. Gen. Stat. § 1A-1, Rule 12', summary: '' },
    }
    expect(codes(validateWorkflowDefinition(def))).toContain('deadline.source_summary_missing')
  })

  it('requires a named attorney and date on a verified rule', () => {
    const def = makeDefinition()
    def.stages[0]!.deadlineRule = {
      ...testDeadlineRule,
      verification: { status: 'attorney_verified' },
    }
    const result = validateWorkflowDefinition(def)
    expect(codes(result)).toEqual(
      expect.arrayContaining(['deadline.verified_by_missing', 'deadline.verified_at_invalid'])
    )
  })

  it('rejects a negative offset in favour of an explicit direction', () => {
    const def = makeDefinition()
    def.stages[0]!.deadlineRule = { ...testDeadlineRule, offset: { count: -5, unit: 'calendar_days' } }
    expect(codes(validateWorkflowDefinition(def))).toContain('deadline.offset_negative')
  })

  it('rejects a service extension with no source', () => {
    const def = makeDefinition()
    def.stages[0]!.deadlineRule = {
      ...testDeadlineRule,
      serviceExtension: {
        appliesToMethods: ['first_class_mail'],
        days: 3,
        source: { citation: '', summary: '' },
      },
    }
    expect(codes(validateWorkflowDefinition(def))).toContain('deadline.service_extension_source_missing')
  })

  it('rejects a required document with no plain-language purpose', () => {
    const def = makeDefinition()
    def.stages[1]!.requiredDocuments[0]!.purpose = ''
    expect(codes(validateWorkflowDefinition(def))).toContain('stage.document_purpose_missing')
  })

  it('rejects a negative court fee', () => {
    const def = makeDefinition()
    def.stages[1]!.courtFeeCents = -100
    expect(codes(validateWorkflowDefinition(def))).toContain('stage.court_fee_invalid')
  })

  it('warns when a definition is marked live but not attorney-verified', () => {
    const def = makeDefinition({ status: 'live' })
    expect(codes(validateWorkflowDefinition(def))).toContain('definition.live_but_unverified')
  })
})

describe('reachableStages', () => {
  it('walks the graph from the initial stage', () => {
    expect(reachableStages(makeDefinition())).toEqual(
      new Set(['served', 'answer_filed', 'case_closed'])
    )
  })
})

describe('assertValidWorkflowDefinition', () => {
  it('is silent on a valid definition', () => {
    expect(() => assertValidWorkflowDefinition(makeDefinition())).not.toThrow()
  })

  it('throws with every error listed, so a seed run fails loudly', () => {
    const def = makeDefinition()
    def.stages[0]!.next = ['nowhere']
    expect(() => assertValidWorkflowDefinition(def)).toThrow(/stage\.next_unknown/)
  })
})
