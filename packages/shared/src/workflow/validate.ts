/**
 * Workflow definition validator.
 *
 * Runs in three places, deliberately: the admin editor (before publish), the seed script
 * (so fixtures can't drift), and CI. Publishing a definition that fails validation is
 * blocked — a broken state machine strands a litigant mid-case with no next action.
 *
 * Errors block publication. Warnings do not, but every unverified legal citation raises
 * one, so the count of warnings is the compliance gate's to-do list.
 */

import { isValidDate } from '../dates.js'
import type { DeadlineRule } from '../deadlines/types.js'
import type {
  ValidationIssue,
  ValidationResult,
  WorkflowDefinition,
  WorkflowStage,
} from './types.js'

const STAGE_KEY = /^[a-z][a-z0-9_]{1,63}$/

function validateDeadlineRule(rule: DeadlineRule, path: string): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const err = (code: string, message: string, p = path): ValidationIssue => ({
    severity: 'error',
    code,
    message,
    path: p,
  })

  if (!rule.key) issues.push(err('deadline.key_missing', 'Deadline rule needs a key.'))
  if (!rule.title) issues.push(err('deadline.title_missing', 'Deadline rule needs a title.'))
  if (!rule.anchor) issues.push(err('deadline.anchor_missing', 'Deadline rule needs an anchor.'))

  if (!Number.isInteger(rule.offset?.count)) {
    issues.push(err('deadline.offset_not_integer', 'Deadline offset count must be a whole number.', `${path}.offset.count`))
  } else if (rule.offset.count < 0) {
    issues.push(
      err(
        'deadline.offset_negative',
        'Deadline offset must not be negative — use direction "before" instead.',
        `${path}.offset.count`
      )
    )
  }

  if (!['calendar_days', 'court_days', 'months'].includes(rule.offset?.unit)) {
    issues.push(err('deadline.offset_unit_invalid', `Unknown offset unit "${rule.offset?.unit}".`, `${path}.offset.unit`))
  }
  if (!['after', 'before'].includes(rule.direction)) {
    issues.push(err('deadline.direction_invalid', `Direction must be "after" or "before".`, `${path}.direction`))
  }
  if (!['next_court_day', 'previous_court_day', 'none'].includes(rule.rollover)) {
    issues.push(err('deadline.rollover_invalid', `Unknown rollover "${rule.rollover}".`, `${path}.rollover`))
  }

  // Non-negotiable: a date we tell a litigant must be traceable to a source.
  if (!rule.source?.citation?.trim()) {
    issues.push(
      err(
        'deadline.source_missing',
        'Every deadline rule must cite the statute or court rule it comes from.',
        `${path}.source.citation`
      )
    )
  }
  if (!rule.source?.summary?.trim()) {
    issues.push(
      err('deadline.source_summary_missing', 'Every deadline rule needs a plain-language summary of its source.', `${path}.source.summary`)
    )
  }

  if (!rule.verification || !['unverified', 'attorney_verified'].includes(rule.verification.status)) {
    issues.push(err('deadline.verification_missing', 'Deadline rule must declare a verification status.', `${path}.verification`))
  } else if (rule.verification.status === 'unverified') {
    issues.push({
      severity: 'warning',
      code: 'deadline.unverified',
      message: `Deadline "${rule.key}" (${rule.source?.citation ?? 'no citation'}) has not been verified by an attorney.`,
      path: `${path}.verification`,
    })
  } else if (rule.verification.status === 'attorney_verified') {
    if (!rule.verification.verifiedBy?.trim()) {
      issues.push(err('deadline.verified_by_missing', 'A verified rule must name the attorney who verified it.', `${path}.verification.verifiedBy`))
    }
    if (!rule.verification.verifiedAt || !isValidDate(rule.verification.verifiedAt.slice(0, 10))) {
      issues.push(err('deadline.verified_at_invalid', 'A verified rule must record when it was verified.', `${path}.verification.verifiedAt`))
    }
  }

  if (rule.serviceExtension) {
    if (!Number.isInteger(rule.serviceExtension.days) || rule.serviceExtension.days < 0) {
      issues.push(err('deadline.service_extension_days_invalid', 'Service extension days must be a non-negative whole number.', `${path}.serviceExtension.days`))
    }
    if (!rule.serviceExtension.appliesToMethods?.length) {
      issues.push(err('deadline.service_extension_methods_empty', 'Service extension must list the service methods it applies to.', `${path}.serviceExtension.appliesToMethods`))
    }
    if (!rule.serviceExtension.source?.citation?.trim()) {
      issues.push(err('deadline.service_extension_source_missing', 'Service extension must cite its source.', `${path}.serviceExtension.source.citation`))
    }
  }

  if (rule.reminderOffsetsDays) {
    for (const [i, d] of rule.reminderOffsetsDays.entries()) {
      if (!Number.isInteger(d) || d < 0) {
        issues.push(err('deadline.reminder_offset_invalid', 'Reminder offsets must be non-negative whole days.', `${path}.reminderOffsetsDays[${i}]`))
      }
    }
  }

  return issues
}

