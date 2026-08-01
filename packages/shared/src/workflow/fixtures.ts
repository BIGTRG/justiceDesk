/**
 * Test fixtures. Not exported from the package index — tests only.
 *
 * A deliberately small three-stage workflow so state-machine tests assert on the engine's
 * behaviour rather than on the shape of the real North Carolina content, which lives in
 * db/seeds and changes as counsel reviews it.
 */

import type { DeadlineRule } from '../deadlines/types.js'
import type { WorkflowDefinition } from './types.js'

export const testDeadlineRule: DeadlineRule = {
  key: 'respond_due',
  title: 'Respond to the lawsuit',
  description: 'File your written response by this date.',
  anchor: 'service_date',
  offset: { count: 30, unit: 'calendar_days' },
  direction: 'after',
  rollover: 'next_court_day',
  jurisdictional: true,
  source: {
    citation: 'N.C. Gen. Stat. § 1A-1, Rule 12(a)(1)',
    summary: 'A defendant generally has 30 days after service to respond.',
  },
  verification: { status: 'unverified' },
}

export function makeDefinition(overrides: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  const base: WorkflowDefinition = {
    caseTypeKey: 'debt_defense',
    jurisdictionKey: 'NC-WAKE-DISTRICT',
    courtLevel: 'district',
    version: 1,
    status: 'draft',
    title: 'Defending a debt collection lawsuit',
    overview: 'Someone has sued you over a debt. Here is what happens and what you can do.',
    initialStageKey: 'served',
    verification: { status: 'unverified' },
    stages: [
      {
        key: 'served',
        title: 'You were served',
        plainLanguageExplainer: 'You got court papers. The clock has started.',
        deadlineRule: testDeadlineRule,
        requiredDocuments: [],
        courtFeeCents: null,
        next: ['answer_filed', 'case_closed'],
      },
      {
        key: 'answer_filed',
        title: 'File your Answer',
        plainLanguageExplainer: 'Tell the court your side in writing.',
        deadlineRule: null,
        requiredDocuments: [
          {
            templateKey: 'nc_debt_answer',
            title: 'Answer to Complaint',
            required: true,
            purpose: 'This is your written response to what the company says you owe.',
          },
        ],
        courtFeeCents: 0,
        next: ['case_closed'],
      },
      {
        key: 'case_closed',
        title: 'Case closed',
        plainLanguageExplainer: 'Your case is over.',
        deadlineRule: null,
        requiredDocuments: [],
        courtFeeCents: null,
        next: [],
        terminal: true,
      },
    ],
  }
  return { ...base, ...overrides }
}
