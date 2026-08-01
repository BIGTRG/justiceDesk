/**
 * Render a completed interview into a PDF and store it in the vault.
 *
 * Two paths:
 *   aoc_form    — fill the official blank PDF with pdf-lib (refuses an unverified map)
 *   ai_freeform — assemble sections and print via headless Chromium
 *
 * Every document produced here is a DRAFT and is watermarked. Finalising is a separate,
 * explicit act by the litigant, and filing is something only they can do.
 */

import type { Logger } from '@justicedesk/service-kit'
import type { Client as MinioClient } from 'minio'
import type pg from 'pg'
import { fillAocForm, TemplateNotFillableError, type FillableTemplate } from '../render/pdfForm.js'
import { renderHtmlToPdf, type DocumentSection } from '../render/htmlPdf.js'

export interface RenderDocumentParams {
  db: pg.Pool
  minio: MinioClient
  bucket: string
  interviewId: string
  caseId: string
  logger: Logger
}

export interface RenderResult {
  documentId: string
  minioKey: string
  byteSize: number
}

export async function renderDocument(params: RenderDocumentParams): Promise<RenderResult> {
  const { db, minio, bucket, interviewId, caseId, logger } = params

  const { rows } = await db.query(
    `SELECT i.id, i.answers, i.template_id AS "templateId",
            t.key AS "templateKey", t.name AS "templateName", t.source,
            t.form_pdf_minio_key AS "formPdfMinioKey", t.field_map AS "fieldMap",
            t.disclosure_text AS "disclosureText", t.verification,
            c.court_case_number AS "courtCaseNumber", c.metadata,
            j.county, j.state, j.court_level AS "courtLevel"
       FROM interviews i
       JOIN document_templates t ON t.id = i.template_id
       JOIN cases c ON c.id = i.case_id
       JOIN jurisdictions j ON j.id = c.jurisdiction_id
      WHERE i.id = $1 AND i.case_id = $2`,
    [interviewId, caseId]
  )

  const row = rows[0]
  if (!row) throw new Error(`Interview ${interviewId} not found on case ${caseId}.`)

  const answers = (row.answers ?? {}) as Record<string, unknown>

  // Reserve the document row first so the object key can carry its ID and version.
  const { rows: created } = await db.query<{ id: string; version: number }>(
    `INSERT INTO documents (case_id, kind, template_id, title, minio_key, version, status, watermark)
     VALUES ($1, 'generated', $2, $3, $4,
             COALESCE((SELECT MAX(version) + 1 FROM documents WHERE case_id = $1 AND template_id = $2), 1),
             'draft', TRUE)
     RETURNING id, version`,
    [caseId, row.templateId, row.templateName, `pending/${interviewId}`]
  )
  const doc = created[0]!
  const minioKey = `cases/${caseId}/documents/${doc.id}/v${doc.version}.pdf`

  let pdf: Buffer

  if (row.source === 'aoc_form') {
    const template: FillableTemplate = {
      key: row.templateKey,
      fieldMap: (row.fieldMap ?? {}) as Record<string, string>,
      verification: (row.verification ?? { status: 'unverified' }) as { status: string },
    }

    let blank: Buffer
    try {
      const stream = await minio.getObject(bucket, row.formPdfMinioKey)
      const chunks: Buffer[] = []
      for await (const chunk of stream) chunks.push(chunk as Buffer)
      blank = Buffer.concat(chunks)
    } catch (err) {
      // The blank official form has not been uploaded yet. Say so precisely — this is a
      // content gap, not a bug, and the admin template manager is where it gets fixed.
      await db.query(`DELETE FROM documents WHERE id = $1`, [doc.id])
      throw new Error(
        `The blank form for "${row.templateKey}" is not in the vault at "${row.formPdfMinioKey}". ` +
          `Upload the official AOC PDF via the admin template manager. (${(err as Error).message})`
      )
    }

    try {
      pdf = await fillAocForm(blank, template, answers, { watermark: true, flatten: false })
    } catch (err) {
      await db.query(`DELETE FROM documents WHERE id = $1`, [doc.id])
      if (err instanceof TemplateNotFillableError) {
        logger.warn('refused to fill an unverified AOC template', {
          templateKey: row.templateKey,
          reasons: err.reasons,
        })
      }
      throw err
    }
  } else {
    const metadata = (row.metadata ?? {}) as Record<string, unknown>
    const sections: DocumentSection[] = buildFreeformSections(answers)

    pdf = await renderHtmlToPdf({
      title: row.templateName,
      caption: {
        court: courtLabel(row.courtLevel),
        county: row.county,
        state: row.state,
        caseNumber: row.courtCaseNumber,
        plaintiff: String(metadata.opposingParty ?? answers.plaintiff_name ?? 'Plaintiff'),
        defendant: String(answers.full_name ?? 'Defendant'),
      },
      sections,
      disclosureText: row.disclosureText,
      signerName: String(answers.full_name ?? ''),
      watermark: true,
    })
  }

  await minio.putObject(bucket, minioKey, pdf, pdf.length, { 'Content-Type': 'application/pdf' })
  await db.query(`UPDATE documents SET minio_key = $2, byte_size = $3 WHERE id = $1`, [
    doc.id,
    minioKey,
    pdf.length,
  ])

  logger.info('document rendered', {
    documentId: doc.id,
    caseId,
    source: row.source,
    byteSize: pdf.length,
  })

  return { documentId: doc.id, minioKey, byteSize: pdf.length }
}