function validateStage(stage: WorkflowStage, index: number, keys: Set<string>): ValidationIssue[] {
  const path = `stages[${index}]`
  const issues: ValidationIssue[] = []
  const err = (code: string, message: string, p = path): ValidationIssue => ({
    severity: 'error',
    code,
    message,
    path: p,
  })

  if (!STAGE_KEY.test(stage.key ?? '')) {
    issues.push(err('stage.key_invalid', `Stage key "${stage.key}" must be lower_snake_case.`, `${path}.key`))
  }
  if (!stage.title?.trim()) issues.push(err('stage.title_missing', 'Stage needs a title.', `${path}.title`))
  if (!stage.plainLanguageExplainer?.trim()) {
    issues.push(err('stage.explainer_missing', 'Stage needs a plain-language explainer.', `${path}.plainLanguageExplainer`))
  }

  if (!Array.isArray(stage.next)) {
    issues.push(err('stage.next_not_array', 'Stage "next" must be an array of stage keys.', `${path}.next`))
  } else {
    for (const [i, target] of stage.next.entries()) {
      if (!keys.has(target)) {
        issues.push(err('stage.next_unknown', `Stage "${stage.key}" points at unknown stage "${target}".`, `${path}.next[${i}]`))
      }
      if (target === stage.key) {
        issues.push({
          severity: 'warning',
          code: 'stage.self_loop',
          message: `Stage "${stage.key}" can advance to itself. Intentional for repeating steps (continuances), otherwise a mistake.`,
          path: `${path}.next[${i}]`,
        })
      }
    }
    const dupes = stage.next.filter((t, i) => stage.next.indexOf(t) !== i)
    if (dupes.length) {
      issues.push(err('stage.next_duplicate', `Stage "${stage.key}" lists ${dupes[0]} more than once.`, `${path}.next`))
    }
  }

  if (stage.terminal === true && stage.next?.length) {
    issues.push(err('stage.terminal_has_next', `Terminal stage "${stage.key}" must not have next stages.`, `${path}.next`))
  }
  if (stage.terminal !== true && Array.isArray(stage.next) && stage.next.length === 0) {
    issues.push(err('stage.dead_end', `Stage "${stage.key}" has no next stages but is not marked terminal.`, `${path}.next`))
  }

  if (stage.courtFeeCents != null) {
    if (!Number.isInteger(stage.courtFeeCents) || stage.courtFeeCents < 0) {
      issues.push(err('stage.court_fee_invalid', 'Court fee must be a non-negative whole number of cents.', `${path}.courtFeeCents`))
    }
  }

  if (!Array.isArray(stage.requiredDocuments)) {
    issues.push(err('stage.documents_not_array', 'requiredDocuments must be an array.', `${path}.requiredDocuments`))
  } else {
    for (const [i, doc] of stage.requiredDocuments.entries()) {
      if (!doc.templateKey?.trim()) {
        issues.push(err('stage.document_template_missing', 'Required document needs a templateKey.', `${path}.requiredDocuments[${i}].templateKey`))
      }
      if (!doc.purpose?.trim()) {
        issues.push(err('stage.document_purpose_missing', 'Required document needs a plain-language purpose.', `${path}.requiredDocuments[${i}].purpose`))
      }
    }
  }

  if (stage.deadlineRule) {
    issues.push(...validateDeadlineRule(stage.deadlineRule, `${path}.deadlineRule`))
  }

  return issues
}

/** Stages reachable from the initial stage by following `next`. */
export function reachableStages(definition: WorkflowDefinition): Set<string> {
  const byKey = new Map(definition.stages.map((s) => [s.key, s]))
  const seen = new Set<string>()
  const queue = [definition.initialStageKey]
  while (queue.length) {
    const key = queue.shift()!
    if (seen.has(key)) continue
    const stage = byKey.get(key)
    if (!stage) continue
    seen.add(key)
    queue.push(...(stage.next ?? []))
  }
  return seen
}

