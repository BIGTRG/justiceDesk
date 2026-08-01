/**
 * Seed-content tests. No database required — these guard the content itself.
 *
 * The point of this suite is that broken legal content can never reach a litigant
 * silently: a malformed state machine, a deadline with no citation, or a template
 * quietly marked verified while its PDF field map is still placeholders all fail here.
 */

import {
  CitationLibrary,
  northCarolinaCalendar,
  buildTimeline,
  calculateDeadline,
  nextAction,
  validateWorkflowDefinition,
  type WorkflowDefinition,
} from '@justicedesk/shared'
import { CASE_TYPES, JURISDICTIONS, NC_CURATED_CITATIONS, PLANS, TEMPLATES, WORKFLOW_DEFINITIONS } from './index.js'
import { collectFindings } from '../verify-content.js'

const calendar = northCarolinaCalendar()

describe('workflow definitions', () => {
  it.each(WORKFLOW_DEFINITIONS.map((d) => [d.caseTypeKey, d] as const))(
    '%s is structurally valid',
    (_key, def: WorkflowDefinition) => {
      const result = validateWorkflowDefinition(def)
      if (!result.valid) {
        throw new Error(result.errors.map((e) => `${e.path}: ${e.message}`).join('\n'))
      }
      expect(result.valid).toBe(true)
    }
  )

  it('covers all three Phase 1 case types', () => {
    expect(WORKFLOW_DEFINITIONS.map((d) => d.caseTypeKey).sort()).toEqual([
      'debt_defense',
      'eviction_tenant',
      'small_claims',
    ])
  })

  it('every definition is seeded as draft, never live', () => {
    // Publishing is an explicit admin action after the compliance gate clears.
    for (const def of WORKFLOW_DEFINITIONS) expect(def.status).toBe('draft')
  })

  it('every jurisdiction referenced by a workflow exists', () => {
    const keys = new Set(JURISDICTIONS.map((j) => j.key))
    for (const def of WORKFLOW_DEFINITIONS) expect(keys).toContain(def.jurisdictionKey)
  })

  it('every case type referenced by a workflow exists', () => {
    const keys = new Set(CASE_TYPES.map((c) => c.key))
    for (const def of WORKFLOW_DEFINITIONS) expect(keys).toContain(def.caseTypeKey)
  })

  it('every required document points at a real template', () => {
    const templateKeys = new Set(TEMPLATES.map((t) => t.key))
    for (const def of WORKFLOW_DEFINITIONS) {
      for (const stage of def.stages) {
        for (const doc of stage.requiredDocuments) {
          expect(templateKeys).toContain(doc.templateKey)
        }
      }
    }
  })
})

describe('deadline rules', () => {
  const rules = WORKFLOW_DEFINITIONS.flatMap((d) =>
    d.stages.filter((s) => s.deadlineRule).map((s) => ({ def: d, stage: s, rule: s.deadlineRule! }))
  )

  it('there is at least one deadline per case type', () => {
    const byCaseType = new Set(rules.map((r) => r.def.caseTypeKey))
    expect(byCaseType.size).toBe(3)
  })

  it('every rule cites a source that is in the curated library', () => {
    const library = new CitationLibrary(NC_CURATED_CITATIONS)
    for (const { rule } of rules) {
      expect(library.has(rule.source.citation)).toBe(true)
    }
  })

  it('every service extension cites a source in the curated library', () => {
    const library = new CitationLibrary(NC_CURATED_CITATIONS)
    for (const { rule } of rules) {
      if (rule.serviceExtension) {
        expect(library.has(rule.serviceExtension.source.citation)).toBe(true)
      }
    }
  })

  it('every rule is marked unverified and carries open questions for counsel', () => {
    for (const { rule } of rules) {
      expect(rule.verification.status).toBe('unverified')
      expect(rule.verification.openQuestions?.length ?? 0).toBeGreaterThan(0)
    }
  })

  it('every case-ending deadline is marked jurisdictional so the UI can emphasise it', () => {
    const critical = rules.filter((r) =>
      ['answer_due', 'notice_of_appeal_due', 'ejectment_notice_of_appeal_due'].includes(r.rule.key)
    )
    expect(critical.length).toBeGreaterThan(0)
    for (const { rule } of critical) expect(rule.jurisdictional).toBe(true)
  })

  it('every rule actually computes against a plausible case', () => {
    const anchors = {
      service_date: '2026-03-02',
      summons_issued_date: '2026-03-02',
      judgment_date: '2026-03-02',
      hearing_date: '2026-04-15',
      case_opened_date: '2026-03-02',
      stage_entered_date: '2026-03-02',
    }
    for (const { rule } of rules) {
      const result = calculateDeadline(rule, { anchors, serviceMethod: 'personal' }, calendar)
      expect(result.dueDate).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      // Unverified content must always warn.
      expect(result.warnings.length).toBeGreaterThan(0)
    }
  })

  it('short eviction deadlines use the compressed reminder cadence', () => {
    const eviction = rules.filter((r) => r.def.caseTypeKey === 'eviction_tenant')
    for (const { rule } of eviction) {
      expect(rule.reminderOffsetsDays).toBeDefined()
      // A 14-day-out reminder is useless on a 7-day clock.
      expect(Math.max(...rule.reminderOffsetsDays!)).toBeLessThanOrEqual(7)
    }
  })
})

