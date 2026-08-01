/**
 * Legal-content verification report.
 *
 * Prints every unverified rule, template and open question across the seed content — the
 * to-do list for the compliance gate. Requires no database.
 *
 *   pnpm --filter @justicedesk/db verify-content
 *
 * Exits non-zero while anything is unverified. That makes it usable as a CI gate on the
 * branch that flips COMPLIANCE_REVIEW_COMPLETE to true: the build cannot claim review is
 * complete while this script still has findings.
 */

import { validateWorkflowDefinition } from '@justicedesk/shared'
import { pathToFileURL } from 'node:url'
import {
  CITATION_OPEN_QUESTIONS,
  JURISDICTIONS,
  NC_CURATED_CITATIONS,
  TEMPLATES,
  WORKFLOW_DEFINITIONS,
} from './seeds/index.js'

interface Finding {
  area: string
  item: string
  detail: string
  blocking: boolean
}

export function collectFindings(): Finding[] {
  const findings: Finding[] = []

  for (const def of WORKFLOW_DEFINITIONS) {
    const label = `${def.caseTypeKey}/${def.jurisdictionKey} v${def.version}`

    if (def.verification.status !== 'attorney_verified') {
      findings.push({
        area: 'workflow',
        item: label,
        detail: 'Definition is not attorney-verified.',
        blocking: true,
      })
    }
    for (const q of def.verification.openQuestions ?? []) {
      findings.push({ area: 'workflow', item: label, detail: q, blocking: q.startsWith('CRITICAL') })
    }

    for (const stage of def.stages) {
      const rule = stage.deadlineRule
      if (!rule) continue
      if (rule.verification.status !== 'attorney_verified') {
        findings.push({
          area: 'deadline',
          item: `${label} → ${stage.key}.${rule.key}`,
          detail: `Unverified deadline rule (${rule.source.citation}).`,
          blocking: true,
        })
      }
      for (const q of rule.verification.openQuestions ?? []) {
        findings.push({
          area: 'deadline',
          item: `${label} → ${stage.key}.${rule.key}`,
          detail: q,
          blocking: q.startsWith('CRITICAL'),
        })
      }
    }

    for (const w of validateWorkflowDefinition(def).warnings) {
      findings.push({ area: 'validator', item: label, detail: `[${w.code}] ${w.message}`, blocking: false })
    }
  }

  for (const t of TEMPLATES) {
    if (t.verification.status !== 'attorney_verified') {
      findings.push({
        area: 'template',
        item: t.key,
        detail: 'Template is not attorney-verified.',
        blocking: true,
      })
    }
    for (const q of t.verification.openQuestions) {
      findings.push({
        area: 'template',
        item: t.key,
        detail: q,
        blocking: q.startsWith('BLOCKING') || q.startsWith('CRITICAL'),
      })
    }
    const placeholders = Object.entries(t.fieldMap).filter(([, v]) => v.startsWith('PLACEHOLDER_'))
    if (placeholders.length) {
      findings.push({
        area: 'template',
        item: t.key,
        detail: `${placeholders.length} PDF field name(s) are placeholders, not read from the real AOC form: ${placeholders
          .map(([k]) => k)
          .join(', ')}`,
        blocking: true,
      })
    }
  }

  for (const q of CITATION_OPEN_QUESTIONS) {
    findings.push({ area: 'citations', item: 'curated library', detail: q, blocking: false })
  }

  for (const j of JURISDICTIONS) {
    const json = JSON.stringify(j.filingAddresses)
    if (json.includes('VERIFY')) {
      findings.push({
        area: 'jurisdiction',
        item: j.key,
        detail: 'Courthouse address, phone or hours are placeholders. A wrong address means a missed hearing.',
        blocking: true,
      })
    }
  }

  return findings
}

export function report(): number {
  const findings = collectFindings()
  const blocking = findings.filter((f) => f.blocking)

  console.log('JusticeDesk — legal content verification report')
  console.log('='.repeat(70))
  console.log(`Workflows: ${WORKFLOW_DEFINITIONS.length}   Templates: ${TEMPLATES.length}   Curated citations: ${NC_CURATED_CITATIONS.length}`)
  console.log('')

  const byArea = new Map<string, Finding[]>()
  for (const f of findings) {
    const list = byArea.get(f.area) ?? []
    list.push(f)
    byArea.set(f.area, list)
  }

  for (const [area, list] of [...byArea].sort()) {
    console.log(`\n## ${area} (${list.length})`)
    for (const f of list) {
      console.log(`  ${f.blocking ? '[BLOCKING]' : '[review]  '} ${f.item}`)
      console.log(`              ${f.detail}`)
    }
  }

  console.log('\n' + '='.repeat(70))
  console.log(`${findings.length} finding(s), ${blocking.length} blocking.`)

  if (findings.length > 0) {
    console.log('\nThe compliance gate is CLOSED. See COMPLIANCE.md.')
    console.log('Do not deploy publicly or enable live payments while findings remain.')
    return 1
  }
  console.log('\nNo outstanding findings.')
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(report())
}