function courtLabel(courtLevel: string): string {
  switch (courtLevel) {
    case 'magistrate':
      return 'In the General Court of Justice — Small Claims Division'
    case 'district':
      return 'In the General Court of Justice — District Court Division'
    case 'superior':
      return 'In the General Court of Justice — Superior Court Division'
    default:
      return 'In the General Court of Justice'
  }
}

/**
 * Turn interview answers into document sections.
 *
 * Structural content only — headings, ordering, the signature block. Any prose that needs
 * drafting comes from svc-ai-gateway's interview endpoint, which runs the guardrails with
 * `citationPolicy: 'reject'`. This function never invents legal text.
 */
export function buildFreeformSections(answers: Record<string, unknown>): DocumentSection[] {
  const sections: DocumentSection[] = []

  const responses = Object.entries(answers).filter(
    ([key]) => !['full_name', 'mailing_address', 'phone', 'court_case_number'].includes(key)
  )

  const denials = responses.filter(([key, v]) => key.startsWith('defense_') && v === true)
  const narrative = answers.additional_facts ?? answers.response_text ?? answers.claim_description

  sections.push({
    heading: 'Response',
    body: 'I am the defendant in this case. I am representing myself. This is my response to the complaint.',
  })

  if (denials.length) {
    sections.push({
      heading: 'Defenses',
      body:
        'I raise the following defenses:\n\n' +
        denials.map(([key]) => `- ${defenseLabel(key)}`).join('\n'),
    })
  }

  if (typeof narrative === 'string' && narrative.trim()) {
    sections.push({ heading: 'Statement of facts', body: narrative.trim() })
  }

  sections.push({
    heading: 'Request',
    body: 'I ask the Court to consider my response and my defenses before making a decision in this case.',
  })

  return sections
}

/** Plain-language labels for the affirmative-defense checkboxes. */
function defenseLabel(key: string): string {
  const labels: Record<string, string> = {
    defense_not_mine: 'This debt is not mine.',
    defense_already_paid: 'I have already paid this debt, in whole or in part.',
    defense_wrong_amount: 'The amount claimed is not correct.',
    defense_too_old: 'I believe the time limit for bringing this claim has passed.',
    defense_wrong_company: 'I dispute that the plaintiff owns this debt.',
  }
  return labels[key] ?? key.replace(/^defense_/, '').replace(/_/g, ' ')
}