describe('end-to-end timeline for each case type', () => {
  it.each(WORKFLOW_DEFINITIONS.map((d) => [d.caseTypeKey, d] as const))(
    '%s produces a usable Next Action from the first stage',
    (_key, def: WorkflowDefinition) => {
      const timeline = buildTimeline({
        definition: def,
        state: { currentStageKey: def.initialStageKey, completedStageKeys: [], role: 'defendant' },
        context: {
          anchors: {
            service_date: '2026-03-02',
            summons_issued_date: '2026-03-02',
            judgment_date: '2026-03-02',
          },
          serviceMethod: 'personal',
        },
        calendar,
        today: '2026-03-03',
      })

      expect(timeline.length).toBeGreaterThan(2)
      expect(timeline.filter((e) => e.status === 'current')).toHaveLength(1)

      const action = nextAction(timeline)
      expect(action).not.toBeNull()
      expect(action!.explainer.length).toBeGreaterThan(40)
      // Unverified content must surface a caveat on the card.
      expect(action!.warnings.length).toBeGreaterThan(0)
    }
  )

  it('every stage explainer is written in plain language, not statute-speak', () => {
    for (const def of WORKFLOW_DEFINITIONS) {
      for (const stage of def.stages) {
        expect(stage.plainLanguageExplainer.length).toBeGreaterThan(30)
        // Raw citations belong in the source field, not in prose aimed at a litigant.
        expect(stage.plainLanguageExplainer).not.toMatch(/N\.C\. Gen\. Stat\.|§/)
      }
    }
  })
})

describe('templates', () => {
  it('every template has a disclosure', () => {
    for (const t of TEMPLATES) {
      expect(t.disclosureText).toMatch(/not a law firm/i)
      expect(t.disclosureText).toMatch(/sign and file it yourself|sign it/i)
    }
  })

  it('every AOC form template names a stored blank PDF', () => {
    for (const t of TEMPLATES.filter((x) => x.source === 'aoc_form')) {
      expect(t.formPdfMinioKey).toBeTruthy()
    }
  })

  it('no template with placeholder field names is marked verified', () => {
    // The exact trap this guards: a template flipped to verified while its field map is
    // still guesses would produce an official-looking, wrongly-filled court form.
    for (const t of TEMPLATES) {
      const hasPlaceholders = Object.values(t.fieldMap).some((v) => v.startsWith('PLACEHOLDER_'))
      if (hasPlaceholders) expect(t.verification.status).toBe('unverified')
    }
  })

  it('every interview question is phrased as a question a person would understand', () => {
    for (const t of TEMPLATES) {
      for (const q of t.interviewSchema.questions) {
        expect(q.prompt.length).toBeGreaterThan(8)
        expect(q.prompt).not.toMatch(/§|pursuant to|heretofore/i)
      }
    }
  })

  it('every conditional question points at a question that exists', () => {
    for (const t of TEMPLATES) {
      const keys = new Set(t.interviewSchema.questions.map((q) => q.key))
      for (const q of t.interviewSchema.questions) {
        if (q.showIf) expect(keys).toContain(q.showIf.questionKey)
      }
    }
  })

  it('every select question offers options', () => {
    for (const t of TEMPLATES) {
      for (const q of t.interviewSchema.questions) {
        if (q.type === 'single_select' || q.type === 'multi_select') {
          expect(q.options?.length ?? 0).toBeGreaterThan(1)
        }
      }
    }
  })
})

describe('plans', () => {
  it('matches the prices in the build spec', () => {
    const price = (caseType: string, kind: string) =>
      PLANS.find((p) => p.caseTypeKey === caseType && p.kind === kind)?.priceCents
    expect(price('debt_defense', 'monthly')).toBe(4900)
    expect(price('debt_defense', 'one_shot')).toBe(3900)
    expect(price('small_claims', 'monthly')).toBe(3900)
    expect(price('small_claims', 'one_shot')).toBe(2900)
    expect(price('eviction_tenant', 'monthly')).toBe(2900)
    expect(price('eviction_tenant', 'one_shot')).toBe(2500)
  })

  it('offers both a monthly and a one-shot plan for every case type', () => {
    for (const c of CASE_TYPES) {
      const kinds = PLANS.filter((p) => p.caseTypeKey === c.key).map((p) => p.kind).sort()
      expect(kinds).toEqual(['monthly', 'one_shot'])
    }
  })

  it('seeds every plan as draft so nothing is purchasable before sign-off', () => {
    for (const p of PLANS) expect(p.status).toBe('draft')
  })
})

describe('compliance gate', () => {
  it('reports outstanding findings while content is unverified', () => {
    const findings = collectFindings()
    expect(findings.length).toBeGreaterThan(0)
    expect(findings.some((f) => f.blocking)).toBe(true)
  })

  it('flags the placeholder courthouse addresses as blocking', () => {
    expect(collectFindings().some((f) => f.area === 'jurisdiction' && f.blocking)).toBe(true)
  })

  it('flags the placeholder PDF field maps as blocking', () => {
    const found = collectFindings().filter(
      (f) => f.area === 'template' && f.detail.includes('placeholders')
    )
    expect(found.length).toBeGreaterThan(0)
    expect(found.every((f) => f.blocking)).toBe(true)
  })
})
