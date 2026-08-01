/**
 * AOC form filling with pdf-lib.
 *
 * The safety property here is the refusal, not the filling. A court form that looks
 * official and has the wrong values in its boxes is worse than no form: a self-represented
 * litigant will file it, and neither they nor the clerk will catch a field that landed in
 * the wrong place.
 *
 * So this module refuses to run when it cannot be sure of the mapping:
 *   * any field name still a PLACEHOLDER_ from the seed data;
 *   * a template not yet marked attorney_verified;
 *   * a mapped field the actual PDF does not contain.
 *
 * That last one matters most — pdf-lib silently ignores a `getTextField` miss if you let
 * it, which would produce a blank box rather than an error.
 */

import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'

export class TemplateNotFillableError extends Error {
  readonly reasons: string[]
  constructor(templateKey: string, reasons: string[]) {
    super(
      `Template "${templateKey}" cannot be filled:\n` +
        reasons.map((r) => `  - ${r}`).join('\n') +
        '\nRefusing to produce a court form that may be wrong.'
    )
    this.name = 'TemplateNotFillableError'
    this.reasons = reasons
  }
}

export interface FillableTemplate {
  key: string
  fieldMap: Record<string, string>
  verification: { status: string }
}

/**
 * Pre-flight checks. Exported so the admin template manager can show the same reasons
 * before anyone tries to generate a document.
 */
export function fillabilityProblems(
  template: FillableTemplate,
  pdfFieldNames: string[]
): string[] {
  const problems: string[] = []

  const placeholders = Object.entries(template.fieldMap).filter(([, v]) =>
    String(v).startsWith('PLACEHOLDER_')
  )
  if (placeholders.length) {
    problems.push(
      `${placeholders.length} field name(s) are still placeholders from the seed data ` +
        `(${placeholders.map(([k]) => k).join(', ')}). Read the real field names off the official AOC PDF.`
    )
  }

  if (template.verification.status !== 'attorney_verified') {
    problems.push(
      'The template has not been attorney-verified. See COMPLIANCE.md — this gate is deliberate.'
    )
  }

  if (Object.keys(template.fieldMap).length === 0) {
    problems.push('The field map is empty, so nothing would be filled in.')
  }

  const available = new Set(pdfFieldNames)
  for (const [answerKey, pdfField] of Object.entries(template.fieldMap)) {
    if (String(pdfField).startsWith('PLACEHOLDER_')) continue
    if (!available.has(pdfField)) {
      problems.push(
        `The PDF has no field named "${pdfField}" (mapped from answer "${answerKey}"). ` +
          `Available fields: ${pdfFieldNames.slice(0, 20).join(', ')}${pdfFieldNames.length > 20 ? ', …' : ''}`
      )
    }
  }

  return problems
}

export interface FillOptions {
  /** Stamp a DRAFT watermark. On unless the document has been finalised. */
  watermark: boolean
  /** Flatten so a filed copy cannot be edited after the fact. */
  flatten: boolean
}

export async function fillAocForm(
  blankPdf: Buffer,
  template: FillableTemplate,
  answers: Record<string, unknown>,
  options: FillOptions
): Promise<Buffer> {
  const doc = await PDFDocument.load(blankPdf)
  const form = doc.getForm()
  const fieldNames = form.getFields().map((f) => f.getName())

  const problems = fillabilityProblems(template, fieldNames)
  if (problems.length) throw new TemplateNotFillableError(template.key, problems)

  for (const [answerKey, pdfField] of Object.entries(template.fieldMap)) {
    const value = answers[answerKey]
    if (value === undefined || value === null || value === '') continue

    const field = form.getFieldMaybe(pdfField)
    if (!field) continue // unreachable — fillabilityProblems already checked

    const text = typeof value === 'boolean' ? (value ? 'Yes' : 'No') : String(value)
    try {
      form.getTextField(pdfField).setText(text)
    } catch {
      // Not a text field — try a checkbox before giving up.
      try {
        const checkbox = form.getCheckBox(pdfField)
        if (text.toLowerCase() === 'yes' || text === 'true') checkbox.check()
        else checkbox.uncheck()
      } catch {
        throw new TemplateNotFillableError(template.key, [
          `Field "${pdfField}" is neither a text field nor a checkbox, so answer "${answerKey}" cannot be written to it.`,
        ])
      }
    }
  }

  if (options.watermark) await stampDraftWatermark(doc)
  if (options.flatten) form.flatten()

  return Buffer.from(await doc.save())
}

/**
 * DRAFT watermark.
 *
 * Applied to every unfinalised document. A litigant walking into a courthouse with an
 * unfinished draft they believed was ready is a real failure mode, and the watermark is
 * the cheapest thing that prevents it.
 */
export async function stampDraftWatermark(doc: PDFDocument): Promise<void> {
  const font = await doc.embedFont(StandardFonts.HelveticaBold)

  for (const page of doc.getPages()) {
    const { width, height } = page.getSize()
    page.drawText('DRAFT — NOT FILED', {
      x: width * 0.12,
      y: height * 0.45,
      size: Math.min(width, height) * 0.08,
      font,
      color: rgb(0.85, 0.1, 0.1),
      opacity: 0.18,
      rotate: { type: 'degrees', angle: 30 } as never,
    })
  }
}

/** Read the field names out of a blank form, for the admin field-mapping screen. */
export async function listPdfFields(
  blankPdf: Buffer
): Promise<Array<{ name: string; type: string }>> {
  const doc = await PDFDocument.load(blankPdf)
  return doc
    .getForm()
    .getFields()
    .map((f) => ({ name: f.getName(), type: f.constructor.name }))
}