/** True when at least one terminal stage is reachable from `fromKey`. */
function canReachTerminal(definition: WorkflowDefinition, fromKey: string): boolean {
  const byKey = new Map(definition.stages.map((s) => [s.key, s]))
  const seen = new Set<string>()
  const queue = [fromKey]
  while (queue.length) {
    const key = queue.shift()!
    if (seen.has(key)) continue
    seen.add(key)
    const stage = byKey.get(key)
    if (!stage) continue
    if (stage.terminal === true) return true
    queue.push(...(stage.next ?? []))
  }
  return false
}

export function validateWorkflowDefinition(definition: WorkflowDefinition): ValidationResult {
  const issues: ValidationIssue[] = []
  const err = (code: string, message: string, path: string): ValidationIssue => ({
    severity: 'error',
    code,
    message,
    path,
  })

  if (!definition.caseTypeKey?.trim()) issues.push(err('definition.case_type_missing', 'Definition needs a caseTypeKey.', 'caseTypeKey'))
  if (!definition.jurisdictionKey?.trim()) issues.push(err('definition.jurisdiction_missing', 'Definition needs a jurisdictionKey.', 'jurisdictionKey'))
  if (!Number.isInteger(definition.version) || definition.version < 1) {
    issues.push(err('definition.version_invalid', 'Version must be a whole number of at least 1.', 'version'))
  }
  if (!definition.overview?.trim()) {
    issues.push(err('definition.overview_missing', 'Definition needs a plain-language overview.', 'overview'))
  }

  if (!Array.isArray(definition.stages) || definition.stages.length === 0) {
    issues.push(err('definition.stages_empty', 'Definition must have at least one stage.', 'stages'))
    return { valid: false, errors: issues, warnings: [] }
  }

  const keys = new Set<string>()
  const seenKeys = new Set<string>()
  for (const stage of definition.stages) {
    if (seenKeys.has(stage.key)) {
      issues.push(err('definition.duplicate_stage_key', `Stage key "${stage.key}" appears more than once.`, 'stages'))
    }
    seenKeys.add(stage.key)
    keys.add(stage.key)
  }

  definition.stages.forEach((stage, i) => issues.push(...validateStage(stage, i, keys)))

  if (!keys.has(definition.initialStageKey)) {
    issues.push(err('definition.initial_stage_unknown', `initialStageKey "${definition.initialStageKey}" is not a stage in this definition.`, 'initialStageKey'))
  } else {
    const reachable = reachableStages(definition)
    for (const stage of definition.stages) {
      if (!reachable.has(stage.key)) {
        issues.push(err('definition.stage_unreachable', `Stage "${stage.key}" cannot be reached from the first stage.`, 'stages'))
      }
    }
    for (const stage of definition.stages) {
      if (reachable.has(stage.key) && !canReachTerminal(definition, stage.key)) {
        issues.push(
          err('definition.no_path_to_terminal', `From stage "${stage.key}" there is no path to an end of the case.`, 'stages')
        )
      }
    }
  }

  if (!definition.stages.some((s) => s.terminal === true)) {
    issues.push(err('definition.no_terminal_stage', 'Definition must have at least one terminal stage.', 'stages'))
  }

  if (definition.status === 'live' && definition.verification?.status !== 'attorney_verified') {
    issues.push({
      severity: 'warning',
      code: 'definition.live_but_unverified',
      message:
        'This definition is marked live but has not been attorney-verified. It must not be published to litigants until the compliance gate clears.',
      path: 'verification',
    })
  }

  return {
    valid: !issues.some((i) => i.severity === 'error'),
    errors: issues.filter((i) => i.severity === 'error'),
    warnings: issues.filter((i) => i.severity === 'warning'),
  }
}

/** Throwing wrapper for seed scripts and CI. */
export function assertValidWorkflowDefinition(definition: WorkflowDefinition): void {
  const result = validateWorkflowDefinition(definition)
  if (!result.valid) {
    const lines = result.errors.map((e) => `  - [${e.code}] ${e.path}: ${e.message}`).join('\n')
    throw new Error(
      `Workflow definition ${definition.caseTypeKey}/${definition.jurisdictionKey} v${definition.version} is invalid:\n${lines}`
    )
  }
}
